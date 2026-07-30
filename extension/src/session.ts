import * as vscode from 'vscode';

/**
 * The conversation.
 *
 * Drift's panel is a thread, not a dashboard. Everything that happens — a scan,
 * a question, a set of proposed edits — arrives as an item in one chronological
 * transcript, the same way Copilot Chat and Claude present work. That ordering
 * is what makes the panel legible: a button at the top of a dashboard that
 * silently changes something at the bottom is a guessing game, whereas a thread
 * shows cause next to effect.
 *
 * This module owns the transcript, the attached context, and the three settings
 * a developer changes often enough to deserve a place in the composer rather
 * than the settings editor.
 */

/** What Drift is allowed to do with its findings. Mirrors Copilot's Ask/Agent split. */
export type SessionMode = 'ask' | 'agent';

/** How hard to look. Real breadth, not a label. */
export type SessionEffort = 'quick' | 'balanced' | 'thorough';

/** How much rope the agent gets. Mirrors Claude Code's permission modes. */
export type SessionPermission = 'ask' | 'auto-edit' | 'full-auto';

export interface Attachment {
  kind: 'file' | 'folder' | 'package' | 'selection';
  /** Shown on the chip. */
  label: string;
  /** Workspace-relative path, package name, or `file:line-line`. */
  value: string;
}

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export type ThreadItem =
  | { id: string; kind: 'user'; text: string; attachments: Attachment[] }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'notice'; tone: 'info' | 'warn' | 'error' | 'success'; text: string }
  | {
      id: string;
      kind: 'step';
      title: string;
      phase: string;
      detail: string;
      done: number;
      total: number;
      state: 'running' | 'done' | 'failed';
      /** Recent phase lines, newest last. Collapsed by default. */
      log: string[];
    }
  | { id: string; kind: 'packages'; headline: string; ids: string[] }
  | {
      id: string;
      kind: 'question';
      text: string;
      options: QuestionOption[];
      allowFreeText: boolean;
      answer?: string;
    }
  | { id: string; kind: 'changes'; title: string };

export interface EffortProfile {
  /** Analyse patch bumps as well as major/minor. */
  includePatch: boolean;
  /** Analyse dev dependencies. */
  includeDev: boolean;
  /** Cap on impact sites recorded per breaking change. */
  maxSites: number;
  /** Cap on packages checked in one scan. `0` means no cap. */
  maxPackages: number;
}

export const EFFORT_PROFILES: Record<SessionEffort, EffortProfile> = {
  // Enough to answer "is anything on fire?" in a few seconds.
  quick: { includePatch: false, includeDev: false, maxSites: 12, maxPackages: 25 },
  // The default: every runtime dependency, every major and minor bump.
  balanced: { includePatch: false, includeDev: false, maxSites: 40, maxPackages: 0 },
  // Everything, including the ~5% of patch releases that break something.
  thorough: { includePatch: true, includeDev: true, maxSites: 120, maxPackages: 0 },
};

export class DriftSession {
  private items: ThreadItem[] = [];
  private attachments: Attachment[] = [];
  private counter = 0;
  private pending: { id: string; resolve: (answer: string) => void } | null = null;

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  dispose(): void {
    this.rejectPending();
    this.emitter.dispose();
  }

  get thread(): readonly ThreadItem[] {
    return this.items;
  }

  get context(): readonly Attachment[] {
    return this.attachments;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get awaitingAnswer(): boolean {
    return this.pending !== null;
  }

  clear(): void {
    this.rejectPending();
    this.items = [];
    this.emitter.fire();
  }

  /* ---------------------------------------------------------------- */
  /* Items                                                             */
  /* ---------------------------------------------------------------- */

  user(text: string): void {
    this.push({ id: this.nextId(), kind: 'user', text, attachments: [...this.attachments] });
  }

  say(text: string): void {
    this.push({ id: this.nextId(), kind: 'assistant', text });
  }

  notice(tone: 'info' | 'warn' | 'error' | 'success', text: string): void {
    this.push({ id: this.nextId(), kind: 'notice', tone, text });
  }

  /**
   * A long-running operation, rendered as one row that updates in place.
   *
   * Returning a handle rather than an id keeps callers from having to remember
   * which string belongs to which operation, and makes it hard to leave a step
   * spinning forever — `done()` and `fail()` are the only ways out.
   */
  step(title: string): StepHandle {
    const id = this.nextId();
    this.push({
      id,
      kind: 'step',
      title,
      phase: 'Starting',
      detail: '',
      done: 0,
      total: 0,
      state: 'running',
      log: [],
    });

    const update = (patch: Partial<Extract<ThreadItem, { kind: 'step' }>>) => {
      const item = this.items.find((entry) => entry.id === id);
      if (!item || item.kind !== 'step') return;
      Object.assign(item, patch);
      this.emitter.fire();
    };

    return {
      id,
      progress: (phase, detail, done = 0, total = 0) => {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.kind !== 'step') return;
        // One line per distinct phase, so the log reads as a list of things
        // done rather than a flood of near-identical updates.
        const line = detail ? `${phase} — ${detail}` : phase;
        if (item.log[item.log.length - 1] !== line) {
          item.log.push(line);
          if (item.log.length > 200) item.log.shift();
        }
        update({ phase, detail, done, total });
      },
      done: (phase) => update({ state: 'done', phase, detail: '' }),
      fail: (phase) => update({ state: 'failed', phase, detail: '' }),
    };
  }

