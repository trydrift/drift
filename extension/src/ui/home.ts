import * as vscode from 'vscode';
import { basename, dirname, join, relative } from 'node:path';
import type { RemediationPlan, RepoContext } from '../../../src/types.js';
import { buildPlan } from '../../../src/plan/index.js';
import { inspectLocalRepo } from '../../../src/repo/local-git.js';
import { DriftConfigSchema, type DriftConfig } from '../../../src/config/schema.js';
import { loadWorkspaceConfig, runAnalysis } from '../analyze.js';
import { runFix } from '../fix.js';
import type { DriftState } from '../state.js';
import {
  DriftSession,
  EFFORT_ORDER,
  type Attachment,
  type SessionEffort,
  type SessionMode,
  type SessionPermission,
  type TaskGroup,
} from '../session.js';
import { DriftHistory, describeWhen, newConversationId } from '../history.js';
import {
  describeEffort,
  describeMode,
  describePermission,
  explainEffort,
  explainMode,
  explainPermission,
} from '../labels.js';
import type { DriftReview, ReviewGroup } from '../review/store.js';
import {
  discoverAgents,
  invalidateAgentCache,
  type AgentModel,
  type DiscoveredAgent,
} from '../agents/registry.js';
import type { AttachedContext } from '../agents/types.js';
import { getGitHubSession, getRateLimitToken } from '../github-auth.js';
import {
  describeSeverity,
  installNpmForcedUpgrade,
  installNpmUpgrade,
  reanalyzeUpgrade,
  scanNpmUpgrades,
  severityOf,
  type UpgradeCandidate,
} from '../upgrades.js';
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
const EXCLUDED_FROM_CONTEXT = '**/{node_modules,.git,dist,out,build,coverage,.next,.turbo,.venv,__pycache__}/**';

interface WorkspaceContext {
  root: string;
  info: NonNullable<Awaited<ReturnType<typeof inspectLocalRepo>>>;
  repo: RepoContext;
  config: DriftConfig;
}

/**
 * One place the panel is drawn.
 *
 * There are two: the sidebar view, and the full-screen editor tab. Both show the
 * same conversation, because a panel that forgets what you were doing when you
 * expand it is not the same panel made bigger.
 */
interface Surface {
  webview: vscode.Webview;
  /** Set once the document's script has announced itself. */
  ready: boolean;
}

