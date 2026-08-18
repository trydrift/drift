/**
 * One line at the bottom of the terminal that says what is happening now.
 *
 * A scan does a great deal of work that produces no output for a long time, and
 * the difference between a tool that is thinking and a tool that is wedged is
 * entirely a matter of whether it says so. This is that: a single rewritten
 * line carrying the current phase, a spinner, and a count.
 *
 * It writes to **stderr**, always, and everything the command actually produces
 * goes to stdout. That separation is what lets `drift outdated > report.txt`
 * capture a clean report while the developer still watches the progress, and
 * what lets `drift outdated | grep` work at all.
 *
 * Where there is no cursor to move — a pipe, a CI runner, `TERM=dumb` — it
 * degrades to periodic plain lines rather than to silence. A six-minute CI step
 * that prints nothing is the same problem in a different place, and carriage
 * returns in a CI log are worse than useless: the log viewer records every one
 * of them and the reader gets four hundred lines of half-drawn spinner.
 */

import { stderr } from 'node:process';
import { displayWidth, truncate, type Palette } from './terminal.js';

const SPINNER_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_ASCII = ['-', '\\', '|', '/'];
const FRAME_MS = 80;

/** How often the non-redrawing fallback is allowed to print a line. */
const PLAIN_INTERVAL_MS = 10_000;

export interface StatusLine {
  /** Replace what the line says. Cheap; call it as often as there is news. */
  update(text: string): void;
  /**
   * Print `text` above the status line, keeping the line itself at the bottom.
   *
   * The only safe way to write to the terminal while this is running: a bare
   * `console.log` lands in the middle of a half-drawn frame.
   */
  print(text: string): void;
  /** Erase the line and stop. Safe to call more than once. */
  stop(): void;
  /** Whether this is a live line or the periodic-plain-lines fallback. */
  readonly live: boolean;
}

/**
 * A status line, or a convincing imitation of one.
 *
 * `print` is on the returned object rather than left to the caller because the
 * two have to be interleaved by whoever owns the cursor. A caller that prints
 * its own rows while a spinner is running will interleave them badly no matter
 * how carefully it is written.
 */
export function createStatusLine(options: {
  palette: Palette;
  /** False on a pipe or a CI runner: no cursor, so no redraw. */
  live: boolean;
  stream?: NodeJS.WriteStream;
  /** Where finished output goes. Defaults to stdout via `console.log`. */
  out?: (line: string) => void;
}): StatusLine {
  const stream = options.stream ?? stderr;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const frames = options.palette.unicode ? SPINNER_UNICODE : SPINNER_ASCII;

  let text = '';
  let frame = 0;
  let drawn = false;
  let stopped = false;
  let lastPlain = 0;
  let timer: NodeJS.Timeout | undefined;

  const erase = (): void => {
    if (!drawn) return;
    stream.write('\r\u001b[2K');
    drawn = false;
  };

  const draw = (): void => {
    // Guarded here rather than at each of the three call sites, because missing
    // one is exactly the bug this module exists to prevent: `print` used to
    // redraw unconditionally, so every finished row a CI run emitted was
    // followed by a spinner frame and a clear-line escape recorded literally
    // into the log.
    if (!options.live || stopped || !text) return;
    const spinner = options.palette('cyan', frames[frame % frames.length]!);
    // Truncated to the terminal, because a line that wraps cannot be erased by
    // a single carriage return — the wrapped remainder stays on screen and the
    // next frame draws over the wrong row.
    const room = Math.max(10, (stream.columns || 80) - displayWidth(spinner) - 2);
    erase();
    stream.write(`${spinner} ${truncate(text, room, options.palette)}`);
    drawn = true;
  };

  if (options.live) {
    timer = setInterval(() => {
      frame += 1;
      draw();
    }, FRAME_MS);
    // Never the reason a process stays alive: a scan that has finished its work
    // should exit, not wait for a spinner.
    timer.unref?.();
  }

  return {
    live: options.live,
    update(next) {
      if (stopped) return;
      text = next;
      if (options.live) {
        draw();
        return;
      }
      // No cursor. Say something occasionally rather than every time, so a long
      // phase leaves a trail in the log without burying the report in it.
      const now = Date.now();
      if (now - lastPlain < PLAIN_INTERVAL_MS) return;
      lastPlain = now;
      stream.write(`${next}\n`);
    },
    print(line) {
      erase();
      out(line);
      draw();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      erase();
    },
  };
}
