import * as vscode from 'vscode';
import { deriveTitle } from './history.js';

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
 * How hard the model thinks. Nothing else.
 *
 * Effort is a reasoning budget handed to the agent the developer chose, and it
 * is deliberately *not* a scope control: Drift always analyses every dependency
 * it can and always attempts every fix the evidence calls for. A dial that
 * quietly narrowed the search would mean a low setting reported packages as safe
 * because nothing looked at them — the one wrong answer this tool must never
 * give.
 *
 * The four levels are ordinal, and each provider names them itself: what Claude
 * calls Ultracode, Codex calls Extra High. Those names come from the agent, via
 * `EffortStop`, so the dial always uses the vocabulary of the subscription the
 * developer is paying for.
 */
export type SessionEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** The slider's stops, weakest first. Index is the slider's value. */
export const EFFORT_ORDER: readonly SessionEffort[] = ['low', 'medium', 'high', 'xhigh'];

export const DEFAULT_EFFORT: SessionEffort = 'medium';

/**
 * Read a stored effort, tolerating the vocabulary Drift used to use.
 *
 * Older entries that were already moved into `drift.agent.efforts` may still
 * hold `quick`/`balanced`/`thorough`/`max`. They map onto the new scale by
 * position so nobody's setting silently resets.
 */
export function normalizeEffort(value: string | undefined): SessionEffort {
  switch (value) {
    case 'low':
    case 'quick':
      return 'low';
    case 'high':
    case 'thorough':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    default:
      return DEFAULT_EFFORT;
  }
}

/**
 * The effort the given subscription is set to.
 *
 * Kept per agent, for the same reason the model is: "High" on Codex and
 * "Ultracode" on Claude are different products, and a developer who dialled one
 * up has not asked the other to follow.
 */
export function readEffort(agentId: string): SessionEffort {
  const config = vscode.workspace.getConfiguration('drift');
  const stored = config.get<Record<string, string>>('agent.efforts', {})?.[agentId];
  if (stored) return normalizeEffort(stored);
  return DEFAULT_EFFORT;
}

/** How much rope the agent gets. Mirrors Claude Code's permission modes. */
export type SessionPermission = 'ask' | 'auto-edit' | 'full-auto';

/**
 * Where a fix does its work.
 *
 * `new` is the default and the safe one: an agent that only ever edits a branch
 * it created cannot damage the branch the developer was on, and abandoning the
 * whole run costs one checkout. `current` exists because it is sometimes what
 * someone actually wants — already on a scratch branch, already mid-migration —
 * and a tool that refuses is a tool they work around.
 */
export type SessionBranchMode = 'new' | 'current';

/**
 * Whether Drift commits on its own.
 *
 * `approve` holds every edit for keep/undo; `auto` commits each group the
 * moment its agent finishes. Kept separate from the permission dial because
 * they answer different questions — permission is how much the *agent* may do,
 * this is how much *git history* Drift may write — and collapsing them is how
 * "let it edit without asking" quietly came to mean "let it commit too".
 */
export type SessionCommitMode = 'approve' | 'auto';

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

/**
 * A thing to do next, as a button.
 *
 * The panel used to end its messages with "say `/fix`" and "say `/commit`",
 * which asks the reader to retype an instruction the panel has already decided
 * on — and only works if they notice it is an instruction rather than prose.
 * The command still exists and still works; this is the same command with
 * something to click.
 */
