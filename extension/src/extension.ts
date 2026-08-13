import * as vscode from 'vscode';
import { basename } from 'node:path';
import { runAnalysis } from './analyze.js';
import { runFix } from './fix.js';
import { DriftState, type RepoRoot } from './state.js';
import { DriftSession } from './session.js';
import { DriftReview } from './review/store.js';
import { DriftReviewUi } from './review/ui.js';
import { DriftHomeView } from './ui/home.js';
import { DriftCodeActionProvider, DriftDiagnostics } from './ui/diagnostics.js';
import {
  DriftDependencyTreeProvider,
  ManifestHoverProvider,
  ManifestLensProvider,
  openDependency,
} from './ui/dependencies.js';
import { DriftReportPanel } from './ui/report.js';
import { DriftStatusBar } from './ui/statusbar.js';
import { configureHttpDiskCache } from '../../src/util/http.js';
import { discoverAgents, invalidateAgentCache } from './agents/registry.js';
import { isSignedIn, onDidChangeGitHubAuth } from './github-auth.js';
import { inspectLocalRepo } from '../../src/repo/local-git.js';
import { Git } from './git.js';
import { vscodeWorkspaceFs } from './upgrades.js';
import { detectWorkspaces, memberDirectories } from '../../src/detect/workspace.js';
import type { RemediationPlan } from '../../src/types.js';
import { discoverNestedProjects } from '../../src/detect/nested.js';
import type { IssueBranchAction } from './issue-actions.js';

/**
 * Drift for VS Code.
 *
 * The design goal is that the first run requires no configuration of any kind:
 * open a repository, and Drift already knows which dependency changed, what
 * broke, and which of your AI agents can fix it. Sign-in is requested only for
 * the one path that genuinely needs an identity — GitHub's cloud agent — and
 * even then it is one click, handled by VS Code.
 */

let output: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Drift', { log: true });
  context.subscriptions.push(output);

  const state = new DriftState();
  const session = new DriftSession();
  const review = new DriftReview();
  context.subscriptions.push(state, session, review);

  const diagnostics = new DriftDiagnostics(state);
  const statusBar = new DriftStatusBar(state);
  const reviewUi = new DriftReviewUi(review);
  configureHttpDiskCache(vscode.Uri.joinPath(context.globalStorageUri, 'evidence-cache').fsPath);
  const home = new DriftHomeView(
    context.extensionUri,
    state,
    session,
    review,
    output,
    // Conversations are about a repository, so they are kept per workspace.
    context.workspaceState,
  );

  context.subscriptions.push(diagnostics, statusBar, reviewUi, home);

  const dependencies = new DriftDependencyTreeProvider(state);
  const dependencyTree = vscode.window.createTreeView('drift.dependencies', { treeDataProvider: dependencies });
  context.subscriptions.push(dependencies, dependencyTree);

  const updateBadges = () => {
    const files = state.plan ? new Set(state.plan.impactSites.map((site) => site.file)).size : 0;
    const badge = files > 0 ? { value: files, tooltip: `${files} affected file${files === 1 ? '' : 's'}` } : undefined;
    dependencyTree.badge = badge;
    home.setBadge(badge);
  };
  context.subscriptions.push(state.onDidChange(updateBadges));
  updateBadges();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('drift.changes', home, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new DriftCodeActionProvider(state, diagnostics, review),
      { providedCodeActionKinds: DriftCodeActionProvider.providedCodeActionKinds },
    ),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new ManifestLensProvider(state)),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new ManifestHoverProvider(state)),
  );

  registerCommands(context, state, diagnostics, review, reviewUi, home);

  // Sign-in state changes what the agent picker can offer.
  context.subscriptions.push(onDidChangeGitHubAuth(() => invalidateAgentCache()));

  // A folder can be added or removed from the window at any time — a repo
  // opened alongside this one, or one closed — without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      state.setRoots(await buildRepoRoots());
      if (state.roots.length === 0) state.set({ kind: 'no-repo' });
    }),
  );

  await initialise(state, home);
}

