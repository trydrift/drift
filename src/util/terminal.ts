/**
 * How Drift talks to a terminal.
 *
 * Everything here answers one question: what does this terminal actually
 * support, and what should the output look like when the answer is "not much"?
 * A CLI is used interactively, piped into `less`, redirected to a file, and run
 * on a CI runner that records every escape byte into a log someone reads six
 * months later. Those are four different renderings of the same information and
 * only the first of them wants colour, cursor movement, or a spinner.
 *
 * The rule throughout is that the plain rendering has to be *complete*, not
 * degraded. Colour and symbols carry emphasis, never meaning: a row that is red
 * also says why in words, and a table that loses its box drawing is still a
 * table. Anything a reader could only learn from an escape sequence is a bug.
 */

import { stdout, stderr } from 'node:process';

/**
 * Whether colour is wanted at all.
 *
 * `NO_COLOR` and `FORCE_COLOR` are the two conventions worth honouring — the
 * first because it is the one users reach for, the second because CI systems
 * that render ANSI in their log viewer need a way to say so despite not being a
 * TTY.
 */
export function supportsColor(stream: NodeJS.WriteStream = stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  // GitHub Actions and most modern CI renders ANSI even though the log stream
  // is a pipe, which is exactly the case a bare `isTTY` check gets wrong.
  if (env.GITHUB_ACTIONS === 'true') return true;
  if (env.CI !== undefined) return false;
  return Boolean(stream.isTTY);
}

/**
 * Whether the terminal will redraw — cursor movement, spinners, a line rewritten
 * in place.
 *
 * Strictly narrower than colour support: a CI log renders colour happily and
 * turns a spinner into four hundred lines of garbage, because there is no
 * cursor to move and every carriage return is recorded literally.
 */
export function supportsRedraw(stream: NodeJS.WriteStream = stderr, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI !== undefined) return false;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

/**
 * Whether the terminal turns OSC 8 into a clickable link.
 *
 * There is no capability query for this, and a terminal that does not
 * understand OSC 8 prints the URL *and* the escape bytes around it — which is
 * worse than plain text, so the fallback has to be a real fallback rather than
 * an optimistic guess. `TERM_PROGRAM` covers the terminals people actually use
 * that support it; everything else gets the URL written out, which is
 * copy-pasteable and loses nothing.
 */
export function supportsHyperlinks(stream: NodeJS.WriteStream = stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DRIFT_HYPERLINKS === '0') return false;
  if (env.DRIFT_HYPERLINKS === '1') return true;
  if (!supportsColor(stream, env)) return false;
  // Actions' log viewer renders neither OSC 8 nor a bare URL as a link, and
  // shows the escape bytes if we try.
  if (env.GITHUB_ACTIONS === 'true') return false;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty') return true;
  if (env.TERM_PROGRAM === 'vscode') return true;
  if (env.WT_SESSION) return true;
  if (env.KITTY_WINDOW_ID) return true;
  return false;
}

/**
 * Whether the font is likely to have the box-drawing and status glyphs.
 *
 * Windows consoles outside Windows Terminal, and anything reporting a legacy
 * `TERM`, reliably render these as boxes. An ASCII table is not worse — it is
 * just less pretty — while a table of replacement characters is unreadable.
 */
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DRIFT_ASCII === '1') return false;
  if (process.platform !== 'win32') return true;
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM === 'vscode');
}

/** ANSI SGR codes, applied only when the stream wants them. */
const SGR = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  italic: '\u001b[3m',
  underline: '\u001b[4m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  brightRed: '\u001b[91m',
  brightGreen: '\u001b[92m',
  brightYellow: '\u001b[93m',
} as const;

export type Style = keyof typeof SGR;

/**
 * A palette bound to one stream's capabilities.
 *
 * Constructed once per command rather than consulted per call so that a test —
 * or a `--no-color` run — gets a palette that is genuinely inert, instead of
 * every call site remembering to check a flag.
 */
export interface Palette {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly hyperlinks: boolean;
  /** Wrap `text` in `style`, or return it untouched. */
  (style: Style, text: string): string;
  /**
   * `text` as a clickable link to `url`, falling back to printing the URL
   * beside it. For prose, where a reader who cannot click still needs a way to
   * get there.
   */
  link(text: string, url: string): string;
  /**
   * `text` as a clickable link, falling back to `text` alone.
   *
   * For anywhere the width is spoken for — a table cell, an aligned row — where
   * appending a URL does not degrade the layout so much as destroy it.
   */
  linkOnly(text: string, url: string): string;
  /** One of the status glyphs, in its unicode or ASCII form. */
  glyph(name: GlyphName): string;
}

