import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeUpgrades, probeDependencyChange, filesNamedIn } from '../dist/verification/upgrade-probe.js';
import { applyVerificationToPlan, describeVerification } from '../dist/verification/apply.js';

/**
 * The probe installs each upgrade in a throwaway worktree and runs the
 * project's own checks against it, so a prediction is never reported until it
 * has been measured. Every test here injects `exec` and `fs`: what matters is
 * which commands are run, in which order, and how their exit codes are read —
 * not whether npm is on this machine.
 */

const root = join(tmpdir(), 'drift-probe-test');

const manifest = JSON.stringify({
  name: 'app',
  scripts: { typecheck: 'tsc --noEmit', build: 'tsc -p .' },
});

/** A workspace that declares a typecheck and a build. */
const fs = {
  readFile: async () => manifest,
  readDirectory: async () => ['package.json', 'package-lock.json'],
  isDirectory: async () => true,
};

/** A workspace that declares no checks at all. */
const bareFs = {
  readFile: async () => JSON.stringify({ name: 'app' }),
  readDirectory: async () => ['package.json', 'package-lock.json'],
  isDirectory: async () => true,
};

interface Call {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * An `exec` that records everything and answers from `outcomes`, matched on the
 * command line. Anything unmatched succeeds — git plumbing and installs are
 * background noise for most of these tests.
 */
function recorder(outcomes: Record<string, number> = {}) {
  const calls: Call[] = [];
  const exec = async (command: string, args: readonly string[], options: { cwd?: string } = {}) => {
    const line = [command, ...args].join(' ');
    calls.push({ command, args: [...args], ...(options.cwd ? { cwd: options.cwd } : {}) });
    const code = outcomes[line] ?? 0;
    return {
      code,
      stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : code === 0 ? '' : `${line} failed`,
      stderr: code === 0 ? '' : `src/app.ts(3,11): error TS2554: Expected 1 arguments, but got 2.`,
    };
  };
  return { calls, exec, lines: () => calls.map((c) => [c.command, ...c.args].join(' ')) };
}

const target = (name: string, overrides: Partial<{ installs: string[] }> = {}) => {
  const installs = overrides.installs ?? [];
  return {
    id: `t-${name}`,
    name,
    current: '1.0.0',
    selected: '2.0.0',
    manifestPath: 'package.json',
    packageManager: 'npm' as const,
    install: async (checkout: string) => {
      installs.push(checkout);
    },
  };
};

describe('probing an upgrade before reporting it', () => {
  test('passes when the project still typechecks and builds with it installed', async () => {
    const { exec, lines } = recorder();
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });

    const verification = results.get('t-zod');
    assert.equal(verification?.status, 'passed');
    assert.deepEqual(
      verification?.checks.map((check) => check.label),
      ['npm run typecheck', 'npm run build'],
    );

    // The upgrade is tested in a worktree, never in the developer's checkout.
    assert.ok(lines().some((line) => line.startsWith('git worktree add --detach')));
    assert.ok(lines().some((line) => line === 'npm install'));
  });

  test('the upgrade is installed into the worktree, not the workspace', async () => {
    const installs: string[] = [];
    const { exec } = recorder();
    await probeUpgrades({ root, targets: [target('zod', { installs })], exec, fs });

    assert.equal(installs.length, 1);
    assert.notEqual(installs[0], root);
    assert.ok(installs[0]?.includes('drift-worktrees'));
  });

