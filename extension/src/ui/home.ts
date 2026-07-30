import * as vscode from 'vscode';
import { join, relative } from 'node:path';
import type { RemediationPlan, RepoContext } from '../../../src/types.js';
import { buildPlan } from '../../../src/plan/index.js';
import { inspectLocalRepo } from '../../../src/repo/local-git.js';
import { DriftConfigSchema, type DriftConfig } from '../../../src/config/schema.js';
import { loadWorkspaceConfig, runAnalysis } from '../analyze.js';
import { runFix } from '../fix.js';
import type { DriftState } from '../state.js';
import { DriftSession } from '../session.js';
import { describePermission } from '../labels.js';
import type { DriftReview, ReviewGroup } from '../review/store.js';
import { discoverAgents, invalidateAgentCache, type DiscoveredAgent } from '../agents/registry.js';
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
import { DriftReportPanel } from './report.js';
import { makeNonce, renderPanel, SLASH_COMMANDS, type AgentChoice, type ViewModel } from './webview.js';

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
  | { type: 'submit'; text: string }
  | { type: 'draft'; text: string }
  | { type: 'answer'; id: string; value: string }
  | { type: 'setAgent' | 'setMode' | 'setEffort' | 'setPermission'; value: string }
  | { type: 'attach' }
  | { type: 'detach'; value: string }
  | { type: 'pickAgent' }
  | { type: 'stop' }
  | { type: 'signIn' }
  | { type: 'showReport' }
  | { type: 'openFile'; file: string; line: number }
  | { type: 'openUrl'; url: string }
  | { type: 'openDiff'; path: string }
  | { type: 'selectVersion'; id: string; value: string }
  | { type: 'upgrade'; id: string; mode: 'safe' | 'force' }
  | { type: 'fixPackage'; id: string }
  | { type: 'fixAll' }
  | { type: 'keepFile' | 'undoFile'; path: string }
  | { type: 'keepGroup' | 'undoGroup'; order: number }
  | { type: 'keepAll' | 'undoAll' };

interface WorkspaceContext {
  root: string;
  info: NonNullable<Awaited<ReturnType<typeof inspectLocalRepo>>>;
  repo: RepoContext;
  config: DriftConfig;
}

