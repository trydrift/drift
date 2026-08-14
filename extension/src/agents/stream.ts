import type { TaskActivityInput } from '../session.js';
import { activityFromReport, stripAnsi } from '../agent-activity.js';

/**
 * Reading a coding agent's stream the way the agent wrote it.
 *
 * These CLIs do not emit lines, they emit *blocks*: a bare keyword on its own
 * line naming what follows, then the body, then the next keyword. Codex's
 * transcript is exactly this —
 *
 *     exec
 *     /bin/zsh -lc "sed -n '1,200p' a.js" in /repo
 *      succeeded in 5066ms:
 *     export function greet(name){ … }
 *
 *     codex
 *     `a.js` exports a `greet(name)` function that …
 *
 * — and reporting one row per line turns that into eleven rows, of which the
 * first is titled `exec`, the fourth is `}` and one is `codex`. That is what
 * the panel was showing: a column of one- and two-word fragments that name
 * nothing and cannot be read in either direction. The agent's actual sentence
 * is in there, split across four rows with its code fences on separate lines.
 *
 * So the stream is reassembled into the blocks it was written as, and each
 * block becomes one row: one command with its output folded under it, one
 * paragraph of reasoning under the heading the model gave it, one answer.
 * That is the shape the Claude and Codex extensions show, and the reason
 * theirs reads like a transcript and this read like a log file.
 *
 * Agents whose output is not block-structured lose nothing: a line that
 * belongs to no block still goes through `activityFromReport`, which is
 * exactly what every line used to do.
 */

/** Codex's block keywords. Each appears alone on a line, introducing a body. */
const BLOCK_HEADERS = new Map<string, BlockKind>([
  ['thinking', 'thinking'],
  ['codex', 'message'],
  ['exec', 'exec'],
  ['bash', 'exec'],
  ['apply_patch', 'patch'],
  ['user', 'prompt'],
  ['tokens used', 'tokens'],
  ['turn diff', 'diff'],
  ['error', 'error'],
]);

type BlockKind = 'thinking' | 'message' | 'exec' | 'patch' | 'prompt' | 'tokens' | 'diff' | 'error' | 'result';

interface Block {
  kind: BlockKind;
  lines: string[];
  /** For a result block: `succeeded`, `failed`, or `exited`. */
  status?: string;
}

/**
 * A command's result, which arrives as its own block some time later.
 *
 * Codex dispatches several commands at once and prints each result when it
 * finishes, so results are in completion order and carry no id tying them back
 * to a command. There is no honest way to pair them in general — the first
 * capture of this made exactly that mistake, and filed a `tsconfig*` glob
 * failure under a `sed package.json` that had succeeded.
 */
const RESULT = /^\s+(succeeded|failed|exited(?:\s+\d+)?)\s+(?:\w+\s+)?in\s+[\d.]+m?s:\s*$/i;

export class AgentStreamReader {
  private pending = '';
  private block: Block | null = null;
  /**
   * The last thing the agent said in its own voice.
   *
   * Kept so the run can report what the agent concluded rather than that it
   * exited — see `finalAnswer`.
   */
  private last = '';

  /** Whether this stream ever looked block-structured. */
  private structured = false;

  /**
   * Commands printed but not yet resolved.
   *
   * Codex dispatches in parallel, so more than one can be in flight; when that
   * happens no result is attributed to any of them.
   */
  private outstanding: TaskActivityInput[] = [];

  push(text: string): TaskActivityInput[] {
    this.pending += text;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';

    const out: TaskActivityInput[] = [];
    for (const line of lines) out.push(...this.line(line));
    return out;
  }

  /** Close the stream, emitting whatever block was still open. */
  flush(): TaskActivityInput[] {
    const out: TaskActivityInput[] = [];
    if (this.pending.trim()) {
      out.push(...this.line(this.pending));
      this.pending = '';
    }
    out.push(...this.close());
    out.push(...this.drain());
    return out;
  }

  /**
   * The agent's own last word, if it said one.
   *
   * "Codex finished." is what a run used to report, which answers the question
   * nobody asked. When the agent decided the code needed no change, the reason
   * it decided that is the single most useful sentence in the whole run, and it
   * was being thrown away with the rest of stdout.
   */
  finalAnswer(): string | undefined {
    const text = this.last.trim();
    return text ? text : undefined;
  }

