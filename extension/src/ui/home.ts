import * as vscode from 'vscode';
import { basename, dirname, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import semver from 'semver';
import { CLEAN_TYPECHECK_MARKER, digestDiagnostics, renderDigest } from '../diagnostics-digest.js';
import type { RemediationPlan, RepoContext } from '../../../src/types.js';
import type { IssueBranchAction, IssueBranchTarget } from '../../../src/actions/issue-branch.js';
import { buildPlan } from '../../../src/plan/index.js';
import { combineVerifications } from '../../../src/verification/apply.js';
import { resolveBaseBranch } from '../../../src/plan/pull-request.js';
import type { RevisionRequest } from '../agents/types.js';
import { renderPullRequestBody } from '../../../src/report/markdown.js';
import { inspectLocalRepo, WORKING_TREE } from '../../../src/repo/local-git.js';
import { DriftConfigSchema, opensPullRequestAsDraft, type DriftConfig } from '../../../src/config/schema.js';
import { loadWorkspaceConfig, runAnalysis, resolveScanChoices } from '../analyze.js';
import { deepVerify, type AnalysisOptions } from '../../../src/analysis.js';
import { describeVerification } from '../../../src/verification/apply.js';
import { envWithShellPath } from '../shell-path.js';
import { clearedByCompiler, runFix, type FixResult } from '../fix.js';
import type { CandidateStateChange, DriftState, RepoRoot } from '../state.js';
import type { NestedProject } from '../../../src/detect/nested.js';
import {
  DriftSession,
  type Attachment,
  type SessionBranchMode,
  type SessionCommitMode,
  type SessionEffort,
  type SessionMode,
  type SessionPermission,
  type StepHandle,
  type TaskGroup,
} from '../session.js';
import { DriftHistory, describeWhen, newConversationId } from '../history.js';
import { describeMode, describePermission, explainMode, explainPermission } from '../labels.js';
import type { DriftReview, ReviewGroup } from '../review/store.js';
import {
  discoverAgents,
  invalidateAgentCache,
  type AgentModel,
  type DiscoveredAgent,
} from '../agents/registry.js';
import { agentSupportsFastMode } from '../agents/cli.js';
import type { AttachedContext, EffortStop } from '../agents/types.js';
import { getGitHubSession, getRateLimitToken } from '../github-auth.js';
import type { PackageManagerId } from '../../../src/detect/package-manager.js';
import { describeSupportedManifests } from '../../../src/detect/capabilities.js';
import { dependencyWatcherGlob } from '../../../src/detect/manifest-globs.js';
import {
  availableChecks,
  describeOutcomes,
  runChecks,
  unrunReasons,
  type CheckOutcome,
} from '../verify.js';
import {
  ambiguityKey,
  describeSeverity,
  discoverTargets,
  scanDirectories,
  installUpgrade,
  reanalyzeUpgrade,
  scanUpgrades,
  QUICK_SCAN_MAX_SITES,
  upgradeCommandFor,
  verifyUpgradeCandidates,
  severityOf,
  type ManagerPreferences,
  type UncheckedDependency,
  type UpgradeCandidate,
} from '../upgrades.js';
import { scanTitle, compareSeverity } from '../severity.js';
import {
  compareUrl,
  dependencyFilesIn,
  dependencyPaths,
  openPullRequest,
  pullRequestBody,
  remoteSlug,
  upgradeBranchName,
  upgradeCommitMessage,
  type CommitMessage,
} from '../ship.js';
import { createPullRequestWithGh } from '../gh.js';
import { Checkpoints } from '../checkpoint.js';
import { DriftReportPanel } from './report.js';
import { openChangeDiff, openPackageVersionDiff, type ChangeDiffRequest } from '../version-diff.js';
import { OperationGate } from './scan-start.js';
import { runRepoDiagnostic } from '../run-diagnostics.js';
import { countWork, startSpan } from '../../../src/util/diagnostics.js';
import { clearHttpCache } from '../../../src/util/http.js';
import { chunkDetail, takeCandidateSummaryBatch } from './update-protocol.js';
import {
  makeNonce,
  renderBody,
  renderCandidateBody,
  renderCandidateSection,
  renderCandidateSummary,
  renderPanel,
  SLASH_COMMANDS,
  type AgentChoice,
  type MenuItem,
  type MenuSection,
  type StaleHint,
  type ViewModel,
} from './webview.js';

/**
 * The Drift panel.
 *
 * One conversation, one composer, one place where work happens. Every command
 * the developer can run is reachable by typing it, and every result — a scan, a
 * question, a set of proposed edits — lands in the thread underneath the message
 * that caused it. Nothing acts at a distance.
 *
 * The controller is deliberately thin: it turns messages from the webview into
 * calls on the same modules the command palette uses, and turns their progress
 * into thread items. Rendering is a pure function of state, and the state lives
 * in `DriftSession`, `DriftReview`, and `DriftState`.
 */

type Incoming =
  | { type: 'ready' }
  | { type: 'uiAck'; sequence: number }
  | { type: 'candidateDetailRequest'; id: string; requestId: string; section?: string }
  | { type: 'detailChunkAck'; requestId: string; index: number }
  | { type: 'submit'; text: string }
  | { type: 'draft'; text: string }
  | { type: 'answer'; id: string; value: string }
  | { type: 'menu'; id: string }
  | { type: 'history'; id: string }
  | { type: 'detach'; value: string }
  | { type: 'rewind'; id: string }
  | { type: 'rescan' }
  | { type: 'upgradeAll' }
  | { type: 'stop' }
  | { type: 'signIn' }
  | { type: 'showReport' }
  | { type: 'openFile'; file: string; line: number }
  | { type: 'openUrl'; url: string }
  | { type: 'openDiff'; path: string }
  | { type: 'openVersionDiff'; id: string }
  /** One finding's before/after, as JSON — see `renderDiffButton` in `webview.ts`. */
  | { type: 'openFindingDiff'; value: string }
  | { type: 'pickVersion'; id: string }
  | { type: 'selectVersion'; id: string; version: string }
  | { type: 'recheck'; id: string }
  /** Deep Verification for one package's row — see `verifyOne`. */
  | { type: 'verifyOne'; id: string }
  /** Deep Verification for every eligible row on screen — see `verifyAll`. */
  | { type: 'verifyAll' }
  | { type: 'installTool'; id: string; value: string }
  | { type: 'upgrade'; id: string; mode: 'safe' | 'force' }
  | { type: 'fixPackage'; id: string }
  | { type: 'fixAll' }
  | { type: 'fileIssuePackage'; id: string }
  | { type: 'fileIssueAll' }
  | { type: 'fileIssueSafe' }
  | { type: 'keepFile' | 'undoFile'; path: string }
  | { type: 'keepGroup' | 'undoGroup' | 'retryCommit'; order: number }
  | { type: 'keepAll' | 'undoAll' };

/**
 * Runs a one-off helper install (`cargo install cargo-public-api`, and the
 * like) to completion.
 *
 * `promisify(execFile)` was used here before, but it leaves stdin as an open,
 * unattended pipe: a tool that stops to ask something interactive (a package
 * manager's "already installed, overwrite?") blocks on it forever instead of
 * failing fast, since there is never a human at the other end of this pipe to
 * answer — which read as the installer hanging with no feedback. Closing
 * stdin immediately makes that fail fast instead.
 */
function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...args], { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

/**
 * Directories the context picker never offers.
 *
 * These hold thousands of files that nobody attaches on purpose, and leaving
 * them in makes the filter box useless — the point of the picker is that typing
 * three characters finds the file you meant.
 */
/** Workspace memento key for "which package manager owns this ecosystem". */
const MANAGER_KEY = 'drift.packageManagers';

const EXCLUDED_FROM_CONTEXT = '**/{node_modules,.git,dist,out,build,coverage,.next,.turbo,.venv,__pycache__}/**';

interface WorkspaceContext {
  root: string;
  info: Awaited<ReturnType<typeof inspectLocalRepo>>;
  repo: RepoContext;
  config: DriftConfig;
}

/**
 * One place the panel is drawn.
 *
 * There is one — the sidebar view — but it is resolved again every time the view
 * is closed and reopened, so the list is what keeps updates going to the live
 * webview rather than a dead one.
 */
interface Surface {
  webview: vscode.Webview;
  /** Set once the document's script has announced itself. */
  ready: boolean;
  nextSequence: number;
  awaitingSequence: number | null;
  pendingBody: string | null;
  pendingCandidates: Map<string, string>;
  detailTransfer: {
    id: string;
    requestId: string;
    section?: string;
    chunks: string[];
    next: number;
    awaitingIndex: number | null;
    retries: number;
  } | null;
  pendingDetailRequests: { id: string; requestId: string; section?: string }[];
  detailAckTimer: ReturnType<typeof setTimeout> | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  resyncAttempted: boolean;
  postFailures: number;
  stalled: boolean;
}

export class DriftHomeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private badge: vscode.ViewBadge | undefined;
  private surfaces: Surface[] = [];
  private candidates = new Map<string, UpgradeCandidate>();
  private candidatePresentation = new Map<string, string>();
  private agents: DiscoveredAgent[] = [];
  /** Models each subscription is currently offering, keyed by agent id. */
  private models = new Map<string, AgentModel[]>();
  private signedInLabel: string | null = null;
  private running: vscode.CancellationTokenSource | null = null;
  private cancellable = true;
  private stopping = false;
  private draft = '';
  private draftToken = 0;
  private scanned = false;
  private readonly operationGate = new OperationGate();
  private operationGateOwnerEnteringRun = false;
  /**
   * What the last successful upgrade installed.
   *
   * Kept so `/commit`, `/push` and `/pr` can describe the work in the same terms
   * the upgrade did — the same packages, the same evidence — instead of falling
   * back to "some dependency files changed" once the offer scrolls out of view.
   */
  private lastUpgraded: UpgradeCandidate[] = [];
  /**
   * What produced the current `findings`/`clean` plan from `/recent` —
   * carried so `/verify` can run Deep Verification straight from it via
   * `deepVerify`, without re-detecting the commit range or re-running any of
   * the analysis that already found it. Cleared on every fresh `/recent`.
   */
  private lastAnalysisContext: AnalysisOptions | null = null;
  /**
   * One `Checkpoints` per root, not one for the panel.
   *
   * A `tree` sha is only meaningful relative to the repository it came from —
   * restoring root A's checkpoint through root B's `Git` instance would
   * silently corrupt the wrong working tree. Keying by root path is what
   * keeps a rewind honest when more than one repository is open.
   */
  private checkpointsByRoot = new Map<string, Checkpoints>();
  private stale: StaleHint | null = null;
  private staleFiles = new Set<string>();
  private readonly history: DriftHistory;
  private conversationId = newConversationId();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly disposables: vscode.Disposable[] = [];

  /**
   * How many times each plan has been sent back to the agent.
   *
   * Counted per plan rather than globally so the number in "attempt 3" means
   * what a developer thinks it means — three tries at *this* upgrade, not three
   * tries at anything today.
   */
  private readonly revisionAttempts = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: DriftState,
    private readonly session: DriftSession,
    private readonly review: DriftReview,
    private readonly output: vscode.LogOutputChannel,
    private readonly memento: vscode.Memento,
  ) {
    this.history = new DriftHistory(memento);

    this.disposables.push(
      state.onDidChange(() => this.render()),
      state.onDidChangeCandidates((change) => this.candidatesChanged(change)),
      session.onDidChange(() => {
        this.render();
        this.autosave();
      }),
      review.onDidChange(() => this.render()),
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id === 'github') void this.refreshIdentity();
      }),
    );

    // A result list describes the repository at the moment it was produced. The
    // moment a manifest or a source file moves, it is describing something that
    // no longer exists — so the panel says which files changed and offers the
    // one action that makes it true again, rather than quietly going stale.
    // Built from Drift's own manifest registry, not typed out here. The
    // hand-written version covered nine ecosystems out of sixteen, so a
    // Composer or NuGet or Swift repository never learned its results had gone
    // stale — the panel just kept showing an answer about a tree that had moved.
    const manifests = vscode.workspace.createFileSystemWatcher(dependencyWatcherGlob());
    this.disposables.push(
      manifests,
      manifests.onDidChange((uri) => this.markStale(uri, 'dependencies')),
      manifests.onDidCreate((uri) => this.markStale(uri, 'dependencies')),
      vscode.workspace.onDidSaveTextDocument((document) => this.markStale(document.uri, 'code')),
      // The context picker's path list is only worth caching while it is true.
      vscode.workspace.onDidCreateFiles(() => (this.paths = null)),
      vscode.workspace.onDidDeleteFiles(() => (this.paths = null)),
      vscode.workspace.onDidRenameFiles(() => (this.paths = null)),
    );

    // Keeping a whole group is the developer saying "this is right" — which is
    // exactly when the commit the planner described should exist. Notice the
    // failure here, where the group and the git error are both in scope, then
    // rethrow so the store can keep the group around for `retryCommit` instead
    // of treating a real failure the same as "nothing to commit".
    review.setCommitHandler(async (group) => {
      try {
        return await this.commitGroup(group);
      } catch (err) {
        this.session.notice(
          'error',
          `Commit failed for "${group.title}": ${(err as Error).message}. Your changes are still here — retry from the review panel.`,
        );
        throw err;
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // The sidebar view is resolved again whenever it is closed and reopened, and
    // the old webview is dead by then — keeping it in the list would mean
    // posting every update at something that will never draw it.
    this.surfaces = this.surfaces.filter((surface) => surface.webview !== this.view?.webview);

    this.view = view;
    view.badge = this.badge;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    this.disposables.push(view.onDidDispose(() => this.detach(view.webview)));
    this.attach(view.webview);

    void this.refreshIdentity();
    void this.refreshAgents();
    this.paint();

    // Warmed now so the context picker has its list in hand the first time it
    // is opened, rather than making the developer wait for a project walk.
    const root = this.state.activeRoot?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) void this.projectPaths(root).catch(() => []);

    // Opening the panel is a request to know the state of your dependencies, so
    // the first scan starts itself. Every step of it is named in the thread as it
    // happens, which is the difference between a tool that looks busy and one
    // that looks stuck.
    if (vscode.workspace.getConfiguration('drift').get<boolean>('analysis.runOnStartup', true)) {
      void this.scanOnStartup();
    }
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const d of this.disposables) d.dispose();
  }

  setBadge(badge: vscode.ViewBadge | undefined): void {
    this.badge = badge;
    if (this.view) this.view.badge = badge;
  }

  async scanDependencies(): Promise<void> {
    await this.reveal();
    await this.scan();
  }

  /** Bring the panel forward, e.g. from a notification action. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('drift.changes.focus');
    this.view?.show?.(true);
  }

  /* ---------------------------------------------------------------- */
  /* Surfaces                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Start talking to a webview.
   *
   * The document is written exactly once per surface. Everything after that is a
   * `render` message carrying the new body, which the webview swaps into place —
   * the script, its listeners and the developer's half-typed message all survive.
   * Reassigning `webview.html` on every update, which is what this replaced, tore
   * the document down and rebuilt it each time; on a panel holding a finished
   * scan that is hundreds of milliseconds per click, and it is why every button
   * in the panel felt like it was thinking about it.
   */
  private attach(webview: vscode.Webview): void {
    const surface: Surface = {
      webview,
      ready: false,
      nextSequence: 0,
      awaitingSequence: null,
      pendingBody: null,
      pendingCandidates: new Map(),
      detailTransfer: null,
      pendingDetailRequests: [],
      detailAckTimer: null,
      ackTimer: null,
      resyncAttempted: false,
      postFailures: 0,
      stalled: false,
    };
    this.surfaces.push(surface);

    this.disposables.push(
      webview.onDidReceiveMessage((message: Incoming) => {
        if (message.type === 'ready') {
          this.cancelDetailTransfer(surface);
          surface.ready = true;
          if (surface.ackTimer) clearTimeout(surface.ackTimer);
          surface.ackTimer = null;
          surface.awaitingSequence = null;
          surface.pendingBody = null;
          surface.pendingCandidates.clear();
          surface.stalled = false;
          surface.resyncAttempted = false;
          surface.postFailures = 0;
          this.sendBody(surface, renderBody(this.viewModel()));
          return;
        }
        if (message.type === 'uiAck') {
          if (surface.awaitingSequence !== message.sequence) return;
          if (surface.ackTimer) clearTimeout(surface.ackTimer);
          surface.ackTimer = null;
          surface.resyncAttempted = false;
          surface.postFailures = 0;
          surface.awaitingSequence = null;
          const pending = surface.pendingBody;
          surface.pendingBody = null;
          if (pending !== null) this.sendBody(surface, pending);
          else if (surface.pendingCandidates.size > 0) this.sendCandidateBatch(surface);
          return;
        }
        if (message.type === 'candidateDetailRequest') {
          this.queueDetailRequest(surface, message);
          return;
        }
        if (message.type === 'detailChunkAck') {
          const transfer = surface.detailTransfer;
          if (!transfer || transfer.requestId !== message.requestId || transfer.awaitingIndex !== message.index) return;
          if (surface.detailAckTimer) clearTimeout(surface.detailAckTimer);
          surface.detailAckTimer = null;
          transfer.awaitingIndex = null;
          transfer.next = message.index + 1;
          transfer.retries = 0;
          this.sendDetailChunk(surface);
          return;
        }
        void this.handle(message);
      }),
    );

    const highlightClientUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'highlight-client.js'),
    );
    const highlightWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'highlight-worker.js'),
    );
    webview.html = renderPanel(this.viewModel(), {
      highlightClientUri: highlightClientUri.toString(),
      highlightWorkerUri: highlightWorkerUri.toString(),
      cspSource: webview.cspSource,
    });
  }

  private detach(webview: vscode.Webview): void {
    const surface = this.surfaces.find((entry) => entry.webview === webview);
    if (surface?.ackTimer) clearTimeout(surface.ackTimer);
    if (surface) this.cancelDetailTransfer(surface);
    this.surfaces = this.surfaces.filter((surface) => surface.webview !== webview);
  }

  /* ---------------------------------------------------------------- */
  /* Conversations                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Put the current conversation away and start an empty one.
   *
   * The empty thread is on screen before anything is written down. Filing the
   * old conversation is a `Memento` write and revealing the view is a command
   * round trip, and awaiting either of those first is what used to make the
   * `+` button feel like it had not been pressed. Neither can fail in a way that
   * changes what the developer sees, so both happen behind the new thread.
   */
  newSession(): void {
    const previous = this.session.isEmpty
      ? null
      : { id: this.conversationId, title: this.session.title, items: this.session.snapshot() };

    this.conversationId = newConversationId();
    this.session.clear();
    this.setDraft('');

    if (previous) void this.history.save(previous);
    void this.reveal();
  }

  /**
   * Reopen something from history.
   *
   * The current conversation is filed first, so switching away from a live
   * thread never loses it — the developer picked a different conversation, not
   * "throw this one away".
   */
  async showHistory(): Promise<void> {
    const entries = this.recentConversations(40);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('Drift: no earlier conversations in this workspace yet.');
      return;
    }

    type Item = vscode.QuickPickItem & { id: string };
    const picked = await vscode.window.showQuickPick<Item>(
      [
        ...entries.map<Item>((entry) => ({
          id: entry.id,
          label: `${entry.active ? '$(comment-discussion)' : '$(history)'} ${entry.title}`,
          description: describeWhen(entry.at),
          detail: `${entry.messages} message${entry.messages === 1 ? '' : 's'}${entry.active ? ` · ${this.busy ? 'active now' : 'current'}` : ''}`,
        })),
        { id: '', label: '', kind: vscode.QuickPickItemKind.Separator },
        {
          id: '__clear',
          label: '$(trash) Delete every saved conversation…',
          detail: `${entries.length} conversation${entries.length === 1 ? '' : 's'} stored for this workspace`,
        },
      ],
      { title: 'Drift: conversation history', placeHolder: 'Pick a conversation to reopen', matchOnDetail: true },
    );
    if (!picked) return;

    if (picked.id === '__clear') {
      await this.clearHistory();
      return;
    }

    await this.restoreConversation(picked.id, { reveal: true });
  }

  /**
   * Throw away every saved conversation.
   *
   * Transcripts hold package names, file paths and the developer's own words
   * about their repository, and there has to be a way to be rid of them that
   * does not involve deleting a workspace. It asks first, in a modal, because
   * nothing here can bring them back.
   *
   * The open thread goes with them. Keeping it would be a lie of omission: the
   * autosave would file it again seconds later, so a history the developer just
   * emptied would quietly refill itself.
   */
  async clearHistory(): Promise<void> {
    const entries = this.history.list();
    const currentUnsaved = !this.session.isEmpty && !entries.some((entry) => entry.id === this.conversationId);
    const count = entries.length + (currentUnsaved ? 1 : 0);

    if (count === 0) {
      void vscode.window.showInformationMessage('Drift: there is no saved conversation history to clear.');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Delete ${count} Drift conversation${count === 1 ? '' : 's'}?`,
      {
        modal: true,
        detail:
          'Every transcript stored for this workspace is removed, including the one on screen, and you are left with an empty panel. No files are touched and nothing in git changes. This cannot be undone.',
      },
      'Delete',
    );
    if (choice !== 'Delete') return;

    await this.history.clear();
    this.conversationId = newConversationId();
    this.session.clear();
    this.setDraft('');
    this.cancelPendingSave();
    void vscode.window.showInformationMessage(
      `Drift: deleted ${count} conversation${count === 1 ? '' : 's'}.`,
    );
  }

  private async saveConversation(): Promise<void> {
    if (this.session.isEmpty) return;
    await this.history.save({
      id: this.conversationId,
      title: this.session.title,
      items: this.session.snapshot(),
    });
  }

  /** Write the live conversation down, cheaply, a moment after it settles. */
  private autosave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveConversation();
    }, 2000);
  }

  private cancelPendingSave(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  /** The draft belongs to the host only when the host sets it. */
  private setDraft(text: string): void {
    this.draft = text;
    this.draftToken += 1;
  }

  get busy(): boolean {
    return this.running !== null || this.operationGate.active;
  }

  /* ---------------------------------------------------------------- */
  /* Message handling                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Route one message from the panel, and make sure whatever happens is
   * visible.
   *
   * `webview.onDidReceiveMessage` calls this fire-and-forget (`void
   * this.handle(message)`), so a throw anywhere in a case below used to become
   * an unhandled rejection: nothing in the panel, nothing in the output
   * channel, nothing a developer clicking a button would ever see — a "View
   * diff" that failed and a "View diff" that was never clicked looked
   * identical. Every action a developer takes is now logged before it runs
   * and any failure is caught, logged, and turned into a notice, so a click
   * that did not work says why instead of just doing nothing.
   */
  private async handle(message: Incoming): Promise<void> {
    this.logAction(message);
    try {
      await this.dispatch(message);
    } catch (err) {
      const detail = (err as Error)?.message ?? String(err);
      this.output.error(`Drift: "${message.type}" failed — ${detail}`);
      this.session.notice('error', detail);
      // Nothing else settles the panel's busy state for an action that threw
      // here — most of these cases are outside `run()`, which is what
      // normally closes that loop — so the click that triggered this would
      // otherwise leave its button spinning until the client's own 20-second
      // timeout gives up on it.
      this.render();
    }
  }

  /**
   * One line per user action, to the "Drift" output channel — before it runs,
   * not after, so a command that hangs or crashes still leaves a record of
   * what was attempted. Purely informational: nothing here decides what to
   * do, only what to say about it.
   */
  private logAction(message: Incoming): void {
    switch (message.type) {
      case 'openFile':
        this.output.info(`Drift: opening ${message.file}${message.line > 1 ? `:${message.line}` : ''}`);
        return;
      case 'openUrl':
        this.output.info(`Drift: opening ${message.url} in the browser`);
        return;
      case 'openDiff':
        this.output.info(`Drift: opening the diff for ${message.path}`);
        return;
      case 'openFindingDiff':
        this.output.info('Drift: fetching a real diff for one finding');
        return;
      case 'openVersionDiff': {
        const candidate = this.candidates.get(message.id);
        this.output.info(
          candidate
            ? `Drift: fetching ${candidate.name} ${candidate.current} → ${candidate.selected} to diff`
            : `Drift: fetching a package diff for an id no longer on the list (${message.id})`,
        );
        return;
      }
      default:
        // Every other action already narrates itself through the transcript
        // (a step, a notice, a task list) — logging it a second time here
        // would just be the same sentence twice.
        return;
    }
  }

  private async dispatch(message: Incoming): Promise<void> {
    switch (message.type) {
      case 'ready':
        return;
      case 'submit':
        await this.submit(message.text);
        return;
      case 'draft':
        this.draft = message.text;
        return;
      case 'answer':
        this.session.answer(message.id, message.value);
        return;
      case 'menu':
        await this.runMenuItem(message.id);
        return;
      case 'history':
        await this.restoreConversation(message.id);
        return;
      case 'detach':
        this.session.detach(message.value);
        return;
      case 'rewind':
        await this.rewind(message.id);
        return;
      case 'rescan':
        await this.scan();
        return;
      case 'upgradeAll':
        // Installed candidates drop off the list as they land, but that only
        // reflects what Drift already knew about — it does not check whether
        // anything moved again meanwhile. Rescanning here, in the same
        // transcript, is how "what's left" stays trustworthy after a batch
        // of upgrades instead of requiring the user to ask for it by hand.
        if (await this.upgrade(this.safeIds(), 'safe')) await this.scan();
        return;
      case 'stop':
        if (!this.cancellable) {
          this.session.notice('info', 'This step finishes before anything else can start.');
          return;
        }
        this.stopping = true;
        this.running?.cancel();
        this.paint();
        return;
      case 'signIn':
        await getGitHubSession({ createIfNone: true });
        await this.refreshIdentity();
        await this.refreshAgents();
        return;
      case 'showReport':
        DriftReportPanel.show(this.state);
        return;
      case 'openFile':
        await this.openFile(message.file, message.line);
        return;
      case 'openUrl':
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case 'openDiff':
        await vscode.commands.executeCommand('drift.openChangeDiff', message.path);
        return;
      case 'openFindingDiff': {
        // The payload is built by the renderer and round-trips through a data
        // attribute, so a malformed one means the panel and the host are out
        // of step — nothing a user can act on, and not worth an error dialog.
        const request = parseChangeDiffRequest(message.value);
        if (!request) {
          this.output.warn('Drift: "View diff" sent a payload the panel could not parse; nothing to show.');
          return;
        }
        try {
          await openChangeDiff(request, this.output);
        } finally {
          // Not `LOCAL_ACTIONS` on the client any more — fetching and locating
          // the real source can take real time — so the button that triggered
          // this is disabled and spinning until a `render` message tells the
          // panel to let go of it. Nothing else here changes `session` or
          // `state`, so nothing would otherwise fire one.
          this.render();
        }
        return;
      }
      case 'openVersionDiff': {
        const candidate = this.candidates.get(message.id);
        if (!candidate) {
          this.output.warn(`Drift: "View diff" was clicked for a package no longer on the list (${message.id}).`);
          return;
        }
        try {
          await openPackageVersionDiff({
            ecosystem: candidate.ecosystem,
            name: candidate.name,
            from: candidate.current,
            to: candidate.selected,
            output: this.output,
          });
        } finally {
          this.render();
        }
        return;
      }
      case 'selectVersion':
        // Retarget rather than install: the whole point of the shortcut is to
        // see what that version costs before committing to it.
        if (this.candidates.get(message.id)?.selected !== message.version) {
          await this.retarget(message.id, message.version);
        }
        return;
      case 'pickVersion':
        await this.pickVersion(message.id);
        return;
      case 'recheck':
        await this.recheck(message.id);
        return;
      case 'verifyOne':
        await this.verifyOne(message.id);
        return;
      case 'verifyAll':
        await this.verifyAll();
        return;
      case 'installTool':
        await this.installTool(message.id, message.value);
        return;
      case 'upgrade':
        await this.upgrade([message.id], message.mode);
        return;
      case 'fixPackage':
        await this.fix([message.id]);
        return;
      case 'fixAll':
        await this.fix(this.affectedIds());
        return;
      case 'fileIssuePackage':
        await this.fileIssue([message.id]);
        return;
      case 'fileIssueAll':
        await this.fileIssue(this.affectedIds());
        return;
      case 'fileIssueSafe':
        await this.fileIssue(this.safeIds());
        return;
      case 'keepFile':
        await this.review.keepFile(message.path);
        return;
      case 'undoFile':
        await this.review.undoFile(message.path);
        return;
      case 'keepGroup':
        await this.review.keepGroup(message.order);
        return;
      case 'undoGroup':
        await this.review.undoGroup(message.order);
        this.session.notice('info', 'Reverted those files to how they were.');
        return;
      case 'retryCommit':
        await this.review.retryCommit(message.order);
        return;
      case 'keepAll':
        await this.review.keepAll();
        return;
      case 'undoAll':
        await this.review.undoAll();
        this.session.notice('info', 'Reverted every file Drift changed. Nothing was committed.');
        return;
    }
  }

  /**
   * Route what the developer typed.
   *
   * Slash commands are exact and always win. An outstanding question takes the
   * next free-text message as its answer, because that is what the developer
   * means when they type after being asked something. Everything else is matched
   * against intent, and anything that matches nothing becomes a standing
   * instruction for the agent — the one thing plain prose is genuinely good for
   * here, and the setting with the biggest effect on fix quality.
   */
  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;

    if (this.session.awaitingAnswer && !text.startsWith('/')) {
      this.session.user(text);
      this.session.answerPending(text);
      return;
    }

    // The message goes up first, always. Taking a checkpoint shells out to git,
    // and waiting for that before echoing what the developer typed made the
    // panel look like it had not registered the message at all — the single
    // biggest source of "why is this so slow". The snapshot still happens
    // before anything acts on the message, so "rewind" keeps meaning exactly
    // what it says: the repository as it was when you pressed Enter.
    const itemId = this.session.user(text);
    this.setDraft('');

    const checkpoint = await this.checkpoint(text);
    if (checkpoint) this.session.setCheckpoint(itemId, checkpoint.id);

    const [command = '', ...rest] = text.split(/\s+/);
    const argument = rest.join(' ').trim();

    switch (command.toLowerCase()) {
      case '/scan':
        await this.scan();
        return;
      case '/recent':
        await this.analyzeRecent();
        return;
      case '/verify':
        await this.deepVerifyRecent();
        return;
      case '/upgrade':
        await this.upgradeByName(argument);
        return;
      case '/fix':
        await this.fix(argument ? this.idsMatching(argument) : this.affectedIds());
        return;
      case '/upgrade-all':
        await this.upgrade(this.safeIds(), 'safe');
        return;
      case '/commit':
        await this.commitDependencyChanges();
        return;
      case '/push':
        await this.pushCurrentBranch();
        return;
      case '/pr':
      case '/pull-request':
        await this.openPullRequestForBranch();
        return;
      case '/issue':
        await this.fileIssue(argument ? this.idsMatching(argument) : this.affectedIds());
        return;
      case '/review':
        this.showReview();
        return;
      case '/redo':
        await this.redoFix();
        return;
      case '/discard':
        await this.discardFix();
        return;
      case '/instruction':
      case '/instructions':
        await this.addWorkspaceInstruction(argument);
        return;
      case '/agent':
        this.openMenu('model:setup');
        return;
      case '/clear':
        this.newSession();
        return;
      case '/help':
        this.help();
        return;
    }

    if (command.startsWith('/')) {
      this.session.notice('warn', `Unknown command \`${command}\`. Type \`/help\` to see what Drift can do.`);
      return;
    }

    await this.interpret(text);
  }

  private async interpret(text: string): Promise<void> {
    const lower = text.toLowerCase();

    const named = [...this.candidates.values()].find((candidate) =>
      lower.includes(candidate.name.toLowerCase()),
    );
    if (named) {
      await this.describe(named);
      return;
    }

    if (/\b(scan|outdated|updates?|upgrades?|newer|dependenc)/.test(lower)) {
      await this.scan();
      return;
    }
    if (/\b(recent|last|changed|history|bump)/.test(lower)) {
      await this.analyzeRecent();
      return;
    }
    if (/\b(fix|repair|migrate|update my code)/.test(lower)) {
      await this.fix(this.affectedIds());
      return;
    }
    // Pull request first: "push this and open a PR" is one request, and the
    // pull-request path pushes on the way through.
    if (/\b(pull request|pr)\b/.test(lower)) {
      await this.openPullRequestForBranch();
      return;
    }
    if (/\bissue\b/.test(lower)) {
      await this.fileIssue(this.affectedIds());
      return;
    }
    if (/\b(commit|branch|stage)\b/.test(lower)) {
      await this.commitDependencyChanges();
      return;
    }
    if (/\bpush\b/.test(lower)) {
      await this.pushCurrentBranch();
      return;
    }
    if (/\b(review|keep|undo|diff)/.test(lower) && !this.review.isEmpty) {
      this.showReview();
      return;
    }
    if (/\b(help|what can you|how do)/.test(lower)) {
      this.help();
      return;
    }

    // Nothing Drift can act on. It used to save the message, silently and
    // permanently, into this workspace's agent instructions — so a developer
    // who typed "why did you think this was unsafe?" and got no intent match
    // had just told every future agent run to ask itself that question.
    //
    // In a chat box, an unrecognised message is overwhelmingly a question, not
    // a policy. Standing instructions materially change how future code edits
    // are made, so they are now something the developer chooses out loud —
    // here, or with `/instruction`.
    const answer = await this.session.ask(
      `I could not match that to anything I can do. Did you mean to save it as a standing instruction for this workspace — something every future agent run should be told?`,
      [
        {
          label: 'Save it as a workspace instruction',
          value: 'save',
          description: 'Every agent run in this workspace will be given it',
        },
        { label: 'No, I was asking a question', value: 'no' },
      ],
      false,
    );

    if (answer !== 'save') {
      this.session.say(
        [
          'Left your instructions alone.',
          '',
          'I can act on `/scan`, `/recent`, `/upgrade <package>`, `/fix`, `/review`, `/commit`, `/push` and `/pr` — type `/help` for the full list. To save a standing instruction deliberately, use `/instruction <text>`.',
        ].join('\n'),
      );
      return;
    }

    await this.addWorkspaceInstruction(text);
  }

  /**
   * Add a standing instruction every future agent run in this workspace is given.
   *
   * Explicit by construction. This is the only path that writes
   * `fix.customInstructions`, so a workspace's agent policy can only ever
   * change because someone asked for it to.
   */
  private async addWorkspaceInstruction(text: string): Promise<void> {
    const instruction = text.trim();
    if (!instruction) {
      this.session.notice(
        'warn',
        'Usage: `/instruction <text>` — for example `/instruction This repo uses Vitest, not Jest.`',
      );
      return;
    }

    const config = vscode.workspace.getConfiguration('drift');
    const current = config.get<string>('fix.customInstructions', '').trim();
    await config.update(
      'fix.customInstructions',
      [current, instruction].filter(Boolean).join('\n'),
      vscode.ConfigurationTarget.Workspace,
    );

    this.session.say(
      [
        "Added to this workspace's Drift instructions. Every agent run from now on will be told:",
        '',
        `> ${instruction}`,
        '',
        'Edit or remove them in Settings under `drift.fix.customInstructions`.',
      ].join('\n'),
    );
  }

  private help(): void {
    this.session.say(
      [
        '**What Drift does**',
        '',
        'It reads changelogs, release notes, registry metadata and published type surfaces for the packages you depend on, works out which changes are genuinely breaking, then searches *your* code for the affected APIs. Only what it can prove touches your files is treated as something to fix.',
        '',
        '**Commands**',
        '',
        ...SLASH_COMMANDS.map(
          (command) => `- \`${command.name}${command.args ? ` ${command.args}` : ''}\` — ${command.description}`,
        ),
        '',
        '**The composer controls**',
        '',
        '- **Agent** — which AI does the editing. Drift drives one you already have and never asks for an API key.',
        '- **Tools** — everything on this list, one click away.',
        '- **Effort** — how hard that agent thinks, named the way it names it: Claude goes up to Ultracode, Codex to Extra High. It never changes what Drift checks or which fixes it attempts, only the reasoning spent on each one.',
        '- **Ask / Agent** — Ask analyses and explains; Agent edits files.',
        '- **Permission** — whether the agent asks first, edits then waits for your review, or edits and commits.',
        '',
        '**Review**',
        '',
        // Qualified deliberately. The unqualified version of this sentence was
        // false for one of the three permission modes the same panel offers:
        // `full-auto` commits each group as it lands. A safety claim that a
        // setting in the menu above contradicts is worse than no claim.
        'On **Edit, then review** — the default — agent edits are never committed until you keep them. Changed lines are highlighted in the editor with Keep and Undo on every hunk, and the change list in this panel opens the real diff editor. **Ask first** additionally asks before each edit; **Edit and commit** commits each group as it goes, which is the one mode where an edit lands without you having reviewed it.',
        '',
        '**Git**',
        '',
        'When an upgrade lands, Drift offers to put it on a branch, commit it with a message that carries the evidence, push it, and open a pull request whose description says what changed upstream and what it touches here. Every step asks first, and you can stop at any of them — `/commit`, `/push` and `/pr` pick the flow back up later. If a breaking change is not worth fixing right now, `/issue` files it on GitHub instead, prefilled with the same evidence.',
        '',
        'The commit only ever contains the manifests and lockfiles the upgrade changed, so unfinished work elsewhere in your tree stays yours. Drift never force-pushes, never rewrites history, and never commits to your default branch without you choosing it.',
      ].join('\n'),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Scanning                                                          */
  /* ---------------------------------------------------------------- */

  /** Called on activation when the setting allows, and by `/scan`. */
  async scanOnStartup(): Promise<void> {
    if (this.scanned) return;
    await this.scan();
  }

  /**
   * Settle which tool owns each ecosystem before anything is scanned.
   *
   * Two lockfiles for one ecosystem is a real state to walk into — a
   * half-finished pnpm migration leaves both behind — and guessing picks a
   * loser and writes the wrong lockfile. Answers are remembered per workspace,
   * because a repository's build tooling is not a per-scan decision.
   *
   * Returns `null` when the developer declined to choose, which cancels the
   * scan rather than proceeding on a guess.
   */
  private async resolveManagers(root: string): Promise<ManagerPreferences | null> {
    const stored = new Map<string, PackageManagerId>(
      Object.entries(this.memento.get<Record<string, PackageManagerId>>(MANAGER_KEY, {})),
    );

    // Every directory the scan is about to read, not just the root. Asking
    // about the root alone meant this safety property quietly evaporated in
    // the layout most likely to need it: a monorepo whose members carry their
    // own lockfiles. `scanDirectories` is the same computation `scanUpgrades`
    // does, shared so the two cannot disagree about what is in scope.
    const dirs = await scanDirectories(root);
    const { ambiguities } = await discoverTargets(root, dirs, stored);
    if (ambiguities.length === 0) return stored;

    for (const ambiguity of ambiguities) {
      const where = ambiguity.dir ? `\`${ambiguity.dir}\`` : 'this repository';
      const answer = await this.session.ask(
        `${where} has ${ambiguity.candidates.length} package managers claiming the same dependencies: ${ambiguity.candidates
          .map((c) => `**${c.manager.label}** (${c.evidence.join(', ')})`)
          .join(', ')}. Which one do you actually use?`,
        [
          ...ambiguity.candidates.map((c) => ({
            label: c.manager.label,
            value: c.manager.id,
            description: `Read ${c.evidence[0]} and run \`${c.manager.label}\` for upgrades`,
          })),
          { label: 'Cancel the scan', value: 'cancel' },
        ],
        false,
      );

      if (answer === 'cancel' || answer === '') {
        this.session.notice('info', 'Scan cancelled. Delete the lockfile you no longer use, or pick a manager next time.');
        return null;
      }

      stored.set(ambiguityKey(ambiguity.dir, ambiguity.ecosystem), answer as PackageManagerId);
    }

    await this.memento.update(MANAGER_KEY, Object.fromEntries(stored));
    return stored;
  }

/**
   * Offer to run the project's own checks over what the agent just wrote.
   *
   * The honest question after a fix is not whether Drift believes it, but
   * whether your toolchain still passes — and that answer already exists in
   * the repository, costs nothing, and reaches no network.
   *
   * A failure never blocks Keep. It is reported next to the group it belongs
   * to and the decision stays where it was, which is the same shape as every
   * other guardrail here: reduce confidence, never remove the choice.
   */
  private async offerVerification(root: string, dirs: readonly string[]): Promise<void> {
    const orders = this.review.groups().filter((g) => !g.committed).map((g) => g.order);
    if (orders.length === 0) return;

    const dir = dirs[0] ?? '';
    const checks = await availableChecks(root, dir);
    if (checks.length === 0) return;

    const answer = await this.session.ask(
      `Run ${checks.map((c) => `\`${c.label}\``).join(', ')} before you decide? ${
        checks.length === 1 ? 'It is' : 'They are'
      } your own ${checks.map((c) => c.source).join(' and ')} — nothing leaves this machine, and a failure will not stop you keeping anything.`,
      [
        { label: 'Run them', value: 'run', description: checks.map((c) => c.label).join(' · ') },
        { label: 'Skip', value: 'skip', description: 'Review the changes without running anything' },
      ],
      false,
    );
    if (answer !== 'run') return;

    const step = this.session.step('Running your checks');
    for (const order of orders) this.review.setChecks(order, null, true);

    await this.run(async (token) => {
      const outcomes = await runChecks({
        root,
        dir,
        checks,
        token,
        onProgress: (check, index, total) =>
          step.progress(`Running \`${check.label}\``, `${index + 1} of ${total}`, index, total),
        onResult: (outcome, index, total) => {
          step.progress(describeOutcome(outcome), `${index + 1} of ${total}`, index + 1, total);
          this.reportCheckOutput(outcome);
        },
      });

      // The checks validate the working tree, not one group in isolation, so
      // every pending group carries the same result rather than pretending to
      // attribute a test failure to a particular commit unit.
      for (const order of orders) this.review.setChecks(order, outcomes);

      const failed = outcomes.filter((o) => o.status === 'failed');
      const reasons = unrunReasons(outcomes);
      if (failed.length > 0) step.fail(describeOutcomes(outcomes));
      else step.done(describeOutcomes(outcomes));

      this.session.notice(
        failed.length > 0 || reasons.length > 0 ? 'warn' : 'success',
        [
          failed.length > 0
            ? `${describeOutcomes(outcomes)}. The result is shown above each changed file — keep or undo as you see fit.`
            : reasons.length > 0
              ? `${describeOutcomes(outcomes)}. Nothing here has been checked against your toolchain.`
              : `${describeOutcomes(outcomes)}. That is your own toolchain, not Drift's opinion.`,
          ...(reasons.length > 0 ? ['', ...reasons.map((reason) => `- ${reason}`)] : []),
        ].join('\n'),
      );
    });
  }