export class DriftHomeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private candidates = new Map<string, UpgradeCandidate>();
  private agents: DiscoveredAgent[] = [];
  private signedInLabel: string | null = null;
  private running: vscode.CancellationTokenSource | null = null;
  private draft = '';
  private scanned = false;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: DriftState,
    private readonly session: DriftSession,
    private readonly review: DriftReview,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      state.onDidChange(() => this.render()),
      session.onDidChange(() => this.render()),
      review.onDidChange(() => this.render()),
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id === 'github') void this.refreshIdentity();
      }),
    );

    // Keeping a whole group is the developer saying "this is right" — which is
    // exactly when the commit the planner described should exist.
    review.setCommitHandler(async (group) => this.commitGroup(group));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    this.disposables.push(view.webview.onDidReceiveMessage((message: Incoming) => this.handle(message)));

    void this.refreshIdentity();
    void this.refreshAgents();
    this.render();

    // Opening the panel is a request to know the state of your dependencies, so
    // the first scan starts itself. Every step of it is named in the thread as it
    // happens, which is the difference between a tool that looks busy and one
    // that looks stuck.
    if (vscode.workspace.getConfiguration('drift').get<boolean>('analysis.runOnStartup', true)) {
      void this.scanOnStartup();
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** Bring the panel forward, e.g. from a notification action. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('drift.changes.focus');
    this.view?.show?.(true);
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /* ---------------------------------------------------------------- */
  /* Message handling                                                  */
  /* ---------------------------------------------------------------- */

  private async handle(message: Incoming): Promise<void> {
    switch (message.type) {
      case 'submit':
        await this.submit(message.text);
        return;
      case 'draft':
        this.draft = message.text;
        return;
      case 'answer':
        this.session.answer(message.id, message.value);
        return;
      case 'setAgent':
        await this.setAgent(message.value);
        return;
      case 'setMode':
        await this.session.setMode(message.value as 'ask' | 'agent');
        return;
      case 'setEffort':
        await this.session.setEffort(message.value as 'quick' | 'balanced' | 'thorough');
        return;
      case 'setPermission':
        await this.session.setPermission(message.value as 'ask' | 'auto-edit' | 'full-auto');
        this.session.notice('info', `Permission set to **${describePermission(this.session.permission)}**.`);
        return;
      case 'attach':
        await this.attach();
        return;
      case 'detach':
        this.session.detach(message.value);
        return;
      case 'pickAgent':
        await vscode.commands.executeCommand('drift.selectAgent');
        invalidateAgentCache();
        await this.refreshAgents();
        return;
      case 'stop':
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
      case 'selectVersion':
        await this.retarget(message.id, message.value);
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

    this.session.user(text);
    this.draft = '';

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
      case '/review':
        this.showReview();
        return;
      case '/agent':
        await vscode.commands.executeCommand('drift.selectAgent');
        invalidateAgentCache();
        await this.refreshAgents();
        this.session.notice('info', `Agent set to **${this.agentLabel()}**.`);
        return;
      case '/clear':
        this.session.clear();
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
      this.session.notice('info', 'Already working — stop the current run first.');
      return;
    }

    const ctx = await this.context();
    if (!ctx) {
      this.session.notice('warn', 'Open a git repository with a `package.json` to scan dependencies.');
      return;
    }

    this.scanned = true;
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
    });
  }

  private async analyzeRecent(): Promise<void> {
    if (this.busy) {
      this.session.notice('info', 'Already working — stop the current run first.');
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
      this.session.notice('info', 'Already working — stop the current run first.');
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

    const step = this.session.step(`${this.agentLabel()} is fixing ${plan.impactSites.length} site${plan.impactSites.length === 1 ? '' : 's'}`);
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
        onLog: (message) => step.progress('Agent', message),
        progress: { report: ({ message }) => step.progress('Working', message ?? '') },
        token,
      });

      for (const warning of result.warnings) this.session.notice('warn', warning);

      switch (result.status) {
        case 'proposed':
          step.done(`${result.pendingFiles} file${result.pendingFiles === 1 ? '' : 's'} changed`);
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
          step.done(`${result.commits} commit${result.commits === 1 ? '' : 's'}`);
          this.session.say(result.message);
          return;
        case 'delegated':
          step.done('Handed to GitHub');
          this.session.say(result.message);
          return;
        case 'nothing':
          step.done('No changes');
          this.session.say(result.message);
          return;
        case 'cancelled':
          step.fail('Cancelled');
          this.session.notice('info', result.message);
          return;
        case 'failed':
          step.fail('Failed');
          this.session.notice('error', result.message);
          this.output.error(result.message);
          return;
      }
    });
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
    const paths = group.files.map((file) => file.path);
    const scope = paths.length > 0 ? paths : this.plannedFiles(group.order);

    try {
      const sha = await git.commitPaths(scope, group.title, group.body ?? '');
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

  private plannedFiles(order: number): string[] {
    return this.state.plan?.commits.find((commit) => commit.order === order)?.files.slice() ?? [];
  }

  /* ---------------------------------------------------------------- */
  /* Context, agents, identity                                         */
  /* ---------------------------------------------------------------- */

  private async attach(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) return;

    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(file) File…', id: 'file', detail: 'Point the agent at a specific file' },
        { label: '$(folder) Folder…', id: 'folder', detail: 'Scope the agent to one area of the repo' },
        {
          label: '$(selection) Current selection',
          id: 'selection',
          detail: 'The lines highlighted in the active editor',
        },
      ],
      { title: 'Add context for Drift', placeHolder: 'What should the agent look at?' },
    );
    if (!choice) return;

    if (choice.id === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        this.session.notice('warn', 'Select some code in an editor first.');
        return;
      }
      const path = relative(ctx.root, editor.document.uri.fsPath).replace(/\\/g, '/');
      const from = editor.selection.start.line + 1;
      const to = editor.selection.end.line + 1;
      this.session.attach({ kind: 'selection', label: `${path}:${from}-${to}`, value: `${path}:${from}-${to}` });
      return;
    }

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: choice.id === 'file',
      canSelectFolders: choice.id === 'folder',
      canSelectMany: choice.id === 'file',
      defaultUri: vscode.Uri.file(ctx.root),
      openLabel: 'Add as context',
    });

    for (const uri of picked ?? []) {
      const path = relative(ctx.root, uri.fsPath).replace(/\\/g, '/') || '.';
      this.session.attach({ kind: choice.id as 'file' | 'folder', label: path, value: path });
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

  private async setAgent(id: string): Promise<void> {
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
    this.session.notice('info', `Agent set to **${this.agentLabel()}**.`);
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
  }

  private async context(): Promise<WorkspaceContext | null> {
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

  /** Run one cancellable operation at a time and keep the UI's busy flag honest. */
  private async run(work: (token: vscode.CancellationToken) => Promise<void>): Promise<void> {
    if (this.running) {
      this.session.notice('info', 'Already working — stop the current run first.');
      return;
    }

    const source = new vscode.CancellationTokenSource();
    this.running = source;
    this.render();

    try {
      await work(source.token);
    } catch (err) {
      this.session.notice('error', (err as Error).message);
      this.output.error(String(err));
    } finally {
      source.dispose();
      this.running = null;
      this.render();
    }
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

  private render(): void {
    if (!this.view) return;

    const totals = this.review.totals();
    const model: ViewModel = {
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
      awaitingAnswer: this.session.awaitingAnswer,
      commands: SLASH_COMMANDS,
      draft: this.draft,
    };

    this.view.webview.html = renderPanel(model);
  }
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