  private line(raw: string): TaskActivityInput[] {
    const text = stripAnsi(raw).replace(/\s+$/, '');

    // A result opens a block of its own. It is indented, which is how it is
    // told apart from a command line, and it closes whatever came before.
    const result = RESULT.exec(text);
    if (result) {
      this.structured = true;
      const closed = this.close();
      this.block = { kind: 'result', lines: [], status: result[1]!.toLowerCase() };
      return closed;
    }

    const header = BLOCK_HEADERS.get(text.trim().toLowerCase());

    if (header && text === text.trimStart()) {
      this.structured = true;
      const closed = this.close();
      this.block = { kind: header, lines: [] };
      return closed;
    }

    if (this.block) {
      this.block.lines.push(text);
      return [];
    }

    // Outside any block. Before the first header this is the CLI's banner;
    // for an agent with no block structure at all it is the whole transcript,
    // and the per-line reader is still the right thing for it.
    if (this.structured || !text.trim() || isBanner(text)) return [];
    return [activityFromReport(text)];
  }

  /**
   * A result, attached to its command only when that attachment is certain.
   *
   * Exactly one command outstanding is the sequential case, and there the
   * pairing is not a guess. With several in flight, Codex prints results in
   * completion order with nothing tying them back, so the result stands on its
   * own row instead of being filed under whichever command happens to be
   * first. A row that says less is recoverable; a row that says something
   * false about which command produced which error is not.
   */
  private result(body: string, status: string): TaskActivityInput[] {
    const failed = status !== 'succeeded';

    if (this.outstanding.length === 1) {
      const command = this.outstanding.pop()!;
      return [
        {
          ...command,
          ...(failed ? { title: `${command.title} failed` } : {}),
          ...(body ? { output: body.slice(0, 4000) } : {}),
        },
      ];
    }

    return [
      ...this.drain(),
      { kind: failed ? 'status' : 'bash', title: failed ? 'Command failed' : 'Output', output: body.slice(0, 4000) },
    ];
  }

  /** Emit every command still waiting for a result it can no longer be matched to. */
  private drain(): TaskActivityInput[] {
    const pending = this.outstanding;
    this.outstanding = [];
    return pending;
  }

  private close(): TaskActivityInput[] {
    const block = this.block;
    this.block = null;
    if (!block) return [];

    const body = block.lines.join('\n').trim();
    if (!body) return [];

    // A command is held back only until the next thing happens. Anything that
    // is not its result ends the wait, so rows still appear in the order the
    // agent produced them.
    switch (block.kind) {
      case 'exec':
        this.outstanding.push(execActivity(body));
        return [];
      case 'result':
        return this.result(body, block.status ?? 'succeeded');
      default:
        return [...this.drain(), ...this.narration(block.kind, body)];
    }
  }

  private narration(kind: BlockKind, body: string): TaskActivityInput[] {
    switch (kind) {
      // The prompt is Drift's own text read back, and the token count is
      // billing, not work. Neither belongs in a log of what happened to the
      // repository.
      case 'prompt':
      case 'tokens':
        return [];
      // The agent talking: what it is about to do, and at the end, what it
      // concluded. Which one this is cannot be known until the stream ends, so
      // every such block is narration here and the last is picked out
      // afterwards by `finalAnswer` — that is what the run reports and what
      // the panel shows as the verdict.
      case 'message':
        this.last = body;
        return [{ kind: 'thinking', title: 'Thinking', detail: body }];
      case 'thinking':
        return [thinkingActivity(body)];
      case 'patch':
        return [{ kind: 'edit', title: 'Edit', detail: firstLine(body), input: body }];
      case 'diff':
        return [{ kind: 'edit', title: 'Changes', input: body }];
      case 'error':
        return [{ kind: 'status', title: 'Error', detail: body }];
      default:
        return [];
    }
  }
}

/**
 * A reasoning block, under the heading the model wrote for it.
 *
 * Models emit these as `**Checking the installed exports**` followed by the
 * paragraph. The heading is a genuine one-line summary of the paragraph — far
 * better than anything a classifier could derive from it — so it becomes the
 * row's title and stops being a stray `**…**` in the middle of the prose.
 */
