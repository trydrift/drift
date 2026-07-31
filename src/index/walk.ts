import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { memberOf } from '../detect/workspace.js';

/**
 * Source-file discovery.
 *
 * Deliberately dependency-free and conservative: directories that are almost
 * never the user's own source (vendored code, build output, VCS internals) are
 * skipped wholesale. Walking `node_modules` would not just be slow — it would
 * produce impact sites in third-party code that Drift must never ask an agent
 * to edit.
 */

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'bower_components',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.tox',
  'site-packages',
  'target',
  'build',
  'dist',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  '.vscode',
  '.terraform',
  'Pods',
  'DerivedData',
]);

export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  /** Runtime-version declarations: CI workflows, engine fields, images. */
  | 'config'
  | 'other';

/**
 * Files that declare a runtime version.
 *
 * Collected so runtime-requirement findings can be localized where the fix
 * actually belongs. Searching source code for "Node.js" only ever finds
 * comments and prose.
 */
const RUNTIME_CONFIG_BASENAMES = new Set([
  'package.json',
  '.nvmrc',
  '.node-version',
  '.ruby-version',
  '.python-version',
  '.tool-versions',
  'dockerfile',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'runtime.txt',
  '.ruby-gemset',
]);

export function isRuntimeConfigPath(path: string): boolean {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (RUNTIME_CONFIG_BASENAMES.has(base)) return true;
  if (base.startsWith('dockerfile')) return true;
  // CI workflow definitions, where the runtime version is usually pinned.
  return /^\.github\/workflows\/.+\.ya?ml$/.test(path) || /^\.(gitlab-ci|circleci)/.test(path);
}

const EXTENSION_LANGUAGES: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'java',
  '.kts': 'java',
  '.scala': 'java',
  '.rb': 'ruby',
  '.rake': 'ruby',
};

export function languageOf(path: string): Language {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'other';
  return EXTENSION_LANGUAGES[path.slice(dot).toLowerCase()] ?? 'other';
}

export interface SourceFile {
  /** Repo-relative, `/`-separated. */
  path: string;
  language: Language;
  content: string;
  lineCount: number;
  /**
   * The workspace member whose directory contains this file.
   *
   * `''` is the repository root, `null` is a file no member claims, and
   * `undefined` means the walk was not given a member list — a single-package
   * repository, where the question does not arise.
   */
  member?: string | null;
}

export interface WalkOptions {
  /** Skip files larger than this. Minified bundles are noise, not source. */
  maxFileBytes?: number;
  /** Hard ceiling on files read, to bound runtime on very large repos. */
  maxFiles?: number;
  /** Extra directory names to skip. */
  extraIgnores?: readonly string[];
  /**
   * Workspace member directories, so each file records which package owns it.
   *
   * The walk stays repository-wide on purpose: an import that crosses a package
   * boundary is a real edge and the index needs it. It is *localization* that
   * respects the boundary, using the label recorded here.
   */
  members?: readonly string[];
}

/**
 * Read every analysable source file under `root`.
 *
 * Files are returned with content in memory. That is acceptable because the
 * walker skips vendored trees and large files, so what remains is the user's
 * own source — and every later stage needs the text anyway.
 */
export async function walkSourceFiles(
  root: string,
  options: WalkOptions = {},
): Promise<SourceFile[]> {
  const { maxFileBytes = 512 * 1024, maxFiles = 5000, extraIgnores = [], members } = options;
  const ignored = new Set([...IGNORED_DIRECTORIES, ...extraIgnores]);

  const files: SourceFile[] = [];

  const visit = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: skip rather than fail the run.
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        // Hidden directories other than the ones we explicitly want are noise.
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        await visit(full);
        continue;
      }

      if (!entry.isFile()) continue;

      const repoPath = toPosix(relative(root, full));
      const language: Language = isRuntimeConfigPath(repoPath)
        ? 'config'
        : languageOf(entry.name);
      if (language === 'other') continue;
      // Minified and generated bundles produce useless multi-thousand-column
      // "impact sites" that a reviewer cannot act on.
      if (/\.min\.(js|ts)$/.test(entry.name) || /\.d\.ts\.map$/.test(entry.name)) continue;

      try {
        const info = await stat(full);
        if (info.size > maxFileBytes) continue;

        const content = await readFile(full, 'utf8');
        files.push({
          path: repoPath,
          language,
          content,
          lineCount: countLines(content),
          ...(members ? { member: memberOf(repoPath, members) } : {}),
        });
      } catch {
        continue;
      }
    }
  };

  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function countLines(content: string): number {
  let count = 1;
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') count += 1;
  return count;
}