/**
   * Run the project's checks after an upgrade, when the developer asks.
   *
   * There is no review store here — an upgrade edits a manifest and a lockfile
   * rather than proposing hunks — so the result is reported in the transcript
   * where the upgrade was reported.
   */
  private async verifyUpgrade(root: string, candidates: readonly UpgradeCandidate[]): Promise<void> {
    const dir = [...new Set(candidates.map((c) => c.workspace ?? ''))].sort(
      (a, b) => b.length - a.length,
    )[0] ?? '';

    const checks = await availableChecks(root, dir);
    if (checks.length === 0) return;

    const answer = await this.session.ask(
      `Run ${checks.map((c) => `\`${c.label}\``).join(', ')} against the upgraded dependencies? Local only — nothing leaves this machine.`,
      [
        { label: 'Run them', value: 'run', description: checks.map((c) => c.label).join(' · ') },
        { label: 'Skip', value: 'skip', description: 'I will run them myself' },
      ],
      false,
    );
    if (answer !== 'run') return;

    const step = this.session.step('Running your checks');
    const outcomes = await runChecks({
      root,
      dir,
      checks,
      onProgress: (check, index, total) =>
        step.progress(`Running \`${check.label}\``, `${index + 1} of ${total}`, index, total),
      onResult: (outcome, index, total) => {
        step.progress(describeOutcome(outcome), `${index + 1} of ${total}`, index + 1, total);
        this.reportCheckOutput(outcome);
      },
    });

    const failed = outcomes.filter((o) => o.status === 'failed');
    const reasons = unrunReasons(outcomes);
    const summary = `${describeOutcomes(outcomes)} after the upgrade.`;

    if (failed.length > 0) step.fail(describeOutcomes(outcomes));
    else step.done(describeOutcomes(outcomes));

    this.session.notice(
      failed.length > 0 || reasons.length > 0 ? 'warn' : 'success',
      [
        summary,
        // A check that never ran proved nothing about the upgrade, and saying
        // only "not run" leaves the developer to guess whether it is still
        // going. The reason is the whole message.
        ...(reasons.length > 0 ? ['', ...reasons.map((reason) => `- ${reason}`)] : []),
      ].join('\n'),
    );
  }

  /**
   * Show the command output in the transcript, not only the progress row.
   *
   * The step tells you where Drift is in the sequence. The command output tells
   * you what the tool actually said, which is the part a developer needs when a
   * check is slow, noisy, or red.
   */
  private reportCheckOutput(outcome: CheckOutcome): void {
    const tone =
      outcome.status === 'passed' ? 'success' : outcome.status === 'failed' ? 'error' : 'warn';
    const lines = [
      `\`${outcome.label}\` ${checkStatusText(outcome)}.`,
      ...(outcome.reason ? ['', outcome.reason] : []),
      '',
      '```',
      cleanFence(outcome.output.trim() || '(no output)'),
      '```',
    ];

    this.session.notice(tone, lines.join('\n'));
  }

  /** Every open root, filtered to what the scope picker has selected — all of them, absent a choice. */
  private selectedRoots(): readonly RepoRoot[] {
    const roots = this.state.roots;
    if (roots.length <= 1) return roots;
    const included = roots.filter((root) => this.session.isRootIncluded(root.path));
    // Every root got excluded some other way than the toggle that already
    // refuses to let this happen — stale state from a closed folder, say.
    // Scanning nothing is never the right recovery from that.
    return included.length > 0 ? included : roots;
  }

  private async scan(options: { quiet?: boolean } = {}): Promise<void> {
    if (this.running) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    if (this.operationGate.active) {
      this.session.notice('info', 'A dependency scan is already waiting for your answer.');
      return;
    }

    const roots = this.selectedRoots();
    if (roots.length === 0) {
      this.session.notice(
        'warn',
        `Open a git repository with a dependency manifest to scan dependencies. Drift reads ${describeSupportedManifests()}.`,
      );
      return;
    }

    const contexts = (await Promise.all(roots.map((root) => this.contextFor(root.path)))).filter(
      (ctx): ctx is WorkspaceContext => ctx !== null,
    );
    if (contexts.length === 0) {
      this.session.notice('warn', 'None of the selected folders are available for Drift to read.');
      return;
    }

    // Only labelled, and only rendered with a repository tag per package, once
    // there is more than one to tell apart — a tag that never varies is one
    // more thing to read past, the same rule `workspaceTag` already follows
    // for workspace members within a single repository.
    const multiRoot = contexts.length > 1;

    let choices: Awaited<ReturnType<typeof resolveScanChoices>>;
    const reserved = await this.operationGate.run(async () => {
      const wasCancellable = this.cancellable;
      this.cancellable = false;
      this.render();
      try {
        choices = await resolveScanChoices(contexts[0]!.config, (question, choices) =>
          this.session.ask(question, choices, false),
        );
        if (!choices) {
          this.session.notice('info', 'Scan cancelled.');
          return;
        }

        const resolvedChoices = choices;
        this.operationGateOwnerEnteringRun = true;
        try {
          await this.runScan(contexts, roots, multiRoot, resolvedChoices, options);
        } finally {
          this.operationGateOwnerEnteringRun = false;
        }
      } finally {
        if (!this.running) {
          this.cancellable = wasCancellable;
          this.render();
        }
      }
    });

    if (reserved === 'busy') {
      this.session.notice('info', 'A dependency scan is already waiting for your answer.');
    }
  }

  private async runScan(
    contexts: readonly WorkspaceContext[],
    roots: readonly RepoRoot[],
    multiRoot: boolean,
    resolvedChoices: NonNullable<Awaited<ReturnType<typeof resolveScanChoices>>>,
    options: { quiet?: boolean },
  ): Promise<void> {
    return this.run(async (token) => {
      this.scanned = true;
      this.clearStale();
      this.state.setCandidates([]);
      const step = this.session.step(
        multiRoot ? `Checking your dependencies across ${contexts.length} repositories` : 'Checking your dependencies',
        { key: 'scan' },
      );

      let found: UpgradeCandidate[] = [];
      const nestedGitRepos: NestedProject[] = [];
      /** Dependencies whose version lookup never returned. Never silently dropped. */
      const unlooked: UncheckedDependency[] = [];
      let checked = 0;
      let failures = 0;

      for (const ctx of contexts) {
        if (token.isCancellationRequested) break;

        const repoLabel = multiRoot
          ? (roots.find((root) => root.path === ctx.root)?.label ?? basename(ctx.root))
          : undefined;

        const managers = await this.resolveManagers(ctx.root);
        if (!managers) continue;

        const { deep, includeDev } = resolvedChoices;

        try {
          const result = await runRepoDiagnostic(
            {
              command: 'vscode: drift.scanDependencies',
              type: `${includeDev ? 'dev' : 'runtime'}-${deep ? 'deep' : 'quick'}`,
              mode: deep ? 'deep' : 'quick',
              repoRoot: ctx.root,
              spanName: 'dependency.core-scan',
              spanMeta: {
                trigger: options.quiet ? 'autostart' : 'command',
                ...(repoLabel ? { repo: repoLabel } : {}),
              },
              isCancelled: () => token.isCancellationRequested,
              enabled: vscode.workspace.getConfiguration('drift').get<boolean>('diagnostics.enabled', false),
            },
            async () => scanWithTransientHttpCache({
            root: ctx.root,
            repo: ctx.repo,
            managers,
            // Quick Scan never installs anything or runs this repository's own
            // checks; Deep Verification — chosen via `drift.analysis.verifyMode`
            // or this run's prompt, same as `verifyOne`/`verifyAll` do
            // explicitly per package — pays for the real thing up front
            // instead. Either way Quick Scan itself, as a mode, never gains
            // installs or checks: `deep` is what is different here, not what
            // "quick" means.
            verify: { enabled: deep },
            output: this.output,
            // Every direct dependency, every time. What counts as a dependency
            // worth checking is a settings question — `drift.analysis.dependencyScope`
            // (or the older `includeDev`/`includePatch`), resolved above into
            // `includeDev` — and never a side effect of how hard the agent was
            // asked to think. A scan that silently looked at less would report
            // packages as safe because nothing had looked at them.
            config: ctx.config,
            breadth: {
              includeDev,
              maxSites: QUICK_SCAN_MAX_SITES,
              maxPackages: 0,
            },
            githubToken: await getRateLimitToken(),
            token,
            repoLabel,
            onProgress: ({ phase, detail, done, total, output }) => {
              // Output belongs to the phase already showing, so it appends
              // rather than replacing it — see `ScanProgress.output`.
              if (output !== undefined) step.output(output);
              else step.progress(repoLabel ? `${repoLabel}: ${phase}` : phase, detail, done, total);
            },
            onCandidate: (candidate) => {
              countWork('dependency.candidate-events');
              this.candidates.set(candidate.id, candidate);
              // Replaced, never appended twice. Each candidate is now published
              // at least twice — once as `checking` the moment its analysis
              // lands, then again with the verdict the probe measured — and
              // pushing both put every package in the list a second time, so a
              // root-plus-`extension/` checkout appeared to hold four `zod`s
              // instead of two. The map above was always keyed by id and always
              // correct; this array was the one counting duplicates.
              const at = found.findIndex((existing) => existing.id === candidate.id);
              if (at >= 0) found[at] = candidate;
              else found.push(candidate);
              // Fill the list in as results arrive rather than after the whole
              // sweep; a partial answer now beats a complete one in a minute.
              this.session.updatePackages(
                headline(found, checked, unlooked.length),
                [...found].sort(bySeverity).map((c) => c.id),
                false,
              );
              this.state.setCandidates([...found].sort(bySeverity));
            },
            onDropped: (id) => {
              // A package listed the moment its manifest was read, which turned
              // out to have no upgrade to offer. The row goes away rather than
              // sitting there forever with nothing in it.
              this.candidates.delete(id);
              const at = found.findIndex((existing) => existing.id === id);
              if (at < 0) return;
              found.splice(at, 1);
              this.session.updatePackages(
                headline(found, checked, unlooked.length),
                [...found].sort(bySeverity).map((c) => c.id),
              );
              this.state.setCandidates([...found].sort(bySeverity));
            },
            }),
          );

          checked += result.checked;
          unlooked.push(...result.unchecked);
          nestedGitRepos.push(...result.nestedGitRepos);
        } catch (err) {
          failures += 1;
          this.session.notice('error', repoLabel ? `${repoLabel}: ${(err as Error).message}` : (err as Error).message);
        }
      }

      if (failures === contexts.length) {
        step.fail('Scan failed');
        return;
      }

      // A backstop. `scanUpgrades` withdraws every row it announced and never
      // reached, on every path out including cancellation and a throw, so this
      // normally finds nothing. It stays because the cost of being wrong is a
      // row spinning forever over a package nobody is checking, and this list
      // is also fed by roots whose scan threw before it could clean up after
      // itself. The notice below is what tells the developer those
      // dependencies went unlooked-at; a permanent spinner is not.
      for (const abandoned of found.filter((c) => c.status === 'pending')) {
        this.candidates.delete(abandoned.id);
      }
      found = found.filter((c) => c.status !== 'pending');

      const ranked = found.slice().sort(bySeverity);
      const stopped = token.isCancellationRequested;

      if (stopped) {
        // A stopped scan is a partial answer, and the danger has never been
        // that it is partial — it is that every surface below reads a partial
        // answer as a complete one and calls the packages nothing looked at
        // safe. So the result is kept and labelled rather than discarded:
        // whoever pressed stop wanted what had been found so far, and saying
        // "checked 12 of 47, the rest were not looked at" gives them that
        // without ever claiming the other 35 are fine.
        step.fail(
          `Stopped after ${found.length} of ${checked} package${checked === 1 ? '' : 's'} · ` +
            `${checked - found.length} not checked`,
        );
        this.session.notice(
          'warn',
          `Scan stopped. ${found.length} of ${checked} dependenc${found.length === 1 ? 'y was' : 'ies were'} checked; ` +
            `the rest were not looked at, which is not the same as being safe. Run \`/scan\` again to finish.`,
        );
      } else {
        step.done(
          `Checked ${checked - unlooked.length} package${checked - unlooked.length === 1 ? '' : 's'} · ` +
            `${ranked.filter((c) => severityOf(c) === 'affected' || severityOf(c) === 'verification-failed').length} need attention` +
            (unlooked.length > 0 ? ` · ${unlooked.length} could not be checked` : ''),
        );
      }

      // Named, with the reason, rather than reduced to a count. "Drift could
      // not reach PyPI for boto3" is something a developer can act on; "4
      // skipped" is something they will assume was unimportant — and the whole
      // point of tracking these separately is that they are not.
      if (unlooked.length > 0) {
        const lines = unlooked.map((dep) => `- \`${dep.name}\` (${dep.current}) — ${dep.reason}`);
        this.session.notice(
          'warn',
          `${unlooked.length} dependenc${unlooked.length === 1 ? 'y' : 'ies'} could not be checked for upgrades. ` +
            `This is not the same as being up to date:\n\n${lines.join('\n')}`,
        );
      }

      // A directory with its own `.git` is a separate repository, most often
      // a submodule — Drift never folds its commits into this one's, so it
      // was deliberately left out of the scan rather than silently merged.
      if (nestedGitRepos.length > 0) {
        const dirs = nestedGitRepos.map((p) => p.dir).join(', ');
        const plural = nestedGitRepos.length === 1;
        this.session.notice(
          'info',
          `Found ${nestedGitRepos.length} nested git repositor${plural ? 'y' : 'ies'} (${dirs}) — Drift keeps each repository's history separate, so open ${plural ? 'it' : 'them'} as ${plural ? 'its own folder' : 'their own folders'} to scan ${plural ? 'it' : 'them'} too.`,
        );
      }

      if (ranked.length === 0) {
        this.state.setCandidates([]);
        const upToDate = Math.max(0, checked - unlooked.length);
        this.session.updatePackages(
          // Never "every one of your N dependencies is already at the newest
          // version" when some of them were never looked at. The sentence is
          // only true about the ones a source actually answered for — and a
          // stopped scan is the largest version of exactly that gap.
          stopped
            ? `Scan stopped before any upgrade was found. Nothing here says your dependencies are up to date — most of them were never checked.`
            : unlooked.length > 0
              ? `${upToDate} of your ${checked} direct dependencies ${upToDate === 1 ? 'is' : 'are'} already at the newest version. ${unlooked.length} could not be checked at all.`
              : `Every one of your ${checked} direct dependenc${checked === 1 ? 'y is' : 'ies are'} already at the newest version.`,
          [],
        );
        if (!stopped) this.session.setTitle(scanTitle([], checked, unlooked.length));
        return;
      }

      this.session.updatePackages(
        stopped
          ? `${ranked.length} upgrade${ranked.length === 1 ? '' : 's'} found before the scan was stopped — ${checked - found.length} of your ${checked} dependencies were never checked.`
          : headline(ranked, checked, unlooked.length),
        ranked.map((c) => c.id),
      );
      this.state.setCandidates(ranked);
      // Named now rather than from the `/scan` that started it: every scan is
      // started the same way, and only the result tells two of them apart in
      // the history list.
      if (!stopped) this.session.setTitle(scanTitle(ranked, checked, unlooked.length));

      const affected = ranked.filter((c) => severityOf(c) === 'affected');
      if (affected.length > 0 && !options.quiet) {
        this.session.say(
          `I can hand ${affected.length === 1 ? 'this' : 'these'} to **${this.agentLabel()}** — say \`/fix\`, or use the button above.`,
        );
      }
    });
  }

  private async analyzeRecent(): Promise<void> {
    if (this.busy) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    const step = this.session.step('Analysing the dependency change in your git history');

    await this.run(async (token) => {
      const result = await runAnalysis({
        state: this.state,
        token,
        progress: { report: ({ message }) => step.progress(message ?? 'Working', '') },
      });

      this.lastAnalysisContext = result.context ?? null;

      const plan = result.plan;
      if (!plan || plan.breakingChanges.length === 0) {
        step.done('Nothing breaking found');
        this.session.say(result.summary);
        this.session.setTitle('Recent changes — nothing breaking');
        return;
      }

      const files = new Set(plan.impactSites.map((site) => site.file)).size;
      step.done(`${plan.changes.length} dependency change${plan.changes.length === 1 ? '' : 's'} analysed`);

      // The packages that moved are what a developer looks this conversation
      // up by later, so they are the title — not "/recent", which every one of
      // these threads would otherwise be called.
      this.session.setTitle(
        `Recent — ${namesOf(plan.changes.map((change) => change.name))}${files > 0 ? `, ${files} file${files === 1 ? '' : 's'} affected` : ''}`,
      );

      // Static analysis only — Deep Verification has not run yet, and
      // nothing here should read as though it had.
      const deepVerifyAction = this.lastAnalysisContext?.config.verify.enabled
        ? [{ label: 'Deep verify', command: '/verify' }]
        : [];

      // The distinction that matters, stated first.
      if (files === 0) {
        this.session.say(
          [
            `The dependencies that moved have ${plan.breakingChanges.length} breaking change${plan.breakingChanges.length === 1 ? '' : 's'} between them, and **none of them touch this repository** — static analysis only, not deeply verified.`,
            '',
            'Open the report if you want to see the reasoning and the sources.',
          ].join('\n'),
          deepVerifyAction,
        );
      } else {
        this.session.say(
          `**${files} file${files === 1 ? '' : 's'}** in this repository use an API that changed, across ${plan.impactSites.length} site${plan.impactSites.length === 1 ? '' : 's'} — static analysis only, not deeply verified. Say \`/fix\` and **${this.agentLabel()}** will work through them, one commit per concern.`,
          deepVerifyAction,
        );
      }
    });
  }

  /**
   * Deep Verification for the plan `/recent` last found: install the change
   * in a throwaway worktree and run this project's own checks against it,
   * continuing from the existing plan rather than re-running the analysis
   * that produced it.
   */
  private async deepVerifyRecent(): Promise<void> {
    const context = this.lastAnalysisContext;
    const plan = this.state.plan;
    if (!context || !plan) {
      this.session.notice('warn', 'Nothing to verify yet — run `/recent` first.');
      return;
    }
    if (!context.config.verify.enabled) {
      this.session.notice('warn', 'Deep Verification is disabled (`verify.enabled: false` in drift.yml).');
      return;
    }

    const step = this.session.step('Installing the change and running your checks against it');

    await this.run(async (token) => {
      const verified = await deepVerify(
        { plan, summary: '' },
        {
          ...context,
          onProgress: (_stage, detail) => {
            if (token.isCancellationRequested) return;
            step.progress('Verifying', detail);
          },
        },
      );

      if (token.isCancellationRequested) {
        step.fail('Deep Verification stopped — falling back to the static result from `/recent`.');
        this.session.notice('warn', 'Deep Verification was cancelled; the findings above remain static predictions.');
        return;
      }

      if (!verified.plan) {
        step.done('Nothing to verify');
        return;
      }

      this.state.set({ kind: 'findings', plan: verified.plan, at: Date.now() });

      const verification = verified.plan.verification;
      if (!verification) {
        step.fail('Deep Verification could not run here — no local checkout to test in.');
        return;
      }

      step.done(
        verification.status === 'passed'
          ? 'Verified safe'
          : verification.status === 'failed'
            ? 'Verified breaking'
            : 'Could not verify',
      );
      this.session.say(describeVerification(verification));
    });
  }

  private async describe(candidate: UpgradeCandidate): Promise<void> {
    const severity = severityOf(candidate);
    const lines = [
      `**${candidate.name}** ${candidate.current} → ${candidate.selected}`,
      '',
      candidate.summary,
      '',
      `- ${describeSeverity(candidate)}`,
      `- ${candidate.evidenceCount} evidence source${candidate.evidenceCount === 1 ? '' : 's'} read`,
      `- Newest version within your \`${manifestName(candidate)}\` range: ${candidate.safeLatest ?? 'none'}`,
      `- Newest published: ${candidate.latest}`,
    ];

    if (candidate.gaps.length > 0) {
      lines.push('', '**What Drift could not check:**', ...candidate.gaps.map((gap) => `- ${gap}`));
    }

    if (severity === 'affected') {
      lines.push('', `Say \`/fix ${candidate.name}\` to let ${this.agentLabel()} update the affected code.`);
    } else if (severity === 'unchecked') {
      lines.push(
        '',
        `I have nothing to go on for this one, so I will not call it safe. Read the release notes, then say \`/upgrade ${candidate.name}\` if you want it anyway.`,
      );
    } else if (severity === 'upstream-only' || severity === 'clean') {
      lines.push('', `Say \`/upgrade ${candidate.name}\` to install it.`);
    }

    this.session.say(lines.join('\n'));
  }

  /* ---------------------------------------------------------------- */
  /* Upgrading                                                         */
  /* ---------------------------------------------------------------- */

  private async upgradeByName(name: string): Promise<void> {
    if (!name) {
      this.session.notice('warn', 'Which package? Try `/upgrade react`.');
      return;
    }

    const ids = this.idsMatching(name);
    if (ids.length === 0) {
      this.session.notice(
        'warn',
        `I have not checked \`${name}\` yet. Run \`/scan\` first, or check the name.`,
      );
      return;
    }

    await this.upgrade(ids, 'safe');
  }

  /** `ctx`, unless the candidate belongs to a different open root than the active one. */
  private async contextForCandidate(
    candidate: UpgradeCandidate,
    active: WorkspaceContext,
  ): Promise<WorkspaceContext> {
    if (!candidate.repoRoot || candidate.repoRoot === active.root) return active;
    return (await this.contextFor(candidate.repoRoot)) ?? active;
  }

  /**
   * Check one package again, from the registry down.
   *
   * The whole-list rescan was the only way to re-run a check, which made the
   * cheapest question in the panel — "is that still true?" — cost every other
   * package in the project. This asks it about one, including whether a newer
   * version has been published since the scan.
   */
  private async recheck(id: string): Promise<void> {
    const candidate = this.candidates.get(id);
    if (!candidate) return;
    await this.retarget(id, candidate.selected, { refreshVersions: true });
  }

  /**
   * Deep Verification for one row: install this candidate in a throwaway
   * worktree and run this project's own checks against it.
   *
   * Its own `this.run()` call, separate from the Quick Scan that produced
   * `candidate` — Stop during this cancels only this verification, and the
   * rest of `this.candidates` (including this one, if it never finishes) is
   * left exactly as the scan reported it. Nothing here re-runs the static
   * analysis that already found `candidate`'s evidence and impact sites.
   */
  private async verifyOne(id: string): Promise<void> {
    const candidate = this.candidates.get(id);
    if (!candidate) return;
    await this.verifyCandidates([candidate], `Verifying ${candidate.name}`);
  }

  /** Deep Verification for every row that hasn't been measured yet. */
  private async verifyAll(): Promise<void> {
    const eligible = [...this.candidates.values()].filter(
      (c) => !c.verification && c.status !== 'pending' && c.status !== 'checking' && c.status !== 'upgrading',
    );
    if (eligible.length === 0) {
      this.session.notice('info', 'Nothing left to verify — every package has already been checked or measured.');
      return;
    }
    await this.verifyCandidates(eligible, `Verifying ${eligible.length} package${eligible.length === 1 ? '' : 's'}`);
  }

  private async verifyCandidates(targets: UpgradeCandidate[], label: string): Promise<void> {
    const ctx = await this.context();
    if (!ctx) return;

    const byRoot = new Map<string, { ctx: WorkspaceContext; candidates: UpgradeCandidate[] }>();
    for (const candidate of targets) {
      const candidateCtx = await this.contextForCandidate(candidate, ctx);
      if (!candidateCtx.config.verify.enabled) {
        this.session.notice(
          'warn',
          `Deep Verification is disabled for ${candidate.repoLabel ?? 'this repository'} (\`verify.enabled: false\` in drift.yml).`,
        );
        continue;
      }
      const entry = byRoot.get(candidateCtx.root);
      if (entry) entry.candidates.push(candidate);
      else byRoot.set(candidateCtx.root, { ctx: candidateCtx, candidates: [candidate] });
    }
    if (byRoot.size === 0) return;

    const step = this.session.step(label, { key: 'verify' });

    return this.run(async (token) => {
      for (const [root, { ctx: candidateCtx, candidates }] of byRoot) {
        if (token.isCancellationRequested) break;
        for (const candidate of candidates) {
          this.candidates.set(candidate.id, { ...candidate, status: 'checking', phase: 'Waiting to be installed and tested' });
        }
        this.state.setCandidates([...this.candidates.values()]);
        this.refreshPackageList();

        try {
          await runRepoDiagnostic(
            {
              command: 'vscode: drift.verify',
              type: 'verify-deep',
              mode: 'deep',
              repoRoot: root,
              spanName: 'verification',
              spanMeta: { trigger: 'command', packages: candidates.length },
              isCancelled: () => token.isCancellationRequested,
              enabled: vscode.workspace.getConfiguration('drift').get<boolean>('diagnostics.enabled', false),
            },
            () => verifyUpgradeCandidates({
            root,
            candidates,
            config: candidateCtx.config,
            token,
            onProgress: ({ phase, detail, done, total }) => step.progress(phase, detail, done, total),
            onCandidate: (verified) => {
              this.candidates.set(verified.id, verified);
              this.state.setCandidates([...this.candidates.values()]);
              this.refreshPackageList();
            },
            }),
          );
        } catch (err) {
          this.session.notice('error', (err as Error).message);
        }
      }

      const verified = targets.filter((c) => this.candidates.get(c.id)?.verification?.status === 'passed').length;
      const failed = targets.filter((c) => this.candidates.get(c.id)?.verification?.status === 'failed').length;
      if (token.isCancellationRequested) {
        step.fail('Deep Verification stopped — the packages it never reached fall back to their Quick Scan result.');
      } else {
        step.done(
          `Verified ${targets.length} package${targets.length === 1 ? '' : 's'}` +
            (failed > 0 ? ` · ${failed} breaking` : '') +
            (verified > 0 ? ` · ${verified} safe` : ''),
        );
      }
    });
  }

  private async installTool(id: string, requestId: string): Promise<void> {
    const candidate = this.candidates.get(id);
    const request = candidate?.toolRequests.find((entry) => entry.id === requestId);
    if (!candidate || !request) return;

    const commandLine = [request.command, ...request.args].join(' ');
    const choice = await vscode.window.showWarningMessage(
      `Drift can install ${request.label.replace(/^Install\s+/i, '')} and then check ${candidate.name} again. Run \`${commandLine}\`?`,
      request.label,
      'Cancel',
    );
    if (choice !== request.label) return;

    const step = this.session.step(request.label);
    let installed = false;
    await this.run(async () => {
      this.output.info(`Running ${commandLine}`);
      try {
        const { stdout, stderr } = await runCommand(request.command, request.args, {
          cwd: candidate.repoRoot ?? this.state.workspaceRoot ?? undefined,
          env: await envWithShellPath(),
          windowsHide: true,
          timeout: 10 * 60_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        if (stdout.trim()) this.output.info(stdout);
        if (stderr.trim()) this.output.info(stderr);
      } catch (err) {
        const failed = err as Error & { stdout?: string; stderr?: string };
        if (failed.stdout?.trim()) this.output.info(failed.stdout);
        if (failed.stderr?.trim()) this.output.error(failed.stderr);
        throw new Error(`${request.label} failed: ${failed.message}`);
      }

      step.done(`${request.label.replace(/^Install\s+/i, '')} installed`);
      installed = true;
    });

    if (installed) await this.recheck(id);
  }

  private async retarget(
    id: string,
    version: string,
    options: { refreshVersions?: boolean } = {},
  ): Promise<void> {
    const ctx = await this.context();
    const candidate = this.candidates.get(id);
    if (!ctx || !candidate) return;
    const candidateCtx = await this.contextForCandidate(candidate, ctx);

    const step = this.session.step(
      options.refreshVersions
        ? `Re-checking ${candidate.name}`
        : `Re-checking ${candidate.name} at ${version}`,
    );

    await this.run(async () => {
      this.candidates.set(id, { ...candidate, selected: version, status: 'checking' });
      this.state.setCandidates([...this.candidates.values()]);
      this.refreshPackageList();

      const updated = await reanalyzeUpgrade({
        candidate,
        version,
        root: candidateCtx.root,
        repo: candidateCtx.repo,
        config: candidateCtx.config,
        githubToken: await getRateLimitToken(),
        refreshVersions: options.refreshVersions,
        onProgress: (phase, detail) => step.progress(phase, detail),
        output: this.output,
      });

      this.candidates.delete(id);
      this.candidates.set(updated.id, updated);
      this.state.setCandidates([...this.candidates.values()]);
      this.refreshPackageList();
      step.done(describeSeverity(updated));
    });
  }

  /**
   * Install, and say whether it worked.
   *
   * The boolean matters: `/fix` now chains straight from an upgrade into a
   * typecheck and then the agent, and a chain that carries on after a failed
   * install would hand the agent a tree still on the old version — the exact
   * ordering mistake the chain exists to prevent.
   *
   * `quiet` suppresses the follow-on offers ("say /fix", the commit prompt) for
   * callers that are mid-flow and will make those offers themselves at the end.
   */
  private async upgrade(
    ids: readonly string[],
    mode: 'safe' | 'force',
    options: { quiet?: boolean } = {},
  ): Promise<boolean> {
    const ctx = await this.context();
    const candidates = ids
      .map((id) => this.candidates.get(id))
      .filter((c): c is UpgradeCandidate => Boolean(c));

    if (!ctx || candidates.length === 0) {
      this.session.notice('warn', 'Nothing selected to upgrade. Run `/scan` first.');
      return false;
    }

    // Forcing past the declared range is a real decision with real consequences,
    // so it is put to the developer rather than buried in a button label.
    if (mode === 'force') {
      const answer = await this.session.ask(
        `Install ${candidates.map((c) => `**${c.name}@${c.latest}**`).join(', ')} past the range your manifest declares? That widens the constraint and can leave peer dependencies unsatisfied.`,
        [
          { label: 'Yes, force it', value: 'force', description: 'I will deal with any peer conflicts' },
          { label: 'Stay within my range', value: 'safe', description: 'Install the newest compatible version instead' },
          { label: 'Cancel', value: 'cancel' },
        ],
        false,
      );
      if (answer === 'cancel' || answer === '') {
        this.session.notice('info', 'Left your dependencies alone.');
        return false;
      }
      if (answer === 'safe') mode = 'safe';
    }

    // Installing something Drift could not read is a decision, not a default.
    // It is put to the developer in the same shape as forcing past a range,
    // because it carries the same kind of risk: Drift has no idea what this
    // does to their code, and saying nothing would imply it does.
    const unverified = candidates.filter((candidate) => severityOf(candidate) === 'unchecked');
    if (unverified.length > 0) {
      const names = unverified.map((c) => `**${c.name}**`).join(', ');
      const answer = await this.session.ask(
        `I could not verify ${names}. ${
          unverified.length === 1 ? 'There was' : 'There were'
        } no reachable changelog, release notes or type declarations to check against, so "no breaking changes" is not something I can claim here. Install ${unverified.length === 1 ? 'it' : 'them'} anyway?`,
        [
          {
            label: 'Install anyway',
            value: 'yes',
            description: 'I have read the release notes myself',
          },
          {
            label: 'Skip the unverified ones',
            value: 'skip',
            description: 'Upgrade only what Drift could check',
          },
          { label: 'Cancel', value: 'cancel' },
        ],
        false,
      );

      if (answer === 'cancel' || answer === '') {
        this.session.notice('info', 'Left your dependencies alone.');
        return false;
      }
      if (answer === 'skip') {
        const remaining = candidates.filter((c) => severityOf(c) !== 'unchecked');
        if (remaining.length === 0) {
          this.session.notice('info', 'That left nothing to install.');
          return false;
        }
        candidates.length = 0;
        candidates.push(...remaining);
      }
    }

    const upgradeBranches = new Map<string, { mode: SessionBranchMode; name: string }>();
    if (!options.quiet) {
      const byRoot = new Map<string, UpgradeCandidate[]>();
      const contexts = new Map<string, WorkspaceContext>();
      for (const candidate of candidates) {
        const candidateCtx = await this.contextForCandidate(candidate, ctx);
        if (!candidateCtx.info) continue;
        contexts.set(candidateCtx.root, candidateCtx);
        byRoot.set(candidateCtx.root, [...(byRoot.get(candidateCtx.root) ?? []), candidate]);
      }

      for (const [root, group] of byRoot) {
        const proposed = await this.availableBranchName(
          root,
          upgradeBranchName(group, { prefix: await this.branchPrefix(root, contexts.get(root)?.config ?? ctx.config) }),
        );
        const branch = await this.chooseBranch(root, proposed, {
          reason:
            group.length === 1
              ? `installing **${group[0]!.name}**`
              : `installing ${group.length} upgrades in \`${basename(root)}\``,
        });
        if (branch === null) return false;
        upgradeBranches.set(root, branch);
      }
    }

    const step = this.session.step(`Upgrading ${candidates.length} package${candidates.length === 1 ? '' : 's'}`);

    let installed = true;
    let committedAny = false;
    const branched = new Set<string>();

    await this.run(async () => {
      for (const candidate of candidates) {
        const candidateCtx = await this.contextForCandidate(candidate, ctx);
        const branch = upgradeBranches.get(candidateCtx.root);
        if (branch?.mode === 'new' && !branched.has(candidateCtx.root)) {
          const actual = await this.startBranch(candidateCtx.root, branch.name);
          if (actual === null) {
            installed = false;
            return;
          }
          branch.name = actual;
          branched.add(candidateCtx.root);
        }

        // "Upgrade to <latest>" means install `latest`; the ordinary Upgrade
        // means install `selected`. This read `candidate.selected` for both,
        // which made the comparison below dead code and the force prompt a
        // lie: the dialog asked to install past the declared range, and then
        // installed the in-range version with `--force` bolted on.
        const target = mode === 'force' ? candidate.latest : candidate.selected;
        let current = candidate;

        // A different version is a different analysis. The evidence on screen
        // was gathered for `selected`, and presenting it as if it described
        // `latest` is the same category of claim Drift exists to stop making.
        if (target !== candidate.selected) {
          step.progress('Re-checking evidence', `${candidate.name}@${target}`);
          current = await reanalyzeUpgrade({
            candidate,
            version: target,
            root: candidateCtx.root,
            repo: candidateCtx.repo,
            config: candidateCtx.config,
            githubToken: await getRateLimitToken(),
            onProgress: (phase, detail) => step.progress(phase, detail),
            output: this.output,
          });
          this.candidates.delete(candidate.id);
        }

        const command = upgradeCommandFor(current, mode);
        step.progress(command ? `Running ${command}` : 'Upgrading', `${current.name}@${target}`);
        this.candidates.set(current.id, { ...current, status: 'upgrading' });
        this.refreshPackageList();

        const stashed = await this.stashUserChangesForUpgrade(candidateCtx.root);
        try {
          await installUpgrade(candidateCtx.root, current, mode);
        } catch (err) {
          await this.restoreUserChangesAfterUpgrade(candidateCtx.root, stashed);
          this.candidates.set(current.id, { ...current, status: 'error', error: (err as Error).message });
          this.refreshPackageList();
          step.fail(`Upgrade failed for ${current.name}`);
          this.session.notice(
            'error',
            command
              ? `\`${command}\` failed: ${(err as Error).message}`
              : (err as Error).message,
          );
          installed = false;
          return;
        }

        if (candidateCtx.info) {
          if (!(await this.commitUpgradeFiles(candidateCtx.root, [current]))) {
            await this.restoreUserChangesAfterUpgrade(candidateCtx.root, stashed);
            installed = false;
            return;
          }
          committedAny = true;
        } else {
          this.session.notice(
            'info',
            `Updated **${current.name}**, but this folder is not using Git, so there is no upgrade commit.`,
          );
        }

        if (!(await this.restoreUserChangesAfterUpgrade(candidateCtx.root, stashed))) {
          installed = false;
          return;
        }

        this.candidates.set(current.id, { ...current, status: 'ready' });
        this.refreshPackageList();
        // Checked rather than assumed. "Safe mode" is a request, not a result:
        // when a package publishes nothing inside the declared range, the
        // target falls back to the version the developer selected, which can
        // sit well outside it — and this line used to claim otherwise on the
        // strength of the mode alone. A tool whose whole job is telling people
        // what is safe cannot afford a reassurance it has not verified.
        const withinRange = satisfiesRange(target, current.range);
        this.session.notice(
          'success',
          mode === 'force'
            ? `Forced **${current.name}** to ${target}. Check for peer-dependency conflicts before committing.`
            : withinRange
              ? `Updated **${current.name}** to ${target}, within the \`${current.range}\` already in \`${manifestName(current)}\`.`
              : `Updated **${current.name}** to ${target}. That is **outside** the \`${current.range}\` in \`${manifestName(current)}\`, so the range needs widening or the two will disagree.`,
        );

        await this.confirmInstalled(candidateCtx.root, current, target);
      }

      step.done('Dependency files updated');

      // Mid-flow callers run the project's checks themselves, once, and feed
      // the result to the agent. Running them here as well would be the same
      // minutes spent twice for the same answer.
      if (options.quiet) return;

      // An upgrade writes a lockfile and a manifest, which is exactly the kind
      // of change a project's own build catches and a diff does not.
      await this.verifyUpgrade(ctx.root, candidates);

      const affected = candidates.filter((c) => this.currentFor(c) && severityOf(this.currentFor(c)!) === 'affected');
      if (affected.length > 0) {
        this.session.say(
          `${affected.length === 1 ? 'That upgrade needs' : 'Those upgrades need'} code changes here.`,
          [
            {
              label: `Fix them with ${this.agentLabel()}`,
              command: '/fix',
              primary: true,
              hint: 'Runs your typecheck first, then hands the real errors to the agent with the evidence',
            },
            { label: 'Review the changes', command: '/review' },
            { label: 'File a GitHub issue instead', command: '/issue' },
          ],
        );
      }

      // An upgrade that stops at a modified lockfile has done the interesting
      // half of the job and left the tedious half. The branch, the message and
      // the pull request body are all things Drift already knows, so they are
      // offered here rather than left as homework — except when there is code to
      // fix first, where committing now would split one change across two
      // commits and leave the branch broken in the middle.
      this.lastUpgraded = candidates.map((c) => this.currentFor(c) ?? c);
      if (affected.length === 0 && !committedAny) await this.offerToCommit(this.lastUpgraded);
    });

    return installed;
  }

  /**
   * Check that the upgrade Drift just reported is the one on disk.
   *
   * An install command that exits zero has not necessarily written what it was
   * asked to write. This repository ended up with `^5.7.3` in its manifest,
   * `5.9.3` in its lockfile and `7.0.2` in `node_modules` — three answers to
   * one question, and every subsequent step trusted the wrong one: the panel
   * said the upgrade was in range, `/fix` was offered against an API that only
   * existed in the installed copy, and `npm ci` on any other machine would have
   * silently produced a different build.
   *
   * Nothing is repaired here. A manifest is the developer's file and rewriting
   * it behind an upgrade they were told had already succeeded is how three
   * answers became four. Saying exactly which three disagree is enough.
   */
  private async confirmInstalled(root: string, candidate: UpgradeCandidate, target: string): Promise<void> {
    const installed = await installedVersion(root, candidate);
    if (!installed) return;

    if (installed === target) return;

    this.session.notice(
      'warn',
      [
        `**${candidate.name}** was asked to move to ${target}, but \`node_modules\` now holds ${installed}.`,
        '',
        `\`${candidate.manifestPath}\` still declares \`${candidate.range}\`. Until those agree, a fresh install on another machine will not reproduce what is here — run the upgrade again, or set the range by hand.`,
      ].join('\n'),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Branching, committing, pushing, pull requests                     */
  /* ---------------------------------------------------------------- */

  /**
   * The branch-name prefix Drift uses, so a team can keep its own convention.
   *
   * An explicit editor setting wins, because it is the more specific statement
   * of intent. Absent one, the repository's own `.github/drift.yml` already
   * names the prefix its cloud fixes use, and a branch made in the panel should
   * look like a branch made anywhere else in the same repository.
   *
   * Led by the branch this is being cut from. `git branch --list` reads as a
   * flat namespace otherwise, and six repos in it makes it hard to tell which
   * `drift/upgrade-...` came off `main` and which came off a release branch —
   * the source branch answers that before the rest of the name has to.
   */
  private async branchPrefix(root: string, config?: DriftConfig): Promise<string> {
    const setting = vscode.workspace.getConfiguration('drift').inspect<string>('git.branchPrefix');
    const explicit =
      setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
    const chosen = (explicit ?? config?.remediation.branchPrefix ?? 'drift').replace(/\/+$/, '') || 'drift';

    const { Git } = await import('../git.js');
    const source = await new Git(root).currentBranch().catch(() => null);
    return source && source !== 'HEAD' ? `${source}/${chosen}` : chosen;
  }

  /**
   * Whether to credit Drift as a co-author on commits.
   *
   * You stay the author — you chose the upgrade and reviewed the diff. Off is
   * offered because some repositories lint commit trailers, and a tool that
   * cannot be told to stop adding one gets uninstalled.
   */
  private coAuthorOption(config?: DriftConfig): { coAuthors?: false } {
    const inspected = vscode.workspace.getConfiguration('drift').inspect<boolean>('git.coAuthor');
    const explicit =
      inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    const enabled = explicit ?? config?.pullRequest.coAuthor ?? true;
    return enabled ? {} : { coAuthors: false };
  }

  /**
   * How this workspace wants pull requests opened.
   *
   * Same precedence as `branchPrefix`: an explicit editor setting is the more
   * specific statement of intent and wins, and otherwise the repository's own
   * `.github/drift.yml` decides — so a pull request raised from the panel looks
   * like one raised by the Action against the same repository.
   */
  private pullRequestSettings(config?: DriftConfig): {
    enabled: boolean;
    confirm: boolean;
    base: 'branched-from' | 'default-branch';
    draft: boolean;
    labels: readonly string[];
    reviewers: readonly string[];
  } {
    const settings = vscode.workspace.getConfiguration('drift');
    const explicit = <T>(key: string): T | undefined => {
      const inspected = settings.inspect<T>(key);
      return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    };

    const fromConfig = config?.pullRequest;

    return {
      enabled: explicit<boolean>('pullRequest.enabled') ?? fromConfig?.enabled ?? true,
      confirm:
        (explicit<string>('pullRequest.confirm') ?? fromConfig?.confirm ?? 'ask') === 'ask',
      base:
        explicit<'branched-from' | 'default-branch'>('pullRequest.base') ??
        fromConfig?.base ??
        'branched-from',
      // Through the shared resolver once drift.yml is in play, so the panel and
      // the Action agree about the deprecated `remediation.draftPr` spelling
      // rather than each applying its own precedence.
      draft:
        explicit<boolean>('pullRequest.draft') ??
        (config ? opensPullRequestAsDraft(config) : true),
      // Repository policy only. There is no editor setting for these: a label
      // set or a reviewer list is a property of the repository everyone shares,
      // not of one developer's editor, so `.github/drift.yml` is the only place
      // it can be stated once and mean the same thing for the Action, the CLI
      // and the panel.
      labels: config?.pullRequest.labels ?? [],
      reviewers: config?.pullRequest.reviewers ?? [],
    };
  }

  /**
   * Offer to turn an upgrade into a commit, and then into a pull request.
   *
   * Candidates are grouped by the repository they came from: with more than one
   * root open, a single `/upgrade-all` can touch two checkouts, and one commit
   * spanning both is not a thing git can express.
   */
  private async offerToCommit(candidates: readonly UpgradeCandidate[]): Promise<void> {
    const ctx = await this.context();
    if (!ctx) return;

    const byRoot = new Map<string, UpgradeCandidate[]>();
    for (const candidate of candidates) {
      const root = candidate.repoRoot ?? ctx.root;
      byRoot.set(root, [...(byRoot.get(root) ?? []), candidate]);
    }

    for (const [root, group] of byRoot) {
      const { Git } = await import('../git.js');
      const git = new Git(root);
      const dirty = await git.dirtyFiles().catch(() => []);
      const paths = dependencyPaths(group, dirty);

      // Nothing on disk changed — the install was a no-op, or the developer
      // already committed it themselves. Either way there is nothing to offer.
      if (paths.length === 0) continue;

      await this.ship(root, {
        paths,
        branchName: upgradeBranchName(group, { prefix: await this.branchPrefix(root, ctx.config) }),
        message: upgradeCommitMessage(group),
        prBody: pullRequestBody(group),
        summary:
          group.length === 1
            ? `**${group[0]!.name}** is now ${group[0]!.selected}.`
            : `${group.length} packages upgraded.`,
      });
    }
  }

  /**
   * Every uncommitted change, side by side with what it was.
   *
   * The panel could already open one file's diff, from the review card, which
   * answers "what happened to this file" and never "what happened". Reviewing a
   * migration means reading all of it, and doing that a file at a time from a
   * list is exactly the friction that makes people skim and keep. VS Code's
   * multi-file diff editor is the same view the SCM sidebar and GitLens use, so
   * this is the familiar one rather than a fourth way to look at a change.
   */
  private async reviewAllChanges(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository to review changes.');
      return;
    }

    const { Git } = await import('../git.js');
    const git = new Git(ctx.root);
    const dirty = await git.dirtyFiles().catch(() => []);

    if (dirty.length === 0) {
      this.session.notice('info', 'Nothing is changed in your working tree right now.');
      return;
    }

    const resources = dirty.map((path) => vscode.Uri.file(join(ctx.root, path)));

    try {
      await vscode.commands.executeCommand(
        'vscode.changes',
        `Drift: ${dirty.length} changed file${dirty.length === 1 ? '' : 's'}`,
        // Each row is [label, before, after]. `git:` URIs resolve through the
        // built-in git extension's content provider, so "before" is HEAD.
        resources.map((uri) => [uri, uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref: 'HEAD' }) }), uri]),
      );
    } catch {
      // The multi-diff editor needs the built-in git extension active. Falling
      // back to the SCM view is worse but still shows every file, which beats
      // an error message that leaves the developer with nothing to click.
      await vscode.commands.executeCommand('workbench.view.scm');
      this.session.notice(
        'info',
        `Opened Source Control with ${dirty.length} changed file${dirty.length === 1 ? '' : 's'}.`,
      );
    }
  }

  /**
   * Commit what is in the tree now, whatever produced it.
   *
   * `/commit` is deliberately about dependency files, because that is what an
   * upgrade leaves behind. After a fix the interesting change is the code, and
   * a developer looking at edited source with no commit button reasonably
   * concludes Drift has no intention of committing it.
   */
  private async commitNow(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository to commit.');
      return;
    }

    const { Git } = await import('../git.js');
    const git = new Git(ctx.root);
    const paths = await git.dirtyFiles().catch(() => []);

    if (paths.length === 0) {
      this.session.notice('info', 'Nothing is changed, so there is nothing to commit.');
      return;
    }

    const plan = this.state.plan;
    await this.ship(ctx.root, {
      paths,
      branchName: plan?.branchName ?? `${await this.branchPrefix(ctx.root, ctx.config)}/changes-${new Date().toISOString().slice(0, 10)}`,
      message: {
        subject: plan?.commits[0]?.message ?? 'chore: apply Drift changes',
        body: paths.map((path) => `- ${path}`).join('\n'),
      },
      prBody: ['Changes made in the Drift panel.', '', ...paths.map((path) => `- \`${path}\``)].join('\n'),
      summary: `${paths.length} changed file${paths.length === 1 ? '' : 's'} in your working tree.`,
    });
  }

  /**
   * `/commit` — commit whatever dependency work is sitting in the tree.
   *
   * Uses the last upgrade when there was one, because that carries the evidence
   * and the version numbers. Absent that, it falls back to whatever manifests
   * and lockfiles are dirty, which is the honest thing to describe when Drift
   * did not do the installing.
   */
  private async commitDependencyChanges(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository to commit.');
      return;
    }

    if (this.lastUpgraded.length > 0) {
      await this.offerToCommit(this.lastUpgraded);
      return;
    }

    const { Git } = await import('../git.js');
    const git = new Git(ctx.root);
    const paths = dependencyFilesIn(await git.dirtyFiles().catch(() => []));

    if (paths.length === 0) {
      this.session.notice(
        'info',
        'No manifest or lockfile has changed, so there is no dependency work to commit. Run `/scan` to see what is available.',
      );
      return;
    }

    await this.ship(ctx.root, {
      paths,
      branchName: `${await this.branchPrefix(ctx.root, ctx.config)}/dependencies-${new Date().toISOString().slice(0, 10)}`,
      message: {
        subject: 'chore(deps): update dependencies',
        body: paths.map((path) => `- ${path}`).join('\n'),
      },
      prBody: [
        'Updates dependency manifests and lockfiles.',
        '',
        ...paths.map((path) => `- \`${path}\``),
      ].join('\n'),
      summary: `${paths.length} dependency file${paths.length === 1 ? '' : 's'} changed.`,
    });
  }

  /**
   * The branch → commit → push → pull request offer.
   *
   * Every step is a question with an answer that stops. Nothing here rewrites
   * history, touches the base branch, or force-pushes, and the commit is scoped
   * to the paths passed in — a developer with unfinished work elsewhere in the
   * tree gets the dependency commit and keeps the rest.
   */
  private async ship(
    root: string,
    plan: { paths: string[]; branchName: string; message: CommitMessage; prBody: string; summary: string },
  ): Promise<void> {
    const { Git } = await import('../git.js');
    const git = new Git(root);

    const current = await git.currentBranch().catch(() => 'HEAD');
    const detached = current === 'HEAD';
    const unborn = await git.isUnborn().catch(() => false);
    const fileList = plan.paths.map((path) => `\`${path}\``).join(', ');

    const answer = await this.session.ask(
      `${plan.summary} ${plan.paths.length === 1 ? 'One file is' : `${plan.paths.length} files are`} changed and uncommitted: ${fileList}. What should I do with ${plan.paths.length === 1 ? 'it' : 'them'}?`,
      [
        {
          label: 'Branch and commit',
          value: 'branch',
          description: `Create \`${plan.branchName}\` and commit there`,
        },
        ...(detached || unborn
          ? []
          : [
              {
                label: `Commit on \`${current}\``,
                value: 'here',
                description: 'Stay on the branch you are on',
              },
            ]),
        { label: 'Stage only', value: 'stage', description: 'I will write the commit myself' },
        { label: 'Leave it', value: 'no', description: 'The files stay changed and uncommitted' },
      ],
      false,
    );

    if (answer === 'no' || answer === '') {
      this.session.notice('info', 'Left uncommitted. Say `/commit` whenever you are ready.');
      return;
    }

    if (answer === 'stage') {
      try {
        await git.stagePaths(plan.paths);
        this.session.notice(
          'success',
          `Staged ${plan.paths.length} file${plan.paths.length === 1 ? '' : 's'}. Suggested message:\n\n\`\`\`\n${plan.message.subject}\n\n${plan.message.body}\n\`\`\``,
        );
      } catch (err) {
        this.session.notice('error', `Could not stage those files: ${(err as Error).message}`);
      }
      return;
    }

    let branch = current;
    if (answer === 'branch') {
      try {
        const { created, name } = await git.createBranch(plan.branchName);
        branch = name;
        this.session.notice(
          'info',
          created
            ? `Created and switched to \`${branch}\`.`
            : `\`${branch}\` already existed, so I switched to it rather than making a second one.`,
        );
      } catch (err) {
        this.session.notice(
          'error',
          `Could not create \`${plan.branchName}\`: ${(err as Error).message}. Nothing was committed.`,
        );
        return;
      }
    }

    let sha: string | null = null;
    try {
      sha = await git.commitPaths(
        plan.paths,
        plan.message.subject,
        plan.message.body,
        this.coAuthorOption(),
      );
    } catch (err) {
      this.session.notice('error', `Commit failed: ${(err as Error).message}`);
      return;
    }

    if (!sha) {
      this.session.notice('info', 'Those files matched what is already committed, so there was nothing to commit.');
      return;
    }

    this.session.notice('success', `Committed **${sha.slice(0, 7)}** on \`${branch}\` — ${plan.message.subject}`);
    await this.offerToPush(root, branch, plan);
  }

  /**
   * Offer to push, and to open the pull request.
   *
   * Pushing is where Drift stops being a local tool, so it is the one place
   * that asks for GitHub access — and it asks only after there is a commit
   * worth pushing.
   */
  private async offerToPush(
    root: string,
    branch: string,
    plan: { message: CommitMessage; prBody: string },
  ): Promise<void> {
    const { Git } = await import('../git.js');
    const git = new Git(root);

    if (!(await git.hasRemote())) {
      this.session.say(
        `The commit is on \`${branch}\`. This repository has no \`origin\` remote, so there is nowhere to push it yet.`,
      );
      return;
    }

    const remote = await git.remoteUrl();
    const slug = remoteSlug(remote);

    // Target the branch this work was started from, not the repository's
    // default. On a team that develops on `develop`, targeting `main` proposes
    // merging into the wrong place — and a pull request pointed at the wrong
    // base shows a diff full of other people's commits.
    const prSettings = this.pullRequestSettings((await this.context())?.config);
    const resolved = resolveBaseBranch({
      policy: prSettings.base,
      branchedFrom: await git.branchedFrom(branch),
      defaultBranch: await git.defaultBranch(),
      currentBranch: branch,
    });
    const base = resolved?.branch ?? null;

    // A pull request needs somewhere to merge *into*. Committing straight onto
    // the default branch is a legitimate choice, but it leaves no PR to open,
    // and saying so beats offering a button that returns a 422.
    const canOpenPr = Boolean(slug) && Boolean(base) && prSettings.enabled;

    const answer = await this.session.ask(
      canOpenPr
        ? `Push \`${branch}\` to \`origin\` and open a pull request into \`${base}\`?`
        : `Push \`${branch}\` to \`origin\`?${
            slug && base === branch ? ` It is your default branch, so there is no pull request to open.` : ''
          }`,
      [
        ...(canOpenPr
          ? [{ label: 'Push and open a pull request', value: 'pr', description: `${branch} → ${base}` }]
          : []),
        // `resolveBaseBranch` guesses from the reflog and the remote's default —
        // right for a feature branch, wrong the moment someone is stacking work
        // on top of another branch rather than merging straight back to main.
        ...(slug ? [{ label: 'Choose a different base branch', value: 'pr-other', description: 'Pick where the pull request lands' }] : []),
        { label: 'Push only', value: 'push', description: 'Send the branch, open the PR yourself' },
        { label: 'Not yet', value: 'no', description: 'The commit stays local' },
      ],
      false,
    );

    if (answer === 'no' || answer === '') {
      this.session.notice('info', `Kept local. Say \`/push\` when you want \`${branch}\` on the remote.`);
      return;
    }

    let chosenBase = base;
    let baseReason = resolved?.reason;
    if (answer === 'pr-other') {
      const branches = (await git.listBranches()).filter((name) => name !== branch);
      if (branches.length === 0) {
        this.session.notice('warn', 'There is no other local branch to target — pushing only.');
      } else {
        const picked = await this.session.ask(
          `Which branch should \`${branch}\` merge into?`,
          branches.map((name) => ({ label: name, value: name })),
          false,
        );
        if (!picked) {
          this.session.notice('info', `Kept local. Say \`/push\` when you want \`${branch}\` on the remote.`);
          return;
        }
        chosenBase = picked;
        baseReason = undefined;
      }
    }

    const step = this.session.step(`Pushing ${branch}`);
    try {
      step.progress('Pushing', `${branch} → origin`);
      await git.push(branch);
      step.done(`Pushed ${branch}`);
    } catch (err) {
      step.fail('Push failed');
      this.session.notice(
        'error',
        `Could not push \`${branch}\`: ${(err as Error).message}. The commit is safe locally.`,
      );
      return;
    }

    if ((answer !== 'pr' && answer !== 'pr-other') || !slug || !chosenBase) {
      const url = compareUrl(remote, chosenBase ?? 'main', branch);
      this.session.say(
        url
          ? `\`${branch}\` is on the remote. [Open a pull request](${url}) when you are ready.`
          : `\`${branch}\` is on the remote.`,
      );
      return;
    }

    await this.createPullRequest({
      slug,
      remote,
      base: chosenBase,
      branch,
      root,
      plan,
      ...(baseReason ? { baseReason } : {}),
      confirm: prSettings.confirm,
      ...(prSettings.draft ? { draft: true } : {}),
      labels: prSettings.labels,
      reviewers: prSettings.reviewers,
    });
  }

  /**
   * Plain text for a native VS Code prompt.
   *
   * The base-branch reason is written once, in markdown, for the chat panel.
   * An input box renders backticks literally, so they are stripped rather than
   * a second copy of the sentence being maintained.
   */
  private static plainText(markdown: string): string {
    return markdown.replace(/[`*_]/g, '');
  }

  /**
   * Raise the pull request: the GitHub CLI first, then the API, then the browser.
   *
   * The order is about how little the developer has to do. `gh`, when it is
   * installed and signed in, needs nothing from them at all — no editor
   * sign-in prompt, no token, no consent dialog for a scope they already
   * granted their terminal. The VS Code GitHub session is the next best thing
   * and costs one click. The compare page is the floor, and it is a floor
   * rather than a failure: the branch is already pushed by the time any of this
   * runs, so the worst outcome is a link that opens GitHub's own form with the
   * right refs already filled in.
   *
   * Which is also why nothing here is fatal. A missing `gh`, a declined
   * sign-in, a token without `repo`, an enterprise host Drift was not built
   * against — every one of them ends at the same link, and failing to open a
   * pull request is never allowed to look like failing to do the work.
   */
  private async createPullRequest(args: {
    slug: string;
    remote: string | null;
    base: string;
    branch: string;
    /** The checkout `gh` should run in. */
    root: string;
    plan: { message: CommitMessage; prBody: string };
    /** How the base was chosen, so the target is never a mystery. */
    baseReason?: string;
    /** Confirm the title before opening. Skipped when configured to `never`. */
    confirm?: boolean;
    draft?: boolean;
    labels?: readonly string[];
    reviewers?: readonly string[];
  }): Promise<void> {
    const fallback = compareUrl(args.remote, args.base, args.branch);

    // A proposed title the developer can edit beats a good one they cannot.
    // The name is Drift's suggestion, not its decision.
    let title = args.plan.message.subject;
    if (args.confirm !== false) {
      const edited = await vscode.window.showInputBox({
        title: 'Open a pull request',
        prompt: `${args.branch} → ${args.base}${args.baseReason ? ` — ${DriftHomeView.plainText(args.baseReason)}` : ''}`,
        value: title,
        valueSelection: [0, title.length],
        ignoreFocusOut: true,
      });
      if (edited === undefined) {
        this.session.say(
          `\`${args.branch}\` is pushed and I have not opened a pull request. Say \`/pr\` when you want one.`,
        );
        return;
      }
      title = edited.trim() || title;
    }

    // The GitHub CLI, if this machine has one signed in. It carries its own
    // credential, so this path asks the developer for nothing.
    const viaCli = await this.createPullRequestWithCli({ ...args, title });
    if (viaCli) return;

    const session = await getGitHubSession({ createIfNone: true });

    if (!session) {
      this.session.say(
        fallback
          ? `\`${args.branch}\` is pushed. Without GitHub access I cannot open the pull request for you — [open it here](${fallback}) instead.`
          : `\`${args.branch}\` is pushed. Open the pull request from GitHub when you are ready.`,
      );
      return;
    }

    const step = this.session.step('Opening a pull request');
    try {
      const pr = await openPullRequest({
        token: session.accessToken,
        slug: args.slug,
        head: args.branch,
        base: args.base,
        title,
        body: args.plan.prBody,
        ...(args.draft ? { draft: true } : {}),
      });

      step.done(pr.existing ? `Pull request #${pr.number} already open` : `Opened #${pr.number}`);
      this.session.say(
        pr.existing
          ? `A pull request for \`${args.branch}\` was already open: [#${pr.number}](${pr.url}). The new commit is on it.`
          : `Opened [#${pr.number}](${pr.url}) — \`${args.branch}\` into \`${args.base}\`${
              args.baseReason ? ` (${args.baseReason})` : ''
            }. The description carries the evidence: what changed upstream, and what it touches here.`,
      );
      await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    } catch (err) {
      step.fail('Could not open the pull request');
      this.session.notice(
        'warn',
        fallback
          ? `GitHub would not open the pull request: ${(err as Error).message} — [open it yourself](${fallback}). The branch is pushed either way.`
          : `GitHub would not open the pull request: ${(err as Error).message}. The branch is pushed either way.`,
      );
    }
  }

  /**
   * The `gh` attempt, which either produces a pull request or gets out of the way.
   *
   * `false` means "carry on down the chain" and is the answer for every case
   * `gh` cannot serve: not installed, installed but signed out, or a genuine
   * refusal from GitHub. Only the last of those is worth a line in the panel —
   * a machine without the GitHub CLI is not a machine with a problem, and
   * saying so would advertise an install Drift does not require.
   */
  private async createPullRequestWithCli(args: {
    root: string;
    branch: string;
    base: string;
    title: string;
    baseReason?: string;
    draft?: boolean;
    labels?: readonly string[];
    reviewers?: readonly string[];
    plan: { prBody: string };
  }): Promise<boolean> {
    let step: StepHandle | undefined;
    const outcome = await createPullRequestWithGh({
      cwd: args.root,
      head: args.branch,
      base: args.base,
      title: args.title,
      body: args.plan.prBody,
      ...(args.draft ? { draft: true } : {}),
      ...(args.labels?.length ? { labels: args.labels } : {}),
      ...(args.reviewers?.length ? { reviewers: args.reviewers } : {}),
      // Only announce the attempt once `gh` is known to be able to make it.
      onAttempt: () => {
        step = this.session.step('Opening a pull request');
      },
    });

    if (outcome.kind === 'opened') {
      const { pr } = outcome;
      step?.done(pr.existing ? `Pull request #${pr.number} already open` : `Opened #${pr.number}`);
      this.session.say(
        pr.existing
          ? `A pull request for \`${args.branch}\` was already open: [#${pr.number}](${pr.url}). The new commit is on it.`
          : `Opened [#${pr.number}](${pr.url}) — \`${args.branch}\` into \`${args.base}\`${
              args.baseReason ? ` (${args.baseReason})` : ''
            }. The description carries the evidence: what changed upstream, and what it touches here.`,
      );
      await vscode.env.openExternal(vscode.Uri.parse(pr.url));
      return true;
    }

    if (outcome.kind === 'failed') {
      step?.fail('The GitHub CLI could not open it');
      this.output.info(`gh pr create did not open a pull request: ${outcome.message}`);
    }
    return false;
  }

  /**
   * The same offer, for a fix the developer has just kept.
   *
   * The pull request body is the report Drift already renders for the cloud
   * agent's PRs — the breaking changes, the sites, the evidence behind each one.
   * A local fix deserves the same review material as a remote one.
   */
  private async offerToPushFix(root: string, branch: string): Promise<void> {
    const plan = this.state.plan;
    const ctx = await this.contextFor(root);
    const packages = plan ? [...new Set(plan.changes.map((change) => change.name))] : [];

    const subject =
      packages.length === 0
        ? 'fix: update code for upgraded dependencies'
        : packages.length === 1
          ? `fix: update code for ${packages[0]}`
          : `fix: update code for ${packages.length} upgraded dependencies`;

    await this.offerToPush(root, branch, {
      message: { subject, body: '' },
      prBody:
        plan && ctx
          ? renderPullRequestBody(plan, ctx.config)
          : `Code changes made with Drift on \`${branch}\`.`,
    });
  }

  /** `/push` — send the current branch to `origin`, nothing else. */
  private async pushCurrentBranch(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository to push.');
      return;
    }

    const { Git } = await import('../git.js');
    const git = new Git(ctx.root);
    const branch = await git.currentBranch().catch(() => 'HEAD');

    if (branch === 'HEAD') {
      this.session.notice('warn', 'You are on a detached HEAD, so there is no branch to push. Say `/commit` to make one.');
      return;
    }
    if (!(await git.hasRemote())) {
      this.session.notice('warn', 'This repository has no `origin` remote, so there is nowhere to push.');
      return;
    }

    const step = this.session.step(`Pushing ${branch}`);
    try {
      await git.push(branch);
      step.done(`Pushed ${branch}`);
      const url = compareUrl(await git.remoteUrl(), (await git.defaultBranch()) ?? 'main', branch);
      this.session.say(
        url
          ? `\`${branch}\` is on the remote. Say \`/pr\` and I will open the pull request, or [open it yourself](${url}).`
          : `\`${branch}\` is on the remote.`,
      );
    } catch (err) {
      step.fail('Push failed');
      this.session.notice('error', `Could not push \`${branch}\`: ${(err as Error).message}`);
    }
  }

  /** `/pr` — push if needed, then open the pull request for the current branch. */
  private async openPullRequestForBranch(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository to raise a pull request.');
      return;
    }

    const { Git } = await import('../git.js');
    const git = new Git(ctx.root);
    const branch = await git.currentBranch().catch(() => 'HEAD');
    const remote = await git.remoteUrl();
    const slug = remoteSlug(remote);

    if (branch === 'HEAD') {
      this.session.notice('warn', 'You are on a detached HEAD. Say `/commit` to put this work on a branch first.');
      return;
    }
    if (!slug) {
      this.session.notice('warn', 'This repository has no GitHub `origin` remote, so there is no pull request to open.');
      return;
    }

    // The branch this work was started from, not the repository's default. On
    // a team that develops on `develop`, targeting `main` proposes merging into
    // the wrong place and shows a diff full of other people's commits.
    const prSettings = this.pullRequestSettings((await this.context())?.config);
    const resolved = resolveBaseBranch({
      policy: prSettings.base,
      branchedFrom: await git.branchedFrom(branch),
      defaultBranch: await git.defaultBranch(),
      currentBranch: branch,
    });

    if (!resolved) {
      this.session.notice(
        'warn',
        `\`${branch}\` is the branch a pull request would merge into. Say \`/commit\` and I will put the work on its own branch first.`,
      );
      return;
    }
    const base = resolved.branch;

    if (!(await git.hasUpstream(branch))) {
      const step = this.session.step(`Pushing ${branch}`);
      try {
        await git.push(branch);
        step.done(`Pushed ${branch}`);
      } catch (err) {
        step.fail('Push failed');
        this.session.notice('error', `Could not push \`${branch}\`: ${(err as Error).message}`);
        return;
      }
    }

    const plan =
      this.lastUpgraded.length > 0
        ? { message: upgradeCommitMessage(this.lastUpgraded), prBody: pullRequestBody(this.lastUpgraded) }
        : {
            message: { subject: `Changes on ${branch}`, body: '' },
            prBody: `Opened from the Drift panel for \`${branch}\`.`,
          };

    await this.createPullRequest({
      slug,
      remote,
      base,
      branch,
      root: ctx.root,
      plan,
      baseReason: resolved.reason,
      confirm: prSettings.confirm,
      ...(prSettings.draft ? { draft: true } : {}),
      labels: prSettings.labels,
      reviewers: prSettings.reviewers,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Fixing                                                            */
  /* ---------------------------------------------------------------- */

  private async fix(
    ids: readonly string[],
    options: { revision?: RevisionRequest } = {},
  ): Promise<void> {
    if (this.busy) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    if (this.session.mode === 'ask') {
      this.session.say(
        'The composer is set to **Ask**, so I will not edit anything. Switch it to **Agent** to let your AI agent make the changes.',
      );
      return;
    }

    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository to fix code.');
      return;
    }
    if (!ctx.info) {
      this.session.notice(
        'warn',
        'Fixes need Git so Drift can branch, checkpoint, and keep commits reviewable. Run `git init` first, then try `/fix` again.',
      );
      return;
    }

    const candidates = ids
      .map((id) => this.candidates.get(id))
      .filter((c): c is UpgradeCandidate => Boolean(c?.plan));

    const plan =
      candidates.length > 0
        ? combinePlans(ctx.repo, ctx.config, candidates.map((c) => c.plan!))
        : this.state.plan;

    if (!plan) {
      this.session.notice('warn', 'Nothing to fix yet. Run `/scan` or `/recent` first.');
      return;
    }

    if (plan.commits.length === 0 || plan.impactSites.length === 0) {
      // "Upgrading is all that is needed" is a compatibility claim, and a
      // runtime requirement Drift could not resolve produces exactly this
      // shape -- no commits, no sites -- without having established it.
      const runtimeUnresolved = (plan.rationale ?? []).some(
        (entry) =>
          entry.assessment.runtimeCompatibility === 'unknown' ||
          entry.assessment.runtimeCompatibility === 'partial',
      );
      const hasReview = (plan.dispositions ?? []).some((d) => d.state === 'review-only' || d.state === 'unknown');
      this.session.say(
        runtimeUnresolved || hasReview
          ? 'There is nothing for an agent to edit, but this upgrade carries a runtime requirement Drift could not check against this repository. Confirm the runtime version you build and deploy on before upgrading.'
          : 'There is nothing for an agent to edit — no code in this repository uses the APIs that changed. Upgrading is all that is needed.',
      );
      return;
    }

    // Where this lands, asked before anything is installed or edited.
    //
    // Deliberately first: the upgrade writes a manifest and a lockfile, and
    // those belong on the same branch as the code changes that go with them.
    // Branching afterwards would leave half the change behind.
    const { Git } = await import('../git.js');
    const sourceBranch = await new Git(ctx.root).currentBranch().catch(() => null);
    const prefixedBranchName =
      sourceBranch && sourceBranch !== 'HEAD' ? `${sourceBranch}/${plan.branchName}` : plan.branchName;
    const proposedBranch = await this.availableBranchName(ctx.root, prefixedBranchName);
    const branch = await this.chooseBranch(ctx.root, proposedBranch);
    if (branch === null) return;

    // Upgrade first, fix second, and never the other way round.
    //
    // Every fix prompt tells the agent "the dependency versions have ALREADY
    // been updated", and the impact sites were computed against the new API. Run
    // that against a tree still on the old version and the agent is editing
    // working code to match a package that is not installed: the build breaks on
    // the spot, and it stays broken until the upgrade lands. Which order this
    // happens in is not a preference, so it is checked rather than assumed.
    const notInstalled = candidates.filter((candidate) => candidate.current !== candidate.selected);
    let upgraded = false;

    if (notInstalled.length > 0) {
      // The branch is created here rather than inside `runFix`, so the
      // manifest, the lockfile and the code changes all land together.
      if (branch.mode === 'new') {
        const actual = await this.startBranch(ctx.root, branch.name);
        if (actual === null) return;
        branch.name = actual;
      }
      if (!(await this.upgrade(notInstalled.map((c) => c.id), 'safe', { quiet: true }))) return;
      upgraded = true;

      // `this.upgrade()` just committed the manifest/lockfile on our behalf,
      // moving HEAD past the commit `plan.headSha` was analysed against.
      // `runFix`'s own guard compares `plan.headSha` against HEAD and rejects
      // any mismatch as a stale plan — correct when the tree moved out from
      // under the user, wrong when Drift itself just moved it one step ago.
      // Re-pointing the plan at the commit we just made keeps that guard
      // honest instead of false-positiving on every "fix all" that includes
      // a not-yet-installed candidate.
      const { Git } = await import('../git.js');
      const headAfterUpgrade = await new Git(ctx.root).headSha().catch(() => null);
      if (headAfterUpgrade) plan.headSha = headAfterUpgrade;
    }

    // The strongest evidence available, and the only kind that is measured
    // rather than predicted: what the project's own compiler says is broken now
    // that the versions have moved. Gathered here, grouped, and handed to the
    // agent alongside Drift's analysis rather than left for a human to read.
    const diagnostics = upgraded
      ? await this.gatherDiagnostics(ctx.root, plan)
      : undefined;

    // A commit the compiler has already cleared is not a concern with an
    // outcome pending, it is a predicted break the compiler just disproved.
    // Filtering it out here — before a single card is built — means it never
    // reads as something Drift flagged and then walked back; it was never
    // flagged. `runFix` still has `clearedByCompiler` of its own for commits
    // that arrive some other way (no `diagnostics` here, e.g. an existing
    // branch that skipped the upgrade step above), so this is additive, not
    // a replacement.
    let clearedCount = 0;
    if (diagnostics) {
      const remaining: typeof plan.commits = [];
      const cleared: typeof plan.commits = [];
      for (const commit of plan.commits) {
        if (clearedByCompiler(commit, plan, diagnostics)) cleared.push(commit);
        else remaining.push(commit);
      }
      if (cleared.length > 0) {
        plan.commits = remaining;
        plan.impactSites = plan.impactSites.filter(
          (site) =>
            !cleared.some(
              (commit) => commit.files.includes(site.file) && commit.breakingChangeIds.includes(site.breakingChangeId),
            ),
        );
        clearedCount = cleared.length;
      }
    }

    if (plan.commits.length === 0) {
      this.state.set({ kind: 'findings', plan, at: Date.now() });
      this.session.say(
        clearedCount > 0
          ? // Says which stage got it wrong, rather than only that something
            // was. The scan tests every upgrade in a worktree before reporting
            // it, so reaching this point at all means that test did not happen
            // or did not agree — and a developer who was just shown a count
            // that evaporated is owed which of the two it was, here, in the
            // panel they are already looking at. Sending them to a log to find
            // out why the thing in front of them was wrong is not an answer.
            `Your typecheck against the upgraded version already passes — every predicted concern here was one it would have caught, so no fix was needed.` +
              whyPredictionsSurvived(plan.verification)
          : 'Nothing left to fix.',
      );
      return;
    }

    const branchMode: SessionBranchMode = upgraded || branch.mode === 'current' ? 'current' : 'new';
    if (branchMode === 'new') plan.branchName = branch.name;

    // The plan goes up before a single file is touched: every concern, the
    // package it belongs to, and the exact sites underneath it. A developer
    // watching this can tell what is about to happen while there is still time
    // to stop it, and afterwards can see which sites the agent actually changed
    // — neither of which is legible in a stream of agent chatter.
    const files = new Set(plan.impactSites.map((site) => site.file)).size;
    const commitMode = this.session.commitMode;
    const landing = upgraded
      ? `on \`${branch.name}\`, alongside the upgrade itself`
      : branchMode === 'new'
        ? `on a new branch, \`${plan.branchName}\``
        : 'on the branch you are on';
    const evidence = diagnostics
      ? ' Your typecheck ran first, and its errors go to the agent with the changelog evidence.' +
        (clearedCount > 0
          ? ` ${clearedCount} other concern${clearedCount === 1 ? '' : 's'} already passed it and needed no fix.`
          : '')
      : '';
    const committing =
      commitMode === 'auto'
        ? 'Each concern is committed as soon as it is finished.'
        : 'Nothing is committed until you keep it.';
    const tasks = this.session.tasks(
      `${this.agentLabel()} is fixing ${plan.impactSites.length} site${plan.impactSites.length === 1 ? '' : 's'}`,
      `${plan.commits.length} commit${plan.commits.length === 1 ? '' : 's'}, one per concern, across ${files} file${files === 1 ? '' : 's'}, ${landing}. ${committing}${evidence}`,
      buildTaskGroups(plan),
    );

    // A fix is the most specific thing this panel does, so it takes the title
    // over whatever a scan earlier in the same thread called it.
    this.session.setTitle(
      `Fix — ${namesOf(plan.changes.map((change) => change.name))}, ${files} file${files === 1 ? '' : 's'}`,
      true,
    );

    this.state.set({ kind: 'findings', plan, at: Date.now() });

    // Held from inside the run and acted on after it, because everything Drift
    // offers next — verifying, reviewing, committing — is itself a run, and a
    // run started from inside one is turned away by the busy guard. That is why
    // the verification offer after a fix never appeared.
    let result: FixResult | null = null;

    await this.run(async (token) => {
      result = await runFix({
        state: this.state,
        plan,
        review: this.review,
        permission: this.session.permission,
        branchMode,
        commitMode,
        diagnostics,
        ask: (question, options) =>
          this.session.ask(
            question,
            (options ?? ['Yes', 'No']).map((option) => ({ label: option, value: option })),
          ),
        context: await this.resolveContext(ctx.root),
        onCommitStart: (commit) => tasks.start(`c${commit.order}`),
        onCommitEnd: (commit, outcome, changed, reason) =>
          tasks.finish(`c${commit.order}`, outcome, changed, reason),
        onActivity: (commit, activity) => tasks.activity(`c${commit.order}`, activity),
        // Agent chatter belongs against the concern it is about, not in a
        // separate log the developer has to correlate by hand.
        onLog: (message) => tasks.note(activeGroupId(plan, this.state), message.slice(0, 120)),
        progress: { report: () => undefined },
        token,
        ...(options.revision ? { revision: options.revision } : {}),
      });

      for (const warning of result.warnings) this.session.notice('warn', warning);

      switch (result.status) {
        case 'proposed':
          tasks.finishAll('unchanged');
          this.session.say(
            [
              result.message,
              '',
              'Changed lines are highlighted in your editor with **Keep** and **Undo** on each one. Keeping a whole group commits it on its own.',
              '',
              'To read the whole change at once, open the git picker in the composer and choose **Review all changes** — every file, side by side with what it was.',
            ].join('\n'),
          );
          this.showReview();
          return;
        case 'committed':
        case 'delegated':
          tasks.finishAll('done');
          this.session.say(result.message);
          return;
        case 'nothing':
          tasks.finishAll('unchanged');
          this.session.say(result.message);
          return;
        case 'cancelled':
          tasks.finishAll('skipped');
          this.session.notice('info', result.message);
          return;
        case 'failed':
          tasks.finishAll('failed');
          this.output.error(result.message);
          if (result.reason === 'stale-plan') {
            // A dead end here just repeats the failure until someone thinks
            // to type `/scan`. The one thing that actually resolves a stale
            // plan is a rescan, so offer it directly instead of a bare error.
            this.session.say(`${result.message} Rescan to pick up where things stand now.`, [
              { label: 'Rescan', command: '/scan', primary: true },
            ]);
          } else {
            this.session.notice('error', result.message);
          }
          return;
      }
    });

    const outcome = result as FixResult | null;
    if (!outcome) return;

    if (outcome.status === 'proposed') {
      await this.offerVerification(ctx.root, memberDirsOf(plan));
      // The fix is the interesting half of the job and it stops at edited
      // files. Saying "keep them" and nothing else leaves the developer to work
      // out on their own that committing is even on offer, which is how a run
      // ends with changed files, no commit, and no idea why.
      await this.offerToCommitFix(outcome.branch);
    } else if (outcome.status === 'committed') {
      await this.offerVerification(ctx.root, memberDirsOf(plan));
      await this.offerToShipFix(outcome.branch);
      // The fix landed on a real commit, so what remains to be scanned has
      // changed — rescan in this same transcript so "what's left" reflects
      // it, instead of leaving the last-known candidate list stale.
      await this.scan();
    }
  }

  /**
   * Create a GitHub issue for one or more breaking changes.
   *
   * The same content builders and `gh` plumbing the report panel's per-row
   * "Create issue" button already drives (`extension/src/issue-actions.ts`),
   * reached here from `/issue` and from the "Fix them with an agent" /
   * "Review the changes" offer — the main panel never offered this at all,
   * even though the capability has existed since the report panel got it.
   *
   * Respects `drift.issueCreation.default`, the same setting the report
   * panel's dropdown and the CLI both read — a developer who has already
   * said they want issue *and* branch together gets that here too, instead
   * of the panel silently narrowing it to just the issue.
   */
  private async fileIssue(ids: readonly string[]): Promise<void> {
    if (this.busy) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository to create an issue.');
      return;
    }

    const candidates = ids
      .map((id) => this.candidates.get(id))
      .filter((c): c is UpgradeCandidate => Boolean(c?.plan));

    const plan =
      candidates.length > 0
        ? combinePlans(ctx.repo, ctx.config, candidates.map((c) => c.plan!))
        : this.state.plan;

    if (!plan || plan.breakingChanges.length === 0) {
      this.session.say('Nothing to file — no breaking change touches this repository yet. Run `/scan` first.');
      return;
    }

    // One target per dependency, filtered to the changes that actually reach
    // this repository's code — the same rule the code-scanning alerts use
    // (`report/sarif.ts`), so an issue never dumps a package's whole upstream
    // changelog just because one line of it matched something here.
    const { groupForAction, branchNameFor } = await import('../../../src/actions/issue-branch.js');
    const targets = groupForAction(plan.breakingChanges, 'package', plan.impactSites);

    const action = vscode.workspace
      .getConfiguration('drift')
      .get<'issue' | 'branch' | 'both'>('issueCreation.default', 'issue');

    for (const target of targets) {
      await this.fileTargetInConversation(ctx.root, action, target, branchNameFor(target));
    }
  }

  /**
   * File one target's issue (and, per `drift.issueCreation.default`,
   * branch) in this conversation, then — unless the branch question was
   * already settled by `action` — ask it here.
   *
   * The report panel's per-row/per-group "File this" button reaches this
   * too (`drift.fileBreakingChange` in `extension.ts`), so a click there
   * behaves exactly like typing `/issue` in the same conversation: the
   * conversation is where the follow-up ("want a branch for that?") gets
   * asked, not a fire-and-forget notification with nowhere to continue.
   */
  async fileTargetInConversation(
    root: string,
    action: IssueBranchAction,
    target: IssueBranchTarget,
    proposedBranchName: string,
  ): Promise<void> {
    await this.reveal();

    const { runIssueBranchAction } = await import('../issue-actions.js');
    let issueNumber: number | undefined;
    let linkedBranch = false;

    await runIssueBranchAction(root, action, target, {
      onIssue: (result) => {
        issueNumber = result.number;
        this.session.say(
          result.status === 'created'
            ? `Filed issue [#${result.number}](${result.url}) for **${target.dependency}**.`
            : `Issue [#${result.number}](${result.url}) for **${target.dependency}** was already open — not filing a duplicate.`,
        );
      },
      onBranch: (result) => {
        linkedBranch = true;
        this.session.say(
          `${result.status === 'created' ? 'Created' : 'Switched to'} branch \`${result.name}\`${issueNumber ? `, linked to issue #${issueNumber}` : ''}.`,
        );
      },
    });

    // `action: 'both'` (or the branch having failed outright) already
    // settled the branch question one way or another — asking again would
    // be a second, redundant prompt for the same thing `onBranch` above
    // just reported.
    if (issueNumber !== undefined && !linkedBranch && action === 'issue') {
      await this.offerBranchForIssue(root, target, issueNumber, proposedBranchName);
    }
  }

  /**
   * Asked right after filing an issue that has no branch yet: link one now,
   * or leave it for later. This is the only place that question is asked —
   * `runIssueBranchAction`'s own notification no longer offers it, so a
   * choice between a fresh branch and one that already exists can be
   * offered here instead of being a single toast button.
   */
  private async offerBranchForIssue(
    root: string,
    target: IssueBranchTarget,
    issueNumber: number,
    proposedName: string,
  ): Promise<void> {
    const canFix = this.session.mode !== 'ask';
    const answer = await this.session.ask(
      `Work on issue #${issueNumber} now?`,
      [
        canFix
          ? {
              label: `Create \`${proposedName}\` and start fixing`,
              value: 'new-fix',
              description: `A new branch, then ${this.agentLabel()} starts on it right away`,
            }
          : undefined,
        {
          label: `Create \`${proposedName}\``,
          value: 'new',
          description: 'A new branch, named from what is being upgraded — no fix started',
        },
        { label: 'Use an existing branch', value: 'existing', description: 'Pick one already in this repository' },
        { label: 'Not now', value: 'no', description: 'Leave the issue as it is' },
      ].filter((option): option is NonNullable<typeof option> => option !== undefined),
      false,
    );
    if (answer === '' || answer === 'no') return;

    if (answer === 'new' || answer === 'new-fix') {
      const { linkBranchToIssue } = await import('../issue-actions.js');
      await linkBranchToIssue(root, target, issueNumber, {
        onBranch: (result) => {
          this.session.say(
            `${result.status === 'created' ? 'Created' : 'Switched to'} branch \`${result.name}\`, linked to issue #${issueNumber}.`,
          );
        },
      });
      if (answer === 'new-fix') await this.fixTarget(target);
      return;
    }

    const { Git } = await import('../git.js');
    const branches = await new Git(root).listBranches();
    const picked = await vscode.window.showQuickPick(branches, {
      title: `Branch to link to issue #${issueNumber}`,
      placeHolder: 'Pick a branch already in this repository',
    });
    if (!picked) return;

    const { linkExistingBranchToIssue } = await import('../issue-actions.js');
    const result = await linkExistingBranchToIssue(root, picked, issueNumber);
    if (!result.ok) return;
    this.session.say(`Switched to \`${picked}\`, linked to issue #${issueNumber}.`);

    if (canFix) {
      const startFix = await this.session.ask(`Start fixing on \`${picked}\` now?`, [
        { label: 'Yes, start fixing', value: 'yes' },
        { label: 'Not now', value: 'no' },
      ]);
      if (startFix === 'yes') await this.fixTarget(target);
    }
  }

  /** The candidates behind one issue/branch target, handed to `fix()` — matched by name, since a target only carries the dependency name, not the scan's composite candidate id. */
  private async fixTarget(target: IssueBranchTarget): Promise<void> {
    const ids = [...this.candidates.values()]
      .filter((candidate) => candidate.name === target.dependency)
      .map((candidate) => candidate.id);
    if (ids.length === 0) {
      this.session.say(`Nothing scanned for **${target.dependency}** in this session — run \`/scan\` first, then fix it from there.`);
      return;
    }
    await this.fix(ids);
  }

  /**
   * Put committing on the table once a fix has produced changes.
   *
   * The keep/undo review is the right default and a poor ending: it resolves
   * each change but never mentions the thing a developer does next. Asking is
   * cheap and every answer is a real one — including "leave it", which is what
   * someone still reading the diff wants and could not previously say.
   */
  private async offerToCommitFix(branch: string | undefined, asked = 0): Promise<void> {
    const answer = await this.session.ask(
      `The edits are on ${branch ? `\`${branch}\`` : 'your working tree'} and nothing is committed yet. What next?`,
      [
        {
          label: 'Review every change',
          value: 'review',
          description: 'Open all of them side by side against what they were',
        },
        {
          label: 'Commit them',
          value: 'commit',
          description: 'Commit the changed files, then optionally push and raise a pull request',
        },
        {
          label: 'Not what I wanted — try again',
          value: 'redo',
          description: 'Say what is wrong; the agent starts over from the original files',
        },
        {
          label: 'Throw these edits away',
          value: 'discard',
          description: 'Restore the files to how they were before the fix',
        },
        { label: 'Leave it for now', value: 'no', description: 'The changes stay in your tree' },
      ],
      false,
    );

    if (answer === 'review') {
      await this.reviewAllChanges();
      // Reviewing is not a decision about committing, so the question comes
      // back rather than the flow ending on an open diff. Once, not in a loop:
      // a second "review" answer opens the diffs and stops there, because a
      // question with no way past it is not a question.
      if (asked === 0) await this.offerToCommitFix(branch, asked + 1);
      else this.session.say('Take your time.', [{ label: 'Commit when ready', command: '/commit' }]);
      return;
    }
    if (answer === 'commit') {
      await this.commitNow();
      return;
    }
    if (answer === 'redo') {
      await this.redoFix();
      return;
    }
    if (answer === 'discard') {
      await this.discardFix();
      return;
    }
    this.session.say('Left uncommitted — the changes are still in your tree.', [
      { label: 'Commit', command: '/commit' },
      { label: 'Review the changes', command: '/review' },
      { label: 'Try again differently', command: '/redo' },
    ]);
  }

  /**
   * Run the fix again, with the developer saying what was wrong.
   *
   * The state a fix flow spends most of its life in is "the agent produced
   * something and the human is not happy with it", and until now the only
   * answers on offer were keep it, keep part of it, or walk away. None of those
   * is what someone actually wants, which is to say *what* is wrong and have
   * another go.
   *
   * Two details make this a retry rather than a re-roll:
   *
   *   - The previous attempt is thrown away first, so the agent edits the
   *     original files rather than layering a correction onto a rejection.
   *   - The rejected diff and the guidance both go into the prompt. Re-running
   *     the identical prompt reliably produces the identical answer, which is
   *     the most frustrating thing a tool can do to someone who just said it
   *     got it wrong.
   */
  private async redoFix(): Promise<void> {
    const ctx = await this.context();
    const plan = this.state.plan;
    if (!ctx || !plan) {
      this.session.notice('warn', 'There is no fix to redo. Run a scan first.');
      return;
    }

    const guidance = await vscode.window.showInputBox({
      title: 'What should the agent do differently?',
      prompt: 'Said plainly. This outranks the evidence and the impact analysis.',
      placeHolder: 'e.g. keep the existing error handling, just change the import',
      ignoreFocusOut: true,
    });
    if (!guidance?.trim()) {
      this.session.notice('info', 'Nothing changed — the edits are still in your tree.');
      return;
    }

    const { Git } = await import('../git.js');
    const git = new Git(ctx.root);

    // Capture what is being rejected *before* discarding it, so the agent can
    // be told what not to do again.
    const previousDiff = await git.diffAgainstHead().catch(() => '');

    const attempt = (this.revisionAttempts.get(plan.id) ?? 1) + 1;
    this.revisionAttempts.set(plan.id, attempt);

    // An already-committed fix cannot be undone by discarding the working
    // tree, and quietly running the agent on top of it would stack a second
    // attempt onto the first — which is precisely what "start over" is not.
    const dirty = await git.dirtyFiles().catch(() => [] as string[]);
    let undoCommit = false;

    if (dirty.length === 0) {
      const committed = await git.headSha().catch(() => null);
      if (!committed) {
        this.session.notice('warn', 'There is nothing to redo — no edits and no commit to start from.');
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        'The previous attempt is already committed. Undo that commit and start over?',
        {
          modal: true,
          detail:
            'Drift will reset the branch by one commit, restoring the files to how they were before the fix. Nothing is pushed, so this only affects your local branch.',
        },
        'Undo the commit and retry',
        'Retry on top of it',
      );
      if (!choice) return;
      undoCommit = choice === 'Undo the commit and retry';
    }

    const step = this.session.step(
      undoCommit ? 'Undoing the previous attempt' : 'Restoring the original files',
    );
    try {
      this.review.begin(ctx.root);
      if (undoCommit) await git.resetHard('HEAD~1');
      else await git.discardAll();
      step.done(
        undoCommit
          ? 'Undone — the agent will start from the original files'
          : 'Restored — the agent will start from the original files',
      );
    } catch (err) {
      step.fail('Could not restore the files');
      this.session.notice(
        'error',
        `Could not undo the previous attempt: ${(err as Error).message}. Your work is untouched; resolve this by hand before retrying.`,
      );
      return;
    }

    this.session.say(
      `Starting again from the original files, attempt ${attempt}. Your note goes to the agent ahead of everything Drift inferred:\n\n> ${guidance.trim()}`,
    );

    await this.fix([], {
      revision: {
        guidance: guidance.trim(),
        ...(previousDiff.trim() ? { previousDiff } : {}),
        attempt,
      },
    });
  }

  /**
   * Throw away everything the agent did.
   *
   * Modal, and it names the number of files, because this is destructive and
   * irreversible in the one way that matters: the edits were never committed,
   * so there is nothing to recover them from.
   */
  private async discardFix(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) return;

    const { Git } = await import('../git.js');
    const git = new Git(ctx.root);

    const changed = await git.dirtyFiles().catch(() => [] as string[]);
    if (changed.length === 0) {
      this.session.notice('info', 'There is nothing to discard — your tree is already clean.');
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Throw away Drift's edits to ${changed.length} file${changed.length === 1 ? '' : 's'}?`,
      {
        modal: true,
        detail: `${changed.slice(0, 10).join('\n')}${
          changed.length > 10 ? `\n…and ${changed.length - 10} more` : ''
        }\n\nNothing was committed, so this cannot be undone.`,
      },
      'Discard',
    );
    if (confirmed !== 'Discard') return;

    try {
      this.review.begin(ctx.root);
      await git.discardAll();
      this.session.notice('success', `Discarded the edits to ${changed.length} file(s).`);
      this.session.say('Back to where you started.', [
        { label: 'Try again differently', command: '/redo' },
        { label: 'Scan again', command: '/scan' },
      ]);
    } catch (err) {
      this.session.notice('error', `Could not discard the edits: ${(err as Error).message}`);
    }
  }

  /** After an auto-commit run: the branch exists, so offer to send it somewhere. */
  private async offerToShipFix(branch: string | undefined): Promise<void> {
    if (!branch) return;

    const answer = await this.session.ask(
      `\`${branch}\` has the fix committed. Push it?`,
      [
        { label: 'Push and open a pull request', value: 'pr', description: 'Carries the evidence into the description' },
        { label: 'Push only', value: 'push', description: 'Send the branch to origin' },
        { label: 'Review it first', value: 'review', description: 'Open every change side by side' },
        {
          label: 'Not what I wanted — try again',
          value: 'redo',
          description: 'Say what is wrong; the agent starts over from the original files',
        },
        { label: 'Not now', value: 'no', description: 'It stays local' },
      ],
      false,
    );

    if (answer === 'pr') await this.openPullRequestForBranch();
    else if (answer === 'push') await this.pushCurrentBranch();
    else if (answer === 'review') await this.reviewAllChanges();
    else if (answer === 'redo') await this.redoFix();
    else
      this.session.say(`\`${branch}\` is local, with the fix committed on it.`, [
        { label: 'Push', command: '/push' },
        { label: 'Open a pull request', command: '/pr' },
      ]);
  }

  /* ---------------------------------------------------------------- */
  /* Rewind                                                            */
  /* ---------------------------------------------------------------- */

  private checkpointsFor(root: string): Checkpoints {
    let checkpoints = this.checkpointsByRoot.get(root);
    if (!checkpoints) {
      checkpoints = new Checkpoints(root);
      this.checkpointsByRoot.set(root, checkpoints);
    }
    return checkpoints;
  }

  private async checkpoint(label: string): Promise<{ id: string } | null> {
    const ctx = await this.context();
    if (!ctx) return null;
    return this.checkpointsFor(ctx.root).capture(label);
  }

  /**
   * Put the repository, and the conversation, back to before a message.
   *
   * Both together, because either alone is a trap: files restored under a
   * transcript that still describes the edits invites the developer to act on
   * work that no longer exists, and a truncated transcript over changed files
   * hides them entirely. This is the one destructive action in the panel, so it
   * asks first, in a modal, naming the number of files it will throw away.
   */
  private async rewind(itemId: string): Promise<void> {
    if (this.busy) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    const item = this.session.thread.find((entry) => entry.id === itemId);
    if (!item || item.kind !== 'user' || !item.checkpoint) return;

    const rewindCtx = await this.context();
    if (!rewindCtx) return;
    const checkpoints = this.checkpointsFor(rewindCtx.root);

    const checkpoint = checkpoints.get(item.checkpoint);
    if (!checkpoint) {
      this.session.notice('warn', 'That checkpoint is gone — a later rewind already passed it.');
      return;
    }

    const preview = await this.rewindPreview(checkpoint.tree);
    const choice = await vscode.window.showWarningMessage(
      `Rewind to before "${truncate(item.text, 60)}"?`,
      {
        modal: true,
        detail:
          preview.length === 0
            ? 'No files have changed since then. The conversation from that message down will be cleared.'
            : `${preview.length} file${preview.length === 1 ? '' : 's'} will be restored to how they were, and everything in the conversation from that message down will be cleared. This cannot be undone.\n\n${preview.slice(0, 12).join('\n')}${preview.length > 12 ? `\n…and ${preview.length - 12} more` : ''}`,
      },
      'Rewind',
    );
    if (choice !== 'Rewind') return;

    try {
      const result = await checkpoints.restore(item.checkpoint);
      this.session.truncateFrom(itemId);

      // The message that started it goes back in the composer: the usual reason
      // to rewind is to say the same thing differently.
      this.setDraft(item.text);

      // Pending review entries describe edits that no longer exist on disk.
      const ctx = await this.context();
      if (ctx) this.review.begin(ctx.root);

      this.session.notice(
        'success',
        result.files.length === 0
          ? 'Rewound. Nothing on disk had changed since then.'
          : `Rewound — ${result.files.length} file${result.files.length === 1 ? '' : 's'} restored to how they were.${
              result.commitsSince
                ? ' Commits made since then are still in your history: Drift restores files, it never rewrites history.'
                : ''
            }`,
      );
      this.render();
    } catch (err) {
      this.session.notice('error', `Could not rewind: ${(err as Error).message}`);
    }
  }

  private async rewindPreview(tree: string): Promise<string[]> {
    const ctx = await this.context();
    if (!ctx) return [];
    const { Git } = await import('../git.js');
    return new Git(ctx.root).changedAgainstTree(tree).catch(() => []);
  }

  private showReview(): void {
    if (this.review.isEmpty) {
      this.session.notice('info', 'Nothing is waiting for review.');
      return;
    }
    this.session.showChanges('Changes waiting for you');
  }

  /**
   * Commit a fully-kept group.
   *
   * Only the files the plan named for this group are committed, so an agent that
   * wandered somewhere else does not get swept in — the atomic-commit promise has
   * to hold at the moment of committing, not just at planning time.
   */
  /**
   * Throws on a real commit failure rather than swallowing it into `null`.
   * `DriftReview` needs that distinction: `null` means "nothing to commit",
   * a legitimate outcome the store clears the group for; a thrown error means
   * the accepted edits are still sitting there uncommitted, and the store
   * keeps the group around so `retryCommit` has something to act on.
   */
  private async commitGroup(group: ReviewGroup): Promise<{ sha: string; branch: string } | null> {
    const root = this.review.workspaceRoot ?? this.state.workspaceRoot;
    if (!root) throw new Error('No workspace root is open.');

    const { Git } = await import('../git.js');
    const git = new Git(root);

    const sha = await git.commitPaths(group.paths, group.title, group.body ?? '', this.coAuthorOption());
    if (!sha) {
      this.session.notice('info', `Nothing left to commit for "${group.title}".`);
      return null;
    }
    const branch = await git.currentBranch().catch(() => 'HEAD');
    this.session.notice('success', `Committed **${sha.slice(0, 7)}** — ${group.title}`);
    if (this.review.isEmpty) {
      this.session.say(
        `That is everything. The work is on \`${branch}\`, one commit per concern, and nothing has been pushed.`,
      );
      // Scheduled rather than awaited: this runs inside the Keep handler, and
      // the button should stop looking pressed before the next question
      // appears underneath it.
      setTimeout(() => void this.offerToPushFix(root, branch), 0);
    }
    return { sha, branch };
  }

  /* ---------------------------------------------------------------- */
  /* Context, agents, identity                                         */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* Composer pickers                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Everything the composer menu offers, grouped by the control that opens it.
   *
   * Built here rather than in the renderer because it is entirely a question of
   * what this workspace can do right now — which subscriptions are installed,
   * which models each of them is currently offering, what is already attached.
   * The renderer takes it as data and draws it.
   *
   * Every section names its anchor, and the menu shows only the sections
   * belonging to whichever control was clicked. That is the rule that makes the
   * row of controls readable: the plus button offers context and nothing else,
   * a subscription button offers that subscription's models and nothing else,
   * and no button hides a setting it does not name.
   */
  private menuSections(): MenuSection[] {
    const sections: MenuSection[] = [
      { id: 'context', anchor: 'context', title: 'Context', items: this.contextItems() },
      // Its own anchor, opened by its own button. Which model does the work is
      // not a kind of context, and it was the one setting in the composer a
      // developer had to already know was hidden behind the plus.
      { id: 'model', anchor: 'model', title: 'Model', items: this.subscriptionItems() },
    ];

    for (const entry of this.available()) {
      sections.push({
        id: `model:${entry.agent.id}`,
        anchor: `model:${entry.agent.id}`,
        title: entry.agent.label,
        items: [
          {
            id: 'back',
            label: 'All subscriptions',
            icon: 'back',
            submenu: 'model',
            keywords: 'back model subscriptions',
          },
          ...this.modelItems(entry),
        ],
      });
    }

    sections.push({ id: 'agents', anchor: 'model:setup', title: 'AI agents', items: this.agentItems() });

    const slider = this.effortSlider();
    if (slider) {
      sections.push({
        id: 'effort',
        anchor: 'effort',
        title: `${this.agentLabel()} effort`,
        slider,
        items: [],
      });
    }

    // Under the same button as effort, because they are the two dials on the
    // same axis: how much this run costs and how long it takes. Drawn only for
    // an agent that actually has the control — see `fastItems`.
    const fast = this.fastItems();
    if (fast.length > 0) {
      sections.push({ id: 'fast', anchor: 'effort', title: 'Speed', items: fast });
    }

    sections.push(
      { id: 'recent-conversations', anchor: 'tools', title: 'Recent conversations', items: this.conversationItems() },
      { id: 'tools', anchor: 'tools', title: 'Tools', items: this.toolItems() },
      { id: 'mode', anchor: 'permission', title: 'Mode', items: this.modeItems() },
      { id: 'permission', anchor: 'permission', title: 'Permission', items: this.permissionItems() },
      // Its own control, because the two questions underneath it — which branch
      // gets the work, and whether Drift may write history without being asked
      // — are the ones a developer wants to check *before* starting a fix, and
      // neither was reachable from anything in the composer that named them.
      { id: 'branch-mode', anchor: 'git', title: 'Branch', items: this.branchModeItems() },
      { id: 'commit-mode', anchor: 'git', title: 'Commits', items: this.commitModeItems() },
      { id: 'git-actions', anchor: 'git', title: 'Now', items: this.gitActionItems() },
    );

    // Only meaningful with more than one root open — the button itself is
    // hidden in that case (see `scopeLabel` in the view model), so this
    // section would never be reachable anyway, but leaving it out entirely
    // is the more honest signal to read from the data alone.
    if (this.state.roots.length > 1) {
      sections.push({ id: 'scope', anchor: 'scope', title: 'Repositories', items: this.scopeItems() });
    }

    return sections;
  }

  /**
   * One row per open root, checkable independently — a scan covers every
   * checked one. Undeclared nested projects (an undeclared sub-package, like
   * this repository's own `extension/`) get no row of their own: `/scan`
   * already includes them in their parent root automatically, which is what
   * "focus on a repository" means in practice. A nested directory with its
   * own `.git` is different — a genuinely separate repository — but it only
   * becomes choosable here once it is opened as its own folder, the same as
   * any other root; a scan reports it by name so that's a deliberate next
   * step, not a silent promotion.
   */
  private scopeItems(): MenuItem[] {
    const roots = this.state.roots;
    const allSelected = roots.every((root) => this.session.isRootIncluded(root.path));

    return [
      {
        id: 'scope:__all',
        label: 'All repositories',
        detail: `Scan every open repository — ${roots.length} right now`,
        icon: 'repo',
        checked: allSelected,
        keywords: 'scope repository all reset every',
      },
      ...roots.map<MenuItem>((root) => ({
        id: `scope:${root.path}`,
        label: root.label,
        detail: root.repo?.slug ?? root.path,
        icon: 'repo',
        checked: this.session.isRootIncluded(root.path),
        keywords: `scope repository folder ${root.label}`,
      })),
    ];
  }

  /**
   * Everything Drift itself can do, in one menu.
   *
   * The slash commands are the complete list of Drift's own actions, and typing
   * one is still the fastest way to run it — but a developer meeting the panel
   * for the first time cannot type a command they have never seen. This is that
   * list, made clickable, next to the controls that decide how it will run.
   */
  private toolItems(): MenuItem[] {
    const icons: Record<string, MenuItem['icon']> = {
      '/scan': 'search',
      '/recent': 'history',
      '/verify': 'shield',
      '/upgrade': 'package',
      '/upgrade-all': 'package',
      '/fix': 'agent',
      '/review': 'diff',
      '/redo': 'agent',
      '/discard': 'history',
      '/instruction': 'info',
      '/agent': 'gear',
      '/clear': 'plus',
      '/help': 'info',
    };

    return SLASH_COMMANDS.map<MenuItem>((command) => ({
      // A trailing space means "this needs an argument, put it in the composer".
      // Only a *required* one does: `/fix [package]` without a package is the
      // whole point of `/fix`, whereas `/upgrade` alone has nothing to act on.
      id: `tool:${command.name}${command.args?.startsWith('<') ? ' ' : ''}`,
      label: command.title,
      detail: command.description,
      // The command itself, kept where a keyboard shortcut would sit: this menu
      // is how the slash commands get learned, not a replacement for them.
      hint: command.name,
      icon: icons[command.name] ?? 'gear',
      keywords: `tool command ${command.name} ${command.description}`,
    }));
  }

  private conversationItems(limit = 5): MenuItem[] {
    const recent = this.recentConversations(limit);
    if (recent.length === 0) {
      return [
        {
          id: 'history:__none',
          label: 'No conversations yet',
          detail: 'Saved threads appear here',
          icon: 'history',
          keywords: 'recent conversation history',
        },
      ];
    }

    return recent.map<MenuItem>((entry) => ({
      id: `history:${entry.id}`,
      label: entry.title,
      detail: `${describeWhen(entry.at)} · ${entry.messages} message${entry.messages === 1 ? '' : 's'}`,
      hint: entry.active ? (this.busy ? 'Active' : 'Current') : undefined,
      icon: 'history',
      checked: entry.active,
      keywords: `recent conversation history ${entry.title}`,
    }));
  }

  /** Subscriptions Drift can actually drive right now. */
  private available(): DiscoveredAgent[] {
    return this.agents.filter((entry) => entry.availability.available);
  }

  /**
   * One row per subscription the developer can actually use.
   *
   * A subscription is not a model: someone paying for Claude has Opus, Sonnet
   * and Haiku, and a Copilot seat carries whatever families GitHub is offering
   * this month. So this list is the first of two steps — pick the thing you pay
   * for, then pick the model inside it — and each row says which model it is
   * currently set to, so neither step is a guess.
   */
  private subscriptionItems(): MenuItem[] {
    const available = this.available();
    if (available.length === 0) {
      return [
        {
          id: 'agent:__pick',
          label: 'Set up an agent…',
          detail: 'Drift drives an agent you already have and never asks for an API key',
          icon: 'gear',
          keywords: 'model agent install sign in setup',
        },
      ];
    }

    const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
    const active = preferred === 'auto' ? available[0]?.agent.id : preferred;

    return [
      ...available.map<MenuItem>((entry) => {
        const chosen = this.session.model(entry.agent.id);
        const model = this.models.get(entry.agent.id)?.find((candidate) => candidate.id === chosen);

        return {
          id: `agent:${entry.agent.id}`,
          label: entry.agent.label,
          detail: model?.label ?? chosen ?? entry.availability.detail,
          icon: 'agent',
          checked: entry.agent.id === active,
          submenu: `model:${entry.agent.id}`,
          keywords: `model subscription ${entry.agent.id}`,
        };
      }),
      {
        id: 'agent:__pick',
        label: 'Set up another agent…',
        detail: 'Every agent Drift supports, including the ones not ready yet',
        icon: 'gear',
        keywords: 'model agent install sign in setup',
      },
    ];
  }

  /** The models inside one subscription. */
  private modelItems(entry: DiscoveredAgent): MenuItem[] {
    const id = entry.agent.id;
    const models = this.models.get(id) ?? [];
    const chosen = this.session.model(id);
    const items: MenuItem[] = [];

    items.push({
      id: `model:${id}:`,
      label: 'Default',
      detail: entry.availability.detail ?? 'Whatever this subscription picks',
      icon: 'agent',
      checked: !chosen,
      keywords: 'model default automatic',
    });

    for (const model of models) {
      items.push({
        id: `model:${id}:${model.id}`,
        label: model.label,
        detail: model.detail,
        icon: 'agent',
        checked: chosen === model.id,
        keywords: `model ${model.id}`,
      });
    }

    // A model the developer typed by hand is still their choice: nothing here
    // knows every id every provider will ship next month.
    if (chosen && !models.some((model) => model.id === chosen)) {
      items.push({
        id: `model:${id}:${chosen}`,
        label: chosen,
        detail: 'Set by hand',
        icon: 'agent',
        checked: true,
        keywords: `model ${chosen}`,
      });
    }

    if (entry.agent.acceptsCustomModel) {
      items.push({
        id: `custom:${id}`,
        label: 'Other model…',
        detail: 'Type a model id this agent accepts',
        icon: 'gear',
        keywords: 'model custom other id',
      });
    }

    return items;
  }

  /** Which subscription does the work, plus a way to install another. */
  private agentItems(): MenuItem[] {
    const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
    const available = this.available();

    return [
      {
        id: 'agent:auto',
        label: 'Automatic',
        detail: available[0] ? `Currently ${available[0].agent.label}` : 'Nothing available yet',
        icon: 'agent',
        checked: preferred === 'auto',
        keywords: 'agent auto best',
      },
      ...available.map<MenuItem>((entry) => ({
        id: `agent:${entry.agent.id}`,
        label: entry.agent.label,
        detail: entry.availability.detail,
        icon: 'agent',
        checked: preferred === entry.agent.id,
        keywords: 'agent subscription ai',
      })),
      {
        id: 'agent:__pick',
        label: 'Set up an agent…',
        detail: 'Every agent Drift supports, including the ones not ready yet',
        icon: 'gear',
        keywords: 'agent install sign in setup',
      },
    ];
  }

  private modeItems(): MenuItem[] {
    return (['agent', 'ask'] as SessionMode[]).map<MenuItem>((value) => ({
      id: `mode:${value}`,
      label: describeMode(value),
      detail: explainMode(value),
      icon: value === 'agent' ? 'agent' : 'ask',
      checked: this.session.mode === value,
      keywords: 'mode chat edit explain',
    }));
  }

  private permissionItems(): MenuItem[] {
    return (['ask', 'auto-edit', 'full-auto'] as SessionPermission[]).map<MenuItem>((value) => ({
      id: `permission:${value}`,
      label: describePermission(value),
      detail: explainPermission(value),
      icon: 'shield',
      checked: this.session.permission === value,
      keywords: 'permission autonomy allow approve commit',
    }));
  }

  /**
   * Where the next fix does its work.
   *
   * Drift has always branched; what it has never done is *say so* anywhere the
   * developer would look before starting, which made the safest thing it does
   * invisible and the alternative unreachable.
   */
  private branchModeItems(): MenuItem[] {
    const current = this.session.branchMode;
    return [
      {
        id: 'branchMode:new',
        label: 'New branch',
        detail: 'Branch first, so abandoning the whole fix is one checkout',
        icon: 'branch',
        checked: current === 'new',
        keywords: 'git branch new safe checkout isolate',
      },
      {
        id: 'branchMode:current',
        label: 'Stay on this branch',
        detail: 'Edit the branch you are on. Undo is up to you.',
        icon: 'branch',
        checked: current === 'current',
        keywords: 'git branch current here in place',
      },
    ];
  }

  private commitModeItems(): MenuItem[] {
    const current = this.session.commitMode;
    return [
      {
        id: 'commitMode:approve',
        label: 'Ask me first',
        detail: 'Hold every change for keep or undo before anything is committed',
        icon: 'commit',
        checked: current === 'approve',
        keywords: 'git commit approve review keep undo manual',
      },
      {
        id: 'commitMode:auto',
        label: 'Commit automatically',
        detail: 'Commit each concern the moment its agent finishes it',
        icon: 'commit',
        checked: current === 'auto',
        keywords: 'git commit auto automatic unattended',
      },
    ];
  }

  /** The git things worth doing right now, rather than settings. */
  private gitActionItems(): MenuItem[] {
    return [
      {
        id: 'git:review',
        label: 'Review all changes',
        detail: 'Open every changed file side by side against what it was',
        icon: 'diff',
        keywords: 'git review diff changes compare gitlens',
      },
      {
        id: 'git:commit',
        label: 'Commit now…',
        detail: 'Branch and commit what is currently changed',
        icon: 'commit',
        keywords: 'git commit now message',
      },
    ];
  }

  /**
   * The effort dial, in the active agent's own vocabulary.
   *
   * Effort is a reasoning budget and nothing else — it never changes which
   * dependencies Drift checks or which fixes it attempts. So the dial only
   * exists when the agent actually has such a budget: Claude and Codex do,
   * the Copilot Language Model API and a local Ollama do not, and drawing a
   * control for them would be drawing a control that does nothing.
   */
  private effortSlider(): MenuSection['slider'] | undefined {
    const agent = this.activeAgent()?.agent;
    const stops = this.effortStops();
    if (!agent || stops.length === 0) return undefined;

    const current = stops.findIndex((stop) => stop.value === this.session.effort(agent.id));

    return {
      id: 'effort',
      value: current === -1 ? Math.min(1, stops.length - 1) : current,
      stops: stops.map((stop) => ({ value: stop.value, label: stop.label, detail: stop.detail })),
    };
  }

  /**
   * The speed/cost toggle, for agents that have one.
   *
   * Only Codex today, and only because its binary exposes `fast_mode` as a
   * feature flag Drift can set per run. Claude Code has fast mode too, but as
   * an interactive `/fast` toggle stored in its own settings — Drift inherits
   * whatever is set there and does not draw a switch it cannot actually throw.
   */
  private fastItems(): MenuItem[] {
    const agent = this.activeAgent()?.agent;
    if (!agent || !agentSupportsFastMode(agent.id)) return [];

    const on = this.session.fast(agent.id);
    return [
      {
        id: `fast:${on ? 'off' : 'on'}`,
        label: 'Fast mode',
        detail: on
          ? 'On — same model, faster answers, more tokens spent'
          : 'Same model, faster answers, more tokens spent',
        icon: 'speed',
        checked: on,
        keywords: 'fast speed latency tokens cost quick',
      },
    ];
  }

  /** The subscription whose settings the composer is currently showing. */
  private activeAgent(): DiscoveredAgent | undefined {
    const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
    const available = this.available();
    return preferred === 'auto' ? available[0] : available.find((entry) => entry.agent.id === preferred);
  }

  /** The stops the chosen model can honour, narrowest wins. */
  private effortStops(): readonly EffortStop[] {
    const active = this.activeAgent();
    if (!active) return [];

    const chosen = this.session.model(active.agent.id);
    const models = this.models.get(active.agent.id) ?? [];
    const model = models.find((candidate) => candidate.id === chosen);

    return model?.efforts ?? active.agent.efforts ?? [];
  }

  /** What the composer's effort button says, or nothing if there is no dial. */
  private effortLabel(): string | null {
    const agent = this.activeAgent()?.agent;
    if (!agent) return null;

    const stops = this.effortStops();
    if (stops.length === 0) return null;

    const current = this.session.effort(agent.id);
    return (stops.find((stop) => stop.value === current) ?? stops[1] ?? stops[0])?.label ?? null;
  }

  private contextItems(): MenuItem[] {
    const editor = vscode.window.activeTextEditor;
    const hasSelection = Boolean(editor && !editor.selection.isEmpty);

    return [
      ...this.session.context.map<MenuItem>((attachment) => ({
        id: `detach:${attachment.value}`,
        label: attachment.label,
        detail: 'Attached — pick to remove',
        icon: attachment.kind === 'folder' ? 'folder' : attachment.kind === 'selection' ? 'selection' : 'file',
        checked: true,
        keywords: 'remove detach attached context',
      })),
      {
        id: 'context:file',
        label: 'Add a file…',
        detail: 'Search this project by path',
        icon: 'file',
        keywords: 'attach context add file search',
      },
      {
        id: 'context:folder',
        label: 'Add a folder…',
        detail: 'Scope the agent to one area of the project',
        icon: 'folder',
        keywords: 'attach context add folder directory scope',
      },
      ...(hasSelection
        ? [
            {
              id: 'context:selection',
              label: 'Editor selection',
              detail: 'The lines highlighted in the active editor',
              icon: 'selection' as const,
              keywords: 'attach context selection highlighted lines',
            },
          ]
        : []),
      {
        id: 'context:upload',
        label: 'Upload from computer…',
        detail: 'Something outside this project',
        icon: 'upload',
        keywords: 'attach context upload browse disk external',
      },
    ];
  }

  /** Dispatch a menu row. The id is the contract between the two halves. */
  private async runMenuItem(id: string): Promise<void> {
    const [kind = '', ...rest] = id.split(':');
    const value = rest.join(':');

    switch (kind) {
      case 'detach':
        this.session.detach(value);
        return;
      case 'context':
        await this.addContext(value);
        return;
      case 'agent':
        await this.setAgent(value);
        return;
      case 'model': {
        // `model:<agent>:<model>`, where an empty model means "this
        // subscription's default".
        const [agentId = '', ...model] = value.split(':');
        await this.setModel(agentId, model.join(':'));
        return;
      }
      case 'custom':
        await this.askForModel(value);
        return;
      case 'mode':
        await this.session.setMode(value as SessionMode);
        return;
      case 'effort': {
        const agent = this.activeAgent()?.agent;
        if (agent) await this.session.setEffort(agent.id, value as SessionEffort);
        return;
      }
      case 'tool':
        // A command that takes an argument cannot be run from a click — there is
        // nothing to run it on yet — so it lands in the composer with the caret
        // after it instead.
        if (value.endsWith(' ')) {
          this.setDraft(value);
          this.render();
        } else {
          await this.submit(value);
        }
        return;
      case 'history':
        if (value !== '__none') await this.restoreConversation(value);
        return;
      case 'permission':
        await this.session.setPermission(value as SessionPermission);
        this.session.notice('info', `Permission set to **${describePermission(value as SessionPermission)}**.`);
        return;
      case 'branchMode':
        await this.session.setBranchMode(value as SessionBranchMode);
        this.session.notice(
          'info',
          value === 'new'
            ? 'Fixes will start on a new branch. Leaving one is `git checkout -`.'
            : 'Fixes will edit the branch you are on. Nothing will be branched for you.',
        );
        return;
      case 'commitMode':
        await this.session.setCommitMode(value as SessionCommitMode);
        this.session.notice(
          'info',
          value === 'auto'
            ? 'Drift will commit each concern as soon as its agent finishes. You can still undo a commit with `git reset`.'
            : 'Nothing will be committed until you keep it.',
        );
        return;
      case 'git':
        if (value === 'review') await this.reviewAllChanges();
        else if (value === 'commit') await this.commitNow();
        return;
      case 'fast': {
        const agent = this.activeAgent()?.agent;
        if (!agent) return;
        const on = value === 'on';
        await this.session.setFast(agent.id, on);
        this.session.notice(
          'info',
          on
            ? `Fast mode on for ${agent.label}. Same model, faster answers, more tokens per run.`
            : `Fast mode off for ${agent.label}.`,
        );
        return;
      }
      case 'scope':
        if (value === '__all') this.session.resetScope();
        else this.session.toggleRoot(value, this.state.roots.map((root) => root.path));
        return;
    }
  }

  private recentConversations(limit: number): Array<{
    id: string;
    title: string;
    at: number;
    messages: number;
    active: boolean;
  }> {
    const saved = this.history.list();
    const currentItems = this.session.snapshot();
    const current =
      currentItems.length === 0
        ? null
        : {
            id: this.conversationId,
            title: this.session.title,
            at: Date.now(),
            messages: currentItems.filter((item) => item.kind === 'user' || item.kind === 'assistant').length,
            active: true,
          };

    return [
      ...(current ? [current] : []),
      ...saved
        .filter((entry) => entry.id !== this.conversationId)
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          at: entry.at,
          messages: entry.messages,
          active: false,
        })),
    ]
      .sort((a, b) => Number(b.active) - Number(a.active) || b.at - a.at)
      .slice(0, limit);
  }

  private async restoreConversation(id: string, options: { reveal?: boolean } = {}): Promise<void> {
    if (id === this.conversationId) {
      if (options.reveal) await this.reveal();
      return;
    }

    const entry = this.history.get(id);
    if (!entry) return;

    void this.saveConversation();
    this.conversationId = entry.id;
    this.session.restore(entry.items, entry.title);
    this.setDraft('');
    this.render();
    if (options.reveal) await this.reveal();
  }

  /**
   * Choose a model, and with it the subscription it belongs to.
   *
   * Picking Opus is picking Claude. Making the developer select the
   * subscription first and the model second would be asking them to say the
   * same thing twice.
   */
  private async setModel(agentId: string, model: string): Promise<void> {
    // Said first, and from what is already known. Everything below is a settings
    // write followed by a fresh probe of every installed agent — hundreds of
    // milliseconds of `which`, version checks and a network call — and the
    // confirmation used to wait behind all of it, so the panel looked like it
    // had ignored the click.
    const label = this.models.get(agentId)?.find((entry) => entry.id === model)?.label ?? model;
    const agentLabel = this.agents.find((entry) => entry.agent.id === agentId)?.agent.label ?? this.agentLabel();
    this.session.notice(
      'info',
      label
        ? `Now using **${label}** on ${agentLabel}.`
        : `Now using **${agentLabel}** with whichever model it picks.`,
    );

    await this.session.setModel(agentId, model || undefined);

    const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
    if (preferred !== agentId) await this.setAgent(agentId, { quiet: true });
    else invalidateAgentCache();

    // An effort the newly chosen model cannot honour has to give way to one it
    // can — Haiku has no Ultracode to spend.
    const stops = this.effortStops();
    if (stops.length > 0 && !stops.some((stop) => stop.value === this.session.effort(agentId))) {
      await this.session.setEffort(agentId, stops[stops.length - 1]!.value);
    }

    await this.refreshAgents();
  }

  /**
   * Where this fix is going to land, asked out loud.
   *
   * Drift has always branched before letting an agent loose, which is the right
   * default and was also completely invisible: the first a developer heard about
   * it was a branch name in a progress line, after the decision was made. That
   * is the wrong order for the one choice here that is awkward to reverse, and
   * it left people reasonably unsure whether their own branch was about to be
   * edited underneath them.
   *
   * The answer is remembered, so agreeing with the default costs one click and
   * the git picker keeps whatever was chosen last.
   */
  private async chooseBranch(
    root: string,
    proposed: string,
    options: { reason?: string } = {},
  ): Promise<{ mode: SessionBranchMode; name: string } | null> {
    const { Git } = await import('../git.js');
    const current = await new Git(root).currentBranch().catch(() => null);
    const preferred = this.session.branchMode;

    // On a detached HEAD there is no branch to stay on, so there is no question
    // to ask — branching is the only thing that can be meant.
    if (!current || current === 'HEAD') return { mode: 'new', name: proposed };

    const answer = await this.session.ask(
      `Before ${options.reason ?? `${this.agentLabel()} touches anything`}: you are on \`${current}\`. Where should this work go?`,
      [
        {
          label: `New branch \`${proposed}\``,
          value: 'new',
          description: `Named from what is being upgraded. Undoing everything is then \`git checkout ${current}\`.`,
        },
        {
          label: 'New branch, different name…',
          value: 'rename',
          description: 'Same isolation, your naming convention',
        },
        {
          label: `Stay on \`${current}\``,
          value: 'current',
          description: 'Edit this branch directly. Undo is yours to manage.',
        },
        { label: 'Cancel', value: 'cancel', description: 'Change nothing' },
      ],
      false,
    );

    if (answer === 'cancel') {
      this.session.notice('info', 'Left your working tree alone.');
      return null;
    }

    // Walking away from the question is not consent to edit the branch someone
    // is standing on, so an empty answer takes the safe reading rather than the
    // remembered one.
    if (answer === '') {
      return { mode: preferred === 'current' ? 'new' : preferred, name: proposed };
    }

    if (answer === 'rename') {
      const typed = await vscode.window.showInputBox({
        title: 'Branch for this upgrade',
        prompt: 'Drift proposed this from the packages being upgraded. Change it to whatever your team uses.',
        value: proposed,
        valueSelection: [proposed.lastIndexOf('/') + 1, proposed.length],
        validateInput: (value) => validateBranchName(value),
      });
      if (typed === undefined) {
        this.session.notice('info', 'Left your working tree alone.');
        return null;
      }
      if (preferred !== 'new') await this.session.setBranchMode('new');
      return { mode: 'new', name: typed.trim() };
    }

    const mode: SessionBranchMode = answer === 'current' ? 'current' : 'new';
    if (mode !== preferred) await this.session.setBranchMode(mode);
    return { mode, name: proposed };
  }

  private async availableBranchName(root: string, proposed: string): Promise<string> {
    const { Git } = await import('../git.js');
    const git = new Git(root);
    // Resolved first so the name shown to the user (this return value feeds
    // straight into `chooseBranch`'s prompt) already matches what
    // `createBranch` will actually create — a proposal like
    // `main/drift/upgrade-x` is unrepresentable whenever `main` is the
    // branch it's being cut from, which is always, so previewing it
    // unresolved would show one name and create another.
    proposed = await git.resolveNestedBranchName(proposed);
    if (!(await git.branchExists(proposed).catch(() => false))) return proposed;

    for (let i = 1; i <= 99; i++) {
      const candidate = `${proposed}-${i}`;
      if (!(await git.branchExists(candidate).catch(() => false))) return candidate;
    }

    return `${proposed}-${Date.now().toString(36)}`;
  }

  /**
   * Run the project's typecheck and turn the result into something an agent
   * can act on.
   *
   * Only the typecheck, not the tests or the build. It is the fastest of the
   * three, it needs no working code to produce useful output, and after a major
   * upgrade it is the one that names the exact API that moved. Tests after a
   * breaking upgrade mostly fail to compile, which reports the same information
   * with a worse signal-to-noise ratio and takes minutes to do it.
   *
   * A clean typecheck is a real answer and is passed along as one: it tells the
   * agent that Drift's analysis predicts breakage the compiler cannot see, which
   * is worth knowing before it starts rewriting working code.
   */
  private async gatherDiagnostics(root: string, plan: RemediationPlan): Promise<string | undefined> {
    const dir = memberDirsOf(plan)[0] ?? '';
    const checks = (await availableChecks(root, dir)).filter((check) => check.kind === 'typecheck');
    if (checks.length === 0) return undefined;

    const check = checks[0]!;
    const step = this.session.step(`Checking what actually broke`);
    step.progress(`Running \`${check.label}\``, 'against the upgraded dependencies');

    const outcomes = await runChecks({ root, dir, checks: [check] });
    const outcome = outcomes[0];

    if (!outcome || outcome.status === 'not-run') {
      step.fail(outcome?.reason ?? 'Could not run it');
      return undefined;
    }

    if (outcome.status === 'passed') {
      step.done(`\`${check.label}\` passes`);
      return [
        `\`${check.label}\` passes against the upgraded dependencies — it ${CLEAN_TYPECHECK_MARKER}.`,
        '',
        'Treat that as a strong signal. The analysis above predicts breakage the',
        'compiler cannot see, which may mean the breakage is real but untyped',
        '(runtime behaviour, not signatures), or that a predicted site is already',
        'correct. Change nothing you cannot justify against the evidence.',
      ].join('\n');
    }

    const digest = digestDiagnostics(outcome.fullOutput ?? outcome.output, {
      focusFiles: [...new Set(plan.impactSites.map((site) => site.file))],
    });

    step.done(
      digest.unparsed
        ? `\`${check.label}\` failed`
        : `\`${check.label}\`: ${digest.total} error${digest.total === 1 ? '' : 's'} in ${
            digest.groups.length + digest.omittedGroups
          } distinct problem${digest.groups.length + digest.omittedGroups === 1 ? '' : 's'}`,
    );

    // Said in the panel too, in one line. The developer is about to watch an
    // agent work from this, and should know what it was handed.
    if (!digest.unparsed) {
      this.session.say(
        [
          `\`${check.label}\` reports **${digest.total} error${digest.total === 1 ? '' : 's'}** across ${
            digest.fileCount
          } file${digest.fileCount === 1 ? '' : 's'}, which are really **${
            digest.groups.length + digest.omittedGroups
          } distinct problem${digest.groups.length + digest.omittedGroups === 1 ? '' : 's'}**.`,
          '',
          ...digest.groups.slice(0, 5).map((group) => {
            const where = group.focused ? ' — on a file this upgrade was proved to affect' : '';
            return `- ${group.code ? `\`${group.code}\` ` : ''}${group.template} · **${group.total}×**${where}`;
          }),
          '',
          `I am handing all of this to ${this.agentLabel()} together with the changelog evidence, grouped so it fixes causes rather than occurrences.`,
        ].join('\n'),
      );
    }

    return renderDigest(digest, { label: check.label, rawTail: outcome.output });
  }

  /**
   * Create and check out the branch the whole change will live on.
   *
   * Returns the branch actually created — `Git.createBranch` may adjust
   * `name` to avoid an unrepresentable nested ref (see
   * `resolveNestedBranchName`), so callers that go on to reference the
   * branch (commit messages, PR bodies, status text) must use the returned
   * name rather than the one they proposed. `null` on failure.
   */
  private async startBranch(root: string, name: string): Promise<string | null> {
    const { Git } = await import('../git.js');
    try {
      const { created, name: actual } = await new Git(root).createBranch(name);
      this.session.notice(
        'info',
        created ? `Working on a new branch, \`${actual}\`.` : `Switched to the existing \`${actual}\`.`,
      );
      return actual;
    } catch (err) {
      this.session.notice('error', `Could not create \`${name}\`: ${(err as Error).message}`);
      return null;
    }
  }

  /** Commit the manifest and lockfile before any code fix starts. */
  private async commitUpgradeFiles(root: string, candidates: readonly UpgradeCandidate[]): Promise<boolean> {
    const { Git } = await import('../git.js');
    const git = new Git(root);
    const dirty = await git.dirtyFiles().catch(() => []);
    const paths = dependencyPaths(candidates, dirty);

    if (paths.length === 0) {
      this.session.notice('info', 'The upgrade did not leave any dependency files to commit.');
      return true;
    }

    const message = upgradeCommitMessage(candidates);
    try {
      const sha = await git.commitPaths(paths, message.subject, message.body, this.coAuthorOption());
      if (!sha) {
        this.session.notice('info', 'The dependency files already match HEAD, so there was no upgrade commit to make.');
        return true;
      }

      this.lastUpgraded = [...candidates];
      this.session.notice(
        'success',
        `Committed the upgrade first as **${sha.slice(0, 7)}** — ${message.subject}`,
      );
      return true;
    } catch (err) {
      this.session.notice('error', `Could not commit the upgrade before fixing code: ${(err as Error).message}`);
      return false;
    }
  }

  private async stashUserChangesForUpgrade(root: string): Promise<boolean> {
    const { Git } = await import('../git.js');
    const git = new Git(root);
    try {
      const stashed = await git.stash('drift: user changes before dependency upgrade');
      if (stashed) {
        this.session.notice(
          'info',
          'Temporarily stashed your existing work so the upgrade commit contains only Drift’s package-manager changes.',
        );
      }
      return stashed;
    } catch {
      return false;
    }
  }

  private async restoreUserChangesAfterUpgrade(root: string, stashed: boolean): Promise<boolean> {
    if (!stashed) return true;
    const { Git } = await import('../git.js');
    try {
      await new Git(root).stashPop();
      this.session.notice('info', 'Restored your pre-existing work after the upgrade commit.');
      return true;
    } catch (err) {
      this.session.notice(
        'error',
        `The upgrade commit was made, but Git could not restore your stashed work cleanly: ${(err as Error).message}. Resolve the stash conflict before continuing.`,
      );
      return false;
    }
  }


  /** For the ids nothing here can know: a fork, a preview, next month's model. */
  private async askForModel(agentId: string): Promise<void> {
    const agent = this.agents.find((entry) => entry.agent.id === agentId)?.agent;
    const typed = await vscode.window.showInputBox({
      title: `${agent?.label ?? 'Agent'}: model id`,
      prompt: 'Exactly as the agent expects it. Leave blank to go back to the default.',
      value: this.session.model(agentId) ?? '',
      placeHolder: 'for example: opus, gpt-5-codex, qwen2.5-coder:14b',
    });
    if (typed === undefined) return;
    await this.setModel(agentId, typed.trim());
  }

  /** Open the composer menu from the host, for `/agent` and the welcome link. */
  private openMenu(anchor: string): void {
    for (const surface of this.surfaces) void surface.webview.postMessage({ type: 'openMenu', anchor });
  }

  private async pickVersion(id: string): Promise<void> {
    const candidate = this.candidates.get(id);
    if (!candidate) return;

    type Item = vscode.QuickPickItem & { version: string };
    const picked = await vscode.window.showQuickPick<Item>(
      candidate.versions.map((version) => ({
        label: `${version === candidate.selected ? '$(check)' : '$(blank)'} ${version}`,
        description:
          version === candidate.latest
            ? 'latest published'
            : version === candidate.safeLatest
              ? `within your ${manifestName(candidate)} range`
              : version === candidate.latestMinor
                ? 'newest without a major bump'
                : undefined,
        version,
      })),
      {
        title: `${candidate.name}: target version`,
        placeHolder: `Currently checking ${candidate.selected} — picking another re-reads the evidence`,
      },
    );

    if (!picked || picked.version === candidate.selected) return;
    await this.retarget(id, picked.version);
  }

  /* ---------------------------------------------------------------- */
  /* Context                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Act on one row of the menu's Context section.
   *
   * Picking *which* file is the one choice still handed to VS Code, and
   * deliberately so: it is a fuzzy search over thousands of paths, and the
   * editor's own path picker — the thing `#file` opens in Copilot Chat — is
   * better at it than any list a webview could draw. What the menu replaced was
   * the part that was never a search: five two-item settings, each behind a
   * full-window palette.
   */
  private async addContext(what: string): Promise<void> {
    // The workspace folder, not `context()`: attaching a file needs a directory,
    // not a git inspection, and shelling out to git before opening the picker is
    // pure latency in front of a control the developer has already clicked.
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.session.notice('warn', 'Open a folder to attach context from it.');
      return;
    }

    if (what === 'upload') {
      await this.attachFromDisk(root);
      return;
    }

    if (what === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        this.session.notice('info', 'Nothing is selected in the editor right now.');
        return;
      }
      this.session.attach(describeSelection(root, editor));
      return;
    }

    if (what === 'folder') {
      const picked = await livePick<vscode.QuickPickItem & { value: string }>(
        { title: 'Add a folder as context', placeHolder: 'Type to filter folders' },
        this.projectPaths(root).then((paths) => {
          const folders = [...new Set(paths.map(dirname).filter((dir) => dir !== '.'))].sort();
          return folders.map((folder) => ({ label: `$(folder) ${folder}`, value: folder }));
        }),
      );
      if (picked) this.session.attach({ kind: 'folder', label: picked.value, value: picked.value });
      return;
    }

    const picked = await livePick<vscode.QuickPickItem & { value: string }>(
      {
        title: 'Add a file as context',
        placeHolder: 'Type to filter this project by path',
        matchOnDescription: true,
      },
      this.projectPaths(root).then((paths) =>
        paths.map((path) => ({
          label: `$(file) ${basename(path)}`,
          description: dirname(path) === '.' ? undefined : dirname(path),
          value: path,
        })),
      ),
    );
    if (picked) this.session.attach({ kind: 'file', label: picked.value, value: picked.value });
  }

  /**
   * Every path in the project, cached and warmed at startup.
   *
   * `findFiles` over a real repository takes long enough to be felt, and it was
   * being run *after* the developer asked for the picker — so the list they
   * wanted to type into appeared a second or two after they clicked. Now it is
   * usually already in hand, and when it is not the picker opens empty and busy
   * rather than not opening at all.
   */
  private paths: { at: number; value: Promise<string[]> } | null = null;

  private projectPaths(root: string): Promise<string[]> {
    if (this.paths && Date.now() - this.paths.at < 60_000) return this.paths.value;

    const value = Promise.resolve(vscode.workspace.findFiles('**/*', EXCLUDED_FROM_CONTEXT, 4000)).then((uris) =>
      uris.map((uri) => relative(root, uri.fsPath).replace(/\\/g, '/')).sort(),
    );

    this.paths = { at: Date.now(), value };
    return value;
  }

  /** The system browser, for the genuine case it is good at: files not in the project. */
  private async attachFromDisk(root: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: vscode.Uri.file(root),
      openLabel: 'Add as context',
      title: 'Upload from computer',
    });

    for (const uri of picked ?? []) {
      const path = relative(root, uri.fsPath).replace(/\\/g, '/') || '.';
      const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => null);
      const kind = stat?.type === vscode.FileType.Directory ? 'folder' : 'file';
      this.session.attach({ kind, label: path, value: path });
    }
  }

  /**
   * Turn attachment chips into something an agent can read.
   *
   * Files and selections are inlined, capped, because that is what makes them
   * useful without a tool loop. Folders are named but not walked — dumping a
   * directory into a prompt buries the evidence that matters under boilerplate.
   */
  private async resolveContext(root: string): Promise<AttachedContext[]> {
    const out: AttachedContext[] = [];

    for (const attachment of this.session.context) {
      if (attachment.kind === 'folder' || attachment.kind === 'package') {
        out.push({ kind: attachment.kind, label: attachment.label, value: attachment.value });
        continue;
      }

      const [path = '', span] = attachment.value.split(':');
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(join(root, path)));
        const text = Buffer.from(bytes).toString('utf8');

        if (attachment.kind === 'selection' && span) {
          const [from, to] = span.split('-').map((part) => Number(part));
          const lines = text.split('\n').slice(Math.max(0, (from ?? 1) - 1), to ?? from ?? 1);
          out.push({ ...attachment, content: lines.join('\n') });
          continue;
        }

        out.push({ ...attachment, content: text });
      } catch {
        // An attachment that has since been deleted is not worth failing over;
        // the path alone still tells the agent where the developer was looking.
        out.push({ kind: attachment.kind, label: attachment.label, value: attachment.value });
      }
    }

    return out;
  }

  private async setAgent(id: string, options: { quiet?: boolean } = {}): Promise<void> {
    if (id === '__pick') {
      await vscode.commands.executeCommand('drift.selectAgent');
      invalidateAgentCache();
      await this.refreshAgents();
      return;
    }

    await vscode.workspace
      .getConfiguration('drift')
      .update('agent.preferred', id, vscode.ConfigurationTarget.Global);
    invalidateAgentCache();
    await this.refreshAgents();
    if (!options.quiet) this.session.notice('info', `Agent set to **${this.agentLabel()}**.`);
  }

  private async openFile(file: string, line: number): Promise<void> {
    const target = Math.max(0, (line || 1) - 1);
    const found = await this.resolveWorkspaceFile(file);
    if (!found) {
      // A path that named something Drift read but that is not in any open
      // root — a file inside a throwaway test checkout, most often. Saying so
      // beats a click that silently does nothing.
      this.output.warn(`Drift: "${file}" is not in any folder open in this window; nothing to open.`);
      this.session.notice('info', `\`${file}\` is not in any folder open in this window.`);
      return;
    }

    this.output.info(`Drift: opened ${found.uri.fsPath}`);
    await vscode.window.showTextDocument(found.uri, {
      selection: new vscode.Range(target, 0, target, 0),
      preview: true,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  /**
   * Find a repo-relative path in whichever open root actually holds it.
   *
   * Progress lines come from every root a multi-root scan covered, so
   * resolving against the active one alone would open the wrong file — or,
   * more often, none — for every root but the first. Existence is checked
   * rather than assumed for the same reason: a link that opens an editor onto
   * a nonexistent file is worse than one that explains itself.
   *
   * Every candidate root is checked at once rather than one after another —
   * `vscode.workspace.fs.stat` is a filesystem round trip and, on a remote or
   * virtual workspace, a real one, so a developer with several roots open was
   * paying for that latency multiple times over on every click. The result
   * still prefers the active root over the others: `Promise.all` waits for
   * every check, and the roots are picked from in their original order rather
   * than by whichever settled first.
   */
  private async resolveWorkspaceFile(file: string): Promise<{ uri: vscode.Uri; root: string } | null> {
    const active = this.state.activeRoot?.path;
    const roots = [
      ...(active ? [active] : []),
      ...this.state.roots.map((root) => root.path).filter((path) => path !== active),
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    ];
    const distinct = [...new Set(roots)];

    const exists = await Promise.all(
      distinct.map(async (root) => {
        const uri = vscode.Uri.file(join(root, file));
        try {
          await vscode.workspace.fs.stat(uri);
          return true;
        } catch {
          return false;
        }
      }),
    );

    const at = exists.indexOf(true);
    if (at === -1) {
      this.output.info(
        `Drift: checked ${distinct.length} open root${distinct.length === 1 ? '' : 's'} for "${file}": ${distinct.join(', ') || '(none open)'}`,
      );
      return null;
    }
    return { uri: vscode.Uri.file(join(distinct[at]!, file)), root: distinct[at]! };
  }

  private async refreshIdentity(): Promise<void> {
    const session = await getGitHubSession({ createIfNone: false });
    this.signedInLabel = session?.account.label ?? null;
    this.render();
  }

  private async refreshAgents(): Promise<void> {
    const ctx = await this.context();
    this.agents = ctx
      ? await discoverAgents({ slug: ctx.info?.slug ?? null, baseBranch: ctx.info?.branch ?? 'working-tree' }, { force: true })
      : [];
    this.render();
    await this.refreshModels();
  }

  /**
   * Ask each usable subscription what it is offering.
   *
   * Done after the agents have been drawn rather than as part of drawing them:
   * a Copilot seat is queried over the network and Ollama over a socket, and the
   * row of buttons should not wait on either. They fill in a moment later.
   */
  private async refreshModels(): Promise<void> {
    const usable = this.available();

    await Promise.all(
      usable.map(async (entry) => {
        if (!entry.agent.listModels) return;
        const models = await entry.agent.listModels().catch(() => []);
        if (models.length === 0) return;
        this.models.set(entry.agent.id, models);
        await this.forgetRetiredModel(entry, models);
      }),
    );

    this.render();
  }

  /**
   * Drop a stored choice the subscription has stopped offering.
   *
   * A model id outlives the roster it came from. Drift held `gpt-5-codex` after
   * ChatGPT accounts lost access to it, and every fix run died on a 400 from
   * the API with the developer having chosen nothing wrong. Left in place the
   * setting fails the same way forever, because nothing about a saved id
   * expires on its own.
   *
   * Only done where the roster came from the install itself. A list this file
   * merely believes to be current is not grounds for overruling a developer's
   * setting; the CLI's own record of what it can reach is.
   */
  private async forgetRetiredModel(entry: DiscoveredAgent, models: readonly AgentModel[]): Promise<void> {
    if (!entry.agent.rosterIsAuthoritative) return;

    const chosen = this.session.model(entry.agent.id);
    if (!chosen || models.some((model) => model.id === chosen)) return;

    await this.session.setModel(entry.agent.id, undefined);
    this.session.notice(
      'warn',
      `**${entry.agent.label}** no longer offers \`${chosen}\`, so Drift has gone back to letting it choose. Pick another from the model button if you want a specific one.`,
    );
  }

  /**
   * The workspace, cached.
   *
   * `inspectLocalRepo` shells out to git and `loadWorkspaceConfig` reads and
   * parses a file, and almost every handler in this class needs both — opening a
   * file, attaching context, taking a checkpoint. Doing that work per click made
   * clicks cost a git invocation each. The window is short enough that a branch
   * switch is picked up within a couple of seconds, and any write Drift makes
   * clears it outright.
   */
  private contextCache: { at: number; value: WorkspaceContext | null } | null = null;

  private async context(): Promise<WorkspaceContext | null> {
    if (this.contextCache && Date.now() - this.contextCache.at < 3000) return this.contextCache.value;

    // The active root, not always the first folder — with more than one
    // open, `Drift: Switch Repository` decides which one every command in
    // this panel acts on.
    const root = this.state.activeRoot?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const value = root ? await this.contextFor(root) : null;
    this.contextCache = { at: Date.now(), value };
    return value;
  }

  /**
   * The context for one specific root, not necessarily the active one.
   *
   * Every candidate remembers which root it came from (`repoRoot`), so an
   * upgrade or a re-check on a candidate from a non-active root — the normal
   * case once more than one root is being scanned at once — still resolves
   * the right manifest directory and the right git identity, rather than
   * silently reusing whichever root happens to be active right now.
   */
  private async contextFor(root: string): Promise<WorkspaceContext | null> {
    let info = await inspectLocalRepo(root);
    if (!info) {
      const prepared = await this.prepareGitOrContinue(root);
      if (prepared === undefined) return null;
      info = prepared;
    }

    const config = await loadWorkspaceConfig(root).catch(() => DriftConfigSchema.parse({}));
    const repo: RepoContext = {
      owner: info?.slug?.split('/')[0] ?? 'local',
      repo: info?.slug?.split('/')[1] ?? basename(root),
      baseBranch: info?.branch ?? 'working-tree',
      beforeSha: info ? (info.parentSha ?? info.headSha) : WORKING_TREE,
      afterSha: info?.headSha ?? WORKING_TREE,
      workspace: root,
    };

    return { root, info, repo, config };
  }

  private async prepareGitOrContinue(root: string): Promise<WorkspaceContext['info'] | undefined> {
    const answer = await this.session.ask(
      `\`${basename(root)}\` is not a Git repository. I recommend initializing Git before Drift touches files, so there is a baseline commit to compare, rewind, branch, and review against.`,
      [
        {
          label: 'Initialize Git',
          value: 'init',
          description: 'Run git init and make a baseline commit before continuing',
        },
        {
          label: 'Continue without Git',
          value: 'continue',
          description: 'Scan and install can run, but there will be no branches, commits, or rewind',
        },
        { label: 'Cancel', value: 'cancel', description: 'Do nothing' },
      ],
      false,
    );

    if (answer === 'cancel' || answer === '') return undefined;
    if (answer === 'continue') return null;

    const { Git } = await import('../git.js');
    const git = new Git(root);
    const step = this.session.step('Initializing Git');
    try {
      step.progress('Running `git init`', basename(root));
      await git.init('main');
      step.progress('Creating baseline commit', 'Current files before Drift changes anything');
      await git.commitAll('chore: baseline before Drift', '', {
        allowEmpty: true,
        identity: { name: 'Drift', email: 'trydrift@outlook.com' },
        // No co-author trailer here. This commit captures the user's *existing*
        // files before Drift has changed anything, so crediting Drift as a
        // co-author of it would claim authorship of work it did not touch.
        coAuthors: false,
      });
      const info = await inspectLocalRepo(root);
      this.state.setRepo(info, root);
      this.contextCache = null;
      step.done('Git is ready');
      this.session.notice('success', 'Initialized Git and made a baseline commit before changing files.');
      return info;
    } catch (err) {
      step.fail('Git initialization failed');
      this.session.notice('error', `Could not initialize Git: ${(err as Error).message}`);
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Plumbing                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Run one operation at a time and keep the UI's busy flag honest.
   *
   * `cancellable: false` is for work whose partial result would be a lie. A scan
   * stopped half way has not "checked" the packages it never reached, but every
   * surface in the panel — the tallies, the safe list, the headline — would read
   * as though it had. Everything an agent does is interruptible; the check that
   * decides what is safe is not.
   */
  private async run(
    work: (token: vscode.CancellationToken) => Promise<void>,
    options: { cancellable?: boolean } = {},
  ): Promise<void> {
    if (this.running || (this.operationGate.active && !this.operationGateOwnerEnteringRun)) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    const source = new vscode.CancellationTokenSource();
    this.running = source;
    this.cancellable = options.cancellable !== false;
    this.stopping = false;
    this.render();

    let failed = false;
    try {
      await work(source.token);
    } catch (err) {
      failed = true;
      this.session.notice('error', (err as Error).message);
      this.output.error(String(err));
    } finally {
      // Nothing is running any more, so nothing may still look like it is.
      // Work that ended properly has already closed its own step or checklist,
      // which makes this a no-op on the happy path and the only thing standing
      // between a stopped run and a spinner that turns until the panel is
      // reloaded.
      // Unconditional, not just on the error and cancel paths: a step still
      // shown as running once `run` has returned is wrong however it got there,
      // and the invariant "no spinner outlives its run" is worth more than
      // being able to tell which bug left one behind.
      this.session.settleLive(source.token.isCancellationRequested && !failed ? 'stopped' : 'failed');
      source.dispose();
      this.running = null;
      this.cancellable = true;
      this.stopping = false;
      // Anything Drift just did may have moved the branch or rewritten a
      // manifest, so the cached view of the workspace is no longer trustworthy.
      this.contextCache = null;
      this.render();
    }
  }

  private busyMessage(): string {
    return this.cancellable
      ? 'Already working — stop the current run first.'
      : 'Still checking your dependencies. This one finishes before anything else starts.';
  }

  /* ---------------------------------------------------------------- */
  /* Staleness                                                         */
  /* ---------------------------------------------------------------- */

  private markStale(uri: vscode.Uri, reason: StaleHint['reason']): void {
    if (uri.scheme !== 'file') return;
    this.contextCache = null;
    // Nothing is stale before the first scan, and Drift's own edits are not news
    // — the run that made them reports what it did.
    if (!this.scanned || this.busy) return;

    const root = this.state.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

    const path = relative(root, uri.fsPath).replace(/\\/g, '/');
    if (!path || path.startsWith('..') || path.split('/').includes('node_modules')) return;

    // A dependency change outranks a code change: it can turn a package from
    // safe into affected, whereas an edit can only move where the impact is.
    if (this.stale?.reason === 'dependencies' && reason === 'code') return;
    if (this.stale?.reason !== reason) this.staleFiles.clear();

    this.staleFiles.add(path);
    this.stale = { reason, label: this.staleLabel(reason) };
    this.render();
  }

  private staleLabel(reason: StaleHint['reason']): string {
    const files = [...this.staleFiles];
    const first = files[0] ?? '';
    const rest = files.length - 1;

    if (reason === 'dependencies') {
      return `${first} changed since this scan${rest > 0 ? ` (and ${rest} more)` : ''} — these results may no longer be right.`;
    }
    return files.length === 1
      ? `You edited ${first} since this scan. Rescanning re-checks where the breaking changes land.`
      : `You edited ${files.length} files since this scan. Rescanning re-checks where the breaking changes land.`;
  }

  private clearStale(): void {
    this.stale = null;
    this.staleFiles.clear();
  }

  private refreshPackageList(): void {
    const ranked = [...this.candidates.values()].sort(bySeverity);
    this.session.updatePackages(headline(ranked, 0), ranked.map((c) => c.id));
  }

  private affectedIds(): string[] {
    return [...this.candidates.values()]
      .filter((candidate) => severityOf(candidate) === 'affected')
      .map((candidate) => candidate.id);
  }

  /**
   * The upgrades with nothing to decide.
   *
   * Everything Drift checked and found either clean upstream, or breaking
   * upstream in ways no code here uses. Packages it could not check are
   * excluded: "unknown" is not "safe", and sweeping them into a bulk action
   * would be the one place Drift claimed something it had not proved.
   */
  private safeIds(): string[] {
    return [...this.candidates.values()]
      .filter((candidate) => {
        const severity = severityOf(candidate);
        return severity === 'clean' || severity === 'upstream-only';
      })
      .map((candidate) => candidate.id);
  }

  private idsMatching(name: string): string[] {
    const needle = name.trim().toLowerCase().replace(/^@?/, '');
    return [...this.candidates.values()]
      .filter((candidate) => candidate.name.toLowerCase().replace(/^@?/, '').includes(needle))
      .map((candidate) => candidate.id);
  }

  private currentFor(candidate: UpgradeCandidate): UpgradeCandidate | undefined {
    return (
      this.candidates.get(candidate.id) ??
      [...this.candidates.values()].find((entry) => entry.name === candidate.name)
    );
  }

  private agentLabel(): string {
    const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
    const available = this.agents.filter((entry) => entry.availability.available);
    if (preferred === 'auto') return available[0]?.agent.label ?? 'your AI agent';
    return this.agents.find((entry) => entry.agent.id === preferred)?.agent.label ?? 'your AI agent';
  }

  /**
   * What the model button says.
   *
   * The model when one is chosen, the subscription when it is choosing for
   * itself — never both, because the button is one word wide and the useful
   * word is whichever the developer last decided. The subscription is in the
   * tooltip either way.
   *
   * `null` when nothing is installed, which turns the button into the way in
   * to setting an agent up rather than a label for a choice nobody has.
   */
  private modelLabel(): string | null {
    const active = this.activeAgent();
    if (!active) return null;

    const chosen = this.session.model(active.agent.id);
    if (!chosen) return active.agent.label;

    return this.models.get(active.agent.id)?.find((model) => model.id === chosen)?.label ?? chosen;
  }

  /** `null` hides the scope button — nothing to disambiguate with one root open. */
  private scopeLabel(): string | null {
    const roots = this.state.roots;
    if (roots.length <= 1) return null;

    const selected = this.selectedRoots();
    if (selected.length === roots.length) return `${roots.length} repositories`;
    if (selected.length === 1) return selected[0]!.label;
    return `${selected.length} of ${roots.length} repositories`;
  }

  /**
   * Coalesce renders.
   *
   * A scan reports progress many times a second. Without this the panel would
   * post an update per progress line; with it a burst costs one. The delay is
   * short enough that progress still reads as live, and it is now the only
   * latency between a state change and the screen — the update itself is a
   * message carrying a string of markup, not a document reload.
   */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Repaint for a reason that has nothing to do with state.
   *
   * The one caller is the syntax highlighter finishing its build, or rebuilding
   * against a theme the user just switched to: nothing about the analysis
   * changed, but every snippet on screen is now painted in the wrong palette.
   */
  rerender(): void {
    this.render();
  }

  private render(): void {
    if (this.surfaces.length === 0 || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.paint();
    }, 60);
  }

  private paint(): void {
    if (this.surfaces.length === 0) return;

    const memory = process.memoryUsage();
    const span = startSpan('extension.summary-render', {
      candidates: this.candidates.size,
      surfaces: this.surfaces.length,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      rss: memory.rss,
    });
    const body = renderBody(this.viewModel());
    const bytes = Buffer.byteLength(body);
    countWork('extension.summary-render-attempts');
    countWork('extension.summary-render-bytes', bytes);
    span.end({ bytes });
    for (const surface of this.surfaces) {
      if (surface.ready) this.sendBody(surface, body);
    }
  }

  /** Keep exactly one renderer update in flight; intermediate revisions collapse. */
  private sendBody(surface: Surface, body: string): void {
    if (surface.stalled) {
      surface.pendingBody = body;
      surface.pendingCandidates.clear();
      return;
    }
    if (surface.awaitingSequence !== null) {
      surface.pendingBody = body;
      surface.pendingCandidates.clear();
      return;
    }
    const sequence = ++surface.nextSequence;
    this.cancelDetailTransfer(surface);
    surface.pendingCandidates.clear();
    surface.awaitingSequence = sequence;
    this.armAckTimeout(surface, sequence);
    countWork('extension.ui-messages');
    countWork('extension.ui-payload-bytes', Buffer.byteLength(body));
    const span = startSpan('extension.post-message', { type: 'render', sequence, bytes: Buffer.byteLength(body) });
    void surface.webview.postMessage({ type: 'render', sequence, body }).then(
      (accepted) => {
        span.end({ accepted });
        if (accepted) return;
        this.recoverSummaryPost(surface, sequence, surface.pendingBody ?? body);
      },
      () => {
        span.fail(new Error('webview rejected render message'));
        this.recoverSummaryPost(surface, sequence, surface.pendingBody ?? body);
      },
    );
  }

  private candidatesChanged(change: CandidateStateChange): void {
    const span = startSpan('extension.candidate-publication', {
      revision: change.revision,
      added: change.added.length,
      updated: change.updated.length,
      removed: change.removed.length,
    });
    const invalidated = new Set([...change.updated, ...change.removed]);
    for (const surface of this.surfaces) {
      surface.pendingDetailRequests = surface.pendingDetailRequests.filter((request) => !invalidated.has(request.id));
      if (surface.detailTransfer && invalidated.has(surface.detailTransfer.id)) this.cancelDetailTransfer(surface, true);
    }
    let requiresLayout = change.added.length > 0 || change.removed.length > 0;
    for (const id of [...change.added, ...change.updated]) {
      const candidate = this.candidates.get(id);
      if (!candidate) continue;
      const presentation = candidatePresentationOf(candidate);
      const previous = this.candidatePresentation.get(id);
      if (previous !== undefined && previous !== presentation) requiresLayout = true;
      this.candidatePresentation.set(id, presentation);
    }
    for (const id of change.removed) this.candidatePresentation.delete(id);

    if (requiresLayout) {
      countWork('extension.candidate-layout-invalidations');
      span.end({ mode: 'layout' });
      this.render();
      return;
    }

    const showRepo = new Set([...this.candidates.values()].map((candidate) => candidate.repoRoot).filter(Boolean)).size > 1;
    for (const surface of this.surfaces) {
      if (!surface.ready) continue;
      for (const id of change.updated) {
        const candidate = this.candidates.get(id);
        if (candidate) {
          surface.pendingCandidates.set(
            id,
            renderCandidateSummary(candidate, showRepo, this.busy),
          );
        }
      }
      if (surface.awaitingSequence === null) this.sendCandidateBatch(surface);
    }
    countWork('extension.candidate-upserts', change.updated.length);
    span.end({ mode: 'patch' });
  }

  private sendCandidateBatch(surface: Surface): void {
    if (surface.stalled || surface.awaitingSequence !== null || surface.pendingBody !== null) return;
    const { operations, bytes } = takeCandidateSummaryBatch(surface.pendingCandidates);
    if (operations.length === 0) return;
    const sequence = ++surface.nextSequence;
    surface.awaitingSequence = sequence;
    this.armAckTimeout(surface, sequence);
    countWork('extension.ui-messages');
    countWork('extension.ui-payload-bytes', bytes);
    countWork('extension.candidate-batches');
    const span = startSpan('extension.post-message', {
      type: 'candidate-batch',
      sequence,
      operations: operations.length,
      bytes,
    });
    void surface.webview.postMessage({ type: 'candidateBatch', sequence, operations }).then(
      (accepted) => {
        span.end({ accepted });
        if (accepted) return;
        this.recoverSummaryPost(surface, sequence, renderBody(this.viewModel()));
      },
      () => {
        span.fail(new Error('webview rejected candidate batch'));
        this.recoverSummaryPost(surface, sequence, renderBody(this.viewModel()));
      },
    );
  }

  private recoverSummaryPost(surface: Surface, sequence: number, latest: string): void {
    if (surface.awaitingSequence !== sequence) return;
    if (surface.ackTimer) clearTimeout(surface.ackTimer);
    surface.ackTimer = null;
    surface.pendingBody = latest;
    surface.pendingCandidates.clear();
    surface.postFailures += 1;
    if (surface.postFailures >= 2) {
      surface.awaitingSequence = null;
      surface.stalled = true;
      return;
    }

    // Keep the failed sequence reserved during the short retry delay so state
    // changes continue to collapse into `pendingBody` instead of overtaking it.
    surface.ackTimer = setTimeout(() => {
      if (surface.awaitingSequence !== sequence) return;
      surface.awaitingSequence = null;
      surface.ackTimer = null;
      const body = surface.pendingBody;
      surface.pendingBody = null;
      if (body !== null) this.sendBody(surface, body);
    }, 250);
  }

  private armAckTimeout(surface: Surface, sequence: number): void {
    if (surface.ackTimer) clearTimeout(surface.ackTimer);
    surface.ackTimer = setTimeout(() => {
      if (surface.awaitingSequence !== sequence) return;
      surface.awaitingSequence = null;
      surface.ackTimer = null;
      surface.pendingCandidates.clear();
      const latest = renderBody(this.viewModel());
      if (!surface.resyncAttempted) {
        surface.resyncAttempted = true;
        surface.pendingBody = null;
        this.sendBody(surface, latest);
      } else {
        // A second missing application acknowledgement means the renderer is
        // not consuming. Retain one latest state and wait for a webview reload.
        surface.stalled = true;
        surface.pendingBody = latest;
      }
    }, 2_000);
  }

  private sendDetailChunk(surface: Surface): void {
    const transfer = surface.detailTransfer;
    if (!transfer || transfer.awaitingIndex !== null) return;
    if (transfer.next >= transfer.chunks.length) {
      this.cancelDetailTransfer(surface, true);
      return;
    }
    const index = transfer.next;
    const chunk = transfer.chunks[index]!;
    transfer.awaitingIndex = index;
    if (surface.detailAckTimer) clearTimeout(surface.detailAckTimer);
    surface.detailAckTimer = setTimeout(() => this.retryDetailChunk(surface, transfer, index), 2_000);
    countWork('extension.detail-chunks');
    countWork('extension.detail-payload-bytes', Buffer.byteLength(chunk));
    void surface.webview.postMessage({
      type: 'candidateDetailChunk',
      requestId: transfer.requestId,
      index,
      total: transfer.chunks.length,
      chunk,
    }).then(
      (accepted) => {
        if (!accepted) this.retryDetailChunk(surface, transfer, index, 100);
      },
      () => this.retryDetailChunk(surface, transfer, index, 100),
    );
  }

  private queueDetailRequest(
    surface: Surface,
    request: { id: string; requestId: string; section?: string },
  ): void {
    if (
      surface.detailTransfer?.requestId === request.requestId
      || surface.pendingDetailRequests.some((pending) => pending.requestId === request.requestId)
    ) return;
    if (!surface.detailTransfer) {
      this.startDetailTransfer(surface, request.id, request.requestId, request.section);
      return;
    }
    if (surface.pendingDetailRequests.length < 8) {
      surface.pendingDetailRequests.push(request);
      return;
    }
    void surface.webview.postMessage({
      type: 'candidateDetailRetry',
      ...request,
      retryAfterMs: 250,
    });
  }

  private retryDetailChunk(surface: Surface, transfer: NonNullable<Surface['detailTransfer']>, index: number, delay = 250): void {
    if (surface.detailTransfer !== transfer || transfer.awaitingIndex !== index) return;
    if (surface.detailAckTimer) clearTimeout(surface.detailAckTimer);
    transfer.awaitingIndex = null;
    transfer.retries += 1;
    // One timer and one message remain in flight regardless of how long the
    // renderer is unavailable. A duplicate chunk is safe: the webview ACKs it
    // again without appending it twice.
    const backoff = Math.min(2_000, delay * Math.max(1, transfer.retries));
    surface.detailAckTimer = setTimeout(() => {
      surface.detailAckTimer = null;
      this.sendDetailChunk(surface);
    }, backoff);
  }

  private cancelDetailTransfer(surface: Surface, startNext = false): void {
    if (surface.detailAckTimer) clearTimeout(surface.detailAckTimer);
    surface.detailAckTimer = null;
    surface.detailTransfer = null;
    if (!startNext) {
      surface.pendingDetailRequests = [];
      return;
    }
    const pending = surface.pendingDetailRequests.shift();
    if (pending) this.startDetailTransfer(surface, pending.id, pending.requestId, pending.section);
  }

  private startDetailTransfer(surface: Surface, id: string, requestId: string, section?: string): void {
    const candidate = this.candidates.get(id);
    if (!candidate) return;
    if (this.busy) {
      void surface.webview.postMessage({
        type: 'candidateDetailRetry',
        id,
        requestId,
        ...(section ? { section } : {}),
        retryAfterMs: 1_000,
      });
      return;
    }
    const span = startSpan('extension.detail-render', { candidateId: id, ...(section ? { section } : {}) });
    const html = section ? renderCandidateSection(candidate, section) : renderCandidateBody(candidate, true);
    if (html === null) {
      span.end({ missing: true });
      return;
    }
    span.end({ bytes: Buffer.byteLength(html) });
    countWork('extension.detail-requests');
    surface.detailTransfer = {
      id,
      requestId,
      ...(section ? { section } : {}),
      chunks: chunkDetail(html),
      next: 0,
      awaitingIndex: null,
      retries: 0,
    };
    this.sendDetailChunk(surface);
  }

  private viewModel(): ViewModel {
    const totals = this.review.totals();

    return {
      nonce: makeNonce(),
      repoLabel: this.state.repo?.slug ?? null,
      signedInLabel: this.signedInLabel,
      agents: this.agents.map(toChoice),
      agentId: vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto'),
      agentLabel: this.agentLabel(),
      mode: this.session.mode,
      effortLabel: this.effortLabel(),
      modelLabel: this.modelLabel(),
      permission: this.session.permission,
      branchMode: this.session.branchMode,
      commitMode: this.session.commitMode,
      scopeLabel: this.scopeLabel(),
      attachments: this.session.context,
      thread: this.session.thread,
      candidates: Object.fromEntries(this.candidates),
      review: totals.files > 0 ? { groups: this.review.groups(), totals } : null,
      busy: this.busy,
      cancellable: this.cancellable,
      stopping: this.stopping,
      awaitingAnswer: this.session.awaitingAnswer,
      commands: SLASH_COMMANDS,
      menu: this.menuSections(),
      stale: this.stale,
      draft: this.draft,
      draftToken: this.draftToken,
      // Scopes the typewriter's bookkeeping to one conversation, so reopening an
      // old thread does not retype a message it already typed months ago.
      conversationId: this.conversationId,
      lazyCandidateDetails: true,
    };
  }
}

/** Layout bucket used to decide whether a row can be patched in place. */
function candidatePresentationOf(candidate: UpgradeCandidate): string {
  if (candidate.status === 'pending' || candidate.status === 'checking' || candidate.status === 'upgrading') {
    return 'checking';
  }
  const severity = severityOf(candidate);
  return severity === 'upstream-only' ? 'clean' : severity;
}

async function scanWithTransientHttpCache(
  options: Parameters<typeof scanUpgrades>[0],
): Promise<Awaited<ReturnType<typeof scanUpgrades>>> {
  try {
    return await scanUpgrades(options);
  } finally {
    const before = process.memoryUsage();
    const release = startSpan('extension.http-memory-release', {
      heapUsed: before.heapUsed,
      external: before.external,
      arrayBuffers: before.arrayBuffers,
      rss: before.rss,
    });
    clearHttpCache();
    const after = process.memoryUsage();
    release.end({
      heapUsed: after.heapUsed,
      external: after.external,
      arrayBuffers: after.arrayBuffers,
      rss: after.rss,
    });
  }
}

/**
 * A quick pick that opens now and fills in when the data arrives.
 *
 * `showQuickPick(promise)` waits for the promise before drawing anything, so a
 * picker over a few thousand paths appears a beat after the click — which reads
 * as the panel having missed it. This draws the list immediately with its busy
 * indicator on, which is both faster and honest about what is happening.
 */
function livePick<T extends vscode.QuickPickItem>(
  options: { title: string; placeHolder: string; matchOnDescription?: boolean },
  items: Promise<T[]>,
): Promise<T | undefined> {
  const pick = vscode.window.createQuickPick<T>();
  pick.title = options.title;
  pick.placeholder = options.placeHolder;
  pick.matchOnDescription = options.matchOnDescription ?? false;
  pick.busy = true;
  pick.show();

  void items
    .then((resolved) => {
      pick.items = resolved;
      pick.busy = false;
    })
    .catch(() => {
      pick.items = [];
      pick.busy = false;
    });

  return new Promise<T | undefined>((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]);
      pick.hide();
    });
    // Also covers accept, which hides the picker — a promise settles once.
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
  });
}

