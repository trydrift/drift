import type { Dirent } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { memberOf } from '../detect/workspace.js';
import { mapWithConcurrency } from '../util/http.js';

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
  // C and C++ put dependencies in the source tree far more often than other
  // ecosystems do, and an impact site inside one is a site in code the project
  // does not own. `.pio` is PlatformIO's build and library cache, `third_party`
  // is what a CMake project overwhelmingly calls a vendored subtree, and
  // `cmake-build-*` is what CLion writes.
  //
  // `external/` is deliberately not here despite being the runner-up name for
  // the same thing. It is also an ordinary directory name in projects with no
  // vendoring at all, and a wrong entry in this list does not produce a wrong
  // finding — it produces no finding, silently, in a directory the developer
  // believes was analysed.
  '.pio',
  'third_party',
  'thirdparty',
  'cmake-build-debug',
  'cmake-build-release',
]);

export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  /**
   * `.c` and `.h`. Kept apart from `cpp` because the two answer the same
   * questions differently — a `.h` shared by both is read as C, which is the
   * conservative choice: every C declaration is valid C++, and the reverse is
   * not true.
   */
  | 'c'
  | 'cpp'
  | 'dotnet'
  | 'php'
  | 'elixir'
  | 'erlang'
  | 'dart'
  | 'swift'
  | 'ocaml'
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
  'containerfile',
  'go.mod',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'cargo.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
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
  if (base.startsWith('containerfile')) return true;
  if (base.endsWith('.gemspec')) return true;
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
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',
  '.inl': 'cpp',
  '.tpp': 'cpp',
  // Arduino sketches. `.ino` is C++ with an implicit prelude, and `.pde` is
  // its pre-1.0 spelling that a great many published examples still use.
  '.ino': 'cpp',
  '.pde': 'cpp',
  '.java': 'java',
  '.kt': 'java',
  '.kts': 'java',
  '.scala': 'java',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.cs': 'dotnet',
  '.fs': 'dotnet',
  '.vb': 'dotnet',
  '.php': 'php',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.dart': 'dart',
  '.swift': 'swift',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
};

/**
 * How much of an oversized file to read before deciding what it is.
 *
 * A bundle announces itself immediately — the first line is a banner or is
 * already thousands of characters long — so this never needs to be large. 64 KB
 * also comfortably covers a legitimate source file's licence header and imports
 * before any real code starts.
 */
const GENERATED_SNIFF_BYTES = 64 * 1024;

/**
 * A line long enough that no one wrote it by hand.
 *
 * Generated parsers and formatted source stay well under this; minified output
 * blows past it on its first line. Deliberately far above anything a linter
 * would permit, because the cost of a wrong "yes" is a real file going
 * unsearched while the report claims completeness.
 */
const MINIFIED_LINE_LENGTH = 2_000;

/** Banners the common bundlers and codegen tools put at the top of their output. */
const GENERATED_MARKERS = [
  '@generated',
  'do not edit',
  'do not modify',
  'auto-generated',
  'autogenerated',
  'generated by',
  'webpackbootstrap',
  'sourcemappingurl',
];

/**
 * Is this oversized file build output rather than source someone maintains?
 *
 * Asked only of files already too large to index, and only to decide whether
 * skipping one is a gap in coverage or simply nothing to look at. Two
 * independent signals, either sufficient: a self-declared banner, or lines no
 * human writes.
 *
 * Wrong in the safe direction by construction — an unreadable file, or one this
 * cannot classify, is treated as *source* and so still counts as a gap. The
 * failure mode is Drift saying it did not finish looking when it had, never the
 * reverse.
 */
export async function looksGenerated(path: string): Promise<boolean> {
  let head: string;
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(GENERATED_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, GENERATED_SNIFF_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }

  const opening = head.slice(0, 4_000).toLowerCase();
  if (GENERATED_MARKERS.some((marker) => opening.includes(marker))) return true;

  // No newline at all inside 64 KB is the clearest minification signal there
  // is; otherwise judge the longest line the sample actually contains.
  const lines = head.split('\n');
  if (lines.length === 1) return true;
  // The final element is a partial line cut by the sample boundary, so it is
  // not evidence of anything and is dropped.
  return lines.slice(0, -1).some((line) => line.length > MINIFIED_LINE_LENGTH);
}

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

