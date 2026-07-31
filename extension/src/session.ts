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

/**
 * How hard to look.
 *
 * Real breadth, not a label: each level changes what is actually analysed, and
 * — where the agent's backend exposes it — how much reasoning the model spends
 * on each fix. `max` is offered only for models that can actually honour it,
 * which is why the composer's slider asks the agent which stops it has.
 */
export type SessionEffort = 'quick' | 'balanced' | 'thorough' | 'max';

/** The slider's stops, weakest first. Index is the slider's value. */
export const EFFORT_ORDER: readonly SessionEffort[] = ['quick', 'balanced', 'thorough', 'max'];

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
  | {
      id: string;
      kind: 'user';
      text: string;
      attachments: Attachment[];
      /**
       * The snapshot taken before this message was acted on, if the workspace
       * is a git repository. Its presence is what puts a rewind control on the
       * turn.
       */
      checkpoint?: string;
    }
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
      kind: 'tasks';
      title: string;
      subtitle: string;
      groups: TaskGroup[];
    }
  | {
      id: string;
      kind: 'question';
      text: string;
      options: QuestionOption[];
      allowFreeText: boolean;
      answer?: string;
    }
  | { id: string; kind: 'changes'; title: string };

export type TaskState = 'pending' | 'active' | 'done' | 'unchanged' | 'skipped' | 'failed';

/**
 * One line of work, named the way the developer would name it.
 *
 * A task is always about a specific thing: this breaking change, in this file,
 * at this line. That specificity is the whole point — "working…" tells a
 * developer nothing they can check, whereas "`res.send()` no longer accepts a
 * status code — src/http.ts:42" can be verified by opening the file.
 */
export interface Task {
  id: string;
  label: string;
  /** Workspace-relative, for the link. */
  file?: string;
  line?: number;
  /** The excerpt at that site, if there is one. */
  detail?: string;
  state: TaskState;
}

/** One commit unit: a single concern, its own checkbox, its own tasks. */
export interface TaskGroup {
  id: string;
  /** The commit message the planner chose. */
  title: string;
  /** The package this group is about, when it is about exactly one. */
  package?: string;
  state: TaskState;
  /** What the agent is doing right now, while this group is active. */
  note?: string;
  tasks: Task[];
}

/** Drives a `tasks` item without the caller having to hold its id. */
export interface TaskListHandle {
  id: string;
  start: (groupId: string) => void;
  note: (groupId: string, text: string) => void;
  /** Close a group. Tasks whose file actually changed are ticked. */
  finish: (groupId: string, state: TaskState, changedFiles?: readonly string[]) => void;
  finishAll: (state: TaskState) => void;
}

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
  // Thorough, with the caps lifted and the model asked to reason hard. Offered
  // only where the agent's backend actually has a knob for that.
  max: { includePatch: true, includeDev: true, maxSites: 400, maxPackages: 0 },
};

/**
 * Effort, in the vocabulary the agent backends use.
 *
 * Codex takes `model_reasoning_effort`, Claude takes a thinking budget, and the
 * Copilot LM API takes nothing at all. Mapping once, here, keeps each agent from
 * inventing its own scale.
 */