/** The active editor's selection, as an attachment `resolveContext` can read back. */
function describeSelection(root: string, editor: vscode.TextEditor): Attachment {
  const path = relative(root, editor.document.uri.fsPath).replace(/\\/g, '/');
  const span = `${path}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
  return { kind: 'selection', label: span, value: span };
}

/** Fit a message into a dialog title without letting it run off the end. */
function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function toChoice(entry: DiscoveredAgent): AgentChoice {
  return {
    id: entry.agent.id,
    label: entry.agent.label,
    available: entry.availability.available,
    detail: entry.availability.detail,
    reason: entry.availability.reason,
  };
}

/**
 * The plan, turned into something with checkboxes.
 *
 * One group per commit unit, because that is the unit the fix flow actually
 * works in and the unit the developer will later keep or undo. Underneath it,
 * one task per breaking change per file, naming the line — which is the level at
 * which a developer can check the claim rather than take it on faith.
 */
function buildTaskGroups(plan: RemediationPlan): TaskGroup[] {
  const changeById = new Map(plan.breakingChanges.map((change) => [change.id, change]));

  return plan.commits.map((commit) => {
    const sites = plan.impactSites.filter(
      (site) => commit.files.includes(site.file) && commit.breakingChangeIds.includes(site.breakingChangeId),
    );

    // Twenty sites in one file for the same change is one task, not twenty
    // rows: the agent will read the file once, and the developer wants the
    // file, not a transcript of every line in it.
    const seen = new Map<string, { file: string; line: number; changeId: string; count: number }>();
    for (const site of sites) {
      const key = `${site.breakingChangeId}|${site.file}`;
      const existing = seen.get(key);
      if (existing) {
        existing.count += 1;
        existing.line = Math.min(existing.line, site.line);
        continue;
      }
      seen.set(key, { file: site.file, line: site.line, changeId: site.breakingChangeId, count: 1 });
    }

    const packages = new Set(
      commit.breakingChangeIds.map((id) => changeById.get(id)?.dependency).filter(Boolean) as string[],
    );

    return {
      id: `c${commit.order}`,
      title: commit.message,
      package: packages.size === 1 ? [...packages][0] : undefined,
      state: 'pending',
      tasks: [...seen.values()].map((entry, index) => {
        const change = changeById.get(entry.changeId);
        return {
          id: `c${commit.order}-${index}`,
          label: change?.summary ?? 'Update the affected code',
          file: entry.file,
          line: entry.line,
          detail: entry.count > 1 ? `${entry.count} sites in this file` : undefined,
          state: 'pending' as const,
        };
      }),
    };
  });
}

/** Which group agent chatter belongs against: the one being worked on. */
function activeGroupId(plan: RemediationPlan, state: DriftState): string {
  const status = state.status;
  const order = status.kind === 'fixing' ? status.commitOrder : plan.commits[0]?.order;
  return `c${order ?? 1}`;
}


/**
 * Workspace member directories a plan touches, nearest first.
 *
 * Checks run where the affected package lives, so a monorepo runs that
 * package's tests rather than every package's.
 */
function memberDirsOf(plan: RemediationPlan): string[] {
  const dirs = new Set<string>();
  for (const change of plan.changes) if (change.workspace !== undefined) dirs.add(change.workspace);
  return dirs.size === 0 ? [''] : [...dirs].sort((a, b) => b.length - a.length);
}

/**
 * Whether a version really is inside a declared range.
 *
 * Tolerant of ranges `semver` cannot parse — a workspace protocol, a git URL, a
 * catalog reference. Those are not violations, they are questions this cannot
 * answer, and answering "outside the range" would be a false alarm about
 * someone's monorepo. Unknown reads as "no complaint".
 */
function satisfiesRange(version: string, range: string): boolean {
  if (!range.trim()) return true;
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return true;
  }
}

/** What is actually in `node_modules`, or `null` when that cannot be read. */
async function installedVersion(root: string, candidate: UpgradeCandidate): Promise<string | null> {
  // Only npm-family layouts put a readable manifest at a predictable path.
  if (candidate.ecosystem !== 'npm') return null;

  const dir = candidate.workspace ? join(root, candidate.workspace) : root;
  for (const base of [dir, root]) {
    try {
      const uri = vscode.Uri.file(join(base, 'node_modules', ...candidate.name.split('/'), 'package.json'));
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // Not installed here, or not readable. The next candidate directory —
      // and then "cannot tell", which never produces a warning.
    }
  }

  return null;
}

/**
 * Why a branch name would not work, or nothing.
 *
 * Only the rules git itself enforces. A house style is the developer's
 * business, and a picker that rejects their convention is a picker they will
 * stop using.
 */
function validateBranchName(value: string): string | null {
  const name = value.trim();
  if (!name) return 'A branch needs a name.';
  if (/\s/.test(name)) return 'Branch names cannot contain spaces.';
  if (/[~^:?*\[\\]/.test(name)) return 'Branch names cannot contain ~ ^ : ? * [ or \\.';
  if (name.startsWith('/') || name.endsWith('/')) return 'Branch names cannot start or end with /.';
  if (name.includes('//')) return 'Branch names cannot contain //.';
  if (name.endsWith('.') || name.includes('..')) return 'Branch names cannot contain .. or end with .';
  if (name.endsWith('.lock')) return 'Branch names cannot end with .lock.';
  return null;
}

/** The manifest file the developer would open, without its directory. */
function manifestName(candidate: UpgradeCandidate): string {
  const path = candidate.manifestPath;
  return path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
}

/**
 * Why a concern the compiler just cleared was shown as outstanding at all.
 *
 * The scan installs every upgrade and runs the project's checks before it
 * reports anything, so predictions reaching the fix stage un-withdrawn means
 * that measurement did not happen — and the reason it did not is on the
 * verification the scan attached to the plan. Said here in full: it is a
 * complete sentence written for a developer (`upgrade-probe.ts` builds it that
 * way), and it is the only thing that explains a count that just evaporated.
 */
function whyPredictionsSurvived(verification: RemediationPlan['verification']): string {
  if (!verification) {
    return ' Verification was switched off for this scan, so what you were shown was a prediction rather than a measurement.';
  }
  if (verification.status === 'skipped') {
    return ` The scan could not test this upgrade, so it could only show you the prediction: ${verification.reason ?? 'no reason was recorded.'}`;
  }
  return ` The scan reached the same conclusion (${verification.status}); these concerns should not have been shown as outstanding.`;
}

/**
 * One finished check, as a line in the step's log.
 *
 * The log is the answer to "is it still going?" — every check that has settled
 * is named with its verdict, so the row above it showing a spinner and a
 * running command is unambiguously the one still working.
 */
function describeOutcome(outcome: CheckOutcome): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  switch (outcome.status) {
    case 'passed':
      return `\`${outcome.label}\` passed in ${seconds}s`;
    case 'failed':
      return `\`${outcome.label}\` failed in ${seconds}s`;
    case 'cancelled':
      return `\`${outcome.label}\` cancelled`;
    case 'not-run':
      return `\`${outcome.label}\` could not run`;
  }
}

