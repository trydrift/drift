import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPalette,
  displayWidth,
  padEnd,
  padStart,
  stripAnsi,
  supportsColor,
  supportsHyperlinks,
  supportsRedraw,
  supportsUnicode,
  truncate,
} from '../dist/util/terminal.js';
import { createStatusLine } from '../dist/util/status-line.js';
import { registryUrl } from '../dist/report/registry-url.js';

/**
 * The contract these tests defend is that the *plain* rendering is complete.
 * Colour, glyphs and hyperlinks carry emphasis; nothing may carry meaning that
 * a piped log, a CI runner or `NO_COLOR=1` would lose. See
 * `src/util/terminal.ts`.
 */

const tty = { isTTY: true, columns: 100 } as NodeJS.WriteStream;
const pipe = { isTTY: false } as NodeJS.WriteStream;

describe('deciding what a terminal can do', () => {
  test('NO_COLOR wins over a TTY, and over FORCE_COLOR', () => {
    assert.equal(supportsColor(tty, { NO_COLOR: '1' }), false);
    assert.equal(supportsColor(tty, { NO_COLOR: '1', FORCE_COLOR: '1' }), false);
  });

  test('FORCE_COLOR turns colour on where a bare isTTY check would say no', () => {
    // The case it exists for: a CI system whose log viewer renders ANSI while
    // the process writes to a pipe.
    assert.equal(supportsColor(pipe, {}), false);
    assert.equal(supportsColor(pipe, { FORCE_COLOR: '1' }), true);
    assert.equal(supportsColor(pipe, { FORCE_COLOR: '0' }), false);
  });

  test('CI gets colour only where it is known to render it', () => {
    assert.equal(supportsColor(pipe, { CI: 'true' }), false);
    assert.equal(supportsColor(pipe, { CI: 'true', GITHUB_ACTIONS: 'true' }), true);
  });

  test('redraw is strictly narrower than colour', () => {
    // Actions renders colour and has no cursor. Drawing a spinner there
    // records every frame as its own line.
    assert.equal(supportsColor(pipe, { CI: 'true', GITHUB_ACTIONS: 'true' }), true);
    assert.equal(supportsRedraw(pipe, { CI: 'true', GITHUB_ACTIONS: 'true' }), false);
    assert.equal(supportsRedraw(tty, {}), true);
    assert.equal(supportsRedraw(tty, { TERM: 'dumb' }), false);
  });

  test('hyperlinks are opt-in by terminal, never assumed', () => {
    // A terminal that does not understand OSC 8 prints the escape bytes, which
    // is worse than plain text — so an unknown terminal must not get them.
    assert.equal(supportsHyperlinks(tty, { FORCE_COLOR: '1' }), false);
    assert.equal(supportsHyperlinks(tty, { FORCE_COLOR: '1', TERM_PROGRAM: 'iTerm.app' }), true);
    assert.equal(supportsHyperlinks(tty, { FORCE_COLOR: '1', DRIFT_HYPERLINKS: '1' }), true);
    // Actions renders neither OSC 8 nor a bare URL as a link.
    assert.equal(supportsHyperlinks(pipe, { GITHUB_ACTIONS: 'true' }), false);
  });

  test('unicode is assumed everywhere except a legacy Windows console', () => {
    assert.equal(supportsUnicode({}), process.platform !== 'win32');
    assert.equal(supportsUnicode({ DRIFT_ASCII: '1' }), false);
  });
});

describe('a palette that has been told to stay quiet', () => {
  const plain = createPalette({ color: false, unicode: false, hyperlinks: false });

  test('returns every string untouched', () => {
    assert.equal(plain('red', 'broken'), 'broken');
    assert.equal(stripAnsi(plain('bold', 'x')), 'x');
  });

  test('still says everything the coloured rendering says', () => {
    // The rule the whole module exists for: severity is in the words, and the
    // glyph is only ever an accent on them.
    assert.equal(plain.glyph('safe'), 'v');
    assert.equal(plain.glyph('arrow'), '->');
  });
});

describe('links', () => {
  const linking = createPalette({ color: false, unicode: true, hyperlinks: true });
  const flat = createPalette({ color: false, unicode: true, hyperlinks: false });

  test('become OSC 8 sequences where the terminal renders them', () => {
    // Asserted exactly rather than by substring: the escape has to open with
    // the URL and close with an empty one, and a `.includes` would pass on a
    // sequence that merely mentioned it somewhere.
    const rendered = linking.link('react', 'https://npmjs.com/package/react');
    assert.equal(rendered, '\u001b]8;;https://npmjs.com/package/react\u0007react\u001b]8;;\u0007');
    assert.equal(stripAnsi(rendered), 'react');
  });

  test('fall back to printing the URL, so a piped log can still reach it', () => {
    assert.equal(flat.link('react', 'https://x.test'), 'react https://x.test');
  });

  test('but `linkOnly` never widens a line it was given no room in', () => {
    // Appending a URL to every cell of a table does not degrade the layout so
    // much as destroy it, so aligned contexts use this instead.
    assert.equal(flat.linkOnly('react', 'https://x.test'), 'react');
    assert.equal(stripAnsi(linking.linkOnly('react', 'https://x.test')), 'react');
  });
});