export function reasoningEffort(effort: SessionEffort): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'quick':
      return 'low';
    case 'balanced':
      return 'medium';
    default:
      return 'high';
  }
}

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
  /* History                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * The transcript, as plain data.
   *
   * A live step is written out as finished: a conversation reopened tomorrow
   * cannot still be scanning, and a spinner restored from disk spins forever.
   */
  snapshot(): ThreadItem[] {
    return JSON.parse(
      JSON.stringify(
        this.items.map((item) =>
          item.kind === 'step' && item.state === 'running' ? { ...item, state: 'done' as const } : item,
        ),
      ),
    ) as ThreadItem[];
  }

  restore(items: readonly ThreadItem[]): void {
    this.rejectPending();
    this.items = JSON.parse(JSON.stringify(items)) as ThreadItem[];
    // Ids must never collide with the restored ones, or `answer` and `rewind`
    // would act on the wrong turn.
    this.counter = this.items.length;
    for (const item of this.items) {
      const n = Number(item.id.replace(/^i/, ''));
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
    }
    this.emitter.fire();
  }

  /** The line shown in the history list. The first thing the developer said. */
  get title(): string {
    const first = this.items.find((item) => item.kind === 'user');
    if (first && first.kind === 'user') return first.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const packages = this.items.find((item) => item.kind === 'packages');
    if (packages && packages.kind === 'packages') return 'Dependency scan';
    return 'Conversation';
  }

  /* ---------------------------------------------------------------- */
  /* Items                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Echo what the developer typed, immediately.
   *
   * Returns the item's id so slower work — taking a checkpoint, which shells out
   * to git — can attach itself afterwards. Waiting for that before showing the
   * message is what used to make the panel feel like it had not registered the
   * click at all.
   */
  user(text: string, checkpoint?: string): string {
    const id = this.nextId();
    this.push({ id, kind: 'user', text, attachments: [...this.attachments], checkpoint });
    return id;
  }

  setCheckpoint(itemId: string, checkpoint: string): void {
    const item = this.items.find((entry) => entry.id === itemId);
    if (!item || item.kind !== 'user') return;
    item.checkpoint = checkpoint;
    this.emitter.fire();
  }

  /**
   * Drop an item and everything after it.
   *
   * The conversation half of a rewind. An outstanding question is abandoned
   * along with it — the work that asked it no longer exists, so waiting for an
   * answer would hang the panel on a promise nobody can keep.
   */
  truncateFrom(id: string): void {
    const at = this.items.findIndex((item) => item.id === id);
    if (at === -1) return;
    this.rejectPending();
    this.items = this.items.slice(0, at);
    this.emitter.fire();
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

  /**
   * The plan, as a checklist, before any of it has happened.
   *
   * An agent that streams prose while it works is asking the developer to read a
   * transcript to find out where it is. A checklist answers that at a glance:
   * what the plan is, which concern is in progress, which files it has already
   * settled, and which are still ahead. The item is created up front with every
   * task pending, so the shape of the work is visible before the first edit.
   */
  tasks(title: string, subtitle: string, groups: TaskGroup[]): TaskListHandle {
    const id = this.nextId();
    this.push({ id, kind: 'tasks', title, subtitle, groups });

    const find = (groupId: string): TaskGroup | undefined => {
      const item = this.items.find((entry) => entry.id === id);
      if (!item || item.kind !== 'tasks') return undefined;
      return item.groups.find((group) => group.id === groupId);
    };

    return {
      id,
      start: (groupId) => {
        const group = find(groupId);
        if (!group) return;
        group.state = 'active';
        for (const task of group.tasks) if (task.state === 'pending') task.state = 'active';
        this.emitter.fire();
      },
      note: (groupId, text) => {
        const group = find(groupId);
        if (!group || group.note === text) return;
        group.note = text;
        this.emitter.fire();
      },
      finish: (groupId, state, changedFiles) => {
        const group = find(groupId);
        if (!group) return;
        group.state = state;
        group.note = undefined;
        const changed = new Set(changedFiles ?? []);
        for (const task of group.tasks) {
          if (state === 'failed' || state === 'skipped') {
            task.state = state;
            continue;
          }
          // A task whose file the agent never touched is not a failure — the
          // evidence pointed at a site the agent judged already correct. Saying
          // "unchanged" is honest; ticking it would not be.
          task.state = !task.file || changed.size === 0 ? state : changed.has(task.file) ? 'done' : 'unchanged';
        }
        this.emitter.fire();
      },
      finishAll: (state) => {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.kind !== 'tasks') return;
        for (const group of item.groups) {
          if (group.state === 'pending' || group.state === 'active') {
            group.state = state;
            group.note = undefined;
            for (const task of group.tasks) {
              if (task.state === 'pending' || task.state === 'active') task.state = state;
            }
          }
        }
        this.emitter.fire();
      },
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

  /**
   * The model chosen within one subscription.
   *
   * Kept per agent, not globally, because "which model" only means anything
   * inside a provider: a developer who picks Opus under Claude and then switches
   * to Copilot has not asked for Opus from Copilot, and should find Copilot
   * exactly as they left it.
   */
  model(agentId: string): string | undefined {
    const models = vscode.workspace.getConfiguration('drift').get<Record<string, string>>('agent.models', {});
    return models?.[agentId] || undefined;
  }

  async setModel(agentId: string, model: string | undefined): Promise<void> {
    const config = vscode.workspace.getConfiguration('drift');
    const models = { ...(config.get<Record<string, string>>('agent.models', {}) ?? {}) };
    if (model) models[agentId] = model;
    else delete models[agentId];
    await config.update('agent.models', models, vscode.ConfigurationTarget.Global);
    this.emitter.fire();
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