function checkStatusText(outcome: CheckOutcome): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  switch (outcome.status) {
    case 'passed':
      return `passed in ${seconds}s`;
    case 'failed':
      return `failed in ${seconds}s`;
    case 'cancelled':
      return 'was cancelled';
    case 'not-run':
      return 'could not run';
  }
}

function cleanFence(output: string): string {
  return output.replace(/```/g, '` ` `');
}

// A thin wrapper around the shared `compareSeverity`, rather than a second
// rank table kept by hand: a duplicate here is exactly how the previous
// version fell out of sync (no `upstream-only` entry, no way to add a new
// severity without remembering to update both copies).
function bySeverity(a: UpgradeCandidate, b: UpgradeCandidate): number {
  const diff = compareSeverity(a, b);
  return diff !== 0 ? diff : a.name.localeCompare(b.name);
}

/**
 * The sentence above the results.
 *
 * Leads with how many upgrades touch this repository, because that is the number
 * that decides what the developer does next. The count of upstream breaking
 * changes is not mentioned here at all — it is available on each package, where
 * it has the context that makes it meaningful.
 */
/**
 * A few package names, for a title that has to fit on one line.
 *
 * Two names and a count beats five truncated ones: the point is to recognise
 * the conversation, and the first packages are the ones a developer went in
 * for.
 */
function namesOf(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 0) return 'dependencies';
  if (unique.length <= 2) return unique.join(', ');
  return `${unique.slice(0, 2).join(', ')} +${unique.length - 2}`;
}