/**
 * One `RepoRoot` per open VS Code workspace folder.
 *
 * Every folder is inspected independently: its own git identity (which can
 * differ from the folder path itself, if the folder is a subdirectory of a
 * larger checkout), and its own undeclared nested projects — the same
 * discovery this repository's own layout motivated, a root manifest plus a
 * sibling subdirectory manifest with nothing but a shared checkout tying
 * them together.
 */
async function buildRepoRoots(): Promise<RepoRoot[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return Promise.all(folders.map((folder) => buildRepoRoot(folder.uri.fsPath)));
}

async function buildRepoRoot(path: string): Promise<RepoRoot> {
  const [repo, gitRoot] = await Promise.all([inspectLocalRepo(path), new Git(path).repoRoot()]);

  const fs = vscodeWorkspaceFs();
  const workspaces = await detectWorkspaces(path, fs).catch(() => []);
  const declaredMembers = memberDirectories(workspaces);
  const subprojects = await discoverNestedProjects(path, fs, declaredMembers).catch(() => []);

  return { path, label: basename(path), repo, gitRoot, subprojects };
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}

/**
 * First run.
 *
 * Analyses automatically when the setting allows, because the most valuable
 * moment for this tool is the one where you did not know to ask.
 *
 * The bar for interrupting is deliberately high: a notification appears only
 * when a breaking change actually lands on code in *this* repository. Breaking
 * changes that exist upstream but that nothing here calls are recorded in the
 * panel and nowhere else. A warning about seven breaking changes that turn out
 * to affect nothing is worse than saying nothing at all — it costs the developer
 * their attention and teaches them to dismiss the next one.
 */
async function initialise(state: DriftState, home: DriftHomeView): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    state.set({ kind: 'no-repo' });
    return;
  }

  state.setRoots(await buildRepoRoots());

  if (!state.activeRoot?.repo) {
    state.set({ kind: 'no-repo' });
    return;
  }

  state.set({ kind: 'idle' });

  if (!vscode.workspace.getConfiguration('drift').get<boolean>('analysis.runOnStartup', true)) {
    return;
  }

  const result = await runAnalysis({ state });
  const plan = result.plan;
  if (!plan || plan.impactSites.length === 0) return;

  const files = new Set(plan.impactSites.map((site) => site.file)).size;
  const choice = await vscode.window.showWarningMessage(
    `Drift: a dependency update affects ${files} file${files === 1 ? '' : 's'} in this repository.`,
    'Open Drift',
    'Show report',
  );

  if (choice === 'Open Drift') await home.reveal();
  if (choice === 'Show report') DriftReportPanel.show(state);
}