/** Explicit completeness facts for consumers that reason from missing sites. */
export interface WalkCoverage {
  localizationRan: boolean;
  localizationComplete: boolean;
  sourceFilesDiscovered: number;
  sourceFilesIndexed: number;
  sourceTruncated: boolean;
  /**
   * Files identified as build output and deliberately not indexed.
   *
   * Not a completeness gap, which is the whole reason it is counted apart from
   * one. A bundle holds every dependency inlined and minified: a match in it is
   * not a place anyone edits, and its absence proves nothing about the source
   * that produced it. Counting one as unread meant a single committed
   * `action/index.cjs` — 1.8 MB, one of 1,584 files — reported this repository
   * as incompletely searched, which downgraded *every* dependency in it to
   * "absence of local use was not proved".
   */
  generatedFilesSkipped: number;
  /**
   * Genuine source too large to read, which *is* a completeness gap.
   *
   * Kept separate from the generated count so the distinction survives into
   * the report: one means "nothing there to find", the other means "there may
   * be something here Drift did not look at".
   */
  oversizedSourceSkipped: number;
  runtimeConfigsDiscovered: number;
  runtimeConfigsIndexed: number;
  runtimeConfigComplete: boolean;
}

/** Array-compatible so existing index/localization consumers need no adapter. */
export type WalkResult = SourceFile[] & { coverage: WalkCoverage };

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
): Promise<WalkResult> {
  const { maxFileBytes = 512 * 1024, maxFiles = 5000, extraIgnores = [], members } = options;
  const ignored = new Set([...IGNORED_DIRECTORIES, ...extraIgnores]);

  // Phase one: which files are *candidates*, in the order a depth-first walk
  // reaches them. Directory listings only — no `stat`, no `readFile` — so the
  // whole of a 14,000-file checkout costs about a sixth of a second, and
  // subdirectories are listed concurrently because listing one says nothing
  // about any other.
  //
  // The order is what makes this equivalent to the serial walk it replaces:
  // entries are taken in `readdir` order and a subdirectory is fully expanded
  // at the point it appears, so the sequence of candidates is exactly the
  // sequence the old loop visited them in. That matters because `maxFiles`
  // genuinely bites on a large repository — Deno offers 6,754 analysable files
  // against a ceiling of 5,000 — and any reordering here would silently change
  // which 1,754 are dropped.
  interface Candidate {
    full: string;
    repoPath: string;
    language: Language;
  }

  /**
   * Every candidate under `dir`, in the order a depth-first walk reaches them.
   *
   * Subdirectories are listed concurrently, but their results are spliced back
   * into the position the directory held among its siblings — so concurrency
   * changes the timing and never the sequence.
   */
  const list = async (dir: string): Promise<Candidate[]> => {
    let entries: Dirent[];
    try {
      entries = await listings.run(() => readdir(dir, { withFileTypes: true }));
    } catch {
      return []; // Unreadable directory: skip rather than fail the run.
    }

    /** A file resolves immediately; a directory resolves once it has been listed. */
    const slots: (Candidate[] | Promise<Candidate[]>)[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        // Hidden directories other than the ones we explicitly want are noise.
        // `.gitlab-ci.yml` lives at the repo root as a plain file, so it needs
        // no exception here, but `.circleci/config.yml` is nested inside a
        // hidden directory the walker must be allowed to enter.
        if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.circleci') continue;
        slots.push(list(full));
        continue;
      }

      if (!entry.isFile()) continue;

      const repoPath = toPosix(relative(root, full));
      const language: Language = isRuntimeConfigPath(repoPath) ? 'config' : languageOf(entry.name);
      if (language === 'other') continue;
      // Minified and generated bundles produce useless multi-thousand-column
      // "impact sites" that a reviewer cannot act on.
      if (/\.min\.(js|ts)$/.test(entry.name) || /\.d\.ts\.map$/.test(entry.name)) continue;

      slots.push([{ full, repoPath, language }]);
    }

    return (await Promise.all(slots)).flat();
  };

  const candidates = await list(root);
  const runtimeConfigs = candidates.filter((candidate) => candidate.language === 'config');
  const sourceCandidates = candidates.filter((candidate) => candidate.language !== 'config');

  // Phase two: read them, in candidate order, many at once.
  //
  // Only as many as are needed. A file that is too large or unreadable is
  // skipped without consuming any of the `maxFiles` budget — which is what the
  // serial walk did — so the batch is topped up from the remaining candidates
  // until either the budget is full or the candidates run out. In practice one
  // round covers it; oversized source files are rare.
  const files: SourceFile[] = [];
  let cursor = 0;
  let generatedSkipped = 0;
  let oversizedSkipped = 0;

  const readCandidates = async (take: readonly Candidate[]): Promise<void> => {
    const read = await mapWithConcurrency(take, READ_CONCURRENCY, async (candidate) => {
      try {
        const info = await stat(candidate.full);
        if (info.size > maxFileBytes) {
          // Too large to index either way — but *why* decides whether the
          // repository has been searched completely, so it is worth one small
          // read to find out. Oversized files are rare enough that this costs
          // nothing in practice.
          if (await looksGenerated(candidate.full)) generatedSkipped += 1;
          else oversizedSkipped += 1;
          return null;
        }
        return await readFile(candidate.full, 'utf8');
      } catch {
        return null;
      }
    });

    for (const [at, content] of read.entries()) {
      if (content === null) continue;
      const candidate = take[at]!;
      files.push({
        path: candidate.repoPath,
        language: candidate.language,
        content,
        lineCount: countLines(content),
        ...(members ? { member: memberOf(candidate.repoPath, members) } : {}),
      });
    }
  };

  // Authoritative configuration is completeness-critical and never spends a
  // source-localization slot.
  await readCandidates(runtimeConfigs);

  let indexedSources = 0;
  while (indexedSources < maxFiles && cursor < sourceCandidates.length) {
    const before = files.length;
    const take = sourceCandidates.slice(cursor, cursor + (maxFiles - indexedSources));
    cursor += take.length;
    await readCandidates(take);
    indexedSources += files.length - before;
  }

  const sorted = files.sort((a, b) => a.path.localeCompare(b.path)) as WalkResult;
  // Build output is not a gap: it was never source anyone could act on, so
  // excluding it is what makes "complete" mean "every file that could hold an
  // actionable reference was read" rather than "every path on disk".
  const localizationComplete = indexedSources + generatedSkipped === sourceCandidates.length;
  const runtimeConfigsIndexed = files.filter((file) => file.language === 'config').length;
  const coverage: WalkCoverage = {
    localizationRan: true,
    localizationComplete,
    sourceFilesDiscovered: sourceCandidates.length,
    sourceFilesIndexed: indexedSources,
    sourceTruncated: !localizationComplete,
    generatedFilesSkipped: generatedSkipped,
    oversizedSourceSkipped: oversizedSkipped,
    runtimeConfigsDiscovered: runtimeConfigs.length,
    runtimeConfigsIndexed,
    runtimeConfigComplete: runtimeConfigs.length === runtimeConfigsIndexed,
  };
  Object.defineProperty(sorted, 'coverage', { value: coverage, enumerable: false });
  return sorted;
}

/**
 * A bound on how many of something may be in flight, with everything else
 * queued in arrival order.
 *
 * The directory walk is recursive and fans out at every level, so without this
 * a large checkout would have every directory in the tree listed at once —
 * tens of thousands of open descriptors on a repository like Kubernetes, and
 * `EMFILE` well before that. Queuing does not change the *order* anything is
 * returned in, only how many are open together.
 */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** Directory listings open at once. Well inside every default descriptor limit. */
const listings = new Semaphore(64);

/**
 * Files read at once.
 *
 * `readFile` runs on libuv's thread pool, which defaults to four threads and is
 * shared with DNS resolution — so a walk that saturates it stalls the registry
 * lookups running alongside it. Sixteen keeps the pool busy through the
 * latency of each read without queueing so deeply that a name lookup waits
 * behind a thousand files.
 */
const READ_CONCURRENCY = 16;

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function countLines(content: string): number {
  let count = 1;
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') count += 1;
  return count;
}