export type GlyphName =
  | 'affected'
  | 'failed'
  | 'safe'
  | 'unknown'
  | 'pending'
  | 'arrow'
  | 'bullet'
  | 'dot'
  | 'corner'
  | 'tee'
  | 'pipe';

const UNICODE_GLYPHS: Record<GlyphName, string> = {
  affected: '▲',
  failed: '✖',
  safe: '✔',
  unknown: '?',
  pending: '·',
  arrow: '→',
  bullet: '•',
  dot: '·',
  corner: '└',
  tee: '├',
  pipe: '│',
};

const ASCII_GLYPHS: Record<GlyphName, string> = {
  affected: '!',
  failed: 'x',
  safe: 'v',
  unknown: '?',
  pending: '.',
  arrow: '->',
  bullet: '*',
  dot: '-',
  corner: '`',
  tee: '|',
  pipe: '|',
};

export function createPalette(options: {
  color: boolean;
  unicode: boolean;
  hyperlinks: boolean;
}): Palette {
  const paint = ((style: Style, text: string) => {
    if (!options.color) return text;
    // Styles nest: `c('gray', ...)` around a string that already contains a
    // `c('cyan', ...)` used to end at the inner reset, so the tail of the outer
    // string came out unstyled. Reopening the outer style after every reset
    // inside it makes nesting behave the way every call site already assumed.
    const inner = text.split(SGR.reset).join(`${SGR.reset}${SGR[style]}`);
    return `${SGR[style]}${inner}${SGR.reset}`;
  }) as Palette;

  Object.defineProperty(paint, 'color', { value: options.color });
  Object.defineProperty(paint, 'unicode', { value: options.unicode });
  Object.defineProperty(paint, 'hyperlinks', { value: options.hyperlinks });

  paint.link = (text, url) => {
    if (!url) return text;
    if (options.hyperlinks) return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
    // The URL itself, not a dropped link. Someone reading a piped log or a CI
    // transcript needs to be able to get to the changelog too, and the only way
    // to give it to them is to print it.
    return text === url ? text : `${text} ${options.color ? `${SGR.gray}${url}${SGR.reset}` : url}`;
  };

  paint.linkOnly = (text, url) =>
    url && options.hyperlinks ? `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007` : text;

  paint.glyph = (name) => (options.unicode ? UNICODE_GLYPHS[name] : ASCII_GLYPHS[name]);

  return paint;
}

/** The palette for a given stream, read from the environment. */
export function paletteFor(
  stream: NodeJS.WriteStream = stdout,
  env: NodeJS.ProcessEnv = process.env,
): Palette {
  return createPalette({
    color: supportsColor(stream, env),
    unicode: supportsUnicode(env),
    hyperlinks: supportsHyperlinks(stream, env),
  });
}

/** Printable width, ignoring escape sequences — what column alignment needs. */
export function displayWidth(text: string): number {
  return stripAnsi(text).length;
}

const ANSI_PATTERN = /\u001b\][0-9]*;;[\s\S]*?(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Pad to `width` printable columns, ignoring the escapes inside `text`. */
export function padEnd(text: string, width: number): string {
  const short = width - displayWidth(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

export function padStart(text: string, width: number): string {
  const short = width - displayWidth(text);
  return short > 0 ? ' '.repeat(short) + text : text;
}

/** Shorten to `width` columns, with an ellipsis, never cutting mid-escape. */
export function truncate(text: string, width: number, palette?: Palette): string {
  if (width <= 1) return '';
  if (displayWidth(text) <= width) return text;
  // Escapes make a safe in-place cut fiddly and this is only ever applied to
  // plain values, so strip first and let the caller re-style the result.
  const plain = stripAnsi(text);
  const ellipsis = palette?.unicode === false ? '...' : '…';
  return plain.slice(0, Math.max(1, width - ellipsis.length)) + ellipsis;
}

/** How wide the terminal is, with a defensible default when there isn't one. */
export function terminalWidth(stream: NodeJS.WriteStream = stdout): number {
  const columns = stream.columns;
  return Number.isFinite(columns) && columns! > 20 ? columns! : 100;
}