function headline(
  candidates: readonly UpgradeCandidate[],
  checked: number,
  /**
   * Dependencies whose version lookup never returned, so they never became
   * candidates. Counted into the caveat below rather than left out: a
   * dependency Drift could not reach is not one it found nothing wrong with.
   */
  unlooked = 0,
): string {
  // A failed verification has no located call site, but it is measured
  // evidence of breakage — folded in with `affected` here so it is never
  // counted toward `safe` below. The bug this guards against: `zod` and
  // `typescript` were once called safe from the exact same kind of gap,
  // just upstream of this function instead of in it.
  const affected =
    candidates.filter((c) => severityOf(c) === 'affected' || severityOf(c) === 'verification-failed').length;
  const unchecked = candidates.filter((c) => severityOf(c) === 'unchecked').length + unlooked;

  // Rows a manifest produced that nothing has looked at yet. They are counted
  // separately and never folded into `safe`: while a scan is running the list
  // is mostly these, and a headline that added them to the safe pile would
  // announce a clean bill of health for packages nobody had opened.
  const pending = candidates.filter((c) => severityOf(c) === 'pending');
  if (pending.length > 0) {
    const answered = candidates.length - pending.length;
    return (
      `**Checking ${candidates.length} dependenc${candidates.length === 1 ? 'y' : 'ies'}** — ` +
      `${answered} answered so far` +
      (affected > 0 ? `, ${affected} affecting code in this repository` : '') +
      '.'
    );
  }

  const safe = candidates.length - affected - (unchecked - unlooked);
  const scope = checked > 0 ? ` out of ${checked} checked` : '';

  if (candidates.length === 0) {
    return unlooked > 0
      ? `No newer versions available for the dependencies Drift could check. ${unlooked} could not be checked at all.`
      : 'No newer versions available.';
  }

  // Never folded into "safe". A headline that counts an unverified upgrade as
  // safe is the same claim that put zod 4 and typescript 7 into this
  // repository, one level further up the page.
  const caveat =
    unchecked === 0
      ? ''
      : ` ${unchecked} ${unchecked === 1 ? 'could not be verified at all — read that one yourself' : 'could not be verified at all — read those yourself'}.`;

  if (affected === 0 && safe === candidates.length) {
    return `**${candidates.length} upgrade${candidates.length === 1 ? '' : 's'} available**${scope}, and none of them affect code in this repository. Safe to take.`;
  }

  if (affected === 0) {
    return `**${candidates.length} upgrade${candidates.length === 1 ? '' : 's'} available**${scope}. ${safe === 0 ? 'None' : `${safe}`} affect${safe === 1 ? 's' : ''} code in this repository.${caveat}`;
  }

  return `**${affected} of ${candidates.length} upgrade${candidates.length === 1 ? '' : 's'}**${scope} affect${affected === 1 ? 's' : ''} code in this repository.${safe > 0 ? ` ${safe} ${safe === 1 ? 'is' : 'are'} safe to take as-is.` : ''}${caveat}`;
}