  test('fails, with the compiler output, when a check that passed at baseline now breaks', async () => {
    // The baseline run happens before any upgrade is applied and is the first
    // `tsc --noEmit`; the recorder cannot distinguish the two, so the failure
    // is put on the build, which passes at baseline and fails after.
    let seenBuilds = 0;
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      if (line === 'npm run build') {
        seenBuilds += 1;
        if (seenBuilds > 1) {
          return { code: 2, stdout: 'src/app.ts(3,11): error TS2554: Expected 1 arguments, but got 2.', stderr: '' };
        }
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });
    const verification = results.get('t-zod');

    assert.equal(verification?.status, 'failed');
    assert.match(verification?.diagnostics ?? '', /TS2554/);
    assert.deepEqual(verification?.failedFiles, ['src/app.ts']);
  });

  test('catches runtime breakage a typecheck cannot see', async () => {
    // The case a compiler is structurally unable to answer: a default that
    // moved, a method that now throws where it returned null. Types are
    // unchanged, so `npm run typecheck` is green and always will be — the test
    // suite is the only thing in the repository with an opinion.
    const runnable = {
      readFile: async () =>
        JSON.stringify({ name: 'app', scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }),
      readDirectory: async () => ['package.json', 'package-lock.json'],
      isDirectory: async () => true,
    };

    let seenTests = 0;
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      if (line === 'npm test') {
        seenTests += 1;
        if (seenTests > 1) {
          return { code: 1, stdout: 'test/parse.test.js:12 AssertionError: expected null, got throw', stderr: '' };
        }
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs: runnable });
    const verification = results.get('t-zod');

    assert.equal(verification?.status, 'failed', 'a green typecheck does not make a broken upgrade safe');
    assert.match(verification?.diagnostics ?? '', /AssertionError/);
    assert.ok(
      verification?.checks.some((check) => check.label === 'npm run typecheck' && check.status === 'passed'),
      'and the typecheck really did pass — that is the point',
    );
  });

  test('a suite already failing before the upgrade still leaves the compiler checks usable', async () => {
    const runnable = {
      readFile: async () =>
        JSON.stringify({ name: 'app', scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }),
      readDirectory: async () => ['package.json', 'package-lock.json'],
      isDirectory: async () => true,
    };

    // Red before anything is touched: excluded from the verdict rather than
    // reported as this upgrade's fault.
    const { exec } = recorder({ 'npm test': 1 });
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs: runnable });
    const verification = results.get('t-zod');

    assert.equal(verification?.status, 'passed');
    assert.deepEqual(
      verification?.checks.map((check) => check.label),
      ['npm run typecheck'],
      'the flaky suite is dropped, the typecheck still counts',
    );
  });

  test('a check that was already red before the upgrade is not blamed on it', async () => {
    const { exec } = recorder({ 'npm run typecheck': 2, 'npm run build': 2 });
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });
    const verification = results.get('t-zod');

    assert.equal(verification?.status, 'skipped');
    assert.match(verification?.reason ?? '', /already fails on this commit/);
  });

  test('a project with no checks is skipped with a reason, never reported as passing', async () => {
    const { exec } = recorder();
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs: bareFs });
    const verification = results.get('t-zod');

    assert.equal(verification?.status, 'skipped');
    assert.match(verification?.reason ?? '', /no typecheck or build/);
  });

  test('an install that cannot resolve is a stated skip, not a failure blamed on the package', async () => {
    const { exec } = recorder();
    const failing = {
      ...target('zod'),
      install: async () => {
        throw new Error('ERESOLVE could not resolve');
      },
    };

    const results = await probeUpgrades({ root, targets: [failing], exec, fs });
    const verification = results.get('t-zod');

    assert.equal(verification?.status, 'skipped');
    assert.match(verification?.reason ?? '', /could not be installed/);
    assert.match(verification?.reason ?? '', /ERESOLVE/);
  });

  test('candidates sharing a manifest share one worktree, and it is always removed', async () => {
    const { exec, lines } = recorder();
    await probeUpgrades({ root, targets: [target('zod'), target('react'), target('vite')], exec, fs });

    const added = lines().filter((line) => line.startsWith('git worktree add'));
    const removed = lines().filter((line) => line.startsWith('git worktree remove'));

    assert.equal(added.length, 1, 'one worktree for three candidates sharing package.json');
    assert.ok(removed.length >= 1, 'the worktree is removed when the group finishes');
  });

  test('each candidate starts from the committed manifest, not the previous candidate’s install', async () => {
    const { exec, lines } = recorder();
    await probeUpgrades({ root, targets: [target('zod'), target('react')], exec, fs });

    assert.ok(
      lines().filter((line) => line === 'git checkout -- .').length >= 1,
      'the worktree is reverted between candidates',
    );
  });

  test('cancelling stops the run and says so', async () => {
    const { exec } = recorder();
    const token = { isCancellationRequested: true };
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs, token });

    assert.equal(results.get('t-zod')?.status, 'skipped');
    assert.match(results.get('t-zod')?.reason ?? '', /Cancelled/);
  });
});

describe('verifying a dependency change that already landed', () => {
  const base = {
    workspace: root,
    packageManager: 'npm' as const,
    afterSha: 'aaaaaaaaaaaa',
    beforeSha: 'bbbbbbbbbbbb',
  };

  test('passes when the project checks out clean at the new version', async () => {
    const { exec } = recorder();
    const verification = await probeDependencyChange({ ...base, exec, fs });
    assert.equal(verification.status, 'passed');
  });

  test('a failure present before the change is not attributed to it', async () => {
    const { exec } = recorder({ 'npm run typecheck': 2 });
    const verification = await probeDependencyChange({ ...base, exec, fs });

    assert.equal(verification.status, 'skipped');
    assert.match(verification.reason ?? '', /already failed at bbbbbbb/);
  });

  test('the second checkout is only paid for when the first one failed', async () => {
    const { exec, lines } = recorder();
    await probeDependencyChange({ ...base, exec, fs });

    const added = lines().filter((line) => line.startsWith('git worktree add'));
    assert.equal(added.length, 1, 'a clean run never checks out the base commit');
  });
});