describe('measuring and padding styled text', () => {
  const c = createPalette({ color: true, unicode: true, hyperlinks: true });

  test('width ignores the escapes, which is what alignment needs', () => {
    assert.equal(displayWidth(c('red', 'abc')), 3);
    assert.equal(displayWidth(c.linkOnly('abc', 'https://x.test')), 3);
  });

  test('padding counts printable columns, not bytes', () => {
    assert.equal(displayWidth(padEnd(c('red', 'ab'), 6)), 6);
    assert.equal(displayWidth(padStart(c('red', 'ab'), 6)), 6);
    // Already wide enough: never truncated by padding.
    assert.equal(stripAnsi(padEnd(c('red', 'abcdef'), 3)), 'abcdef');
  });

  test('truncation is by column and keeps an ellipsis', () => {
    assert.equal(truncate('abcdefgh', 5), 'abcd…');
    assert.equal(truncate('abc', 5), 'abc');
    assert.equal(displayWidth(truncate('abcdefgh', 5)), 5);
  });
});

describe('nesting one style inside another', () => {
  const c = createPalette({ color: true, unicode: true, hyperlinks: false });

  test('the outer style survives past the inner one', () => {
    // `c('gray', ...)` around a string containing `c('cyan', ...)` used to end
    // at the inner reset, leaving the tail of the line unstyled.
    const nested = c('gray', `run ${c('cyan', 'drift fix')} now`);
    assert.equal(stripAnsi(nested), 'run drift fix now');
    assert.ok(nested.endsWith('\u001b[0m'));
    // The gray is reopened after the inner reset rather than abandoned.
    assert.ok(nested.includes('\u001b[0m\u001b[90m'));
  });
});

describe('the status line where there is no cursor to move', () => {
  test('prints occasional plain lines instead of redrawing', () => {
    const written: string[] = [];
    const out: string[] = [];
    const stream = { write: (chunk: string) => written.push(chunk), columns: 80 } as unknown as NodeJS.WriteStream;
    const status = createStatusLine({
      palette: createPalette({ color: false, unicode: false, hyperlinks: false }),
      live: false,
      stream,
      out: (line) => out.push(line),
    });

    status.update('Checking the npm registry');
    status.update('Reading changelogs');
    status.print('a finished row');
    status.stop();

    // The first update speaks; the second is inside the quiet interval. Neither
    // may emit a carriage return, which a CI log records literally.
    assert.deepEqual(written, ['Checking the npm registry\n']);
    assert.deepEqual(out, ['a finished row']);
  });

  test('finished output goes to the caller, never to the progress stream', () => {
    // stdout carries the report and stderr carries the progress, which is what
    // makes `drift outdated > report.txt` a clean report.
    const written: string[] = [];
    const out: string[] = [];
    const stream = { write: (chunk: string) => written.push(chunk), columns: 80 } as unknown as NodeJS.WriteStream;
    const status = createStatusLine({
      palette: createPalette({ color: false, unicode: false, hyperlinks: false }),
      live: false,
      stream,
      out: (line) => out.push(line),
    });
    status.print('the report');
    status.stop();
    assert.deepEqual(written, []);
    assert.deepEqual(out, ['the report']);
  });
});

describe('the page a developer would open for a package', () => {
  test('names the real page for each registry that has one', () => {
    assert.equal(registryUrl('npm', 'react'), 'https://www.npmjs.com/package/react');
    // A scoped name keeps its slash; the percent-encoded form redirects at best.
    assert.equal(registryUrl('npm', '@types/node'), 'https://www.npmjs.com/package/@types/node');
    assert.equal(registryUrl('cargo', 'serde'), 'https://crates.io/crates/serde');
    // A module path is already URL-shaped and must not become one segment.
    assert.equal(registryUrl('go', 'github.com/spf13/cobra'), 'https://pkg.go.dev/github.com/spf13/cobra');
    assert.equal(
      registryUrl('maven', 'com.google.guava:guava'),
      'https://central.sonatype.com/artifact/com.google.guava/guava',
    );
  });

  test('declines rather than guessing where there is no canonical page', () => {
    // A link to a 404 is worse than a name that is simply not a link.
    assert.equal(registryUrl('swift', 'swift-composable-architecture'), null);
    assert.equal(registryUrl('maven', 'not-a-coordinate'), null);
  });
});
