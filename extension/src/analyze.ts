import * as vscode from 'vscode';
import { analyzeRepository, type AnalysisOptions } from '../../src/analysis.js';
import { DriftConfigSchema, type DriftConfig } from '../../src/config/schema.js';
import { parseConfig } from '../../src/config/load.js';
import { LocalGitProvider, chooseManifestRange, inspectLocalRepo } from '../../src/repo/local-git.js';
import { PARSERS } from '../../src/detect/index.js';
import { createLogger } from '../../src/util/logger.js';
import type { RemediationPlan } from '../../src/types.js';
import { getRateLimitToken } from './github-auth.js';
import type { DriftState } from './state.js';
import { envWithShellPath } from './shell-path.js';

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
  /**
   * What produced this result — present only when analysis actually ran (not
   * on the early "no folder"/"not a git repo" exits). Lets a caller run Deep
   * Verification afterwards with `deepVerify` from `src/analysis.js` without
   * re-deriving the commit range, the config, or the provider: the exact
   * options `analyzeRepository` used, so continuing costs nothing beyond the
   * verification itself.
   */
  context?: AnalysisOptions;
}

export async function runAnalysis(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { state, progress, token } = options;

  // The active root, when Drift already knows about one — the common case
  // after activation. Falling back to the first open folder covers the one
  // caller (extension activation itself) that runs before `state.roots` is
  // populated.
  const root = state.activeRoot?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    state.set({ kind: 'no-repo' });
    return { plan: null, summary: 'No folder is open.' };
  }

  const info = await inspectLocalRepo(root);

  if (!info) {
    state.setRepo(null, root);
    state.set({ kind: 'no-repo' });
    return { plan: null, summary: 'This folder is not a git repository.' };
  }

  state.setRepo(info, root);

  const range = options.range ?? (await chooseManifestRange(root, info));
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

  const analysisOptions: AnalysisOptions = {
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
    env: await envWithShellPath(),
    // Signed out is fine — this only raises the public rate limit.
    githubToken: await getRateLimitToken(),
  };

  try {
    const result = await analyzeRepository({
      ...analysisOptions,
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
      return { ...result, context: analysisOptions };
    }

    state.set({ kind: 'findings', plan: result.plan, at: Date.now() });
    return { ...result, context: analysisOptions };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    state.set({ kind: 'error', message });
    return { plan: null, summary: message };
  }
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

  // `.get()` always returns a value — the package.json default when the
  // developer never touched the setting — so it cannot tell "explicitly set
  // to false" apart from "unset". `.inspect()` reports only what was actually
  // configured, which is what "settings win" requires: an untouched setting
  // must leave the committed config's own value alone.
  const triggerOn = {
    ...base.triggerOn,
    ...(explicitlySet(settings, 'analysis.includePatch')
      ? { patch: settings.get<boolean>('analysis.includePatch', base.triggerOn.patch) }
      : {}),
    ...(explicitlySet(settings, 'analysis.includeDev')
      ? { dev: settings.get<boolean>('analysis.includeDev', base.triggerOn.dev) }
      : {}),
    ...(explicitlySet(settings, 'analysis.includeTransitive')
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
    tools: {
      ...base.tools,
      ...(explicitlySet(settings, 'tools.autoInstall')
        ? { autoInstall: settings.get<boolean>('tools.autoInstall', base.tools.autoInstall) }
        : {}),
    },
  };
}

/** Whether a developer or workspace actually set this key, as opposed to it resolving to its declared default. */
function explicitlySet(settings: vscode.WorkspaceConfiguration, key: string): boolean {
  const info = settings.inspect<boolean>(key);
  return (
    info?.globalValue !== undefined ||
    info?.workspaceValue !== undefined ||
    info?.workspaceFolderValue !== undefined
  );
}

/** What a scan actually does, once `resolveScanChoices` has settled both questions. */
export interface ScanChoices {
  /** `true` — Deep Verification: install each candidate and run this project's own checks. */
  deep: boolean;
  /** `true` — also analyse dev, optional, and peer dependencies. */
  includeDev: boolean;
}

/**
 * Settle "Quick Scan or Deep Verification?" and "runtime only or +dev?" for
 * one scan, asking the developer at most once.
 *
 * Both questions are independent settings (`drift.analysis.verifyMode`,
 * `drift.analysis.dependencyScope`), each of which can itself be `'ask'` —
 * the default for a new install. Two separate prompts every time a scan
 * starts would be exactly the kind of friction that gets a feature turned
 * off, so when both still need asking they are asked together, in one
 * QuickPick with four combined choices, rather than as two interruptions in
 * a row. `undefined` means the developer dismissed the prompt — the caller's
 * job is to abort that scan rather than guess.
 *
 * `drift.analysis.includeDev` (boolean, pre-existing) is honoured only when
 * `drift.analysis.dependencyScope` was never explicitly set — the moment a
 * developer sets the new setting, the old one stops being read for this
 * decision, so there is exactly one place "ask" can come from and no
 * ambiguity about which setting won.
 */
/**
 * `drift.analysis.dependencyScope`, resolved against the same fallback chain
 * `resolveScanChoices` uses for its prompt — but never itself a source of
 * `'ask'`: this reads only what settings/config already say, explicitly
 * doing no I/O and asking no question, so it is safe to call from a quiet,
 * on-activation scan that must never block on a dialog. `'ask'` is treated
 * exactly like "unset" here (there is nobody to ask), which is what makes
 * this correct for a background scan rather than merely convenient.
 */
function scopeSetting(config: DriftConfig): 'runtime' | 'runtime+dev' | 'ask' {
  const settings = vscode.workspace.getConfiguration('drift');
  return explicitlySet(settings, 'analysis.dependencyScope')
    ? settings.get<'runtime' | 'runtime+dev' | 'ask'>('analysis.dependencyScope', 'ask')
    : explicitlySet(settings, 'analysis.includeDev')
      ? (settings.get<boolean>('analysis.includeDev', config.triggerOn.dev) ? 'runtime+dev' : 'runtime')
      : 'ask';
}

/**
 * Whether a scan should look at dev/optional/peer dependencies, resolved
 * without ever prompting — for a quiet, on-activation scan
 * (`scanOnStartup`), where `resolveScanChoices`'s interactive prompt would be
 * an interruption nobody asked for. Takes `config` per call, not once for the
 * whole run, because a multi-root workspace's members can each carry their
 * own `drift.yml` and therefore their own `triggerOn.dev` fallback.
 */
export function resolveDependencyScope(config: DriftConfig): boolean {
  const scope = scopeSetting(config);
  if (scope === 'runtime') return false;
  if (scope === 'runtime+dev') return true;
  return config.triggerOn.dev;
}

export async function resolveScanChoices(config: DriftConfig): Promise<ScanChoices | undefined> {
  const settings = vscode.workspace.getConfiguration('drift');

  const verifyMode = settings.get<'quick' | 'deep' | 'ask'>('analysis.verifyMode', 'ask');
  const dependencyScope = scopeSetting(config);

  const askDeep = verifyMode === 'ask';
  const askDev = dependencyScope === 'ask';

  if (!askDeep && !askDev) {
    return { deep: verifyMode === 'deep', includeDev: dependencyScope === 'runtime+dev' };
  }

  if (askDeep && askDev) {
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & ScanChoices>(
      [
        { label: 'Quick Scan, dev dependencies included', deep: false, includeDev: true, detail: 'Static analysis only. Fastest.' },
        { label: 'Quick Scan, production dependencies only', deep: false, includeDev: false, detail: 'Static analysis only. Fastest.' },
        {
          label: 'Deep Verification, dev dependencies included',
          deep: true,
          includeDev: true,
          detail: 'Also installs the upgrade and runs project checks. Much slower.',
        },
        {
          label: 'Deep Verification, production dependencies only',
          deep: true,
          includeDev: false,
          detail: 'Also installs the upgrade and runs project checks. Much slower.',
        },
      ],
      { title: 'Drift: how should this scan run?', ignoreFocusOut: true },
    );
    return picked ? { deep: picked.deep, includeDev: picked.includeDev } : undefined;
  }

  if (askDeep) {
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { deep: boolean }>(
      [
        { label: 'Quick Scan', deep: false, detail: 'Static analysis only. Fastest.' },
        { label: 'Deep Verification', deep: true, detail: 'Also installs the upgrade and runs project checks. Much slower.' },
      ],
      { title: 'Drift: how should this scan run?', ignoreFocusOut: true },
    );
    return picked ? { deep: picked.deep, includeDev: dependencyScope === 'runtime+dev' } : undefined;
  }

  const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { includeDev: boolean }>(
    [
      { label: 'Runtime + dev dependencies', includeDev: true, detail: 'More complete, but can take longer.' },
      { label: 'Runtime dependencies only', includeDev: false, detail: 'Faster.' },
    ],
    { title: 'Drift: which dependencies should this scan look at?', ignoreFocusOut: true },
  );
  return picked ? { deep: verifyMode === 'deep', includeDev: picked.includeDev } : undefined;
}

export { PARSERS };