describe('reading a compiler’s file names', () => {
  test('understands the shapes real toolchains print', () => {
    assert.deepEqual(filesNamedIn('src/app.ts(3,11): error TS2554: nope'), ['src/app.ts']);
    assert.deepEqual(filesNamedIn('src/main.rs:12:5: error[E0308]: mismatched types'), ['src/main.rs']);
    assert.deepEqual(filesNamedIn('./lib/x.go:3:1: undefined: Foo'), ['lib/x.go']);
    assert.deepEqual(filesNamedIn('all good here'), []);
  });
});

describe('what a measurement does to a plan', () => {
  const change = (id: string, kind: string) => ({
    id,
    dependency: 'zod',
    kind: kind as never,
    summary: `${id} changed`,
    symbols: [id],
    confidence: 0.9,
    citations: [],
  });

  const plan = () => ({
    schemaVersion: 1,
    id: 'plan-1',
    branchName: 'drift/zod',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [],
    evidence: [{ id: 'e1' } as never],
    breakingChanges: [change('signature-changed', 'signature-change'), change('behaviour-changed', 'behaviour-change')],
    impactSites: [
      { id: 's1', breakingChangeId: 'signature-changed', file: 'src/a.ts', line: 1 } as never,
      { id: 's2', breakingChangeId: 'behaviour-changed', file: 'src/b.ts', line: 1 } as never,
    ],
    commits: [
      { id: 'c1', breakingChangeIds: ['signature-changed'], dependsOn: [], dependencyReasons: [] } as never,
      { id: 'c2', breakingChangeIds: ['behaviour-changed'], dependsOn: ['c1'], dependencyReasons: [] } as never,
    ],
    planEdges: [{ from: 'c1', to: 'c2', reason: 'ordering' } as never],
    upgradeCohorts: [],
    risk: 'medium' as never,
    gaps: [],
    checkedSurfaces: [],
    blockers: [],
    warnings: [],
    createdAt: new Date().toISOString(),
  });

  const passed = { status: 'passed' as const, checks: [], failedFiles: [] };

  test('a green build drops what a compiler could have caught', () => {
    const verified = applyVerificationToPlan(plan(), passed);

    assert.deepEqual(
      verified.breakingChanges.map((c) => c.id),
      ['behaviour-changed'],
      'the signature change is disproved by the compiler',
    );
    assert.deepEqual(verified.impactSites.map((s) => s.file), ['src/b.ts']);
    assert.deepEqual(verified.commits.map((c) => c.id), ['c2'], 'its commit unit goes with it');
    assert.deepEqual(verified.planEdges, [], 'and so do edges pointing at it');
    assert.deepEqual(verified.commits[0]?.dependsOn, [], 'no unit depends on a unit that no longer exists');
  });

  test('a green build proves nothing about behaviour, so behavioural findings survive', () => {
    const verified = applyVerificationToPlan(plan(), passed);
    assert.ok(verified.breakingChanges.some((c) => c.id === 'behaviour-changed'));
  });

  test('evidence is kept: the upstream change still happened', () => {
    const verified = applyVerificationToPlan(plan(), passed);
    assert.equal(verified.evidence.length, 1);
  });

  test('a red build keeps every finding and carries the output', () => {
    const failed = {
      status: 'failed' as const,
      checks: [{ kind: 'typecheck' as const, label: 'tsc', status: 'failed' as const, durationMs: 1, output: 'boom' }],
      diagnostics: 'src/a.ts(1,1): error TS2554',
      failedFiles: ['src/a.ts'],
    };
    const verified = applyVerificationToPlan(plan(), failed);

    assert.equal(verified.breakingChanges.length, 2, 'nothing is dropped on a failure');
    assert.equal(verified.verification?.diagnostics, 'src/a.ts(1,1): error TS2554');
    assert.match(describeVerification(failed), /fails with this upgrade installed in 1 file/);
  });

  test('a skipped verification changes nothing but is recorded with its reason', () => {
    const skipped = { status: 'skipped' as const, reason: 'No checks to run.', checks: [], failedFiles: [] };
    const verified = applyVerificationToPlan(plan(), skipped);

    assert.equal(verified.breakingChanges.length, 2);
    assert.equal(verified.verification?.reason, 'No checks to run.');
    assert.equal(describeVerification(skipped), 'No checks to run.');
  });
});
