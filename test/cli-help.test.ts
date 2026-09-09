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
  assert.match(err, /there's no `analze` command/);
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
  assert.match(err, /`outdated` has no `--dry-run` option/);
  assert.match(err, /Nothing ran, so nothing here changed/);
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
  assert.match(err, /`-z` isn't an option/);
  assert.match(err, /options in full/);
});

test('a stray word after a scanning command is refused', async () => {
  const { code, err } = await run(['outdated', '--dir', '.', 'lodash']);

  assert.equal(code, 1);
  assert.match(err, /`outdated` doesn't take `lodash`/);
});

test('extra arguments past a command\u2019s positionals are refused', async () => {
  const diff = await run(['diff', 'npm', 'lodash', '4.17.20', '4.17.21', 'extra']);
  assert.equal(diff.code, 1);
  assert.match(diff.err, /`diff` doesn't take `extra`/);

  const telemetry = await run(['telemetry', 'print', '--nonsense']);
  assert.equal(telemetry.code, 1);
  assert.match(telemetry.err, /`telemetry` has no `--nonsense` option/);
});

test('a real option is still accepted in either spelling', async () => {
  // An empty directory, so this exercises the proofreader and not the scanner.
  const empty = await mkdtemp(join(tmpdir(), 'drift-cli-args-'));
  for (const argv of [['outdated', '--dir', empty, '--json'], ['outdated', `--dir=${empty}`, '--json']]) {
    const { err } = await run(argv);
    assert.ok(!/has no|isn't an option|doesn't take/.test(err), `${argv.join(' ')} is a valid command line`);
  }
});

test('`--help` still explains rather than being proofread', async () => {
  const { code, out } = await run(['fix', '--help']);

  assert.equal(code, 0);
  assert.match(out, /drift fix \u2014/);
});

test('a lost dash is read as a lost dash, not as a mystery', async () => {
  const short = await run(['outdated', '-json']);
  assert.equal(short.code, 1);
  assert.match(short.err, /Did you mean `--json`\?/);

  const bare = await run(['fix', 'json']);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /Did you mean `--json`\?/);
});

/**
 * The overview, the help topics, and the list a typo is measured against are
 * three copies of the same fact. `explain` and `mcp` were in the first and
 * neither of the others, so `drift explain --help` — the way anyone reads
 * about a command — answered that there is no such topic.
 */
test('every command in the overview has help and is offered after a typo', async () => {
  const { out } = await run(['--help']);
  const advertised = [...out.matchAll(/^ {2}drift ([a-z]+)/gm)].map((match) => match[1]!);
  assert.ok(advertised.includes('explain') && advertised.includes('mcp'), 'read the overview');

  for (const command of new Set(advertised)) {
    const topic = await run(['help', command]);
    assert.equal(topic.code, 0, `\`drift help ${command}\` explains it`);

    const typo = await run([`${command}x`]);
    assert.match(typo.err, new RegExp(`Commands:.*\\b${command}\\b`), `a typo lists \`${command}\``);
  }
});

test('a command that stops on an unexpected error says so kindly', async () => {
  const { reportCrash } = await import('../dist/cli.js');
  const error = console.error;
  let err = '';
  console.error = (...args: unknown[]) => void (err += `${args.join(' ')}\n`);
  try {
    reportCrash('outdated', new Error('EACCES: permission denied'));
  } finally {
    console.error = error;
  }

  assert.match(err, /the `outdated` run stopped: EACCES: permission denied/);
  assert.match(err, /DRIFT_DEBUG=1/, 'says how to get the stack trace it withheld');
  assert.match(err, /github\.com\/trydrift\/drift\/issues/, 'says where a real bug goes');
  assert.ok(!/ at .*cli\.ts/.test(err), 'no stack trace unless it was asked for');
});

/**
 * Every menu says what declining means, rather than inheriting it.
 *
 * `ask` falls back to its *last* option when given no explicit one, which is a
 * fine default for a list that ends in "Skip" and a silent bug for one that
 * does not: the agent picker used to hand back a real provider when the user
 * pressed escape, so backing out of "which agent should Drift use" chose the
 * one at the bottom of the list. Nothing about the call site showed it — the
 * argument that would have said so was the one missing.
 */
test('every prompt says what declining means instead of inheriting it', async () => {
  const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');

  /** The arguments of the `ask(` call starting at `open`, split at depth 1. */
  const argumentsAt = (open: number): string[] => {
    const args: string[] = [];
    let depth = 0;
    let start = open + 1;
    for (let at = open; at < source.length; at++) {
      const character = source[at]!;
      if ('([{'.includes(character)) depth += 1;
      else if (')]}'.includes(character)) {
        depth -= 1;
        if (depth === 0) {
          args.push(source.slice(start, at));
          break;
        }
      } else if (character === ',' && depth === 1) {
        args.push(source.slice(start, at));
        start = at + 1;
      }
    }
    return args;
  };

  const calls = [...source.matchAll(/\bawait ask\(/g)];
  assert.ok(calls.length > 0, 'the CLI still asks questions');
  for (const call of calls) {
    const open = call.index! + call[0].length - 1;
    const args = argumentsAt(open);
    const line = source.slice(0, call.index).split('\n').length;
    assert.ok(
      args.length >= 3,
      `the ask() at src/cli.ts:${line} leaves declining to fall through to its last option — ` +
        'pass the value that means "no" explicitly',
    );
  }
});
