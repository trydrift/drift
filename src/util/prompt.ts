/**
 * Terminal prompts shared by every CLI command that asks a human a question.
 *
 * Two renderings of the same question, chosen by what the terminal can do:
 *
 *  - an arrow-key menu when there is a real terminal to draw on — move with
 *    up/down, pick with enter, type to filter a long list, escape to decline;
 *  - the original numbered question when there isn't — a terminal that cannot
 *    redraw, a `TERM=dumb` session, CI.
 *
 * Piped or scripted input never blocks at all: it resolves to the
 * caller-supplied fallback, which is what keeps `drift outdated | tee log`
 * from hanging on a menu nobody is there to answer.
 *
 * Nothing here decides anything. A prompt returns the value the human picked
 * (or the fallback) and the caller does what it always did with it, so the
 * upgrade a menu selects is the same upgrade `--upgrade <name>` installs.
 */

import { emitKeypressEvents } from 'node:readline';
import { displayWidth, paletteFor, stripAnsi, supportsRedraw } from './terminal.js';

/** One row of a menu. */
export interface Choice {
  /** What the caller gets back when this row is picked. */
  value: string;
  /** What the row reads as on screen. Defaults to `value`. */
  label?: string;
  /** Dim trailing detail: a version range, a verdict, why the option exists. */
  hint?: string;
}

export type ChoiceInput = string | Choice;

/**
 * Streams and escape hatches, injectable so tests can drive a menu without a
 * terminal.
 */
export interface PromptIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /**
   * What Ctrl-C does. The default re-raises it as the interrupt it is, so a
   * menu is as killable as any other program; tests pass a no-op and get the
   * fallback instead of losing the runner.
   */
  onInterrupt?: () => void;
}

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

function normalize(options: readonly ChoiceInput[]): Choice[] {
  return options.map((option) => {
    const choice = typeof option === 'string' ? { value: option, label: option } : option;
    return {
      value: choice.value,
      label: oneLine(choice.label ?? choice.value),
      ...(choice.hint ? { hint: oneLine(choice.hint) } : {}),
    };
  });
}

/**
 * A row is one line, whatever it was written as.
 *
 * Menu rows are built from text that has every right to wrap — a verdict
 * sentence, a fix-plan summary — and a row that wraps costs the redraw its
 * count of how many lines to erase, which is how a menu leaves debris behind.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Whether Drift may take over the cursor on this terminal at all.
 *
 * `DRIFT_NO_TUI=1` is the switch for a session where that goes wrong — a
 * harness that records the bytes, a terminal that mishandles a redraw — so it
 * has to cover every prompt that moves the cursor, not only the menu. A
 * pre-filled line editor is one of those: it works by writing text and then
 * erasing it again.
 */
function canRedraw(output: NodeJS.WriteStream): boolean {
  if (process.env.DRIFT_NO_TUI === '1') return false;
  return supportsRedraw(output);
}

/**
 * Whether there is somebody on both ends of the question.
 *
 * A terminal on stdin is not enough. `drift analyze | tail` reads keystrokes
 * from a terminal but writes the question into the pipe, where nobody sees it,
 * and a prompt nobody can see holds the command open exactly as long as one
 * nobody is there to answer. Both streams have to be a terminal before a
 * question is worth asking; anything else takes the caller's fallback.
 */
export function canPrompt(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

/** Whether an arrow-key menu can be drawn on these streams. */
function canDraw(input: NodeJS.ReadStream, output: NodeJS.WriteStream): boolean {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return false;
  return canRedraw(output);
}

/**
 * Pick one of `options`.
 *
 * Returns the chosen `value` — the option string itself when options were
 * given as plain strings, so call sites that compare the answer against their
 * own labels keep working. Declining (escape, `q`) returns `fallback`, which
 * is also what a non-interactive run gets without printing anything.
 */
export async function ask(
  question: string,
  options: readonly ChoiceInput[],
  fallback?: string,
  io: PromptIO = {},
): Promise<string> {
  const choices = normalize(options);
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const decline = fallback ?? choices[choices.length - 1]?.value ?? '';

  if (choices.length === 0) return decline;
  if (!canPrompt(input, output)) return decline;
  if (!canDraw(input, output)) return askNumbered(question, choices, decline, input, output);

  return selectInteractive({ question, choices, decline, input, output, io });
}

/** `[y/N]`-style confirmation, as a two-row menu where one can be drawn. */
export async function confirm(question: string, defaultAnswer = false, io: PromptIO = {}): Promise<boolean> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!canPrompt(input, output)) return defaultAnswer;

  if (!canDraw(input, output)) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input, output });
    try {
      const hint = defaultAnswer ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
      if (answer === '') return defaultAnswer;
      return answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  }

  const answer = await selectInteractive({
    question,
    choices: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    decline: defaultAnswer ? 'yes' : 'no',
    initial: defaultAnswer ? 0 : 1,
    inline: true,
    keys: { y: 'yes', n: 'no' },
    input,
    output,
    io,
  });
  return answer === 'yes';
}

