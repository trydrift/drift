import * as vscode from 'vscode';
import { analyzeRepository } from '../../src/analysis.js';
import { DriftConfigSchema, type DriftConfig } from '../../src/config/schema.js';
import { parseConfig } from '../../src/config/load.js';
import {
  LocalGitProvider,
  WORKING_TREE,
  inspectLocalRepo,
  lastCommitTouching,
} from '../../src/repo/local-git.js';
import { isManifestPath, PARSERS } from '../../src/detect/index.js';
import { createLogger } from '../../src/util/logger.js';
import type { RemediationPlan } from '../../src/types.js';
import { getRateLimitToken } from './github-auth.js';
import type { DriftState } from './state.js';

/**
 * Running an analysis from the editor.
 *
 * The interesting problem here is choosing *what to compare*. In CI the range
 * is handed to you by the push event. In an editor there is no such signal —
 * the user opened a folder, and Drift has to work out for itself which change
 * is worth looking at.
 *
 * Uncommitted manifest edits are the most likely thing the user cares about
 * (they just ran `npm install`), so those win. Otherwise Drift finds the most
 * recent commit that touched a manifest, which is almost always the dependency
 * bump they want to know about — and is far more useful than blindly diffing
 * `HEAD^..HEAD`, which is usually unrelated work.
 */

export interface AnalyzeOptions {
  state: DriftState;
  /** Explicit range, when the user picked one. */
  range?: { before: string; after: string };
  /** Surfaces progress; supplied by the withProgress wrapper. */
  progress?: vscode.Progress<{ message?: string }>;
  token?: vscode.CancellationToken;
}

export interface AnalyzeResult {
  plan: RemediationPlan | null;
  summary: string;
}

/** Every manifest filename Drift knows how to parse, for git pathspecs. */
const MANIFEST_GLOBS = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'requirements*.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'Gemfile.lock',
];

export async function runAnalysis(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { state, progress, token } = options;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    state.set({ kind: 'no-repo' });
    return { plan: null, summary: 'No folder is open.' };
  }

  const root = folder.uri.fsPath;
  const info = await inspectLocalRepo(root);

  if (!info) {
    state.setRepo(null, root);
    state.set({ kind: 'no-repo' });
    return { plan: null, summary: 'This folder is not a git repository.' };
  }

  state.setRepo(info, root);

  const range = options.range ?? (await chooseRange(root, info));
  if (!range) {
    state.set({ kind: 'clean', summary: 'No dependency changes found to analyse.', at: Date.now() });
    return { plan: null, summary: 'No dependency changes found to analyse.' };
  }

  const config = await loadWorkspaceConfig(root);
  const logger = createLogger(
    vscode.workspace.getConfiguration('drift').get<'debug' | 'info' | 'warn' | 'error'>(
      'logLevel',
      'info',
    ),
  );

  state.set({ kind: 'analysing', detail: 'Reading dependency changes' });

  try {
    const result = await analyzeRepository({
      repo: {
        owner: info.slug?.split('/')[0] ?? 'local',
        repo: info.slug?.split('/')[1] ?? 'workspace',
        baseBranch: info.branch,
        beforeSha: range.before,
        afterSha: range.after,
        workspace: root,
      },
      config,
      logger,
      provider: new LocalGitProvider(root, range),
      workspace: root,
      // Signed out is fine — this only raises the public rate limit.
      githubToken: await getRateLimitToken(),
      onProgress: (_stage, detail) => {
        if (token?.isCancellationRequested) return;
        progress?.report({ message: detail });
        state.set({ kind: 'analysing', detail });
      },
    });

    if (token?.isCancellationRequested) {
      state.set({ kind: 'idle' });
      return { plan: null, summary: 'Cancelled.' };
    }

    if (!result.plan || result.plan.breakingChanges.length === 0) {
      state.set({ kind: 'clean', summary: result.summary, plan: result.plan ?? undefined, at: Date.now() });
      return result;
    }

    state.set({ kind: 'findings', plan: result.plan, at: Date.now() });
    return result;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    state.set({ kind: 'error', message });
    return { plan: null, summary: message };
  }
}

