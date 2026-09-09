import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../dist/cli.js';
import { stripAnsi } from '../dist/util/terminal.js';

/**
 * Run the CLI with stdout/stderr captured, the way a user would read them.
 *
 * Styling is stripped: help is coloured whenever the terminal renders ANSI —
 * including on a CI runner, where `GITHUB_ACTIONS` says the log viewer does —
 * so an assertion against the raw bytes would pass locally and fail in exactly
 * the place these tests run. What is asserted here is the wording, which is the
 * same either way.
 */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const log = console.log;
  const error = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => void (out += `${args.join(' ')}\n`);
  console.error = (...args: unknown[]) => void (err += `${args.join(' ')}\n`);
  try {
    const code = await main(argv);
    return { code, out: stripAnsi(out), err: stripAnsi(err) };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('the overview lists every command and stays short enough to read', async () => {
  const { code, out } = await run(['--help']);

  assert.equal(code, 0);
  for (const command of ['analyze', 'outdated', 'upgrade', 'fix', 'pr', 'diff', 'help']) {
    assert.match(out, new RegExp(`drift ${command}`), `the overview names \`${command}\``);
  }
  assert.ok(out.split('\n').length < 60, 'the overview fits on a screen or two');
});

test('`drift help <command>` answers for that command only', async () => {
  const { code, out } = await run(['help', 'fix']);

  assert.equal(code, 0);
  assert.match(out, /drift fix —/);
  assert.match(out, /--plan/);
  assert.ok(!out.includes('--before'), 'analyze-only options stay in analyze');
});

test('`--help` after a command explains it instead of running it', async () => {
  const { code, out } = await run(['outdated', '--help']);

  assert.equal(code, 0);
  assert.match(out, /drift outdated —/);
  assert.match(out, /--upgrade <selector>/);
});

test('a mistyped command names the one that was meant', async () => {
  const { code, err } = await run(['analze']);

  assert.equal(code, 1);
  assert.match(err, /unknown command `analze`/);
  assert.match(err, /Did you mean `analyze`\?/);
});

test('a mistyped topic does not guess wildly', async () => {
  const { code, err } = await run(['help', 'kubernetes']);

  assert.equal(code, 1);
  assert.ok(!/Did you mean/.test(err), 'nothing close enough to suggest');
  assert.match(err, /Topics: /);
});

test('British spelling reaches the same help', async () => {
  const { out } = await run(['help', 'analyse']);
  assert.match(out, /drift analyze —/);
});

/**
 * The unknown-flag warning reads its vocabulary out of the help text, so a real
 * option that nobody documented would be reported to its user as a typo. This
 * is the check that keeps that from happening quietly.
 */
test('every flag the CLI reads is documented somewhere in its help', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const read = new Set<string>();
  for (const match of source.matchAll(/flags\.([a-zA-Z]+)|flags\['([a-z-]+)'\]/g)) {
    const name = match[1] ?? match[2]!;
    // `flags.add` is a Set method inside the help machinery itself, not a flag.
    if (name !== 'add') read.add(name);
  }
  assert.ok(read.size > 10, 'found the flag reads to check');

  const { out } = await run(['--help']);
  const topics = await Promise.all(
    ['analyze', 'outdated', 'upgrade', 'fix', 'pr'].map(async (command) => (await run(['help', command])).out),
  );
  const documented = [out, ...topics].join('\n');

  for (const flag of read) {
    assert.ok(documented.includes(`--${flag}`), `\`--${flag}\` is read by the CLI but documented nowhere`);
  }
});

/**
 * An ignored argument is an argument whose effect the caller believes they
 * got. These are the shapes that used to run anyway.
 */
test('an unknown option stops the run instead of being ignored', async () => {
  const { code, err } = await run(['outdated', '--dry-run', '--dir', '.']);

  assert.equal(code, 1);
  assert.match(err, /unknown option `--dry-run`/);
  assert.match(err, /drift help outdated/);
});

test('a mistyped option names the one that was meant', async () => {
  const { code, err } = await run(['outdated', '--jsom']);

  assert.equal(code, 1);
  assert.match(err, /Did you mean `--json`\?/);
});

test('a short flag is refused, because Drift has none', async () => {
  const { code, err } = await run(['outdated', '-z']);

  assert.equal(code, 1);
  assert.match(err, /unknown option `-z`/);
});

test('a stray word after a scanning command is refused', async () => {
  const { code, err } = await run(['outdated', '--dir', '.', 'lodash']);

  assert.equal(code, 1);
  assert.match(err, /unexpected argument `lodash`/);
});

test('extra arguments past a command’s positionals are refused', async () => {
  const diff = await run(['diff', 'npm', 'lodash', '4.17.20', '4.17.21', 'extra']);
  assert.equal(diff.code, 1);
  assert.match(diff.err, /unexpected argument `extra`/);

  const telemetry = await run(['telemetry', 'print', '--nonsense']);
  assert.equal(telemetry.code, 1);
  assert.match(telemetry.err, /unknown option `--nonsense`/);
});

test('a real option is still accepted in either spelling', async () => {
  // An empty directory, so this checks the proofreader and not the scanner.
  const empty = await mkdtemp(join(tmpdir(), 'drift-cli-args-'));
  for (const argv of [['outdated', '--dir', empty, '--json'], ['outdated', `--dir=${empty}`, '--json']]) {
    const { err } = await run(argv);
    assert.ok(!/unknown option|unexpected argument/.test(err), `${argv.join(' ')} is a valid command line`);
  }
});

test('`--help` still explains rather than being proofread', async () => {
  const { code, out } = await run(['fix', '--help']);
  assert.equal(code, 0);
  assert.match(out, /drift fix —/);
});