function registerCommands(
  context: vscode.ExtensionContext,
  state: DriftState,
  diagnostics: DriftDiagnostics,
  review: DriftReview,
  reviewUi: DriftReviewUi,
  home: DriftHomeView,
): void {
  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  /* Review — the same vocabulary as the CodeLenses in the editor. */
  register('drift.keepHunk', ((path: string, hunkId: string) => review.keepHunk(path, hunkId)) as never);
  register('drift.undoHunk', ((path: string, hunkId: string) => review.undoHunk(path, hunkId)) as never);
  register('drift.keepFile', ((path: string) => review.keepFile(path)) as never);
  register('drift.undoFile', ((path: string) => review.undoFile(path)) as never);
  register('drift.keepAllChanges', () => review.keepAll());
  register('drift.undoAllChanges', () => review.undoAll());
  register('drift.openChangeDiff', ((path: string) => reviewUi.openDiff(path)) as never);
  // Whatever the checks printed, verbatim. A summary is enough to decide with;
  // a failure is not something to paraphrase.
  register('drift.showCheckOutput', ((order: number) => {
    const checks = review.checksFor(order) ?? [];
    if (checks.length === 0) return;
    output.show(true);
    for (const check of checks) {
      output.info(`${check.label} — ${check.status}${check.reason ? ` (${check.reason})` : ''}`);
      if (check.output) output.info(check.output);
    }
  }) as never);
  register('drift.nextChange', () => reviewUi.revealNext());
  register('drift.reviewChanges', () => home.reveal());
  register('drift.scanDependencies', () => home.scanDependencies());
  register('drift.newSession', () => home.newSession());
  register('drift.history', () => home.showHistory());
  register('drift.clearHistory', () => home.clearHistory());

  register('drift.analyze', async () => {
    if (state.isBusy) {
      void vscode.window.showInformationMessage('Drift is already working.');
      return;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Drift: analysing dependency changes',
        cancellable: true,
      },
      (progress, token) => runAnalysis({ state, progress, token }),
    );

    output.info(result.summary);

    if (!result.plan || result.plan.breakingChanges.length === 0) {
      void vscode.window.showInformationMessage(`Drift: ${result.summary}`);
      return;
    }

    DriftReportPanel.show(state);
  });

  register('drift.fixAll', () => startFix(state, review, home, undefined));
  register('drift.fixCommit', ((order: number) => startFix(state, review, home, order)) as never);

  register('drift.showReport', () => DriftReportPanel.show(state));
  register('drift.openDependency', ((id: string) => openDependency(state, id)) as never);
  register('drift.disableEditorSignals', async () => {
    const config = vscode.workspace.getConfiguration('drift');
    await config.update('ui.showInlineDiagnostics', false, vscode.ConfigurationTarget.Workspace);
    await config.update('ui.showManifestCodeLens', false, vscode.ConfigurationTarget.Workspace);
    diagnostics.clear();
    DriftReportPanel.refresh();
    void vscode.window.showInformationMessage('Drift: editor flags hidden for this workspace.');
  });

  register('drift.explainChange', ((changeId: string) => {
    DriftReportPanel.show(state, changeId);
  }) as never);

  register('drift.selectAgent', () => selectAgent(state));

  register('drift.showLog', () => output.show());

  register('drift.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:drift.drift'),
  );

  register('drift.signInToGitHub', async () => {
    const { getGitHubSession } = await import('./github-auth.js');
    const session = await getGitHubSession({ createIfNone: true });
    invalidateAgentCache();
    void vscode.window.showInformationMessage(
      session
        ? `Drift: signed in to GitHub as ${session.account.label}.`
        : 'Drift: GitHub sign-in was cancelled.',
    );
  });

  register('drift.pushBranch', () => pushBranch(state));

  register('drift.switchRepo', () => switchRepo(state));

  // The one-click "file this" action on a breaking-change row or a
  // package's group header. `scope`/`id` name what to bundle — one finding
  // by its id, or every finding for a dependency — and `action` is omitted
  // for the button's primary click (the configured default) and supplied
  // for its dropdown's other two choices.
  register(
    'drift.fileBreakingChange',
    (async (scope: 'change' | 'package', id: string, action?: IssueBranchAction) => {
      const plan = state.plan;
      const root = state.workspaceRoot;
      if (!plan || !root) {
        void vscode.window.showWarningMessage('Drift: nothing to file — run analyze first.');
        return;
      }

      const changes = plan.breakingChanges.filter((change) =>
        scope === 'change' ? change.id === id : change.dependency === id,
      );
      if (changes.length === 0) return;

      const resolvedAction =
        action ??
        vscode.workspace.getConfiguration('drift').get<IssueBranchAction>('issueCreation.default', 'issue');

      const { runIssueBranchAction } = await import('./issue-actions.js');
      await runIssueBranchAction(root, resolvedAction, { dependency: changes[0]!.dependency, changes });
    }) as never,
  );
}

/**
 * Choose which open root every single-root command in the panel acts on.
 *
 * Only meaningful with more than one folder open — a multi-root VS Code
 * window, or two unrelated repositories opened side by side. Undeclared
 * nested projects (an undeclared sub-package, like this repository's own
 * `extension/`) don't get their own entry here: `/scan` already covers them
 * as part of their parent root, which is what "focus on a specific folder"
 * usually means in practice. A nested directory with its own `.git` is
 * different — it's a separate repository, reported after a scan rather than
 * offered here, since switching to it would need its own root to be built
 * the way a real workspace folder is.
 */