/**
 * A free-text answer with an editable default.
 *
 * `initial` is written into the line editor rather than printed beside it, so
 * changing one word of a proposed pull request title costs one word rather
 * than retyping the whole thing — which is the difference between a default a
 * developer can change and a good one they cannot. Enter on its own keeps it,
 * so the common case is still one keystroke, and a non-interactive run takes
 * the default rather than hanging on a line nobody will type.
 *
 * The pre-fill needs a terminal that can erase what it wrote: `rl.write` puts
 * the text in the buffer *and* echoes it, so where there is no cursor to move
 * (a CI log, `TERM=dumb`) the old rendering is the honest one — the default is
 * shown in brackets and an empty answer accepts it.
 */
export async function text(question: string, initial: string, io: PromptIO = {}): Promise<string> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!canPrompt(input, output)) return initial;

  const palette = paletteFor(output);
  const editable = canRedraw(output);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
  try {
    const prompt = editable
      ? `${palette('cyan', '?')} ${palette('bold', question)} `
      : `${palette('cyan', '?')} ${palette('bold', question)} ${palette('gray', `[${initial}]`)} `;
    const answered = rl.question(prompt);
    if (editable) rl.write(initial);
    const answer = await answered;
    return answer.trim() || initial;
  } finally {
    rl.close();
  }
}

/**
 * The fallback rendering: the question, a numbered list, one line of input.
 *
 * Kept whole rather than degraded — a terminal that cannot draw a menu still
 * gets every option, in the same order, with the same meaning.
 */
async function askNumbered(
  question: string,
  choices: readonly Choice[],
  decline: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
  try {
    output.write(`\n${question}\n`);
    choices.forEach((choice, index) => {
      output.write(`  [${index + 1}] ${choice.label}${choice.hint ? `  ${choice.hint}` : ''}\n`);
    });
    const answer = await rl.question('> ');
    const index = Number.parseInt(answer.trim(), 10);
    return Number.isInteger(index) && choices[index - 1] ? choices[index - 1]!.value : decline;
  } finally {
    rl.close();
  }
}