  packages(headline: string, ids: readonly string[]): void {
    // Only ever one package list in the thread; a second scan replaces the
    // first rather than leaving two contradictory lists on screen.
    this.items = this.items.filter((item) => item.kind !== 'packages');
    this.push({ id: this.nextId(), kind: 'packages', headline, ids: [...ids] });
  }

  updatePackages(headline: string, ids: readonly string[]): void {
    const item = this.items.find((entry) => entry.kind === 'packages');
    if (!item || item.kind !== 'packages') {
      this.packages(headline, ids);
      return;
    }
    item.headline = headline;
    item.ids = [...ids];
    this.emitter.fire();
  }

  /** Ensure exactly one live changes card, at the end of the thread. */
  showChanges(title: string): void {
    this.items = this.items.filter((item) => item.kind !== 'changes');
    this.push({ id: this.nextId(), kind: 'changes', title });
  }

  hideChanges(): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.kind !== 'changes');
    if (this.items.length !== before) this.emitter.fire();
  }

  /* ---------------------------------------------------------------- */
  /* Questions                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Ask the developer something and wait.
   *
   * The agent, and Drift itself, hit genuine forks — two plausible target
   * versions, an ambiguous call site, a dirty working tree. A modal dialog for
   * each of those interrupts; a question in the thread waits. Only one question
   * is ever outstanding, because a queue of them is a form, and nobody reads a
   * form in a chat panel.
   */
  ask(text: string, options: QuestionOption[], allowFreeText = true): Promise<string> {
    this.rejectPending();

    const id = this.nextId();
    this.push({ id, kind: 'question', text, options, allowFreeText });

    return new Promise<string>((resolve) => {
      this.pending = { id, resolve };
    });
  }

  answer(id: string, value: string): boolean {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.kind !== 'question' || item.answer !== undefined) return false;

    item.answer = value;
    this.emitter.fire();

    if (this.pending?.id === id) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve(value);
      return true;
    }
    return false;
  }

  /** Answer the outstanding question with free text typed into the composer. */
  answerPending(value: string): boolean {
    return this.pending ? this.answer(this.pending.id, value) : false;
  }

  private rejectPending(): void {
    if (!this.pending) return;
    const { resolve } = this.pending;
    this.pending = null;
    // An abandoned question resolves empty rather than hanging; callers treat
    // an empty answer as "the developer did not choose", which is a real answer.
    resolve('');
  }

  /* ---------------------------------------------------------------- */
  /* Context                                                           */
  /* ---------------------------------------------------------------- */

  attach(attachment: Attachment): void {
    if (this.attachments.some((a) => a.kind === attachment.kind && a.value === attachment.value)) return;
    this.attachments.push(attachment);
    this.emitter.fire();
  }

  detach(value: string): void {
    this.attachments = this.attachments.filter((a) => a.value !== value);
    this.emitter.fire();
  }

  clearContext(): void {
    this.attachments = [];
    this.emitter.fire();
  }

  /* ---------------------------------------------------------------- */
  /* Composer settings                                                 */
  /* ---------------------------------------------------------------- */

  get mode(): SessionMode {
    return read<SessionMode>('session.mode', 'agent');
  }

  get effort(): SessionEffort {
    return read<SessionEffort>('session.effort', 'balanced');
  }

  get permission(): SessionPermission {
    return read<SessionPermission>('session.permission', 'auto-edit');
  }

  get effortProfile(): EffortProfile {
    return EFFORT_PROFILES[this.effort];
  }

  async setMode(mode: SessionMode): Promise<void> {
    await write('session.mode', mode);
    this.emitter.fire();
  }

  async setEffort(effort: SessionEffort): Promise<void> {
    await write('session.effort', effort);
    this.emitter.fire();
  }

  async setPermission(permission: SessionPermission): Promise<void> {
    await write('session.permission', permission);
    this.emitter.fire();
  }

  private push(item: ThreadItem): void {
    this.items.push(item);
    this.emitter.fire();
  }

  private nextId(): string {
    this.counter += 1;
    return `i${this.counter}`;
  }
}

export interface StepHandle {
  id: string;
  progress: (phase: string, detail: string, done?: number, total?: number) => void;
  done: (phase: string) => void;
  fail: (phase: string) => void;
}

function read<T extends string>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('drift').get<T>(key, fallback);
}

function write(key: string, value: string): Thenable<void> {
  return vscode.workspace
    .getConfiguration('drift')
    .update(key, value, vscode.ConfigurationTarget.Workspace);
}