/**
 * Work out which commit range to analyse.
 *
 * Order of preference, most-likely-to-be-what-you-meant first:
 *   1. Uncommitted manifest edits — you just changed a dependency.
 *   2. The last commit that touched a manifest — the bump you merged.
 *   3. Nothing. Better to say so than to analyse an unrelated diff.
 */
async function chooseRange(
  root: string,
  info: { headSha: string; parentSha: string | null },
): Promise<{ before: string; after: string } | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run('git', args, { cwd: root, windowsHide: true });
      return stdout;
    } catch {
      return null;
    }
  };

  // 1 — uncommitted manifest changes, staged or not.
  const dirty = await git(['status', '--porcelain']);
  if (dirty) {
    const dirtyManifests = dirty
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter((p) => p && isManifestPath(p));

    if (dirtyManifests.length > 0) {
      // The most common editor case by far: the user just ran `npm install`
      // and has not committed. Compare HEAD to what is on disk right now.
      return { before: info.headSha, after: WORKING_TREE };
    }
  }

  // 2 — the most recent commit that moved a manifest.
  const recent = await lastCommitTouching(root, MANIFEST_GLOBS);
  if (recent) return { before: recent.parent, after: recent.sha };

  // 3 — fall back to HEAD^..HEAD only if it actually touched a manifest.
  if (info.parentSha) {
    const changed = await git(['diff', '--name-only', info.parentSha, info.headSha]);
    if (changed?.split('\n').some((p) => p.trim() && isManifestPath(p.trim()))) {
      return { before: info.parentSha, after: info.headSha };
    }
  }

  return null;
}

export async function loadWorkspaceConfig(root: string): Promise<DriftConfig> {
  const candidates = ['.github/drift.yml', '.github/drift.yaml', 'drift.yml', 'drift.yaml'];

  for (const relative of candidates) {
    try {
      const uri = vscode.Uri.file(`${root}/${relative}`);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const { config, problems } = parseConfig(Buffer.from(bytes).toString('utf8'), relative);
      if (problems.length > 0) {
        void vscode.window.showWarningMessage(
          `Drift: ${relative} has problems and defaults were used. ${problems[0]}`,
        );
      }
      return mergeSettings(config);
    } catch {
      // Not present; try the next candidate.
    }
  }

  return mergeSettings(DriftConfigSchema.parse({}));
}

/**
 * Layer VS Code settings over the committed config.
 *
 * The file is the team's shared policy; settings are the individual's local
 * preference. Letting settings win means one developer can widen what they see
 * locally without changing what the repository enforces for everyone.
 */
function mergeSettings(base: DriftConfig): DriftConfig {
  const settings = vscode.workspace.getConfiguration('drift');

  const triggerOn = {
    ...base.triggerOn,
    ...(settings.get<boolean>('analysis.includePatch') !== undefined
      ? { patch: settings.get<boolean>('analysis.includePatch', base.triggerOn.patch) }
      : {}),
    ...(settings.get<boolean>('analysis.includeDev') !== undefined
      ? { dev: settings.get<boolean>('analysis.includeDev', base.triggerOn.dev) }
      : {}),
    ...(settings.get<boolean>('analysis.includeTransitive') !== undefined
      ? {
          transitive: settings.get<boolean>('analysis.includeTransitive', base.triggerOn.transitive),
        }
      : {}),
  };

  const ignore = settings.get<string[]>('analysis.ignore', []);

  return {
    ...base,
    triggerOn,
    ignore: ignore.length > 0 ? [...base.ignore, ...ignore] : base.ignore,
    remediation: {
      ...base.remediation,
      customInstructions:
        settings.get<string>('fix.customInstructions', '') || base.remediation.customInstructions,
    },
  };
}

export { PARSERS };