function combinePlans(repo: RepoContext, config: DriftConfig, plans: RemediationPlan[]): RemediationPlan {
  const combined = buildPlan({
    repo,
    config,
    changes: plans.flatMap((p) => p.changes),
    evidence: plans.flatMap((p) => p.evidence),
    breakingChanges: plans.flatMap((p) => p.breakingChanges),
    impactSites: plans.flatMap((p) => p.impactSites),
  });

  // `buildPlan` builds from changes and sites, so anything measured *about*
  // those plans is lost unless it is carried across explicitly — and this is
  // the path every fix takes, including a fix over a single candidate. Dropping
  // it here is what made a scan that had verified an upgrade arrive at the fix
  // stage looking like a scan that never ran a check at all.
  const verification = combineVerifications(plans.map((p) => p.verification));
  return verification ? { ...combined, verification } : combined;
}

/**
 * The before/after diff request a panel button carries, validated.
 *
 * The payload crosses a webview boundary as a string, so it is untrusted in
 * shape even though the renderer on the other side is Drift's own: anything
 * that is not a well-formed request is dropped rather than half-applied.
 */
function parseChangeDiffRequest(value: string | undefined): ChangeDiffRequest | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const request = parsed as Record<string, unknown>;
    if (typeof request.before !== 'string' || typeof request.after !== 'string') return null;
    return {
      before: request.before,
      after: request.after,
      title: typeof request.title === 'string' ? request.title : 'change',
      ...(typeof request.language === 'string' ? { language: request.language } : {}),
      ...(typeof request.symbol === 'string' ? { symbol: request.symbol } : {}),
      ...(isSource(request.source) ? { source: request.source } : {}),
    };
  } catch {
    return null;
  }
}

function isSource(value: unknown): value is { ecosystem: string; name: string; from: string; to: string } {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.ecosystem === 'string' &&
    typeof source.name === 'string' &&
    typeof source.from === 'string' &&
    typeof source.to === 'string'
  );
}
