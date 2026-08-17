import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeUpgrades, probeDependencyChange, filesNamedIn, warmProbe } from '../dist/verification/upgrade-probe.js';
import { applyVerificationToPlan, combineVerifications, describeVerification } from '../dist/verification/apply.js';

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

  test('a check that was already red before the upgrade is not blamed on it, and says why', async () => {
    const { exec } = recorder({ 'npm run typecheck': 2, 'npm run build': 2 });
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });
    const verification = results.get('t-zod');

    assert.equal(verification?.status, 'skipped');
    assert.match(verification?.reason ?? '', /already fails on this commit/);
    // A baseline that fails for a reason specific to the worktree (a missing
    // gitignored file the build needs, say) must not read as a bare "build
    // failed" — the compiler's own output has to be there to tell the two
    // apart.
    assert.match(verification?.reason ?? '', /\$ npm run typecheck/);
    assert.match(verification?.reason ?? '', /TS2554/);
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

  test('a clean group is settled by one combined check run, not one per candidate', async () => {
    const { exec, lines } = recorder();
    const results = await probeUpgrades({
      root,
      targets: [target('zod'), target('react'), target('vite')],
      exec,
      fs,
    });

    for (const id of ['t-zod', 't-react', 't-vite']) {
      assert.equal(results.get(id)?.status, 'passed', `${id} is settled by the combined pass`);
      assert.equal(results.get(id)?.measuredWith, 3, `${id} says what it was measured alongside`);
    }

    // Baseline once, then the batch once. The old shape ran the pair per
    // candidate, which is what made a scan cost a check run per dependency.
    assert.equal(
      lines().filter((line) => line === 'npm run typecheck').length,
      2,
      'baseline plus one combined run, not one run per candidate',
    );
  });

  test('a red group is re-measured one candidate at a time, so the blame lands on the right one', async () => {
    // The batch goes red and cannot say which of the three did it. Only `react`
    // actually breaks, and only after it is installed on its own can that be
    // established — so the other two must still come back clean.
    let installed = '';
    const failing = (name: string) => ({
      ...target(name),
      install: async () => {
        installed = installed ? `${installed}+${name}` : name;
      },
    });
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      const broken = line === 'npm run typecheck' && installed.includes('react');
      return {
        code: broken ? 1 : 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: broken ? 'src/app.ts(3,11): error TS2554: Expected 1 arguments, but got 2.' : '',
        ...(command === 'git' && args[0] === 'checkout' ? {} : {}),
      };
    };
    // `git checkout -- .` is what puts the tree back; the fake tracks that by
    // clearing what it believes is installed.
    const resetting = async (command: string, args: readonly string[], options?: { cwd?: string }) => {
      if (command === 'git' && args[0] === 'checkout') installed = '';
      return exec(command, args, options as never);
    };

    const results = await probeUpgrades({
      root,
      targets: [failing('zod'), failing('react'), failing('vite')],
      exec: resetting as never,
      fs,
    });

    assert.equal(results.get('t-react')?.status, 'failed', 'the package that actually breaks is named');
    assert.equal(results.get('t-zod')?.status, 'passed', 'an innocent candidate is not blamed for the batch');
    assert.equal(results.get('t-vite')?.status, 'passed', 'an innocent candidate is not blamed for the batch');
    assert.equal(
      results.get('t-zod')?.measuredWith,
      undefined,
      'a verdict reached alone does not claim to have been measured alongside anything',
    );
  });

  test('a large red group is halved rather than re-measured package by package', async () => {
    // Eight upgrades, one of which breaks the typecheck. Testing each on its
    // own is eight check runs; halving finds the culprit in far fewer, and
    // every candidate still ends up with the same verdict it would have got.
    let installed: string[] = [];
    const candidate = (name: string) => ({
      ...target(name),
      install: async () => {
        installed.push(name);
      },
    });
    const names = ['a', 'b', 'c', 'd', 'e', 'react', 'g', 'h'];

    let checkRuns = 0;
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      if (command === 'git' && args[0] === 'checkout') installed = [];
      if (line === 'npm run typecheck') checkRuns += 1;
      const broken = line === 'npm run typecheck' && installed.includes('react');
      return {
        code: broken ? 1 : 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: broken ? 'src/app.ts(3,11): error TS2554: Expected 1 arguments, but got 2.' : '',
      };
    };

    const results = await probeUpgrades({
      root,
      targets: names.map(candidate),
      exec: exec as never,
      fs,
    });

    assert.equal(results.get('t-react')?.status, 'failed', 'the package that actually breaks is named');
    for (const name of names.filter((n) => n !== 'react')) {
      assert.equal(results.get(`t-${name}`)?.status, 'passed', `${name} is not blamed for someone else's failure`);
    }
    // One baseline, the whole batch, then the halves. The serial shape needed
    // nine runs of the typecheck alone; anything close to that means the
    // search stopped narrowing.
    assert.ok(checkRuns < 9, `expected fewer than nine typecheck runs, got ${checkRuns}`);
    assert.equal(
      results.get('t-react')?.measuredWith,
      undefined,
      'the package finally blamed was measured on its own',
    );
  });

  test('every phase about a package names that package, so a caller can show it on its row', async () => {
    // `ProbeProgress.targets` is what lets the panel put "running the test
    // suite" on the row it belongs to instead of on all of them. The phases
    // that name a target must actually carry it; the ones about the checkout
    // itself — creating the worktree, installing the project's own
    // dependencies, measuring the baseline — must not pretend to.
    const { exec } = recorder();
    const phases: { phase: string; targets?: readonly string[] }[] = [];
    await probeUpgrades({
      root,
      targets: [target('zod')],
      exec,
      fs,
      onProgress: (progress) => {
        if (progress.phase) phases.push({ phase: progress.phase, targets: progress.targets });
      },
    });

    const attributed = phases.filter((entry) => entry.targets?.includes('t-zod'));
    assert.ok(
      attributed.some((entry) => /Testing zod@2\.0\.0/.test(entry.phase)),
      `no phase named the package it was about: ${JSON.stringify(phases)}`,
    );
    assert.ok(
      phases.some((entry) => /Preparing a test checkout/.test(entry.phase) && !entry.targets),
      'work on the checkout itself is not attributed to a package',
    );
  });

  test('a worktree that fails to reset is not reused for the next candidate in a group', async () => {
    // `git checkout -- .` succeeds the first time (letting the batch attempt,
    // which fails to install at all, fall through to the serial pass) and
    // fails every time after — a real reset command that runs and returns
    // nonzero, not a missing one. The old code read that as success (only a
    // thrown exec was ever caught) and moved straight on to install the next
    // candidate on top of whatever the first one left behind.
    let installedCount = 0;
    let checkoutCalls = 0;
    const failedBatchInstallOnce = new Set<string>();
    const failing = (name: string) => ({
      ...target(name),
      install: async () => {
        if (name === 'zod' && !failedBatchInstallOnce.has(name)) {
          failedBatchInstallOnce.add(name);
          throw new Error('batch install fails, forcing the serial fallback');
        }
        installedCount += 1;
      },
    });
    const exec = async (command: string, args: readonly string[]) => {
      if (command === 'git' && args[0] === 'checkout') {
        checkoutCalls += 1;
        return checkoutCalls === 1 ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'conflict' };
      }
      return {
        code: 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: '',
      };
    };

    const results = await probeUpgrades({
      root,
      targets: [failing('zod'), failing('react'), failing('vite')],
      exec,
      fs,
    });

    assert.equal(results.get('t-zod')?.status, 'passed', 'the first candidate is still tested and settled');
    assert.equal(installedCount, 1, 'nothing after the failed reset is installed on the contaminated tree');
    assert.equal(results.get('t-react')?.status, 'skipped');
    assert.match(results.get('t-react')?.reason ?? '', /could not be reset/);
    assert.equal(results.get('t-vite')?.status, 'skipped');
    assert.match(results.get('t-vite')?.reason ?? '', /could not be reset/);
  });

  test('a single candidate is never described as measured alongside others', async () => {
    const { exec } = recorder();
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });

    assert.equal(results.get('t-zod')?.status, 'passed');
    assert.equal(results.get('t-zod')?.measuredWith, undefined);
  });

  test('cancelling stops the run and says so', async () => {
    const { exec } = recorder();
    const token = { isCancellationRequested: true };
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs, token });

    assert.equal(results.get('t-zod')?.status, 'skipped');
    assert.match(results.get('t-zod')?.reason ?? '', /Cancelled/);
  });

  test('independent manifest groups are each settled correctly, run concurrently', async () => {
    const { exec, calls } = recorder();
    const results = await probeUpgrades({
      root,
      targets: [
        { ...target('zod'), manifestPath: 'package.json' },
        { ...target('react'), manifestPath: 'packages/web/package.json' },
      ],
      exec,
      fs,
    });

    assert.equal(results.get('t-zod')?.status, 'passed');
    assert.equal(results.get('t-react')?.status, 'passed');
    // One worktree per manifest group — concurrency does not change how many
    // are made, only whether the loop over them awaits one at a time.
    const added = calls.filter((c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    assert.equal(added.length, 2, 'one worktree per manifest group');
  });
});