async function switchRepo(state: DriftState): Promise<void> {
  const roots = state.roots;
  if (roots.length === 0) {
    void vscode.window.showInformationMessage('Drift: no repository is open.');
    return;
  }

  const active = state.activeRoot;
  const picked = await vscode.window.showQuickPick(
    roots.map((root) => ({
      label: `${root.path === active?.path ? '$(check) ' : ''}${root.label}`,
      description: root.repo?.slug ?? undefined,
      detail: root.path,
      root,
    })),
    { placeHolder: 'Which repository should Drift work on?' },
  );

  if (picked) state.setActiveRoot(picked.root.path);
}

async function startFix(
  state: DriftState,
  review: DriftReview,
  home: DriftHomeView,
  onlyCommit: number | undefined,
): Promise<void> {
  const plan = state.plan;
  if (!plan) {
    void vscode.window.showInformationMessage('Drift: run an analysis first.');
    return;
  }

  if (state.isBusy) {
    void vscode.window.showInformationMessage('Drift is already working.');
    return;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: onlyCommit ? `Drift: fixing commit ${onlyCommit}` : 'Drift: fixing breaking changes',
      cancellable: true,
    },
    (progress, token) =>
      runFix({
        state,
        plan,
        onlyCommit,
        progress,
        token,
        review,
        permission: vscode.workspace
          .getConfiguration('drift')
          .get<'ask' | 'auto-edit' | 'full-auto'>('session.permission', 'auto-edit'),
      }),
  );

  output.info(result.message);
  for (const warning of result.warnings) output.warn(warning);

  switch (result.status) {
    case 'proposed': {
      const choice = await vscode.window.showInformationMessage(
        result.message,
        'Review changes',
        'Undo all',
      );
      if (choice === 'Review changes') await home.reveal();
      if (choice === 'Undo all') await review.undoAll();
      break;
    }

    case 'committed': {
      const actions = ['Show report', 'View diff'];
      if (await hasRemote(state)) actions.push('Push branch');

      const choice = await vscode.window.showInformationMessage(
        `Drift: ${result.commits} commit(s) on ${result.branch}.`,
        ...actions,
      );

      if (choice === 'Show report') DriftReportPanel.show(state);
      if (choice === 'View diff') {
        await vscode.commands.executeCommand('workbench.view.scm');
      }
      if (choice === 'Push branch') await pushBranch(state);
      break;
    }

    case 'delegated': {
      const choice = await vscode.window.showInformationMessage(
        result.message,
        ...(result.url ? ['Open pull request'] : []),
      );
      if (choice === 'Open pull request' && result.url) {
        await vscode.env.openExternal(vscode.Uri.parse(result.url));
      }
      break;
    }

    case 'nothing':
      void vscode.window.showInformationMessage(`Drift: ${result.message}`);
      break;

    case 'cancelled':
      void vscode.window.showInformationMessage('Drift: cancelled.');
      break;

    case 'failed': {
      // A stale plan only ever resolves one way — rescanning — so that is the
      // one thing worth offering here instead of the generic recovery pair.
      const choice =
        result.reason === 'stale-plan'
          ? await vscode.window.showErrorMessage(`Drift: ${result.message} Rescan to pick up where things stand now.`, 'Rescan')
          : await vscode.window.showErrorMessage(`Drift: ${result.message}`, 'Show log', 'Change agent');
      if (choice === 'Rescan') await vscode.commands.executeCommand('drift.scanDependencies');
      if (choice === 'Show log') output.show();
      if (choice === 'Change agent') await selectAgent(state);
      break;
    }
  }
}

