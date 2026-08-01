import * as vscode from 'vscode';
import { basename, dirname, join, relative } from 'node:path';
import semver from 'semver';
import { digestDiagnostics, renderDigest } from '../diagnostics-digest.js';
import type { RemediationPlan, RepoContext } from '../../../src/types.js';
import { buildPlan } from '../../../src/plan/index.js';
import { renderPullRequestBody } from '../../../src/report/markdown.js';
import { inspectLocalRepo, WORKING_TREE } from '../../../src/repo/local-git.js';
import { DriftConfigSchema, type DriftConfig } from '../../../src/config/schema.js';
import { loadWorkspaceConfig, runAnalysis } from '../analyze.js';
import { runFix, type FixResult } from '../fix.js';
import type { DriftState, RepoRoot } from '../state.js';
import type { NestedProject } from '../../../src/detect/nested.js';
import {
  DriftSession,
  type Attachment,
  type SessionBranchMode,
  type SessionCommitMode,
  type SessionEffort,
  type SessionMode,
  type SessionPermission,
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
  installUpgrade,
  reanalyzeUpgrade,
  scanUpgrades,
  upgradeCommandFor,
  severityOf,
  type ManagerPreferences,
  type UpgradeCandidate,
} from '../upgrades.js';
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
import { Checkpoints } from '../checkpoint.js';
import { DriftReportPanel } from './report.js';
import {
  makeNonce,
  renderBody,
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
  | { type: 'submit'; text: string }
  | { type: 'draft'; text: string }
  | { type: 'answer'; id: string; value: string }
  | { type: 'menu'; id: string }
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
  | { type: 'pickVersion'; id: string }
  | { type: 'recheck'; id: string }
  | { type: 'upgrade'; id: string; mode: 'safe' | 'force' }
  | { type: 'fixPackage'; id: string }
  | { type: 'fixAll' }
  | { type: 'keepFile' | 'undoFile'; path: string }
  | { type: 'keepGroup' | 'undoGroup'; order: number }
  | { type: 'keepAll' | 'undoAll' };

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
}

