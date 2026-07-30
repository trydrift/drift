import * as vscode from 'vscode';
import { runAnalysis } from './analyze.js';
import { runFix } from './fix.js';
import { DriftState } from './state.js';
import { DriftSession } from './session.js';
import { DriftReview } from './review/store.js';
import { DriftReviewUi } from './review/ui.js';
import { DriftHomeView } from './ui/home.js';
import { DriftCodeActionProvider, DriftDiagnostics } from './ui/diagnostics.js';
import { DriftReportPanel } from './ui/report.js';
import { DriftStatusBar } from './ui/statusbar.js';
import { discoverAgents, invalidateAgentCache } from './agents/registry.js';
import { isSignedIn, onDidChangeGitHubAuth } from './github-auth.js';
import { inspectLocalRepo } from '../../src/repo/local-git.js';

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
  const home = new DriftHomeView(context.extensionUri, state, session, review, output);

  context.subscriptions.push(diagnostics, statusBar, reviewUi, home);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('drift.changes', home, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new DriftCodeActionProvider(state, diagnostics),
      { providedCodeActionKinds: DriftCodeActionProvider.providedCodeActionKinds },
    ),
  );

  registerCommands(context, state, session, review, reviewUi, home);

  // Sign-in state changes what the agent picker can offer.
  context.subscriptions.push(onDidChangeGitHubAuth(() => invalidateAgentCache()));

  await initialise(state, home);
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
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    state.set({ kind: 'no-repo' });
    return;
  }

  const info = await inspectLocalRepo(folder.uri.fsPath);
  state.setRepo(info, folder.uri.fsPath);

  if (!info) {
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
  session: DriftSession,
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
  register('drift.nextChange', () => reviewUi.revealNext());
  register('drift.reviewChanges', () => home.reveal());
  register('drift.newSession', () => {
    session.clear();
    return home.reveal();
  });

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
      const choice = await vscode.window.showErrorMessage(
        `Drift: ${result.message}`,
        'Show log',
        'Change agent',
      );
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

async function pushBranch(state: DriftState): Promise<void> {
  const root = state.workspaceRoot;
  const status = state.status;

  if (!root || status.kind !== 'fixed') {
    void vscode.window.showInformationMessage('Drift: nothing to push.');
    return;
  }

  const signedIn = await isSignedIn();
  if (!signedIn) {
    const choice = await vscode.window.showInformationMessage(
      'Pushing needs GitHub access. Sign in with one click — no token required.',
      'Sign in',
      'Cancel',
    );
    if (choice !== 'Sign in') return;
    await vscode.commands.executeCommand('drift.signInToGitHub');
  }

  const { Git } = await import('./git.js');
  const git = new Git(root);

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Drift: pushing ${status.branch}` },
      () => git.push(status.branch),
    );
    void vscode.window.showInformationMessage(
      `Drift: pushed ${status.branch}. Open a pull request when you are ready.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Drift: push failed. ${(err as Error).message}`);
  }
}

async function hasRemote(state: DriftState): Promise<boolean> {
  if (!state.workspaceRoot) return false;
  const { Git } = await import('./git.js');
  return new Git(state.workspaceRoot).hasRemote();
}
