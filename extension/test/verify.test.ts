import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { availableChecks, describeOutcomes, runChecks, unrunReasons } from '../src/verify.js';
import type { CheckOutcome, LocalCheck } from '../src/verify.js';
import { DriftReview } from '../src/review/store.js';

/**
 * Verification is the strongest signal Drift can give a reviewer without
 * asking them to read every line — but only if it runs the checks the project
 * actually has, and only if a failure informs the decision rather than taking
 * it away.
 */

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-verify-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const script = (name: string, body: string): LocalCheck => {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return {
    kind: 'test',
    label: name,
    command: { command: path, args: [] },
    source: 'a test fixture',
    compileCapable: false,
  };
};

describe('finding the checks a project has', () => {
  test('reads them from the manifest in the given directory', async () => {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(
      join(root, 'app', 'package.json'),
      '{"scripts":{"typecheck":"tsc --noEmit","test":"node --test"}}',
    );
    writeFileSync(join(root, 'app', 'package-lock.json'), '{}');

    const checks = await availableChecks(root, 'app');
    assert.deepEqual(checks.map((c) => c.label), ['npm run typecheck', 'npm test']);
    assert.match(checks[0]!.source, /scripts\.typecheck/);
  });

  test('a directory with no manifest offers nothing', async () => {
    assert.deepEqual(await availableChecks(root, 'nowhere'), []);
  });

  test('Gradle gets typecheck, test and build checks like the other supported ecosystems', async () => {
    mkdirSync(join(root, 'java'), { recursive: true });
    writeFileSync(join(root, 'java', 'build.gradle'), 'plugins { id "java" }\n');

    const checks = await availableChecks(root, 'java');
    assert.deepEqual(checks.map((c) => c.label), [
      'gradle compileTestJava',
      'gradle test',
      'gradle build -x test',
    ]);
  });
});

describe('running them', () => {
  test('reports pass and fail per check, and keeps going after a failure', async () => {
    // Stopping at the first red hides the case where the type error is trivial
    // and the tests are fine — which is exactly the case a reviewer needs.
    const outcomes = await runChecks({
      root,
      checks: [script('ok.sh', 'echo fine; exit 0'), script('bad.sh', 'echo broken >&2; exit 1'), script('ok2.sh', 'exit 0')],
    });

    assert.deepEqual(outcomes.map((o) => o.status), ['passed', 'failed', 'passed']);
    assert.match(outcomes[1]!.output, /broken/);
  });

  test('a missing binary is "not run", not a failure of the fix', async () => {
    const outcomes = await runChecks({
      root,
      checks: [
        {
          kind: 'test',
          label: 'definitely-not-installed',
          command: { command: join(root, 'definitely-not-installed'), args: [] },
          source: 'a test fixture',
          compileCapable: false,
        },
      ],
    });

    assert.equal(outcomes[0]!.status, 'not-run');
    // The reason has to name the fix. "not run" on its own reads as a progress
    // state, and the developer is left guessing whether it is still going.
    assert.match(outcomes[0]!.reason ?? '', /was not found/);
    assert.match(outcomes[0]!.reason ?? '', /command -v/);
  });

  test('each check is reported as it settles, not only at the end', async () => {
    const seen: string[] = [];
    await runChecks({
      root,
      checks: [script('first.sh', 'exit 0'), script('second.sh', 'exit 1')],
      onProgress: (check) => seen.push(`start ${check.label}`),
      onResult: (outcome) => seen.push(`${outcome.status} ${outcome.label}`),
    });

    assert.deepEqual(seen, [
      'start first.sh',
      'passed first.sh',
      'start second.sh',
      'failed second.sh',
    ]);
  });

  test('cancellation records the checks that did not run rather than dropping them', async () => {
    const token = { isCancellationRequested: true } as never;
    const outcomes = await runChecks({ root, checks: [script('ok3.sh', 'exit 0')], token });

    assert.deepEqual(outcomes.map((o) => o.status), ['cancelled']);
    assert.equal(outcomes.length, 1, 'a cancelled check is still accounted for');
  });

  test('output is the tail, where the failure is', async () => {
    const outcomes = await runChecks({
      root,
      checks: [script('noisy.sh', 'for i in $(seq 1 200); do echo line$i; done; echo THE_ERROR >&2; exit 1')],
    });

    assert.match(outcomes[0]!.output, /THE_ERROR/);
    assert.match(outcomes[0]!.output, /earlier line\(s\) omitted/);
    assert.ok(outcomes[0]!.output.split('\n').length <= 41);
  });
});

describe('the one-line verdict', () => {
  const outcome = (label: string, status: string, reason?: string) =>
    ({ kind: 'test', label, status, durationMs: 1, output: '', reason }) as never;

  test('names what failed and counts what did not', () => {
    assert.equal(
      describeOutcomes([outcome('npm run typecheck', 'passed'), outcome('npm test', 'failed')]),
      '1 passed · npm test failed',
    );
    assert.equal(describeOutcomes([]), 'No local checks to run.');
    assert.equal(
      describeOutcomes([outcome('npm test', 'passed'), outcome('mypy .', 'not-run')]),
      '1 passed · 1 could not run',
    );
  });

  test('nothing running at all is a sentence, not a tally', () => {
    // "3 not run" was read as "step 3 is running". A result that is entirely
    // absent has to say so in words.
    assert.equal(
      describeOutcomes([
        outcome('npm run typecheck', 'not-run'),
        outcome('npm test', 'not-run'),
        outcome('npm run build', 'not-run'),
      ]),
      'none of your 3 checks could run',
    );
    assert.equal(
      describeOutcomes([outcome('npm test', 'cancelled')]),
      'none of your 1 check could run (cancelled)',
    );
  });

  test('the reasons survive to the message under the summary', () => {
    assert.deepEqual(
      unrunReasons([
        outcome('npm test', 'not-run', '`npm` was not found.'),
        outcome('npm run build', 'not-run', '`npm` was not found.'),
        outcome('npm run typecheck', 'passed'),
      ]),
      ['`npm` was not found.'],
      'one cause stated once, however many checks it stopped',
    );
  });
});

describe('a failing check never takes the decision away', () => {
  const failing: CheckOutcome[] = [
    { kind: 'test', label: 'npm test', compileCapable: false, status: 'failed', durationMs: 12, output: '1 failing' },
  ];

  test('Keep still works with every check red', async () => {
    const review = new DriftReview();
    review.begin(root);
    review.snapshot({ order: 1, title: 'refactor: rename' }, [
      { path: 'src/a.ts', content: 'before\n' },
    ]);

    // Pretend the agent rewrote the file, then the checks failed.
    const group = review.group(1)!;
    group.files[0]!.current = 'after\n';
    review.setChecks(1, failing);

    assert.deepEqual(review.checksFor(1), failing);

    await review.keepGroup(1);
    assert.equal(review.group(1)!.files.length, 0, 'the group resolved despite the failure');
    review.dispose();
  });

  test('results are attached and cleared without touching the diff', () => {
    const review = new DriftReview();
    review.begin(root);
    review.snapshot({ order: 2, title: 'fix: signature' }, [
      { path: 'src/b.ts', content: 'x\n' },
    ]);

    review.setChecks(2, null, true);
    assert.equal(review.group(2)!.checking, true);
    assert.equal(review.checksFor(2), undefined, 'running is not a result');

    review.setChecks(2, failing);
    assert.equal(review.group(2)!.checking, false);
    assert.equal(review.checksFor(2)!.length, 1);
    assert.equal(review.group(2)!.paths.length, 1, 'the diff is untouched by verification');
    review.dispose();
  });
});