export interface MessageAction {
  label: string;
  /** The slash command or text submitted as if typed. */
  command: string;
  /** Draws the button as the obvious one. At most one per message. */
  primary?: boolean;
  hint?: string;
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
  | { id: string; kind: 'assistant'; text: string; actions?: MessageAction[] }
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
      /**
       * Every phase line this step has printed, newest last. Collapsed by
       * default, and the way a reader reaches an earlier phase's output — see
       * `StepLogEntry.output`.
       */
      log: StepLogEntry[];
      /**
       * The command output produced by each phase that printed any, oldest
       * first — a typecheck's output stays available after the build that
       * follows it starts printing its own.
       *
       * Kept rather than overwritten in place: the first version of this
       * cleared the buffer the moment the phase changed, which turned a
       * multi-minute check into a terminal that visibly emptied itself every
       * time the tool moved from typechecking to building to testing — indis-
       * tinguishable, at a glance, from the run having lost its place. The
       * panel now keeps every phase's output and lets the reader pick which
       * one they are looking at; see `renderStep` and `selectOutput` in the
       * webview script.
       */
      outputs?: StepOutputSegment[];
      /** When set, a later `step()` call with the same key replaces this one instead of stacking. */
      key?: string;
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

/**
 * One line of a step's log, and the output it can lead to.
 *
 * The log is the list of things this step has done, in order, and it is the
 * natural place to ask "what did *that* one print". Before this it was a list
 * of bare strings sitting next to a separate row of tabs that tried to fit a
 * phase name into a badge — two controls for one question, neither of which
 * had room to say what it was offering. Now the list is the control.
 */
export interface StepLogEntry {
  /** The line as shown: the phase, and its detail when there is one. */
  text: string;
  /**
   * The output segment this line's phase printed into, when it printed
   * anything at all. Absent for a phase that produced no command output,
   * which is most of them and is why they are not offered as something to
   * click.
   */
  output?: string;
}

/** One phase's worth of command output, kept together so a reader can tell which step it came from. */
export interface StepOutputSegment {
  /** A stable identity independent of position, since old segments are evicted from the front. */
  id: string;
  /** The phase this output was printed under — the same string `item.phase` showed at the time. */
  phase: string;
  lines: string[];
}

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

export interface TaskActivity {
  id: string;
  /**
   * What the agent did, not which pipe said so.
   *
   * `read` and `create` are split out from `edit` because they are the two
   * things a reviewer scanning the drawer most wants to tell apart at a
   * glance: a file the agent merely looked at, and a file that did not exist
   * before it ran.
   */
  kind: 'thinking' | 'bash' | 'edit' | 'create' | 'read' | 'status' | 'search';
  title: string;
  detail?: string;
  input?: string;
  output?: string;
  file?: string;
  added?: number;
  removed?: number;
  lines?: { kind: 'add' | 'del' | 'context'; text: string }[];
  /**
   * Pages the agent said it was consulting.
   *
   * Rendered as real links. An agent that reports "searching the changelog at
   * <url>" is telling the developer exactly which source its fix is about to be
   * based on, and the only useful response to that is to read it — which means
   * the URL has to be clickable rather than a string in a log line.
   */
  links?: string[];
}

export type TaskActivityInput = Omit<TaskActivity, 'id'>;

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
  /**
   * Why this group ended the way it did, in the agent's own words.
   *
   * Only ever set for an outcome that needs explaining. "No change needed" is
   * the case that matters: on its own it reads as Drift quietly retracting the
   * breakage it just reported, and the developer cannot tell a considered
   * verdict from an agent that gave up. The agent almost always explained
   * itself, and that explanation was being discarded.
   */
  reason?: string;
  /**
   * The inspectable work log for this commit unit.
   *
   * Kept on the group, not as loose transcript messages, because the useful
   * question is "what happened for this concern?" A developer should be able
   * to collapse one fix and inspect another without correlating timestamps by
   * hand.
   */
  activity?: TaskActivity[];
  tasks: Task[];
}

/** Drives a `tasks` item without the caller having to hold its id. */
export interface TaskListHandle {
  id: string;
  start: (groupId: string) => void;
  note: (groupId: string, text: string) => void;
  activity: (groupId: string, activity: TaskActivityInput) => void;
  /**
   * Close a group. Tasks whose file actually changed are ticked.
   *
   * `reason` is what the agent said about an outcome that needs explaining —
   * "no change needed" with no reason behind it reads as Drift retracting its
   * own finding and leaves the developer nothing to judge.
   */
  finish: (
    groupId: string,
    state: TaskState,
    changedFiles?: readonly string[],
    reason?: string,
  ) => void;
  finishAll: (state: TaskState) => void;
}

