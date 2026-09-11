import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

import { main } from '../dist/cli.js';
import { stripAnsi } from '../dist/util/terminal.js';
import { COMPLETION_SHELLS, completionScript, type CompletionSpec } from '../dist/completion.js';

/** Run the CLI with stdout/stderr captured, styling stripped. */
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

/** Whether a shell is installed here, so its check can run for real. */
function installed(shell: string): boolean {
  return spawnSync('which', [shell], { encoding: 'utf8' }).status === 0;
}

test('every shell Drift claims to support produces a script', async () => {
  for (const shell of COMPLETION_SHELLS) {
    const { code, out } = await run(['completion', shell]);
    assert.equal(code, 0, `${shell} exits 0`);
    assert.ok(out.includes('drift'), `${shell} script mentions the command it completes`);
    assert.ok(out.split('\n').length > 5, `${shell} script is more than a stub`);
  }
});

/**
 * The scripts are shell source, and a script that does not parse is worse than
 * no completion at all: it fails at the top of an interactive session, on every
 * new shell, for something the user cannot easily connect back to Drift. So
 * where the shell is actually installed, it gets to judge its own script.
 */
test('the generated scripts parse in the shells they are written for', async () => {
  for (const shell of ['bash', 'zsh'] as const) {
    if (!installed(shell)) continue;
    const { out } = await run(['completion', shell]);
    const parsed = spawnSync(shell, ['-n'], { input: out, encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${shell} rejected its own completion script:\n${parsed.stderr}`);
  }
});

test('a bash shell actually completes commands, topics and per-command options', async (t) => {
  if (!installed('bash')) return t.skip('bash is not installed here');
  const { out } = await run(['completion', 'bash']);

  /** Ask the generated function what it would offer for a command line. */
  const complete = (...words: string[]): string[] => {
    const script = `${out}
COMP_WORDS=(${words.map((word) => `'${word}'`).join(' ')})
COMP_CWORD=${words.length - 1}
_drift_complete
printf '%s\\n' "\${COMPREPLY[@]}"
`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  };

  assert.ok(complete('drift', '').includes('outdated'), 'commands complete on an empty word');
  assert.deepEqual(complete('drift', 'out'), ['outdated'], 'a prefix narrows to the command that has it');
  assert.ok(complete('drift', 'help', '').includes('environment'), '`help` completes its topics');
  assert.ok(complete('drift', 'outdated', '--').includes('--upgrade'), 'a command completes its own options');
});

/**
 * The claim `drift help completion` makes: an option that completes is one the
 * CLI accepts. Both lists come from the help text, so this checks the wiring
 * that keeps them derived from it — the failure it guards against is a
 * generator that leaks one command's options into another's.
 */
test('a command is never offered another command’s options', async () => {
  const { out: outdated } = await run(['completion', 'bash']);

  const optionsFor = (command: string): string[] => {
    const line = outdated.split('\n').find((row) => row.trim().startsWith(`'${command}') options=`));
    assert.ok(line, `the script has an options list for ${command}`);
    return [...line.matchAll(/--[a-z][\w-]*/g)].map((match) => match[0]);
  };

  // `--before` and `--after` name a commit range, which only `analyze` reads.
  assert.ok(optionsFor('analyze').includes('--before'), 'analyze offers its own range options');
  assert.ok(!optionsFor('outdated').includes('--before'), 'outdated does not offer analyze’s range options');

  // `--upgrade <selector>` is `outdated`'s, and `upgrade` refuses it by name.
  assert.ok(optionsFor('outdated').includes('--upgrade'), 'outdated offers --upgrade');

  // `fix` documents itself as taking every `analyze` option too.
  assert.ok(optionsFor('fix').includes('--before'), 'fix inherits analyze’s options, as its help says');
});

/**
 * fish is rarely installed on the machines this suite runs on, so its script
 * cannot be handed to the shell to judge the way bash's and zsh's are. The one
 * thing that has actually gone wrong here is checkable without it: an unquoted
 * command substitution that produces nothing disappears before `test` sees it,
 * so `test (__drift_command) = analyze` becomes `test = analyze` on an empty
 * command line — not an expression, and fish says so on every tab press.
 */
test('the fish conditions survive an empty command line', async () => {
  const { out } = await run(['completion', 'fish']);

  const conditions = out.split('\n').filter((line) => line.trim().startsWith('test '));
  assert.ok(conditions.length >= 2, `expected the two condition functions, got ${JSON.stringify(conditions)}`);
  for (const line of conditions) {
    assert.ok(
      !/\(\s*__drift_/.test(line),
      `\`${line.trim()}\` passes a bare command substitution to test; capture it into a quoted variable first`,
    );
  }
});

test('a missing shell is refused with the list of the ones that exist', async () => {
  const { code, err } = await run(['completion']);

  assert.equal(code, 1);
  assert.match(err, /needs a shell/);
  for (const shell of COMPLETION_SHELLS) assert.match(err, new RegExp(shell));
});

test('a mistyped shell names the one that was meant', async () => {
  const { code, err } = await run(['completion', 'basj']);

  assert.equal(code, 1);
  assert.match(err, /Did you mean `bash`\?/);
});

test('a shell Drift cannot write for is refused without a wild guess', async () => {
  const { code, err } = await run(['completion', 'powershell']);

  assert.equal(code, 1);
  assert.ok(!/Did you mean/.test(err), 'nothing close enough to suggest');
});

test('`drift help completion` explains how to install what it prints', async () => {
  const { code, out } = await run(['help', 'completion']);

  assert.equal(code, 0);
  assert.match(out, /drift completion —/);
  for (const shell of COMPLETION_SHELLS) assert.match(out, new RegExp(shell));
});

/** The generator is pure, so a spec with a quote in it must not escape its own string. */
test('a name that could break out of the script is quoted', () => {
  const spec: CompletionSpec = {
    commands: ["it's"],
    topics: ["it's"],
    flagsByCommand: { "it's": ['dir'] },
    valueFlags: ['dir'],
    directoryFlags: ['dir'],
    fileFlags: [],
  };

  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell, spec);
    assert.ok(!/'it's'/.test(script), `${shell} script does not close its quote on an apostrophe`);
  }

  if (installed('bash')) {
    const parsed = spawnSync('bash', ['-n'], { input: completionScript('bash', spec), encoding: 'utf8' });
    assert.equal(parsed.status, 0, `bash rejected a script built from an awkward name:\n${parsed.stderr}`);
  }
});