interface SelectArgs {
  question: string;
  choices: readonly Choice[];
  decline: string;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  io: PromptIO;
  /** Row highlighted when the menu opens. */
  initial?: number;
  /** Render the rows on the question's own line — for yes/no. */
  inline?: boolean;
  /** Single keys that pick a value outright, e.g. `y`/`n`. */
  keys?: Record<string, string>;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * The arrow-key menu.
 *
 * Every navigation convention a terminal user already has works here: arrows,
 * vim's `j`/`k`, emacs' Ctrl-N/Ctrl-P, home/end, page up/down. So does the
 * habit this menu replaces — typing a row's number, which moves the cursor
 * there (and digits accumulate, so `12` then enter picks row 12). `/` filters
 * a long list by substring; escape leaves the filter, then leaves the menu.
 */
function selectInteractive(args: SelectArgs): Promise<string> {
  const { question, choices, decline, input, output, io } = args;
  const palette = paletteFor(output);

  return new Promise<string>((resolvePromise) => {
    let cursor = clamp(args.initial ?? 0, 0, choices.length - 1);
    let offset = 0;
    let filter: string | null = null;
    let digits = '';
    let renderedLines = 0;

    const visibleRows = (): number => {
      const rows = typeof output.rows === 'number' && output.rows > 8 ? output.rows - 6 : 10;
      return clamp(Math.min(rows, 12), 3, 12);
    };

    const matches = (): Choice[] => {
      if (!filter) return [...choices];
      const needle = filter.toLowerCase();
      return choices.filter(
        (choice) => choice.label!.toLowerCase().includes(needle) || (choice.hint ?? '').toLowerCase().includes(needle),
      );
    };

    const erase = (): void => {
      if (renderedLines > 0) output.write(`\u001b[${renderedLines}A\u001b[0J`);
      renderedLines = 0;
    };

    const write = (lines: readonly string[]): void => {
      // Clipped to the terminal, for the same reason rows are single lines: one
      // wrapped line and the erase above is one line short of the frame.
      const width = terminalColumns(output) - 1;
      output.write(lines.map((line) => `${clip(line, width)}\n`).join(''));
      renderedLines = lines.length;
    };

    const declineLabel = (): string => {
      const match = choices.find((choice) => choice.value === decline);
      return match ? match.label!.toLowerCase() : 'cancel';
    };

    const header = (shownCount: number): string => {
      if (filter !== null) return `filter: ${filter || '…'}  (enter to pick · esc to clear)`;
      const parts = ['↑/↓ move', 'enter select'];
      if (choices.length > visibleRows()) parts.push('/ filter');
      parts.push(`esc ${declineLabel()}`);
      return `(${parts.join(' · ')})${shownCount === choices.length ? '' : ` — ${shownCount} shown`}`;
    };

    const inlineLines = (): string[] => {
      const rows = choices
        .map((choice, index) =>
          index === cursor
            ? `${palette('cyan', palette.glyph('arrow'))} ${palette('cyan', palette('bold', choice.label!))}`
            : `  ${palette('gray', choice.label!)}`,
        )
        .join('  ');
      return [`${palette('cyan', '?')} ${palette('bold', question)}  ${rows}   ${palette('gray', '(y/n · enter)')}`];
    };

    const listLines = (): string[] => {
      const rowsAvailable = visibleRows();
      const shown = matches();
      if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + rowsAvailable) offset = cursor - rowsAvailable + 1;
      offset = clamp(offset, 0, Math.max(0, shown.length - rowsAvailable));

      const width = terminalColumns(output);
      const numberWidth = String(choices.length).length;
      const labelWidth = Math.min(
        Math.max(...shown.map((choice) => displayWidth(choice.label!)), 1),
        Math.max(16, Math.floor(width * 0.45)),
      );

      const lines = [`${palette('cyan', '?')} ${palette('bold', question)}  ${palette('gray', header(shown.length))}`];

      const window = shown.slice(offset, offset + rowsAvailable);
      if (offset > 0) lines.push(palette('gray', `  ${palette.glyph('dot')} ${offset} more above`));

      for (const [index, choice] of window.entries()) {
        const active = offset + index === cursor;
        const number = String(choices.indexOf(choice) + 1).padStart(numberWidth, ' ');
        const label = fit(choice.label!, labelWidth);
        const pointer = active ? palette('cyan', palette.glyph('arrow')) : ' ';
        const hintWidth = Math.max(8, width - labelWidth - numberWidth - 8);
        const body = choice.hint ? `${pad(label, labelWidth)}  ${palette('gray', fit(choice.hint, hintWidth))}` : label;
        lines.push(`${pointer} ${palette('gray', number)} ${active ? palette('cyan', body) : body}`);
      }

      const below = shown.length - (offset + window.length);
      if (below > 0) lines.push(palette('gray', `  ${palette.glyph('dot')} ${below} more below`));
      if (shown.length === 0) lines.push(palette('gray', `  no match for "${filter}"`));

      return lines;
    };

    const render = (): void => {
      erase();
      write(args.inline ? inlineLines() : listLines());
    };

    const wasRaw = Boolean(input.isRaw);
    const cleanup = (): void => {
      input.off('keypress', onKeypress);
      input.off('end', onEnd);
      input.off('close', onEnd);
      if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      input.pause();
      output.write(SHOW_CURSOR);
    };

    /**
     * Input ended while the menu was open.
     *
     * A menu resolves on a keypress, and nothing else — so a terminal that goes
     * away mid-question (a closed tab, a detached session, a harness that ends
     * its side of the pipe) would leave this promise pending for the lifetime
     * of the process, holding the run open on a question nobody can answer. The
     * answer to a question that can no longer be asked is the same as the answer
     * to one that was declined.
     */
    function onEnd(): void {
      cleanup();
      erase();
      resolvePromise(decline);
    }

    const finish = (value: string, picked: boolean): void => {
      cleanup();
      erase();
      const chosen = choices.find((choice) => choice.value === value);
      const answer = chosen?.label ?? value;
      output.write(
        `${picked ? palette('green', palette.glyph('safe')) : palette('gray', palette.glyph('dot'))} ` +
          `${palette('bold', question)} ${palette(picked ? 'cyan' : 'gray', answer)}\n`,
      );
      resolvePromise(value);
    };

    const move = (delta: number): void => {
      const shown = matches();
      if (shown.length === 0) return;
      cursor = clamp(clamp(cursor, 0, shown.length - 1) + delta, 0, shown.length - 1);
    };

    function onKeypress(chunk: string | undefined, key: Key = {}): void {
      const name = key.name ?? '';

      if (key.ctrl && name === 'c') {
        cleanup();
        output.write('\n');
        if (io.onInterrupt) {
          io.onInterrupt();
          resolvePromise(decline);
          return;
        }
        process.kill(process.pid, 'SIGINT');
        return;
      }

      if (name === 'return' || name === 'enter') {
        const shown = matches();
        const chosen = shown[clamp(cursor, 0, shown.length - 1)];
        if (chosen) finish(chosen.value, true);
        return;
      }

      if (filter !== null) {
        if (name === 'escape') {
          filter = null;
          cursor = 0;
          offset = 0;
        } else if (name === 'backspace') {
          filter = filter.slice(0, -1);
          cursor = 0;
          offset = 0;
        } else if (name === 'up' || (key.ctrl && name === 'p')) {
          move(-1);
        } else if (name === 'down' || (key.ctrl && name === 'n')) {
          move(1);
        } else if (chunk && !key.ctrl && !key.meta && chunk >= ' ') {
          filter += chunk;
          cursor = 0;
          offset = 0;
        }
        render();
        return;
      }

      const shortcut = args.keys?.[(chunk ?? '').toLowerCase()];
      if (shortcut) {
        finish(shortcut, true);
        return;
      }

      if (name === 'escape' || (!args.keys && (chunk === 'q' || chunk === 'Q'))) {
        finish(decline, false);
        return;
      }

      if (chunk && /^[0-9]$/.test(chunk)) {
        const grown = `${digits}${chunk}`;
        const asIndex = Number.parseInt(grown, 10);
        const withinRange = asIndex >= 1 && asIndex <= choices.length;
        digits = withinRange ? grown : chunk;
        const wanted = choices[(withinRange ? asIndex : Number.parseInt(chunk, 10)) - 1];
        const position = wanted ? matches().indexOf(wanted) : -1;
        if (position >= 0) cursor = position;
        render();
        return;
      }
      digits = '';

      switch (name) {
        case 'up':
          move(-1);
          break;
        case 'down':
          move(1);
          break;
        case 'left':
          if (args.inline) move(-1);
          break;
        case 'right':
          if (args.inline) move(1);
          break;
        case 'pageup':
          move(-visibleRows());
          break;
        case 'pagedown':
          move(visibleRows());
          break;
        case 'home':
          cursor = 0;
          break;
        case 'end':
          cursor = matches().length - 1;
          break;
        case 'tab':
          move(key.shift ? -1 : 1);
          break;
        default:
          if (key.ctrl && name === 'p') move(-1);
          else if (key.ctrl && name === 'n') move(1);
          else if (chunk === 'k') move(-1);
          else if (chunk === 'j') move(1);
          else if (chunk === 'g') cursor = 0;
          else if (chunk === 'G') cursor = matches().length - 1;
          else if (chunk === '/' && !args.inline) {
            filter = '';
            cursor = 0;
            offset = 0;
          }
      }
      render();
    }

    emitKeypressEvents(input);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    output.write(HIDE_CURSOR);
    input.on('keypress', onKeypress);
    input.once('end', onEnd);
    input.once('close', onEnd);
    render();
  });
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

function terminalColumns(output: NodeJS.WriteStream): number {
  const columns = output.columns;
  return typeof columns === 'number' && columns > 20 ? columns : 100;
}

/**
 * Shorten a rendered line to the terminal's width.
 *
 * A line that fits is returned untouched, styling and all. One that doesn't is
 * cut as plain text: colour is emphasis, and losing it on the one row that was
 * too long beats losing the frame.
 */
function clip(line: string, width: number): string {
  return displayWidth(line) <= width ? line : fit(line, width);
}

/** Shorten to `width` printable columns. Plain text only — styling comes after. */
function fit(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return plain;
  return `${plain.slice(0, Math.max(1, width - 1))}…`;
}

function pad(value: string, width: number): string {
  const short = width - displayWidth(value);
  return short > 0 ? value + ' '.repeat(short) : value;
}