/**
 * Preparing a checkout is a worktree, a full install and a baseline check run
 * — minutes of local work that depends on nothing the scan learns from the
 * network. Starting it early is the largest single speedup available to a
 * scan, so what these protect is that it stays an optimisation: the same
 * verdicts, the same number of worktrees, and nothing left on disk.
 */
describe('warming a test checkout before the packages that need it are known', () => {
  test('a warmed checkout is used instead of preparing a second one', async () => {
    const { exec, calls } = recorder();
    const warm = warmProbe({ root, targets: [], exec, fs }, [{ dir: '', packageManager: 'npm' }]);

    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs, warm });
    await warm.dispose();

    assert.equal(results.get('t-zod')?.status, 'passed');
    const added = calls.filter((c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    assert.equal(added.length, 1, 'the warmed checkout is taken, not duplicated');
  });

  test('a directory nobody warmed still prepares its own, so warming never changes the verdict', async () => {
    const { exec, calls } = recorder();
    // Warmed for the root only; the probe is handed a member manifest too.
    const warm = warmProbe({ root, targets: [], exec, fs }, [{ dir: '', packageManager: 'npm' }]);

    const results = await probeUpgrades({
      root,
      targets: [
        { ...target('zod'), manifestPath: 'package.json' },
        { ...target('react'), manifestPath: 'packages/web/package.json' },
      ],
      exec,
      fs,
      warm,
    });
    await warm.dispose();

    assert.equal(results.get('t-zod')?.status, 'passed');
    assert.equal(results.get('t-react')?.status, 'passed');
    const added = calls.filter((c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    assert.equal(added.length, 2, 'the unwarmed member prepared its own');
  });

  test('a warmed checkout nobody took is removed rather than left on disk', async () => {
    const { exec, calls } = recorder();
    // Warmed for a member that turns out to have no upgrades worth testing.
    const warm = warmProbe({ root, targets: [], exec, fs }, [{ dir: 'packages/web', packageManager: 'npm' }]);

    await probeUpgrades({ root, targets: [], exec, fs, warm });
    await warm.dispose();

    const added = calls.filter((c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    const removed = calls.filter(
      (c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove' && c.args.includes('--force'),
    );
    assert.equal(added.length, 1, 'the warmup did prepare one');
    assert.ok(
      removed.some((c) => c.args.some((arg) => arg.includes('probe-packages'))),
      'the abandoned worktree was disposed of',
    );
  });

  test('a warmup whose install fails settles its packages with the reason, not a crash', async () => {
    const { exec } = recorder({ 'npm install': 1 });
    const warm = warmProbe({ root, targets: [], exec, fs }, [{ dir: '', packageManager: 'npm' }]);

    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs, warm });
    await warm.dispose();

    assert.equal(results.get('t-zod')?.status, 'skipped');
    assert.match(results.get('t-zod')?.reason ?? '', /npm install/);
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

  test('a new regression in one check is kept even though an unrelated check was already red at baseline', async () => {
    // `build` fails at both commits — pre-existing, not this dependency's
    // fault. `typecheck` passes at baseline and fails after — a genuine
    // regression. The old aggregate comparison (`before.status !== 'passed'`)
    // would have discarded the whole result because the baseline verdict was
    // `failed` overall; per-check comparison must keep the typecheck failure.
    const exec = async (command, args, options = {}) => {
      const line = [command, ...args].join(' ');
      const atAfter = (options.cwd ?? '').includes('aaaaaaa');
      const failing = line === 'npm run build' || (line === 'npm run typecheck' && atAfter);
      return {
        code: failing ? 1 : 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: failing ? `src/app.ts(3,11): error TS2554: ${line} broke` : '',
      };
    };

    const verification = await probeDependencyChange({ ...base, exec, fs });

    assert.equal(verification.status, 'failed');
    assert.equal(verification.checks.filter((c) => c.status === 'failed').length, 2, 'both are reported as red');
    assert.match(verification.diagnostics ?? '', /npm run typecheck/);
    assert.doesNotMatch(verification.diagnostics ?? '', /npm run build/, 'the pre-existing build failure is not blamed on this dependency');
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

  const passed = {
    status: 'passed' as const,
    checks: [
      {
        kind: 'typecheck' as const,
        label: 'tsc --noEmit',
        compileCapable: true,
        status: 'passed' as const,
        durationMs: 1,
        output: '',
      },
    ],
    failedFiles: [],
  };

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

  test('a passing test suite alone cannot clear a compiler-provable finding', () => {
    // Only `test` ran. A green suite proves nothing about a signature or an
    // export — that requires a typecheck or a build, neither of which ran
    // here — so nothing a compiler could have caught should be dropped.
    const testOnly = {
      status: 'passed' as const,
      checks: [{ kind: 'test' as const, label: 'npm test', status: 'passed' as const, durationMs: 1, output: '' }],
      failedFiles: [],
    };
    const verified = applyVerificationToPlan(plan(), testOnly);
    assert.equal(verified.breakingChanges.length, 2, 'nothing is dropped without a compile-capable check passing');
  });

  test('a green "check" script that is actually a linter cannot clear a compiler-provable finding', () => {
    // `"check": "eslint ."` lands in the `typecheck` kind by name — SCRIPT_NAMES
    // matches the property name, not what it runs — but eslint never sees a
    // signature or an export. Only `compileCapable` (computed from the actual
    // command, not the kind bucket) may license clearing a finding.
    const lintNamedCheck = {
      status: 'passed' as const,
      checks: [
        { kind: 'typecheck' as const, label: 'npm run check', compileCapable: false, status: 'passed' as const, durationMs: 1, output: '' },
      ],
      failedFiles: [],
    };
    const verified = applyVerificationToPlan(plan(), lintNamedCheck);
    assert.equal(verified.breakingChanges.length, 2, 'a passing lint cannot disprove a signature or export change');
  });

  test('a batch pass over several upgrades together does not clear any one of their predictions', () => {
    // Dependencies can compensate for each other, so a green run over a whole
    // group only proves the group is safe together — not that this candidate
    // is safe alone. `measuredWith > 1` must not license pruning even though
    // the check that ran is compiler-capable.
    const batch = { ...passed, measuredWith: 3 };
    const verified = applyVerificationToPlan(plan(), batch);
    assert.equal(verified.breakingChanges.length, 2, 'nothing is pruned on the strength of a batched pass');
    assert.equal(verified.verification, batch, 'the batch result is still recorded');
  });

  test('verification is only applied within the workspace it actually checked', () => {
    const twoWorkspaces = {
      ...plan(),
      breakingChanges: [
        { ...change('web-export-removed', 'removed-export'), workspace: 'packages/web' },
        { ...change('api-export-removed', 'removed-export'), workspace: 'packages/api' },
      ],
    };
    // Both findings are compiler-provable, but only `packages/web` was
    // actually installed and checked. A green result for it must not clear
    // the finding that lives in `packages/api`, which this pass never
    // touched.
    const verified = applyVerificationToPlan(twoWorkspaces, passed, 'packages/web');
    assert.deepEqual(
      verified.breakingChanges.map((c) => c.id),
      ['api-export-removed'],
      'only the finding in the verified workspace is cleared',
    );
  });
});

describe('one verdict for a plan built from several', () => {
  const passed = (label: string) => ({
    status: 'passed' as const,
    checks: [{ kind: 'typecheck' as const, label, status: 'passed' as const, durationMs: 1, output: '' }],
    failedFiles: [],
  });
  const failed = {
    status: 'failed' as const,
    checks: [{ kind: 'typecheck' as const, label: 'tsc', status: 'failed' as const, durationMs: 1, output: 'boom' }],
    diagnostics: 'src/a.ts(1,1): error TS2554',
    failedFiles: ['src/a.ts'],
  };
  const skipped = { status: 'skipped' as const, reason: 'No checks to run.', checks: [], failedFiles: [] };

  test('all passed is passed, and the checks that proved it are kept', () => {
    const combined = combineVerifications([passed('tsc'), passed('build')]);
    assert.equal(combined?.status, 'passed');
    assert.equal(combined?.checks.length, 2);
  });

  test('any failure condemns the whole plan and carries its output', () => {
    const combined = combineVerifications([passed('tsc'), failed]);
    assert.equal(combined?.status, 'failed');
    assert.deepEqual(combined?.failedFiles, ['src/a.ts']);
    assert.match(combined?.diagnostics ?? '', /TS2554/);
  });

  test('a part nobody measured makes the whole plan unmeasured, with the reason', () => {
    const combined = combineVerifications([passed('tsc'), skipped]);
    assert.equal(combined?.status, 'skipped', 'half-verified is not verified');
    assert.match(combined?.reason ?? '', /No checks to run\./);
  });

  test('a missing verification counts as unmeasured, not as a pass', () => {
    // The bug this exists for: a plan assembled from candidates dropped
    // verification entirely, so a scan that had measured an upgrade reached the
    // fix stage looking like one that had never run a check.
    const combined = combineVerifications([passed('tsc'), undefined]);
    assert.equal(combined?.status, 'skipped');
  });

  test('nothing measured anywhere stays undefined, so nothing claims otherwise', () => {
    assert.equal(combineVerifications([undefined, undefined]), undefined);
    assert.equal(combineVerifications([]), undefined);
  });
});