export class DriftSession {
  private items: ThreadItem[] = [];
  private attachments: Attachment[] = [];
  private counter = 0;
  private pending: { id: string; resolve: (answer: string) => void } | null = null;
  /** Set once the panel knows what this conversation turned out to be about. */
  private explicitTitle: string | null = null;
  /**
   * Which open roots the next scan acts on. Empty means "all of them" — the
   * common case, and the reason this is a set of exclusions-from-nothing
   * rather than a set that starts empty and has to be filled in: a window
   * with one folder open should never make anyone visit a menu first.
   *
   * Kept in memory rather than in `drift.*` settings, unlike the mode/
   * permission/effort controls next to it — those describe a preference that
   * should follow the developer between sessions, but a root's filesystem
   * path is specific to this machine and this exact multi-root layout, and
   * persisting it would mean a setting that silently stops matching reality
   * the moment a folder is added or removed from the window.
   */
  private excludedRoots = new Set<string>();

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
    this.explicitTitle = null;
    this.emitter.fire();
  }

  /* ---------------------------------------------------------------- */
  /* Scope                                                              */
  /* ---------------------------------------------------------------- */

  /** Every open root's path is included unless explicitly excluded. */
  isRootIncluded(path: string): boolean {
    return !this.excludedRoots.has(path);
  }

  toggleRoot(path: string, allPaths: readonly string[]): void {
    if (this.excludedRoots.has(path)) {
      this.excludedRoots.delete(path);
    } else if (allPaths.filter((p) => this.isRootIncluded(p)).length > 1) {
      // Never let every root end up excluded — that is not "scope to
      // nothing", it is a control with no way back to "scope to everything"
      // short of finding the reset action, and a scan that silently checked
      // nothing would be the one wrong answer Drift must never give.
      this.excludedRoots.add(path);
    }
    this.emitter.fire();
  }

  resetScope(): void {
    if (this.excludedRoots.size === 0) return;
    this.excludedRoots.clear();
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

  /**
   * Reopen a saved conversation.
   *
   * The saved title comes back with it. Recomputing one from the transcript
   * would rename an entry the moment it is opened, so the row the developer
   * clicked and the thread they land in would disagree.
   */
  restore(items: readonly ThreadItem[], title?: string): void {
    this.rejectPending();
    this.explicitTitle = title?.trim() ? title.trim().slice(0, 80) : null;
    this.items = (JSON.parse(JSON.stringify(items)) as ThreadItem[]).map((item) =>
      // A conversation saved before a step's log carried the output each line
      // led to holds plain strings. Read as objects they would render as
      // blanks, so they are lifted into the current shape on the way in — the
      // output they point at is gone either way, since a restored step is not
      // running.
      item.kind === 'step'
        ? {
            ...item,
            log: item.log.map((entry) =>
              typeof entry === 'string' ? { text: entry as string } : entry,
            ),
          }
        : item,
    );
    // Ids must never collide with the restored ones, or `answer` and `rewind`
    // would act on the wrong turn.
    this.counter = this.items.length;
    for (const item of this.items) {
      const n = Number(item.id.replace(/^i/, ''));
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
    }
    this.emitter.fire();
  }

  /**
   * The line shown in the history list.
   *
   * Prefers a title the panel set once it knew what the run actually found —
   * "3 of 12 upgrades affect this repo" tells two entries apart, and the
   * `/scan` that produced both does not. Falls back to reading the transcript,
   * which is all a conversation saved by an older version has.
   */
  get title(): string {
    return this.explicitTitle ?? deriveTitle(this.items);
  }

  /**
   * Name this conversation after what happened in it.
   *
   * Called by the panel at the moments where it learns something a title can
   * be built from — a scan's tallies, the packages a fix is about. Ignored
   * once set for this conversation unless `replace` is passed: the first
   * concrete fact is usually the one the developer is looking for later, and a
   * title that keeps changing under a live thread is one they cannot search.
   */
  setTitle(title: string, replace = false): void {
    const trimmed = title.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    if (this.explicitTitle && !replace) return;
    this.explicitTitle = trimmed.slice(0, 80);
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

  say(text: string, actions?: MessageAction[]): void {
    this.push({ id: this.nextId(), kind: 'assistant', text, ...(actions?.length ? { actions } : {}) });
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
  step(title: string, options: { key?: string } = {}): StepHandle {
    // A `key` marks this step as a singleton, the same rule `packages()` and
    // `showChanges()` already follow: a rescan replaces the "Checking your
    // dependencies" row in place rather than stacking a second one under it.
    if (options.key) {
      this.items = this.items.filter((item) => !(item.kind === 'step' && item.key === options.key));
    }

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
      key: options.key,
    });

    const update = (patch: Partial<Extract<ThreadItem, { kind: 'step' }>>) => {
      const item = this.items.find((entry) => entry.id === id);
      if (!item || item.kind !== 'step') return;
      Object.assign(item, patch);
      this.emitter.fire();
    };

    let segmentCounter = 0;

    return {
      id,
      progress: (phase, detail, done = 0, total = 0) => {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.kind !== 'step') return;
        // One line per distinct phase, so the log reads as a list of things
        // done rather than a flood of near-identical updates.
        const line = detail ? `${phase} — ${detail}` : phase;
        const isNewPhase = item.phase !== phase;
        if (item.log[item.log.length - 1]?.text !== line) {
          item.log.push({ text: line });
          // A scan writes a line per phase per package, so 200 evicted real
          // content on any repository big enough to want the log — and it
          // evicted it silently, from the front, where the scan says what it
          // decided to look at. This is a runaway guard on a panel that is
          // never redrawn from scratch, not a display budget: no realistic
          // scan reaches it, and the renderer shows everything below it.
          if (item.log.length > 5000) item.log.shift();
        }
        // A new phase gets its own output segment, opened empty and filled in
        // by `output()` below as the command prints. The previous segment is
        // kept, not cleared: a developer looking at "Checking as it is" while
        // "Installing dependencies" moves on to the next phase should still be
        // able to find the install's own output afterwards, tabbed rather than
        // erased out from under them. Bounded the same way the log itself is —
        // this is a scrollback, not an archive.
        if (isNewPhase) {
          segmentCounter += 1;
          const segments = item.outputs ?? (item.outputs = []);
          segments.push({ id: `${id}-o${segmentCounter}`, phase, lines: [] });
          if (segments.length > MAX_STEP_OUTPUT_SEGMENTS) segments.shift();
        }
        // Whatever segment is open now is the one this line's phase prints
        // into, so the log entry can offer it. Written on every line rather
        // than only on the first of a phase: a phase that runs three commands
        // has three lines, and any of them is a reasonable thing to click.
        const open = item.outputs?.[item.outputs.length - 1];
        const entry = item.log[item.log.length - 1];
        if (entry && open && open.phase === phase) entry.output = open.id;
        update({ phase, detail, done, total });
      },
      output: (chunk) => {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.kind !== 'step') return;

        // `output()` is only ever meaningful once a phase has been named, so
        // a chunk that arrives before the first `progress()` call opens its
        // own segment rather than being dropped.
        const segments = item.outputs ?? (item.outputs = []);
        const segment = segments[segments.length - 1] ?? (segments.push({ id: `${id}-o0`, phase: item.phase, lines: [] }), segments[segments.length - 1]!);

        // Chunks arrive on pipe boundaries, not line boundaries, so the tail
        // of the buffer is re-joined with whatever continues it rather than
        // left as a half line that never completes.
        const lines = segment.lines;
        const pending = lines.length > 0 && !lines[lines.length - 1]!.endsWith('\n') ? lines.pop()! : '';
        const combined = pending + chunk;
        const parts = combined.split('\n');
        const trailing = parts.pop() ?? '';

        for (const part of parts) {
          const cleaned = stripControl(part);
          // Progress bars and spinners redraw the same line hundreds of times.
          // Kept only when they carry new text.
          if (cleaned.trim() && cleaned !== lines[lines.length - 1]) lines.push(cleaned);
        }
        if (trailing) lines.push(trailing);

        // A tail, deliberately. This is a live window onto a running command,
        // not its transcript — the full output is on the `CheckOutcome` and is
        // what the failure report quotes.
        while (lines.length > MAX_STEP_OUTPUT_LINES) lines.shift();
        this.emitter.fire();
      },
      // Clearing done/total here (not just flipping `state`) matters: `renderStep`
      // keys the "N / M" badge and progress bar off `total > 0` alone, so without
      // this a finished step still shows a fraction like "7 / 14" next to its
      // checkmark — read by a developer mid-glance as "still running, stuck at 7".
      // `outputs` is deliberately left alone here: the segments already
      // gathered are worth reviewing after the step finishes, and a developer
      // reading a failed check's output is the exact moment this must not
      // vanish.
      done: (phase) => update({ state: 'done', phase, detail: '', done: 0, total: 0 }),
      fail: (phase) => update({ state: 'failed', phase, detail: '', done: 0, total: 0 }),
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
      activity: (groupId, activity) => {
        const group = find(groupId);
        if (!group) return;
        const entries = group.activity ?? (group.activity = []);
        const previous = entries[entries.length - 1];
        if (
          previous &&
          previous.kind === activity.kind &&
          previous.title === activity.title &&
          previous.detail === activity.detail &&
          previous.input === activity.input &&
          previous.output === activity.output
        ) {
          return;
        }
        entries.push({ ...activity, id: `${groupId}-a${entries.length + 1}` });
        // Raised from 80 now that `surface()` (`agents/cli.ts`) reports every
        // line a chunk carries instead of just its last one — the same fix
        // that stopped losing an agent's reasoning also means a verbose run
        // produces more rows, and the old cap started evicting real content.
        if (entries.length > 400) entries.shift();
        this.emitter.fire();
      },
      finish: (groupId, state, changedFiles, reason) => {
        const group = find(groupId);
        if (!group) return;
        group.state = state;
        group.note = undefined;
        // The running commentary is stale the moment the group closes. A
        // stated reason is not: it is the answer to the question the final
        // state raises, so it is kept in its own field and given room to be
        // read rather than ellipsised into the title row.
        group.reason = reason?.trim() || undefined;
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

  /**
   * Put down anything still shown as working.
   *
   * A spinner means "this is happening right now", so one left turning after
   * the run behind it has stopped is a straightforward lie — and the most
   * expensive kind, because the honest reading of it is "still working, wait",
   * which is advice to wait forever. Pressing stop, or an error thrown past the
   * handle that would have closed a step, both used to leave exactly that.
   *
   * Whatever finished cleanly settled itself already, so on a normal run this
   * finds nothing and does nothing.
   */
  settleLive(reason: 'stopped' | 'failed'): void {
    const phase = reason === 'stopped' ? 'Stopped' : 'Did not finish';
    const taskState: TaskState = reason === 'stopped' ? 'skipped' : 'failed';
    let changed = false;

    for (const item of this.items) {
      if (item.kind === 'step' && item.state === 'running') {
        item.state = 'failed';
        item.phase = phase;
        item.detail = '';
        changed = true;
        continue;
      }

      if (item.kind !== 'tasks') continue;
      for (const group of item.groups) {
        if (group.state !== 'active' && group.state !== 'pending') continue;
        // A group that never started is not a casualty of the stop; it simply
        // never happened, and "skipped" says that whichever way the run ended.
        group.state = group.state === 'active' ? taskState : 'skipped';
        group.note = undefined;
        changed = true;
        for (const task of group.tasks) {
          if (task.state === 'active' || task.state === 'pending') task.state = group.state;
        }
      }
    }

    if (changed) this.emitter.fire();
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

  get permission(): SessionPermission {
    return read<SessionPermission>('session.permission', 'auto-edit');
  }

  get branchMode(): SessionBranchMode {
    return read<SessionBranchMode>('git.branchMode', 'new');
  }

  get commitMode(): SessionCommitMode {
    return read<SessionCommitMode>('git.commitMode', 'approve');
  }

  async setBranchMode(mode: SessionBranchMode): Promise<void> {
    await write('git.branchMode', mode);
    this.emitter.fire();
  }

  async setCommitMode(mode: SessionCommitMode): Promise<void> {
    await write('git.commitMode', mode);
    this.emitter.fire();
  }

  /** How hard the given subscription has been asked to think. */
  effort(agentId: string): SessionEffort {
    return readEffort(agentId);
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

  /**
   * Set the effort for one subscription.
   *
   * Written globally, like the model, because a reasoning budget is a statement
   * about the subscription — "when I use Claude, use Ultracode" — not about the
   * repository that happens to be open.
   */
  /**
   * Whether this subscription has been asked for speed over cost.
   *
   * Per agent, like the model and the effort, and for the same reason: fast
   * mode is something one provider sells and another does not, so a developer
   * who turned it on for Codex has said nothing about Claude.
   */
  fast(agentId: string): boolean {
    return Boolean(
      vscode.workspace.getConfiguration('drift').get<Record<string, boolean>>('agent.fast', {})?.[agentId],
    );
  }

  async setFast(agentId: string, fast: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('drift');
    const all = { ...(config.get<Record<string, boolean>>('agent.fast', {}) ?? {}) };
    if (fast) all[agentId] = true;
    else delete all[agentId];
    await config.update('agent.fast', all, vscode.ConfigurationTarget.Global);
    this.emitter.fire();
  }

  async setEffort(agentId: string, effort: SessionEffort): Promise<void> {
    const config = vscode.workspace.getConfiguration('drift');
    const efforts = { ...(config.get<Record<string, string>>('agent.efforts', {}) ?? {}) };
    efforts[agentId] = effort;
    await config.update('agent.efforts', efforts, vscode.ConfigurationTarget.Global);
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
  /** A chunk the current phase's command printed. Filed under whichever phase was named by the most recent `progress()` call. */
  output: (chunk: string) => void;
  done: (phase: string) => void;
  fail: (phase: string) => void;
}

/**
 * How many lines of a single phase's output the step keeps.
 *
 * Enough to see a compiler working through files or a test runner naming
 * suites, and few enough that the drawer stays a glance rather than a scroll.
 */
const MAX_STEP_OUTPUT_LINES = 200;

/**
 * How many phases' worth of output a step remembers.
 *
 * A scan with many manifests or many candidates can move through more phases
 * than anyone would ever want tabs for; this keeps the oldest ones from
 * accumulating forever while still leaving enough recent history to look back
 * a few steps without losing the thread.
 */
const MAX_STEP_OUTPUT_SEGMENTS = 30;

/**
 * ANSI escapes and carriage returns out, so the panel renders text rather than
 * terminal control codes.
 *
 * A `\r` is kept as a line break in spirit — a tool that redraws in place is
 * showing successive states of one line, and the last one is the current one.
 */
function stripControl(text: string): string {
  const lastRedraw = text.lastIndexOf('\r');
  const visible = lastRedraw === -1 ? text : text.slice(lastRedraw + 1);
  // eslint-disable-next-line no-control-regex
  return visible.replace(/\[[0-9;?]*[a-zA-Z]/g, '').replace(/[ --]/g, '');
}

function read<T extends string>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('drift').get<T>(key, fallback);
}

function write(key: string, value: string): Thenable<void> {
  return vscode.workspace
    .getConfiguration('drift')
    .update(key, value, vscode.ConfigurationTarget.Workspace);
}