/**
 * Agent picker.
 *
 * Shows agents Drift can actually use right now. The side panel still has a
 * collapsed unavailable list for setup hints; the picker is for making a
 * decision, so it stays compact.
 */
async function selectAgent(state: DriftState): Promise<void> {
  const repo = state.repo;

  const discovered = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Drift: looking for AI agents' },
    () =>
      discoverAgents(
        { slug: repo?.slug ?? null, baseBranch: repo?.branch ?? 'main' },
        { force: true },
      ),
  );

  const current = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');

  const available = discovered.filter((d) => d.availability.available);
  const unavailable = discovered.length - available.length;

  const items: (vscode.QuickPickItem & { id: string })[] = [
    {
      id: 'auto',
      label: '$(sparkle) Automatic',
      description: current === 'auto' ? 'current' : undefined,
      detail: 'Use the best agent available right now.',
    },
    ...available.map((d) => ({
      id: d.agent.id,
      label: `$(check) ${d.agent.label}`,
      description: [
        d.agent.id === current ? 'current' : '',
        d.availability.detail ?? '',
      ]
        .filter(Boolean)
        .join(' · '),
      detail: d.agent.description,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Drift: which AI agent should fix your code?',
    placeHolder: unavailable
      ? `${unavailable} unavailable agent${unavailable === 1 ? '' : 's'} hidden. Open the Drift panel to manage setup hints.`
      : 'Drift drives an agent you already have. It never asks for an API key.',
    matchOnDetail: true,
  });

  if (!picked) return;

  await vscode.workspace
    .getConfiguration('drift')
    .update('agent.preferred', picked.id, vscode.ConfigurationTarget.Global);

  invalidateAgentCache();
  void vscode.window.showInformationMessage(`Drift will use: ${picked.label.replace(/\$\([^)]*\)\s*/, '')}`);
}

/**
 * Push the reviewed branch, then raise the pull request.
 *
 * The push itself asks for nothing. Git already has whatever credential the
 * developer pushes with every day — an SSH key, a credential helper, a
 * manager the OS provides — and demanding an editor sign-in before letting
 * them use it would be inventing a dependency where there was none. Sign-in
 * is offered only if the push actually fails, which is the moment it might
 * genuinely be the answer.
 *
 * Only once the branch is on the remote does anything look at pull requests,
 * because a pull request against a ref that does not exist is not a thing
 * GitHub will make.
 */
async function pushBranch(state: DriftState): Promise<void> {
  const root = state.workspaceRoot;
  const status = state.status;

  if (!root || status.kind !== 'fixed') {
    void vscode.window.showInformationMessage('Drift: nothing to push.');
    return;
  }

  const { Git } = await import('./git.js');
  const git = new Git(root);

  const push = () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Drift: pushing ${status.branch}` },
      () => git.push(status.branch),
    );

  try {
    await push();
  } catch (err) {
    // A failed push is the first point at which signing in might actually
    // help — and it only helps if they are not signed in already, so an
    // already-signed-in developer gets the error rather than a pointless offer.
    if (await isSignedIn()) {
      void vscode.window.showErrorMessage(`Drift: push failed. ${(err as Error).message}`);
      return;
    }

    const choice = await vscode.window.showErrorMessage(
      `Drift: push failed. ${(err as Error).message}`,
      'Sign in to GitHub',
      'Cancel',
    );
    if (choice !== 'Sign in to GitHub') return;
    await vscode.commands.executeCommand('drift.signInToGitHub');

    try {
      await push();
    } catch (retryError) {
      void vscode.window.showErrorMessage(`Drift: push failed. ${(retryError as Error).message}`);
      return;
    }
  }

  await offerPullRequest(root, git, status.branch, status.plan);
}

/**
 * The pull request, made rather than merely linked to where that is possible.
 *
 * With the GitHub CLI installed and signed in, Drift opens the pull request
 * itself, with the title and body it would have used anywhere else, and hands
 * back the real URL. Without it — no `gh`, a signed-out `gh`, or a refusal
 * from GitHub — the developer gets the compare page instead, which is where
 * this always ended before and is still a fine place to end. The branch is
 * pushed in both cases, so neither outcome loses work.
 */
async function offerPullRequest(
  root: string,
  git: Git,
  branch: string,
  plan: RemediationPlan,
): Promise<void> {
  const { compareUrl, remoteSlug } = await import('./ship.js');
  const { createPullRequestWithGh } = await import('./gh.js');
  const { resolveBaseBranch, titleFor } = await import('../../src/plan/pull-request.js');
  const { renderPullRequestBody } = await import('../../src/report/markdown.js');
  const { loadWorkspaceConfig } = await import('./analyze.js');
  const { DriftConfigSchema, opensPullRequestAsDraft } = await import('../../src/config/schema.js');

  const remote = await git.remoteUrl();
  const slug = remoteSlug(remote);

  // The same policy the panel, the CLI and the Action read: an explicit editor
  // setting is the more specific statement of intent, and otherwise the
  // repository's own `.github/drift.yml` decides.
  const config = await loadWorkspaceConfig(root).catch(() => DriftConfigSchema.parse({}));
  const settings = vscode.workspace.getConfiguration('drift');
  const explicit = <T>(key: string): T | undefined => {
    const inspected = settings.inspect<T>(key);
    return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  };

  const enabled = explicit<boolean>('pullRequest.enabled') ?? config.pullRequest.enabled;
  const resolved = resolveBaseBranch({
    policy:
      explicit<'branched-from' | 'default-branch'>('pullRequest.base') ?? config.pullRequest.base,
    branchedFrom: await git.branchedFrom(branch),
    defaultBranch: await git.defaultBranch(),
    currentBranch: branch,
  });

  // Committing straight onto the branch a pull request would target leaves no
  // pull request to open. Saying so beats offering a button that returns a 422.
  if (!slug || !resolved || !enabled) {
    void vscode.window.showInformationMessage(`Drift: pushed ${branch}.`);
    return;
  }

  const base = resolved.branch;
  const fallback = compareUrl(remote, base, branch);
  const draft = explicit<boolean>('pullRequest.draft') ?? opensPullRequestAsDraft(config);

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Drift: opening a pull request' },
    () =>
      createPullRequestWithGh({
        cwd: root,
        head: branch,
        base,
        title: titleFor({ changes: plan.changes }, { title: config.pullRequest.titleTemplate }),
        // The evidence, not a generic sentence. A reviewer's first question
        // about a dependency bump is "why is this safe?", and the answer is
        // the report Drift already has in hand.
        body: renderPullRequestBody(plan, config),
        ...(draft ? { draft: true } : {}),
        ...(config.pullRequest.labels.length ? { labels: config.pullRequest.labels } : {}),
        ...(config.pullRequest.reviewers.length
          ? { reviewers: config.pullRequest.reviewers }
          : {}),
      }),
  );

  if (outcome.kind === 'opened') {
    const { pr } = outcome;
    const choice = await vscode.window.showInformationMessage(
      pr.existing
        ? `Drift: pushed ${branch}. Pull request #${pr.number} was already open — ${pr.url}`
        : `Drift: pushed ${branch} and opened #${pr.number} into ${base} — ${pr.url}`,
      'Open pull request',
    );
    if (choice === 'Open pull request') await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    return;
  }

  if (outcome.kind === 'failed') {
    output.warn(`Drift: the GitHub CLI could not open the pull request — ${outcome.message}`);
  }

  const choice = await vscode.window.showInformationMessage(
    `Drift: pushed ${branch}.`,
    ...(fallback ? ['Open a pull request'] : []),
  );
  if (choice === 'Open a pull request' && fallback) {
    await vscode.env.openExternal(vscode.Uri.parse(fallback));
  }
}

async function hasRemote(state: DriftState): Promise<boolean> {
  if (!state.workspaceRoot) return false;
  const { Git } = await import('./git.js');
  return new Git(state.workspaceRoot).hasRemote();
}