export class DriftHomeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private surfaces: Surface[] = [];
  private candidates = new Map<string, UpgradeCandidate>();
  private agents: DiscoveredAgent[] = [];
  /** Models each subscription is currently offering, keyed by agent id. */
  private models = new Map<string, AgentModel[]>();
  private signedInLabel: string | null = null;
  private running: vscode.CancellationTokenSource | null = null;
  private cancellable = true;
  private draft = '';
  private draftToken = 0;
  private scanned = false;
  /**
   * What the last successful upgrade installed.
   *
   * Kept so `/commit`, `/push` and `/pr` can describe the work in the same terms
   * the upgrade did — the same packages, the same evidence — instead of falling
   * back to "some dependency files changed" once the offer scrolls out of view.
   */
  private lastUpgraded: UpgradeCandidate[] = [];
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
    const manifests = vscode.workspace.createFileSystemWatcher(
      '**/{package.json,package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,pyproject.toml,requirements.txt,poetry.lock,uv.lock,go.mod,go.sum,Cargo.toml,Cargo.lock,Gemfile,Gemfile.lock,pom.xml,build.gradle,build.gradle.kts}',
    );
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
    // exactly when the commit the planner described should exist.
    review.setCommitHandler(async (group) => this.commitGroup(group));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // The sidebar view is resolved again whenever it is closed and reopened, and
    // the old webview is dead by then — keeping it in the list would mean
    // posting every update at something that will never draw it.
    this.surfaces = this.surfaces.filter((surface) => surface.webview !== this.view?.webview);

    this.view = view;
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
    const surface: Surface = { webview, ready: false };
    this.surfaces.push(surface);

    this.disposables.push(
      webview.onDidReceiveMessage((message: Incoming) => {
        if (message.type === 'ready') {
          surface.ready = true;
          void webview.postMessage({ type: 'render', body: renderBody(this.viewModel()) });
          return;
        }
        void this.handle(message);
      }),
    );

    webview.html = renderPanel(this.viewModel());
  }

  private detach(webview: vscode.Webview): void {
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
    await this.saveConversation();

    const entries = this.history.list();
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('Drift: no earlier conversations in this workspace yet.');
      return;
    }

    type Item = vscode.QuickPickItem & { id: string };
    const picked = await vscode.window.showQuickPick<Item>(
      [
        ...entries.map<Item>((entry) => ({
          id: entry.id,
          label: `${entry.id === this.conversationId ? '$(comment-discussion)' : '$(history)'} ${entry.title}`,
          description: describeWhen(entry.at),
          detail: `${entry.messages} message${entry.messages === 1 ? '' : 's'}`,
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

    const entry = this.history.get(picked.id);
    if (!entry) return;

    this.conversationId = entry.id;
    this.session.restore(entry.items);
    this.setDraft('');
    await this.reveal();
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
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('Drift: there is no saved conversation history to clear.');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Delete ${entries.length} saved Drift conversation${entries.length === 1 ? '' : 's'}?`,
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
    void vscode.window.showInformationMessage(
      `Drift: deleted ${entries.length} saved conversation${entries.length === 1 ? '' : 's'}.`,
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

  /** The draft belongs to the host only when the host sets it. */
  private setDraft(text: string): void {
    this.draft = text;
    this.draftToken += 1;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /* ---------------------------------------------------------------- */
  /* Message handling                                                  */
  /* ---------------------------------------------------------------- */

  private async handle(message: Incoming): Promise<void> {
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
        await this.upgrade(this.safeIds(), 'safe');
        return;
      case 'stop':
        if (!this.cancellable) {
          this.session.notice(
            'info',
            'The dependency check runs to the end. Stopping half way would leave packages marked safe that nothing has looked at yet.',
          );
          return;
        }
        this.running?.cancel();
        this.session.notice('info', 'Stopping…');
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
      case 'pickVersion':
        await this.pickVersion(message.id);
        return;
      case 'recheck':
        await this.recheck(message.id);
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
      case '/review':
        this.showReview();
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

    // Not a request Drift can act on, so treat it as what it most likely is:
    // something the developer wants every agent run to know about this repo.
    const config = vscode.workspace.getConfiguration('drift');
    const current = config.get<string>('fix.customInstructions', '').trim();
    await config.update(
      'fix.customInstructions',
      [current, text].filter(Boolean).join('\n'),
      vscode.ConfigurationTarget.Workspace,
    );

    this.session.say(
      [
        "I have added that to this workspace's Drift instructions, so every agent run from now on will be told:",
        '',
        `> ${text}`,
        '',
        'I can act on `/scan`, `/recent`, `/upgrade <package>`, `/fix`, `/review`, `/commit`, `/push` and `/pr` — type `/help` for the full list.',
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
        'Agent edits are never committed until you keep them. Changed lines are highlighted in the editor with Keep and Undo on every hunk, and the change list in this panel opens the real diff editor.',
        '',
        '**Git**',
        '',
        'When an upgrade lands, Drift offers to put it on a branch, commit it with a message that carries the evidence, push it, and open a pull request whose description says what changed upstream and what it touches here. Every step asks first, and you can stop at any of them — `/commit`, `/push` and `/pr` pick the flow back up later.',
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
    await this.scan({ quiet: true });
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

    const { ambiguities } = await discoverTargets(root, [''], stored);
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
        onResult: (outcome, index, total) =>
          step.progress(describeOutcome(outcome), `${index + 1} of ${total}`, index + 1, total),
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
      onResult: (outcome, index, total) =>
        step.progress(describeOutcome(outcome), `${index + 1} of ${total}`, index + 1, total),
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
        ...(failed.length > 0
          ? ['', ...failed.map((o) => [`\`${o.label}\``, '```', o.output, '```'].join('\n'))]
          : []),
      ].join('\n'),
    );
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
    if (this.busy) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    const roots = this.selectedRoots();
    if (roots.length === 0) {
      this.session.notice(
        'warn',
        'Open a git repository with a dependency manifest — `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, or `pom.xml` — to scan dependencies.',
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

    this.scanned = true;
    this.clearStale();
    const step = this.session.step(
      multiRoot ? `Checking your dependencies across ${contexts.length} repositories` : 'Checking your dependencies',
    );

    await this.run(async (token) => {
      const found: UpgradeCandidate[] = [];
      const nestedGitRepos: NestedProject[] = [];
      let checked = 0;
      let failures = 0;

      for (const ctx of contexts) {
        if (token.isCancellationRequested) break;

        const repoLabel = multiRoot
          ? (roots.find((root) => root.path === ctx.root)?.label ?? basename(ctx.root))
          : undefined;

        const managers = await this.resolveManagers(ctx.root);
        if (!managers) continue;

        try {
          const result = await scanUpgrades({
            root: ctx.root,
            repo: ctx.repo,
            managers,
            // Every direct dependency, every time. What counts as a dependency
            // worth checking is a settings question — `drift.analysis.includeDev`
            // and `includePatch`, already merged into this config — and never a
            // side effect of how hard the agent was asked to think. A scan that
            // silently looked at less would report packages as safe because
            // nothing had looked at them.
            config: ctx.config,
            breadth: {
              includeDev: ctx.config.triggerOn.dev,
              maxSites: 400,
              maxPackages: 0,
            },
            githubToken: await getRateLimitToken(),
            token,
            repoLabel,
            onProgress: ({ phase, detail, done, total }) =>
              step.progress(repoLabel ? `${repoLabel}: ${phase}` : phase, detail, done, total),
            onCandidate: (candidate) => {
              this.candidates.set(candidate.id, candidate);
              found.push(candidate);
              // Fill the list in as results arrive rather than after the whole
              // sweep; a partial answer now beats a complete one in a minute.
              this.session.updatePackages(
                headline(found, checked),
                [...found].sort(bySeverity).map((c) => c.id),
              );
            },
          });

          checked += result.checked;
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

      const ranked = found.slice().sort(bySeverity);
      step.done(
        `Checked ${checked} package${checked === 1 ? '' : 's'} · ${ranked.filter((c) => severityOf(c) === 'affected').length} need attention`,
      );

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
        this.session.updatePackages(
          `Every one of your ${checked} direct dependenc${checked === 1 ? 'y is' : 'ies are'} already at the newest version.`,
          [],
        );
        return;
      }

      this.session.updatePackages(headline(ranked, checked), ranked.map((c) => c.id));

      const affected = ranked.filter((c) => severityOf(c) === 'affected');
      if (affected.length > 0 && !options.quiet) {
        this.session.say(
          `I can hand ${affected.length === 1 ? 'this' : 'these'} to **${this.agentLabel()}** — say \`/fix\`, or use the button above.`,
        );
      }
    }, { cancellable: false });
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

      const plan = result.plan;
      if (!plan || plan.breakingChanges.length === 0) {
        step.done('Nothing breaking found');
        this.session.say(result.summary);
        return;
      }

      const files = new Set(plan.impactSites.map((site) => site.file)).size;
      step.done(`${plan.changes.length} dependency change${plan.changes.length === 1 ? '' : 's'} analysed`);

      // The distinction that matters, stated first.
      if (files === 0) {
        this.session.say(
          [
            `The dependencies that moved have ${plan.breakingChanges.length} breaking change${plan.breakingChanges.length === 1 ? '' : 's'} between them, and **none of them touch this repository**. Nothing to do.`,
            '',
            'Open the report if you want to see the reasoning and the sources.',
          ].join('\n'),
        );
      } else {
        this.session.say(
          `**${files} file${files === 1 ? '' : 's'}** in this repository use an API that changed, across ${plan.impactSites.length} site${plan.impactSites.length === 1 ? '' : 's'}. Say \`/fix\` and **${this.agentLabel()}** will work through them, one commit per concern.`,
        );
      }
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
      });

      this.candidates.delete(id);
      this.candidates.set(updated.id, updated);
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

    const step = this.session.step(`Upgrading ${candidates.length} package${candidates.length === 1 ? '' : 's'}`);

    let installed = true;
    let committedAny = false;

    await this.run(async () => {
      for (const candidate of candidates) {
        const candidateCtx = await this.contextForCandidate(candidate, ctx);
        const target = mode === 'force' ? candidate.latest : (candidate.safeLatest ?? candidate.selected);
        let current = candidate;

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
   */
  private branchPrefix(config?: DriftConfig): string {
    const setting = vscode.workspace.getConfiguration('drift').inspect<string>('git.branchPrefix');
    const explicit =
      setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
    const chosen = explicit ?? config?.remediation.branchPrefix ?? 'drift';
    return chosen.replace(/\/+$/, '') || 'drift';
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
        branchName: upgradeBranchName(group, { prefix: this.branchPrefix(ctx.config) }),
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
      branchName: plan?.branchName ?? `${this.branchPrefix(ctx.config)}/changes-${new Date().toISOString().slice(0, 10)}`,
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
      branchName: `${this.branchPrefix(ctx.config)}/dependencies-${new Date().toISOString().slice(0, 10)}`,
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
        const { created } = await git.createBranch(plan.branchName);
        branch = plan.branchName;
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
      sha = await git.commitPaths(plan.paths, plan.message.subject, plan.message.body);
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
    const base = await git.defaultBranch();
    // A pull request needs somewhere to merge *into*. Committing straight onto
    // the default branch is a legitimate choice, but it leaves no PR to open,
    // and saying so beats offering a button that returns a 422.
    const canOpenPr = Boolean(slug) && Boolean(base) && base !== branch;

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
        { label: 'Push only', value: 'push', description: 'Send the branch, open the PR yourself' },
        { label: 'Not yet', value: 'no', description: 'The commit stays local' },
      ],
      false,
    );

    if (answer === 'no' || answer === '') {
      this.session.notice('info', `Kept local. Say \`/push\` when you want \`${branch}\` on the remote.`);
      return;
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

    if (answer !== 'pr' || !slug || !base) {
      const url = compareUrl(remote, base ?? 'main', branch);
      this.session.say(
        url
          ? `\`${branch}\` is on the remote. [Open a pull request](${url}) when you are ready.`
          : `\`${branch}\` is on the remote.`,
      );
      return;
    }

    await this.createPullRequest({ slug, remote, base, branch, plan });
  }

  /**
   * Open the pull request through GitHub's API, falling back to the browser.
   *
   * The fallback matters more than the API path: a developer who declines the
   * sign-in prompt, or whose token cannot open pull requests on this repository,
   * still has a pushed branch and one link away from the same outcome. Failing
   * to open a PR is never allowed to look like failing to do the work.
   */
  private async createPullRequest(args: {
    slug: string;
    remote: string | null;
    base: string;
    branch: string;
    plan: { message: CommitMessage; prBody: string };
  }): Promise<void> {
    const fallback = compareUrl(args.remote, args.base, args.branch);
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
        title: args.plan.message.subject,
        body: args.plan.prBody,
      });

      step.done(pr.existing ? `Pull request #${pr.number} already open` : `Opened #${pr.number}`);
      this.session.say(
        pr.existing
          ? `A pull request for \`${args.branch}\` was already open: [#${pr.number}](${pr.url}). The new commit is on it.`
          : `Opened [#${pr.number}](${pr.url}) — \`${args.branch}\` into \`${args.base}\`. The description carries the evidence: what changed upstream, and what it touches here.`,
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
    const base = await git.defaultBranch();

    if (branch === 'HEAD') {
      this.session.notice('warn', 'You are on a detached HEAD. Say `/commit` to put this work on a branch first.');
      return;
    }
    if (!slug) {
      this.session.notice('warn', 'This repository has no GitHub `origin` remote, so there is no pull request to open.');
      return;
    }
    if (!base || base === branch) {
      this.session.notice(
        'warn',
        `\`${branch}\` is the branch a pull request would merge into. Say \`/commit\` and I will put the work on its own branch first.`,
      );
      return;
    }

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

    await this.createPullRequest({ slug, remote, base, branch, plan });
  }

  /* ---------------------------------------------------------------- */
  /* Fixing                                                            */
  /* ---------------------------------------------------------------- */

  private async fix(ids: readonly string[]): Promise<void> {
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
      this.session.say(
        'There is nothing for an agent to edit — no code in this repository uses the APIs that changed. Upgrading is all that is needed.',
      );
      return;
    }

    // Where this lands, asked before anything is installed or edited.
    //
    // Deliberately first: the upgrade writes a manifest and a lockfile, and
    // those belong on the same branch as the code changes that go with them.
    // Branching afterwards would leave half the change behind.
    const proposedBranch = await this.availableBranchName(ctx.root, plan.branchName);
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
      if (branch.mode === 'new' && !(await this.startBranch(ctx.root, branch.name))) return;
      if (!(await this.upgrade(notInstalled.map((c) => c.id), 'safe', { quiet: true }))) return;
      upgraded = true;
    }

    // The strongest evidence available, and the only kind that is measured
    // rather than predicted: what the project's own compiler says is broken now
    // that the versions have moved. Gathered here, grouped, and handed to the
    // agent alongside Drift's analysis rather than left for a human to read.
    const diagnostics = upgraded
      ? await this.gatherDiagnostics(ctx.root, plan)
      : undefined;

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
      ? ' Your typecheck ran first, and its errors go to the agent with the changelog evidence.'
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
        onCommitEnd: (commit, outcome, changed) => tasks.finish(`c${commit.order}`, outcome, changed),
        onActivity: (commit, activity) => tasks.activity(`c${commit.order}`, activity),
        // Agent chatter belongs against the concern it is about, not in a
        // separate log the developer has to correlate by hand.
        onLog: (message) => tasks.note(activeGroupId(plan, this.state), message.slice(0, 120)),
        progress: { report: () => undefined },
        token,
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
          this.session.notice('error', result.message);
          this.output.error(result.message);
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
    }
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
    this.session.say('Left uncommitted — the changes are still in your tree.', [
      { label: 'Commit', command: '/commit' },
      { label: 'Review the changes', command: '/review' },
    ]);
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
        { label: 'Not now', value: 'no', description: 'It stays local' },
      ],
      false,
    );

    if (answer === 'pr') await this.openPullRequestForBranch();
    else if (answer === 'push') await this.pushCurrentBranch();
    else if (answer === 'review') await this.reviewAllChanges();
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
  private async commitGroup(group: ReviewGroup): Promise<{ sha: string; branch: string } | null> {
    const root = this.review.workspaceRoot ?? this.state.workspaceRoot;
    if (!root) return null;

    const { Git } = await import('../git.js');
    const git = new Git(root);

    try {
      const sha = await git.commitPaths(group.paths, group.title, group.body ?? '');
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
    } catch (err) {
      this.session.notice('error', `Commit failed: ${(err as Error).message}`);
      return null;
    }
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
      '/upgrade': 'package',
      '/upgrade-all': 'package',
      '/fix': 'agent',
      '/review': 'diff',
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
  ): Promise<{ mode: SessionBranchMode; name: string } | null> {
    const { Git } = await import('../git.js');
    const current = await new Git(root).currentBranch().catch(() => null);
    const preferred = this.session.branchMode;

    // On a detached HEAD there is no branch to stay on, so there is no question
    // to ask — branching is the only thing that can be meant.
    if (!current || current === 'HEAD') return { mode: 'new', name: proposed };

    const answer = await this.session.ask(
      `Before ${this.agentLabel()} touches anything: you are on \`${current}\`. Where should this work go?`,
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
        `\`${check.label}\` passes against the upgraded dependencies — it reports no errors at all.`,
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

  /** Create and check out the branch the whole change will live on. */
  private async startBranch(root: string, name: string): Promise<boolean> {
    const { Git } = await import('../git.js');
    try {
      const { created } = await new Git(root).createBranch(name);
      this.session.notice(
        'info',
        created ? `Working on a new branch, \`${name}\`.` : `Switched to the existing \`${name}\`.`,
      );
      return true;
    } catch (err) {
      this.session.notice('error', `Could not create \`${name}\`: ${(err as Error).message}`);
      return false;
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
      const sha = await git.commitPaths(paths, message.subject, message.body);
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
    const ctx = await this.context();
    if (!ctx) return;
    const target = Math.max(0, (line || 1) - 1);
    await vscode.window.showTextDocument(vscode.Uri.file(join(ctx.root, file)), {
      selection: new vscode.Range(target, 0, target, 0),
      preview: true,
      viewColumn: vscode.ViewColumn.One,
    });
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
        identity: { name: 'Drift', email: 'drift@example.invalid' },
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
    if (this.running) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    const source = new vscode.CancellationTokenSource();
    this.running = source;
    this.cancellable = options.cancellable !== false;
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

  private render(): void {
    if (this.surfaces.length === 0 || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.paint();
    }, 60);
  }

  private paint(): void {
    if (this.surfaces.length === 0) return;

    const body = renderBody(this.viewModel());
    for (const surface of this.surfaces) {
      if (surface.ready) void surface.webview.postMessage({ type: 'render', body });
    }
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
      awaitingAnswer: this.session.awaitingAnswer,
      commands: SLASH_COMMANDS,
      menu: this.menuSections(),
      stale: this.stale,
      draft: this.draft,
      draftToken: this.draftToken,
      // Scopes the typewriter's bookkeeping to one conversation, so reopening an
      // old thread does not retype a message it already typed months ago.
      conversationId: this.conversationId,
    };
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

function bySeverity(a: UpgradeCandidate, b: UpgradeCandidate): number {
  const rank = { affected: 0, error: 1, 'upstream-only': 2, unchecked: 3, clean: 4 } as const;
  const diff = rank[severityOf(a)] - rank[severityOf(b)];
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
function headline(candidates: readonly UpgradeCandidate[], checked: number): string {
  const affected = candidates.filter((c) => severityOf(c) === 'affected').length;
  const unchecked = candidates.filter((c) => severityOf(c) === 'unchecked').length;
  const safe = candidates.length - affected - unchecked;
  const scope = checked > 0 ? ` out of ${checked} checked` : '';

  if (candidates.length === 0) return 'No newer versions available.';

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
  return buildPlan({
    repo,
    config,
    changes: plans.flatMap((p) => p.changes),
    evidence: plans.flatMap((p) => p.evidence),
    breakingChanges: plans.flatMap((p) => p.breakingChanges),
    impactSites: plans.flatMap((p) => p.impactSites),
  });
}
