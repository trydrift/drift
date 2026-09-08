import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { ask, confirm, type PromptIO } from '../dist/util/prompt.js';
import { stripAnsi } from '../dist/util/terminal.js';

/**
 * A terminal that is only a terminal as far as the prompt can tell: raw mode is
 * a no-op, keystrokes are written in as bytes, and everything drawn is kept so
 * a test can read the menu the way a developer would see it.
 */
function fakeTerminal(): {
  io: PromptIO;
  press: (keys: string) => Promise<void>;
  screen: () => string;
  /** Forget everything drawn so far, so a test can read one frame in isolation. */
  clear: () => void;
  interrupted: () => number;
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode: () => input });

  let drawn = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      drawn += String(chunk);
      done();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns: 100, rows: 30 });

  let interrupts = 0;
  return {
    io: { input, output, onInterrupt: () => void (interrupts += 1) },
    press: async (keys: string) => {
      (input as unknown as PassThrough).write(keys);
      await new Promise((resolve) => setImmediate(resolve));
    },
    screen: () => stripAnsi(drawn),
    clear: () => void (drawn = ''),
    interrupted: () => interrupts,
  };
}

/** `supportsRedraw` refuses to draw under CI, which the test suite runs as. */
function withDrawableTerminal<T>(body: () => Promise<T>): Promise<T> {
  const ci = process.env.CI;
  const noTui = process.env.DRIFT_NO_TUI;
  delete process.env.CI;
  delete process.env.DRIFT_NO_TUI;
  return body().finally(() => {
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
    if (noTui === undefined) delete process.env.DRIFT_NO_TUI;
    else process.env.DRIFT_NO_TUI = noTui;
  });
}

const DOWN = '\u001b[B';
const UP = '\u001b[A';
const ENTER = '\r';
const ESCAPE = '\u001b';