export class DriftHomeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private full: vscode.WebviewPanel | null = null;
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
  private checkpoints: Checkpoints | null = null;
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
    memento: vscode.Memento,
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
    const manifests = vscode.workspace.createFileSystemWatcher('**/{package.json,package-lock.json}');
    this.disposables.push(
      manifests,
      manifests.onDidChange((uri) => this.markStale(uri, 'dependencies')),
      manifests.onDidCreate((uri) => this.markStale(uri, 'dependencies')),
      vscode.workspace.onDidSaveTextDocument((document) => this.markStale(document.uri, 'code')),
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
    this.full?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /** Bring the panel forward, e.g. from a notification action. */
  async reveal(): Promise<void> {
    if (this.full) {
      this.full.reveal();
      return;
    }
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

  /**
   * The panel, in the editor area, as large as the window.
   *
   * A sidebar view cannot be made full screen — so the panel moves to an editor
   * tab, which can. Toggling back disposes the tab and puts the sidebar where it
   * was. The conversation is untouched by either move: both surfaces render the
   * same state.
   */
  async toggleFullScreen(): Promise<void> {
    if (this.full) {
      this.full.dispose();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'drift.full',
      'Drift',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );

    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'activity-icon.svg');
    panel.onDidDispose(() => {
      this.full = null;
      this.detach(panel.webview);
      void this.reveal();
    });

    this.full = panel;
    this.attach(panel.webview);

    // The sidebar copy would only be a narrow duplicate of what is now filling
    // the window.
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
  }

  /* ---------------------------------------------------------------- */
  /* Conversations                                                     */
  /* ---------------------------------------------------------------- */

  /** Put the current conversation away and start an empty one. */
  async newSession(): Promise<void> {
    await this.saveConversation();
    this.conversationId = newConversationId();
    this.session.clear();
    this.setDraft('');
    await this.reveal();
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
      entries.map((entry) => ({
        id: entry.id,
        label: `${entry.id === this.conversationId ? '$(comment-discussion)' : '$(history)'} ${entry.title}`,
        description: describeWhen(entry.at),
        detail: `${entry.messages} message${entry.messages === 1 ? '' : 's'}`,
      })),
      { title: 'Drift: conversation history', placeHolder: 'Pick a conversation to reopen', matchOnDetail: true },
    );
    if (!picked) return;

    const entry = this.history.get(picked.id);
    if (!entry) return;

    this.conversationId = entry.id;
    this.session.restore(entry.items);
    this.setDraft('');
    await this.reveal();
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
      case '/review':
        this.showReview();
        return;
      case '/agent':
        this.openMenu('model:setup');
        return;
      case '/clear':
        await this.newSession();
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
        'I can act on `/scan`, `/recent`, `/upgrade <package>`, `/fix`, and `/review` — type `/help` for the full list.',
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
        '- **Ask / Agent** — Ask analyses and explains; Agent edits files.',
        '- **Effort** — Quick checks runtime dependencies only; Thorough adds dev dependencies and patch releases.',
        '- **Permission** — whether the agent asks first, edits then waits for your review, or edits and commits.',
        '',
        '**Review**',
        '',
        'Agent edits are never committed until you keep them. Changed lines are highlighted in the editor with Keep and Undo on every hunk, and the change list in this panel opens the real diff editor.',
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

  private async scan(options: { quiet?: boolean } = {}): Promise<void> {
    if (this.busy) {
      this.session.notice('info', this.busyMessage());
      return;
    }

    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository with a `package.json` to scan dependencies.');
      return;
    }

    this.scanned = true;
    this.clearStale();
    const step = this.session.step('Checking your dependencies');
    const profile = this.session.effortProfile;

    await this.run(async (token) => {
      try {
        const found: UpgradeCandidate[] = [];
        const result = await scanNpmUpgrades({
          root: ctx.root,
          repo: ctx.repo,
          config: {
            ...ctx.config,
            triggerOn: {
              ...ctx.config.triggerOn,
              patch: profile.includePatch,
              dev: profile.includeDev,
            },
          },
          breadth: {
            includeDev: profile.includeDev,
            maxSites: profile.maxSites,
            maxPackages: profile.maxPackages,
          },
          githubToken: await getRateLimitToken(),
          token,
          onProgress: ({ phase, detail, done, total }) => step.progress(phase, detail, done, total),
          onCandidate: (candidate) => {
            this.candidates.set(candidate.id, candidate);
            found.push(candidate);
            // Fill the list in as results arrive rather than after the whole
            // sweep; a partial answer now beats a complete one in a minute.
            this.session.updatePackages(
              headline(found, 0),
              [...found].sort(bySeverity).map((c) => c.id),
            );
          },
        });

        const ranked = result.candidates.slice().sort(bySeverity);
        step.done(
          `Checked ${result.checked} package${result.checked === 1 ? '' : 's'} · ${ranked.filter((c) => severityOf(c) === 'affected').length} need attention`,
        );

        if (ranked.length === 0) {
          this.session.updatePackages(
            `Every one of your ${result.checked} direct dependenc${result.checked === 1 ? 'y is' : 'ies are'} already at the newest version.`,
            [],
          );
          return;
        }

        this.session.updatePackages(headline(ranked, result.checked), ranked.map((c) => c.id));

        const affected = ranked.filter((c) => severityOf(c) === 'affected');
        if (affected.length > 0 && !options.quiet) {
          this.session.say(
            `I can hand ${affected.length === 1 ? 'this' : 'these'} to **${this.agentLabel()}** — say \`/fix\`, or use the button above.`,
          );
        }
      } catch (err) {
        step.fail('Scan failed');
        this.session.notice('error', (err as Error).message);
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
      `- Newest version within your \`package.json\` range: ${candidate.safeLatest ?? 'none'}`,
      `- Newest published: ${candidate.latest}`,
    ];

    if (severity === 'affected') {
      lines.push('', `Say \`/fix ${candidate.name}\` to let ${this.agentLabel()} update the affected code.`);
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

  private async retarget(id: string, version: string): Promise<void> {
    const ctx = await this.context();
    const candidate = this.candidates.get(id);
    if (!ctx || !candidate) return;

    const step = this.session.step(`Re-checking ${candidate.name} at ${version}`);

    await this.run(async () => {
      this.candidates.set(id, { ...candidate, selected: version, status: 'checking' });
      this.refreshPackageList();

      const updated = await reanalyzeUpgrade({
        candidate,
        version,
        root: ctx.root,
        repo: ctx.repo,
        config: ctx.config,
        githubToken: await getRateLimitToken(),
        onProgress: (phase, detail) => step.progress(phase, detail),
      });

      this.candidates.delete(id);
      this.candidates.set(updated.id, updated);
      this.refreshPackageList();
      step.done(describeSeverity(updated));
    });
  }

  private async upgrade(ids: readonly string[], mode: 'safe' | 'force'): Promise<void> {
    const ctx = await this.context();
    const candidates = ids
      .map((id) => this.candidates.get(id))
      .filter((c): c is UpgradeCandidate => Boolean(c));

    if (!ctx || candidates.length === 0) {
      this.session.notice('warn', 'Nothing selected to upgrade. Run `/scan` first.');
      return;
    }

    // Forcing past the declared range is a real decision with real consequences,
    // so it is put to the developer rather than buried in a button label.
    if (mode === 'force') {
      const answer = await this.session.ask(
        `Install ${candidates.map((c) => `**${c.name}@${c.latest}**`).join(', ')} with \`npm install --force\`? That widens the range in \`package.json\` and can leave peer dependencies unsatisfied.`,
        [
          { label: 'Yes, force it', value: 'force', description: 'I will deal with any peer conflicts' },
          { label: 'Stay within my range', value: 'safe', description: 'Install the newest compatible version instead' },
          { label: 'Cancel', value: 'cancel' },
        ],
        false,
      );
      if (answer === 'cancel' || answer === '') {
        this.session.notice('info', 'Left your dependencies alone.');
        return;
      }
      if (answer === 'safe') mode = 'safe';
    }

    const step = this.session.step(`Upgrading ${candidates.length} package${candidates.length === 1 ? '' : 's'}`);

    await this.run(async () => {
      for (const candidate of candidates) {
        const target = mode === 'force' ? candidate.latest : (candidate.safeLatest ?? candidate.selected);
        let current = candidate;

        if (target !== candidate.selected) {
          step.progress('Re-checking evidence', `${candidate.name}@${target}`);
          current = await reanalyzeUpgrade({
            candidate,
            version: target,
            root: ctx.root,
            repo: ctx.repo,
            config: ctx.config,
            githubToken: await getRateLimitToken(),
            onProgress: (phase, detail) => step.progress(phase, detail),
          });
          this.candidates.delete(candidate.id);
        }

        step.progress('Running npm install', `${current.name}@${target}`);
        this.candidates.set(current.id, { ...current, status: 'upgrading' });
        this.refreshPackageList();

        try {
          if (mode === 'force') await installNpmForcedUpgrade(ctx.root, current);
          else await installNpmUpgrade(ctx.root, current);
        } catch (err) {
          this.candidates.set(current.id, { ...current, status: 'error', error: (err as Error).message });
          this.refreshPackageList();
          step.fail(`npm install failed for ${current.name}`);
          this.session.notice('error', `\`npm install ${current.name}@${target}\` failed: ${(err as Error).message}`);
          return;
        }

        this.candidates.set(current.id, { ...current, status: 'ready' });
        this.refreshPackageList();
        this.session.notice(
          'success',
          mode === 'force'
            ? `Forced **${current.name}** to ${target}. Check \`npm ls\` for peer-dependency conflicts before committing.`
            : `Updated **${current.name}** to ${target}, within the range already in \`package.json\`.`,
        );
      }

      step.done('Dependency files updated');

      const affected = candidates.filter((c) => this.currentFor(c) && severityOf(this.currentFor(c)!) === 'affected');
      if (affected.length > 0) {
        this.session.say(
          `${affected.length === 1 ? 'That upgrade needs' : 'Those upgrades need'} code changes here. Say \`/fix\` and **${this.agentLabel()}** will make them.`,
        );
      }
    });
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

    // The plan goes up before a single file is touched: every concern, the
    // package it belongs to, and the exact sites underneath it. A developer
    // watching this can tell what is about to happen while there is still time
    // to stop it, and afterwards can see which sites the agent actually changed
    // — neither of which is legible in a stream of agent chatter.
    const files = new Set(plan.impactSites.map((site) => site.file)).size;
    const tasks = this.session.tasks(
      `${this.agentLabel()} is fixing ${plan.impactSites.length} site${plan.impactSites.length === 1 ? '' : 's'}`,
      `${plan.commits.length} commit${plan.commits.length === 1 ? '' : 's'}, one per concern, across ${files} file${files === 1 ? '' : 's'}. Nothing is committed until you keep it.`,
      buildTaskGroups(plan),
    );

    this.state.set({ kind: 'findings', plan, at: Date.now() });

    await this.run(async (token) => {
      const result = await runFix({
        state: this.state,
        plan,
        review: this.review,
        permission: this.session.permission,
        ask: (question, options) =>
          this.session.ask(
            question,
            (options ?? ['Yes', 'No']).map((option) => ({ label: option, value: option })),
          ),
        context: await this.resolveContext(ctx.root),
        onCommitStart: (commit) => tasks.start(`c${commit.order}`),
        onCommitEnd: (commit, outcome, changed) => tasks.finish(`c${commit.order}`, outcome, changed),
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
            ].join('\n'),
          );
          this.showReview();
          return;
        case 'committed':
          tasks.finishAll('done');
          this.session.say(result.message);
          return;
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
  }

  /* ---------------------------------------------------------------- */
  /* Rewind                                                            */
  /* ---------------------------------------------------------------- */

  private async checkpoint(label: string): Promise<{ id: string } | null> {
    const ctx = await this.context();
    if (!ctx) return null;
    this.checkpoints ??= new Checkpoints(ctx.root);
    return this.checkpoints.capture(label);
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
    if (!item || item.kind !== 'user' || !item.checkpoint || !this.checkpoints) return;

    const checkpoint = this.checkpoints.get(item.checkpoint);
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
      const result = await this.checkpoints.restore(item.checkpoint);
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
      { id: 'model', anchor: 'context', title: 'Model', items: this.subscriptionItems() },
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
            submenu: 'context',
            keywords: 'back model subscriptions',
          },
          ...this.modelItems(entry),
        ],
      });
    }

    sections.push(
      { id: 'agents', anchor: 'model:setup', title: 'AI agents', items: this.agentItems() },
      {
        id: 'effort',
        anchor: 'effort',
        title: 'Effort',
        slider: this.effortSlider(),
        items: [],
      },
      { id: 'mode', anchor: 'permission', title: 'Mode', items: this.modeItems() },
      { id: 'permission', anchor: 'permission', title: 'Permission', items: this.permissionItems() },
    );

    return sections;
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
   * The effort dial, with the stops the selected model can honour.
   *
   * A model with no reasoning budget still gets the first three, because those
   * change what Drift itself analyses. What it does not get is a fourth position
   * that would move the handle and change nothing.
   */
  private effortSlider(): MenuSection['slider'] {
    const stops = this.effortStops();
    const current = Math.max(0, stops.indexOf(this.session.effort));

    return {
      id: 'effort',
      value: current === -1 ? 1 : current,
      stops: stops.map((value) => ({ value, label: describeEffort(value), detail: explainEffort(value) })),
    };
  }

  private effortStops(): SessionEffort[] {
    const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
    const available = this.available();
    const active = preferred === 'auto' ? available[0] : available.find((entry) => entry.agent.id === preferred);
    if (!active) return [...EFFORT_ORDER];

    const chosen = this.session.model(active.agent.id);
    const models = this.models.get(active.agent.id) ?? [];
    const model = models.find((candidate) => candidate.id === chosen) ?? models[0];

    return model?.efforts?.length ? [...model.efforts] : [...EFFORT_ORDER];
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
      case 'effort':
        await this.session.setEffort(value as SessionEffort);
        return;
      case 'permission':
        await this.session.setPermission(value as SessionPermission);
        this.session.notice('info', `Permission set to **${describePermission(value as SessionPermission)}**.`);
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
    await this.session.setModel(agentId, model || undefined);

    const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
    if (preferred !== agentId) await this.setAgent(agentId, { quiet: true });
    else invalidateAgentCache();

    // The effort the model cannot honour has to give way to one it can.
    const stops = this.effortStops();
    if (!stops.includes(this.session.effort)) {
      await this.session.setEffort(stops[stops.length - 1] ?? 'balanced');
    }

    const label = this.models.get(agentId)?.find((entry) => entry.id === model)?.label ?? model;
    this.session.notice(
      'info',
      label
        ? `Now using **${label}** on ${this.agentLabel()}.`
        : `Now using **${this.agentLabel()}** with whichever model it picks.`,
    );

    await this.refreshAgents();
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
              ? 'within your package.json range'
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
    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a folder to attach context from it.');
      return;
    }

    if (what === 'upload') {
      await this.attachFromDisk(ctx.root);
      return;
    }

    if (what === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        this.session.notice('info', 'Nothing is selected in the editor right now.');
        return;
      }
      this.session.attach(describeSelection(ctx.root, editor));
      return;
    }

    const uris = await vscode.workspace.findFiles('**/*', EXCLUDED_FROM_CONTEXT, 4000);
    const paths = uris.map((uri) => relative(ctx.root, uri.fsPath).replace(/\\/g, '/')).sort();

    if (what === 'folder') {
      await this.attachFolder(paths);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      paths.map((path) => ({
        label: `$(file) ${basename(path)}`,
        description: dirname(path) === '.' ? undefined : dirname(path),
        path,
      })),
      {
        title: 'Add a file as context',
        placeHolder: 'Type to filter this project by path',
        matchOnDescription: true,
      },
    );
    if (picked) this.session.attach({ kind: 'file', label: picked.path, value: picked.path });
  }

  private async attachFolder(paths: readonly string[]): Promise<void> {
    const folders = [...new Set(paths.map(dirname).filter((dir) => dir !== '.'))].sort();
    if (folders.length === 0) {
      this.session.notice('info', 'Every file in this project is at the top level — attach one directly.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: `$(folder) ${folder}`, folder })),
      { title: 'Add a folder as context', placeHolder: 'Type to filter folders' },
    );
    if (picked) this.session.attach({ kind: 'folder', label: picked.folder, value: picked.folder });
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
      ? await discoverAgents({ slug: ctx.info.slug, baseBranch: ctx.info.branch }, { force: true })
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
        if (models.length > 0) this.models.set(entry.agent.id, models);
      }),
    );

    this.render();
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

    const value = await this.readContext();
    this.contextCache = { at: Date.now(), value };
    return value;
  }

  private async readContext(): Promise<WorkspaceContext | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;

    const root = folder.uri.fsPath;
    const info = await inspectLocalRepo(root);
    if (!info) return null;

    const config = await loadWorkspaceConfig(root).catch(() => DriftConfigSchema.parse({}));
    const repo: RepoContext = {
      owner: info.slug?.split('/')[0] ?? 'local',
      repo: info.slug?.split('/')[1] ?? 'workspace',
      baseBranch: info.branch,
      beforeSha: info.parentSha ?? info.headSha,
      afterSha: info.headSha,
      workspace: root,
    };

    return { root, info, repo, config };
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

    try {
      await work(source.token);
    } catch (err) {
      this.session.notice('error', (err as Error).message);
      this.output.error(String(err));
    } finally {
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
        return severity !== 'affected' && severity !== 'error';
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
      effort: this.session.effort,
      permission: this.session.permission,
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
    };
  }
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

function bySeverity(a: UpgradeCandidate, b: UpgradeCandidate): number {
  const rank = { affected: 0, error: 1, 'upstream-only': 2, clean: 3 } as const;
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
  const safe = candidates.length - affected;
  const scope = checked > 0 ? ` out of ${checked} checked` : '';

  if (candidates.length === 0) return 'No newer versions available.';

  if (affected === 0) {
    return `**${candidates.length} upgrade${candidates.length === 1 ? '' : 's'} available**${scope}, and none of them affect code in this repository. Safe to take.`;
  }

  return `**${affected} of ${candidates.length} upgrade${candidates.length === 1 ? '' : 's'}**${scope} affect${affected === 1 ? 's' : ''} code in this repository.${safe > 0 ? ` The other ${safe} ${safe === 1 ? 'is' : 'are'} safe to take as-is.` : ''}`;
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