function thinkingActivity(body: string): TaskActivityInput {
  const heading = /^\*\*(.+?)\*\*\s*/.exec(body);
  if (!heading) return { kind: 'thinking', title: 'Thinking', detail: body, links: linksIn(body) };

  const rest = body.slice(heading[0].length).trim();
  return {
    kind: 'thinking',
    title: heading[1]!.trim(),
    detail: rest || undefined,
    links: linksIn(rest),
  };
}

/**
 * A command, named by what it does rather than by how it was spelled.
 *
 * Codex runs everything through `/bin/zsh -lc "…"`, and it reads a file by
 * shelling out to `sed -n '1,200p' path`. Shown literally, the drawer is a
 * wall of shell wrappers in which reading a file, searching for a symbol and
 * running the test suite all look identical. The Claude and Codex extensions
 * both name these — `Read`, `Search`, `Bash` — and that naming is most of what
 * makes their transcripts skimmable.
 */
export function execActivity(body: string): TaskActivityInput {
  const [first = '', ...rest] = body.split('\n');
  // `<command> in <cwd>`, where the cwd is the workspace the panel is already
  // showing. It is the same path on every row and worth none of the width.
  const command = unwrapShell(`${first}\n${rest.join('\n')}`.replace(/\s+in\s+\/\S*\s*$/, '').trim());
  return { ...namedCommand(command), input: command };
}

/** What a shell command amounts to, in the reader's terms. */
function namedCommand(command: string): { kind: TaskActivityInput['kind']; title: string; file?: string } {
  // Codex has no read tool; `sed -n '1,200p' file` and `cat file` are how it
  // reads one, and calling those `Bash` hides the most common thing it does.
  const read = /^(?:sed\s+-n\s+(?:'|")?[\d,]+p(?:'|")?|cat|head|tail|bat)\s+(?:-\S+\s+)*(\S+)\s*$/.exec(command);
  if (read) return { kind: 'read', title: 'Read', file: unquote(read[1]!) };

  if (/^(?:rg|grep|ag|ack)\b/.test(command)) return { kind: 'search', title: 'Search' };
  if (/^(?:ls|find|fd|tree)\b/.test(command)) return { kind: 'read', title: 'List' };
  if (/^git\s+(?:diff|status|log|show)\b/.test(command)) return { kind: 'read', title: 'Git' };
  if (/^(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:test|typecheck|lint|build|tsc)\b/.test(command)) {
    return { kind: 'bash', title: 'Verify' };
  }

  return { kind: 'bash', title: 'Bash' };
}

/**
 * The command a shell wrapper was asked to run.
 *
 * `/bin/zsh -lc "rg foo"` is one command to a reader and two to a parser, and
 * the wrapper is the same on every row. Only stripped when the quoting is
 * unambiguous — a wrapper whose payload cannot be read back intact is left
 * exactly as the agent printed it rather than guessed at.
 */
export function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[a-z]+\s+)*(['"])([\s\S]*)\1\s*$/.exec(command);
  if (!match) return command;

  const quote = match[1]!;
  const inner = match[2]!;
  // A payload containing its own delimiter was assembled by rules this cannot
  // reproduce; unquoting it would rewrite the command it claims to be showing.
  if (inner.includes(quote)) return command;
  return inner.replace(/\\(["'`$\\])/g, '$1').trim();
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}

/**
 * The CLI introducing itself, before any work has happened.
 *
 * Version, model, sandbox and session id are printed once per run inside a
 * `------` rule. They belong in the run's header, not as eight rows in a log
 * of what the agent did to the repository.
 */
function isBanner(text: string): boolean {
  const line = text.trim();
  if (/^-{3,}$/.test(line)) return true;
  if (/^(OpenAI Codex|Reading prompt from stdin)/i.test(line)) return true;
  return /^(workdir|model|provider|approval|sandbox|reasoning (effort|summaries)|session id):\s/i.test(line);
}

function linksIn(text: string): string[] | undefined {
  const found = text.match(/https?:\/\/[^\s<>"'`)\]}]+/g);
  if (!found) return undefined;
  return [...new Set(found.map((url) => url.replace(/[.,;:!?]+$/, '')))].slice(0, 8);
}