/**
 * A lone escape byte is ambiguous — it could be the start of a longer sequence —
 * so readline holds it until its escape timeout passes. Real terminals behave
 * the same way; a test that types straight through it is testing meta-enter.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

test('arrow keys move the highlight and enter picks the highlighted row', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answer = ask('Pick one', ['alpha', 'beta', 'gamma'], 'gamma', term.io);

    await term.press(DOWN);
    await term.press(ENTER);

    assert.equal(await answer, 'beta');
  });
});

test('the menu never walks off either end', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answer = ask('Pick one', ['alpha', 'beta'], 'beta', term.io);

    await term.press(UP.repeat(4));
    await term.press(ENTER);

    assert.equal(await answer, 'alpha');
  });
});

test('vim keys navigate too', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answer = ask('Pick one', ['alpha', 'beta', 'gamma'], 'gamma', term.io);

    await term.press('jj');
    await term.press('k');
    await term.press(ENTER);

    assert.equal(await answer, 'beta');
  });
});

test('typing a row number still selects that row — including two digits', async () => {
  await withDrawableTerminal(async () => {
    const options = Array.from({ length: 12 }, (_, index) => `pkg-${index + 1}`);
    const term = fakeTerminal();
    const answer = ask('Pick one', options, 'pkg-12', term.io);

    await term.press('11');
    await term.press(ENTER);

    assert.equal(await answer, 'pkg-11');
  });
});

test('escape declines and returns the fallback', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answer = ask('Upgrade one of these now?', ['zod', 'react', 'Skip'], 'Skip', term.io);

    await term.press(ESCAPE);

    assert.equal(await answer, 'Skip');
  });
});

test('a value distinct from its label comes back as the value', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answer = ask(
      'Pick one',
      [
        { value: 'issue', label: 'File a GitHub issue', hint: 'one issue per package' },
        { value: 'skip', label: 'Skip' },
      ],
      'skip',
      term.io,
    );

    await term.press(ENTER);

    assert.equal(await answer, 'issue');
    assert.match(term.screen(), /one issue per package/);
  });
});

test('a long list scrolls instead of printing every row', async () => {
  await withDrawableTerminal(async () => {
    const options = Array.from({ length: 40 }, (_, index) => `pkg-${index + 1}`);
    const term = fakeTerminal();
    const answer = ask('Pick one', options, 'pkg-40', term.io);

    term.clear();
    await term.press(DOWN);
    const visible = term.screen();
    assert.match(visible, /more below/);
    assert.ok(!/\s40 pkg-40/.test(visible), 'the far end of the list is not drawn until scrolled to');

    await term.press(ESCAPE);
    assert.equal(await answer, 'pkg-40');
  });
});

test('slash filters the list and enter picks from what is left', async () => {
  await withDrawableTerminal(async () => {
    const options = ['react', 'react-dom', 'zod', 'typescript', ...Array.from({ length: 12 }, (_, i) => `pkg-${i}`)];
    const term = fakeTerminal();
    const answer = ask('Pick one', options, 'zod', term.io);

    await term.press('/');
    await term.press('type');
    await term.press(ENTER);

    assert.equal(await answer, 'typescript');
  });
});

test('escape leaves the filter before it leaves the menu', async () => {
  await withDrawableTerminal(async () => {
    const options = Array.from({ length: 20 }, (_, index) => `pkg-${index + 1}`);
    const term = fakeTerminal();
    const answer = ask('Pick one', options, 'pkg-20', term.io);

    await term.press('/');
    await term.press('pkg-3');
    assert.match(term.screen(), /filter: pkg-3/);

    term.clear();
    await term.press(ESCAPE);
    await settle();
    assert.match(term.screen(), /pkg-1/, 'the whole list is back');

    await term.press(ENTER);
    assert.equal(await answer, 'pkg-1', 'still on the unfiltered list');
  });
});

test('a hint that arrives with a newline in it still occupies one row', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answer = ask(
      'Pick one',
      [
        { value: 'alpha', hint: 'affects your code\n12 sites in 4 files' },
        { value: 'beta', hint: 'no upstream breaking changes' },
      ],
      'beta',
      term.io,
    );

    term.clear();
    await term.press(DOWN);
    const frame = term.screen().trimEnd().split('\n');
    assert.equal(frame.length, 3, 'one header and one row per option');
    assert.match(frame[1]!, /affects your code 12 sites in 4 files/);

    await term.press(ENTER);
    assert.equal(await answer, 'beta');
  });
});

test('ctrl-c hands control back to the caller rather than answering for them', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answer = ask('Pick one', ['alpha', 'Skip'], 'Skip', term.io);

    await term.press('\u0003');

    assert.equal(await answer, 'Skip');
    assert.equal(term.interrupted(), 1);
  });
});

test('confirm takes a single y or n keystroke', async () => {
  await withDrawableTerminal(async () => {
    const yes = fakeTerminal();
    const answered = confirm('Start fixing now?', false, yes.io);
    await yes.press('y');
    assert.equal(await answered, true);

    const no = fakeTerminal();
    const declined = confirm('Start fixing now?', true, no.io);
    await no.press('n');
    assert.equal(await declined, false);
  });
});

test('confirm starts on its default, so enter alone takes it', async () => {
  await withDrawableTerminal(async () => {
    const term = fakeTerminal();
    const answered = confirm('Start fixing now?', true, term.io);
    await term.press(ENTER);
    assert.equal(await answered, true);
  });
});

test('a terminal that cannot redraw still gets the numbered list', async () => {
  const term = fakeTerminal();
  process.env.DRIFT_NO_TUI = '1';
  try {
    const answer = ask('Pick one', ['alpha', 'beta', 'Skip'], 'Skip', term.io);
    await term.press('2\n');
    assert.equal(await answer, 'beta');
    assert.match(term.screen(), /\[2\] beta/);
  } finally {
    delete process.env.DRIFT_NO_TUI;
  }
});

test('a piped stdin answers with the fallback and draws nothing', async () => {
  const term = fakeTerminal();
  Object.assign(term.io.input!, { isTTY: false });

  assert.equal(await ask('Pick one', ['alpha', 'beta'], 'beta', term.io), 'beta');
  assert.equal(await confirm('Start fixing now?', false, term.io), false);
  assert.equal(term.screen(), '');
});
