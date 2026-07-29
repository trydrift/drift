import * as vscode from 'vscode';
import { runAnalysis } from './analyze.js';
import { runFix } from './fix.js';
import { DriftState } from './state.js';
import { DriftTreeProvider } from './ui/tree.js';
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
  context.subscriptions.push(state);

  const diagnostics = new DriftDiagnostics(state);
  const statusBar = new DriftStatusBar(state);
  const tree = new DriftTreeProvider(state);

  context.subscriptions.push(diagnostics, statusBar);

  context.subscriptions.push(
    vscode.window.createTreeView('drift.changes', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new DriftCodeActionProvider(state, diagnostics),
      { providedCodeActionKinds: DriftCodeActionProvider.providedCodeActionKinds },
    ),
  );

  registerCommands(context, state);

  // Sign-in state changes what the agent picker can offer.
  context.subscriptions.push(onDidChangeGitHubAuth(() => invalidateAgentCache()));

  await initialise(state);
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}

/**
 * First run.
 *
 * Analyses automatically when the setting allows, because the most valuable
 * moment for this tool is the one where you did not know to ask. It stays
 * silent when there is nothing to report — an unprompted analysis that finds
 * nothing should be invisible.
 */
async function initialise(state: DriftState): Promise<void> {
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

  if (result.plan && result.plan.breakingChanges.length > 0) {
    const count = result.plan.breakingChanges.length;
    const choice = await vscode.window.showWarningMessage(
      `Drift found ${count} breaking change${count === 1 ? '' : 's'} from a dependency update.`,
      'Show report',
      'Fix them',
    );
    if (choice === 'Show report') DriftReportPanel.show(state);
    if (choice === 'Fix them') await vscode.commands.executeCommand('drift.fixAll');
  }
}

function registerCommands(context: vscode.ExtensionContext, state: DriftState): void {
  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

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

  register('drift.fixAll', () => startFix(state, undefined));
  register('drift.fixCommit', ((order: number) => startFix(state, order)) as never);

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

async function startFix(state: DriftState, onlyCommit: number | undefined): Promise<void> {
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
    (progress, token) => runFix({ state, plan, onlyCommit, progress, token }),
  );

  output.info(result.message);
  for (const warning of result.warnings) output.warn(warning);

  switch (result.status) {
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
 * Shows everything Drift knows how to drive, available or not, each with a
 * one-line reason and how to enable it. Hiding unavailable agents would leave
 * someone wondering why the tool they use isn't listed.
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

  const items: (vscode.QuickPickItem & { id: string })[] = [
    {
      id: 'auto',
      label: '$(sparkle) Automatic',
      description: current === 'auto' ? 'current' : undefined,
      detail: 'Use the best agent available right now.',
    },
    ...discovered.map((d) => ({
      id: d.agent.id,
      label: `${d.availability.available ? '$(check)' : '$(circle-slash)'} ${d.agent.label}`,
      description: [
        d.agent.id === current ? 'current' : '',
        d.availability.detail ?? '',
      ]
        .filter(Boolean)
        .join(' · '),
      detail: d.availability.available
        ? d.agent.description
        : `Unavailable — ${d.availability.reason}`,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Drift: which AI agent should fix your code?',
    placeHolder: 'Drift drives an agent you already have. It never asks for an API key.',
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
