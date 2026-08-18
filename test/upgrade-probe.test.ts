import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeUpgrades, probeDependencyChange, filesNamedIn, warmProbe } from '../dist/verification/upgrade-probe.js';
import { clearToolAvailability } from '../dist/verification/tool-availability.js';
import { applyVerificationToPlan, combineVerifications, describeVerification } from '../dist/verification/apply.js';
import { applyVerification } from '../dist/upgrade/verification.js';
import { severityOf, describeSeverity } from '../dist/upgrade/severity.js';

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

const cargoTarget = (name: string) => ({
  id: `t-${name}`,
  name,
  current: '1.0.0',
  selected: '2.0.0',
  manifestPath: 'Cargo.toml',
  packageManager: 'cargo' as const,
  install: async () => {},
});

const composerTarget = (name: string, install?: (checkout: string) => void) => ({
  id: `t-${name}`,
  name,
  current: '1.0.0',
  selected: '2.0.0',
  manifestPath: 'composer.json',
  packageManager: 'composer' as const,
  install: async (checkout: string) => {
    install?.(checkout);
  },
});

describe('not building a test checkout nothing could be run in', () => {
  /**
   * The probe's most expensive step is the one that can be skipped on the
   * strength of `PATH` alone. Answers are memoised for the process, so every
   * test here starts from a clean slate.
   */
  const withoutTool = (missing: string) => {
    const calls: string[] = [];
    const exec = async (command: string, args: readonly string[]) => {
      calls.push([command, ...args].join(' '));
      if (command === missing) {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };
    return { calls, exec };
  };

  test('a missing check tool skips the group without checking anything out', async () => {
    clearToolAvailability();
    const { calls, exec } = withoutTool('npm');
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });

    const verification = results.get('t-zod');
    assert.equal(verification?.status, 'skipped');
    // The point of the whole exercise: no worktree, no install, no checks.
    assert.ok(!calls.some((line) => line.startsWith('git worktree add')));
    assert.ok(!calls.some((line) => line === 'npm install'));
  });

  test('a missing host toolchain still skips a Cargo project before checkout', async () => {
    clearToolAvailability();
    const { calls, exec } = withoutTool('cargo');
    const cargoFs = {
      readFile: async () => '[package]\nname = "app"\nversion = "0.1.0"\n',
      readDirectory: async () => ['Cargo.toml', 'Cargo.lock'],
      isDirectory: async () => true,
    };

    const results = await probeUpgrades({ root, targets: [cargoTarget('serde')], exec, fs: cargoFs });

    assert.equal(results.get('t-serde')?.status, 'skipped');
    assert.match(results.get('t-serde')?.reason ?? '', /`cargo` is not installed/);
    assert.ok(!calls.some((line) => line.startsWith('git worktree add')));
    assert.ok(!calls.some((line) => line === 'cargo check'));
  });

  test('the reason names the tool, rather than describing a baseline nobody could run', async () => {
    clearToolAvailability();
    const { exec } = withoutTool('npm');
    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });

    assert.match(results.get('t-zod')?.reason ?? '', /`npm` is not installed/);
  });

  test('one probe per tool, however many members ask about it', async () => {
    clearToolAvailability();
    const { calls, exec } = withoutTool('npm');
    await probeUpgrades({ root, targets: [target('zod'), target('semver'), target('yaml')], exec, fs });

    assert.equal(calls.filter((line) => line === 'npm --version').length, 1);
  });

  test('a tool that answers a bare --version with a usage error still counts as present', async () => {
    clearToolAvailability();
    // `go version` is the real spelling; `go --version` exits non-zero. Reading
    // the exit code rather than ENOENT would skip verification on a machine
    // with a perfectly good toolchain.
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      if (line === 'npm --version') return { code: 2, stdout: '', stderr: 'unknown flag' };
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });
    assert.equal(results.get('t-zod')?.status, 'passed');
  });

  test('tool availability is keyed by PATH so one scan cannot poison the next', async () => {
    clearToolAvailability();
    const calls: string[] = [];
    const exec = async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
      const line = [command, ...args].join(' ');
      calls.push(`${line} PATH=${options.env?.PATH ?? ''}`);
      if (line === 'npm --version' && options.env?.PATH === '/missing') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const first = await probeUpgrades({ root, targets: [target('zod')], exec, fs, env: { PATH: '/missing' } });
    const second = await probeUpgrades({ root, targets: [target('react')], exec, fs, env: { PATH: '/present' } });

    assert.equal(first.get('t-zod')?.status, 'skipped');
    assert.equal(second.get('t-react')?.status, 'passed');
    assert.equal(calls.filter((line) => line.startsWith('npm --version')).length, 2);
    assert.ok(calls.some((line) => line === 'npm --version PATH=/missing'));
    assert.ok(calls.some((line) => line === 'npm --version PATH=/present'));
  });

  test('a negative tool result is rechecked on a later scan even when PATH is unchanged', async () => {
    clearToolAvailability();
    let npmAvailable = false;
    const calls: string[] = [];
    const env = { PATH: '/usr/local/bin' };
    const exec = async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
      const line = [command, ...args].join(' ');
      calls.push(`${line} PATH=${options.env?.PATH ?? ''}`);
      if (line === 'npm --version' && !npmAvailable) {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const first = await probeUpgrades({ root, targets: [target('zod')], exec, fs, env });
    npmAvailable = true;
    const second = await probeUpgrades({ root, targets: [target('react')], exec, fs, env });

    assert.equal(first.get('t-zod')?.status, 'skipped');
    assert.equal(second.get('t-react')?.status, 'passed');
    assert.equal(
      calls.filter((line) => line === 'npm --version PATH=/usr/local/bin').length,
      2,
      'the second scan probes again instead of reusing the stale negative',
    );
  });

  test('a positive tool result is rechecked on a later scan even when PATH is unchanged', async () => {
    clearToolAvailability();
    let npmAvailable = true;
    const calls: string[] = [];
    const env = { PATH: '/usr/local/bin' };
    const exec = async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
      const line = [command, ...args].join(' ');
      calls.push(`${line} PATH=${options.env?.PATH ?? ''}`);
      if (line === 'npm --version' && !npmAvailable) {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const first = await probeUpgrades({ root, targets: [target('zod')], exec, fs, env });
    npmAvailable = false;
    const second = await probeUpgrades({ root, targets: [target('react')], exec, fs, env });

    assert.equal(first.get('t-zod')?.status, 'passed');
    assert.equal(second.get('t-react')?.status, 'skipped');
    assert.match(second.get('t-react')?.reason ?? '', /`npm` is not installed/);
    assert.equal(
      calls.filter((line) => line === 'npm --version PATH=/usr/local/bin').length,
      2,
      'the second scan probes again instead of reusing the stale positive',
    );
  });

  test('probe errors fail open and let verification run', async () => {
    clearToolAvailability();
    const calls: string[] = [];
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (line === 'npm --version') throw new Error('spawn EACCES');
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs });

    assert.equal(results.get('t-zod')?.status, 'passed');
    assert.ok(calls.some((line) => line.startsWith('git worktree add')));
    assert.ok(calls.includes('npm run typecheck'));
  });

  test('a cached baseline cannot resurrect a check whose host tool is now missing', async () => {
    clearToolAvailability();
    let upgradeInstalled = false;
    let cacheRead = false;
    const calls: string[] = [];
    const pythonFs = {
      readFile: async () => '[project]\ndependencies = ["mypy", "pytest"]\n',
      readDirectory: async () => ['pyproject.toml'],
      isDirectory: async () => true,
    };
    const cachedGreenBaseline = {
      read: async () => {
        cacheRead = true;
        return [
          { kind: 'typecheck' as const, label: 'mypy .', compileCapable: true, status: 'passed' as const },
          { kind: 'test' as const, label: 'pytest', compileCapable: false, status: 'passed' as const },
        ];
      },
      write: async () => {
        throw new Error('cached baseline should not be rewritten');
      },
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (line === 'pytest --version') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      if (line === 'pytest') {
        return { code: 127, stdout: '', stderr: 'pytest: command not found' };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };
    const pyTarget = {
      id: 't-httpx',
      name: 'httpx',
      current: '1.0.0',
      selected: '2.0.0',
      manifestPath: 'pyproject.toml',
      packageManager: 'pip' as const,
      install: async () => {
        upgradeInstalled = true;
      },
    };

    const results = await probeUpgrades({
      root,
      targets: [pyTarget],
      exec,
      fs: pythonFs,
      baselineCache: cachedGreenBaseline,
    });

    const verification = results.get('t-httpx');
    assert.equal(cacheRead, true);
    assert.equal(upgradeInstalled, true);
    assert.equal(verification?.status, 'passed');
    assert.deepEqual(verification?.checks.map((check) => check.label), ['mypy .']);
    assert.equal(calls.filter((line) => line === 'mypy .').length, 1);
    assert.ok(!calls.includes('pytest'), 'the stale cached pytest pass must not make pytest runnable today');
  });

  test('a committed-only check is availability-tested before cached baseline can use it', async () => {
    clearToolAvailability();
    let upgradeInstalled = false;
    let cacheRead = false;
    const calls: string[] = [];
    const splitFs = {
      readFile: async (path: string) =>
        path.includes('drift-worktrees')
          ? '[project]\ndependencies = ["mypy", "pytest"]\n'
          : '[project]\ndependencies = ["mypy"]\n',
      readDirectory: async () => ['pyproject.toml'],
      isDirectory: async () => true,
    };
    const cachedGreenBaseline = {
      read: async () => {
        cacheRead = true;
        return [
          { kind: 'typecheck' as const, label: 'mypy .', compileCapable: true, status: 'passed' as const },
          { kind: 'test' as const, label: 'pytest', compileCapable: false, status: 'passed' as const },
        ];
      },
      write: async () => {
        throw new Error('cached baseline should not be rewritten');
      },
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (line === 'pytest --version') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      if (line === 'pytest') {
        throw new Error('pytest must not run');
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };
    const pyTarget = {
      id: 't-httpx',
      name: 'httpx',
      current: '1.0.0',
      selected: '2.0.0',
      manifestPath: 'pyproject.toml',
      packageManager: 'pip' as const,
      install: async () => {
        upgradeInstalled = true;
      },
    };

    const results = await probeUpgrades({
      root,
      targets: [pyTarget],
      exec,
      fs: splitFs,
      baselineCache: cachedGreenBaseline,
    });

    const verification = results.get('t-httpx');
    assert.equal(cacheRead, true);
    assert.equal(upgradeInstalled, true);
    assert.equal(verification?.status, 'passed');
    assert.ok(calls.some((line) => line.startsWith('git worktree add')), 'early preflight must not skip the worktree');
    assert.ok(calls.includes('pytest --version'), 'the committed-only check is probed after worktree detection');
    assert.deepEqual(verification?.checks.map((check) => check.label), ['mypy .']);
    assert.equal(calls.filter((line) => line === 'mypy .').length, 1, 'the available check still judges the upgrade');
    assert.ok(!calls.includes('pytest'), 'the unavailable committed-only check never runs');
  });

  test('an open-checkout-only check cannot change committed worktree verification', async () => {
    clearToolAvailability();
    const calls: string[] = [];
    const splitFs = {
      readFile: async (path: string) =>
        path.includes('drift-worktrees')
          ? '[project]\ndependencies = ["mypy"]\n'
          : '[project]\ndependencies = ["pytest"]\n',
      readDirectory: async () => ['pyproject.toml'],
      isDirectory: async () => true,
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (line === 'pytest --version') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      if (line === 'pytest') {
        throw new Error('open-checkout-only pytest must not run');
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };
    const pyTarget = {
      id: 't-httpx',
      name: 'httpx',
      current: '1.0.0',
      selected: '2.0.0',
      manifestPath: 'pyproject.toml',
      packageManager: 'pip' as const,
      install: async () => {},
    };

    const results = await probeUpgrades({ root, targets: [pyTarget], exec, fs: splitFs });

    const verification = results.get('t-httpx');
    assert.equal(verification?.status, 'passed');
    assert.ok(calls.some((line) => line.startsWith('git worktree add')));
    assert.ok(!calls.includes('pytest --version'), 'the open-only missing check is not authoritative');
    assert.deepEqual(verification?.checks.map((check) => check.label), ['mypy .']);
  });

  test('all currently unavailable authoritative checks skip instead of passing from cache', async () => {
    clearToolAvailability();
    let upgradeInstalled = false;
    const calls: string[] = [];
    const pythonFs = {
      readFile: async () => '[project]\ndependencies = ["pytest"]\n',
      readDirectory: async () => ['pyproject.toml'],
      isDirectory: async () => true,
    };
    const cachedGreenBaseline = {
      read: async () => [{ kind: 'test' as const, label: 'pytest', compileCapable: false, status: 'passed' as const }],
      write: async () => {
        throw new Error('cached baseline should not be rewritten');
      },
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (line === 'pytest --version') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };
    const pyTarget = {
      id: 't-httpx',
      name: 'httpx',
      current: '1.0.0',
      selected: '2.0.0',
      manifestPath: 'pyproject.toml',
      packageManager: 'pip' as const,
      install: async () => {
        upgradeInstalled = true;
      },
    };

    const results = await probeUpgrades({
      root,
      targets: [pyTarget],
      exec,
      fs: pythonFs,
      baselineCache: cachedGreenBaseline,
    });

    const verification = results.get('t-httpx');
    assert.equal(verification?.status, 'skipped');
    assert.match(verification?.reason ?? '', /`pytest` is not installed/);
    assert.equal(upgradeInstalled, false, 'no upgrade is installed when no authoritative checks can run');
    assert.ok(!calls.includes('pytest'), 'the cached green baseline cannot make pytest run');
  });

  test('a Composer vendor binary missing before install does not skip the checkout', async () => {
    clearToolAvailability();
    let dependenciesInstalled = false;
    let upgradeInstalled = false;
    const calls: string[] = [];
    const composerFs = {
      readFile: async () => JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^10' } }),
      readDirectory: async () => ['composer.json', 'composer.lock'],
      isDirectory: async () => true,
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (line === 'vendor/bin/phpunit --version') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      if (line === 'composer install') dependenciesInstalled = true;
      if (line === 'vendor/bin/phpunit' && !dependenciesInstalled) {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const results = await probeUpgrades({
      root,
      targets: [composerTarget('symfony/console', () => { upgradeInstalled = true; })],
      exec,
      fs: composerFs,
    });

    assert.equal(results.get('t-symfony/console')?.status, 'passed');
    assert.ok(calls.some((line) => line.startsWith('git worktree add')));
    assert.ok(calls.includes('composer install'));
    assert.ok(!calls.includes('vendor/bin/phpunit --version'));
    assert.equal(calls.filter((line) => line === 'vendor/bin/phpunit').length, 2);
    assert.equal(upgradeInstalled, true);
  });

  test('a Composer project still skips safely when composer itself is missing', async () => {
    clearToolAvailability();
    const calls: string[] = [];
    const composerFs = {
      readFile: async () => JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^10' } }),
      readDirectory: async () => ['composer.json', 'composer.lock'],
      isDirectory: async () => true,
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (command === 'composer') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const results = await probeUpgrades({ root, targets: [composerTarget('symfony/console')], exec, fs: composerFs });

    assert.equal(results.get('t-symfony/console')?.status, 'skipped');
    assert.match(results.get('t-symfony/console')?.reason ?? '', /`composer` is not installed/);
    assert.ok(!calls.some((line) => line.startsWith('git worktree add')));
    assert.ok(!calls.includes('composer install'));
    assert.ok(!calls.includes('vendor/bin/phpunit'));
  });
});

describe('probing an upgrade before reporting it', () => {
  test('a present toolchain is probed once and then left alone', async () => {
    clearToolAvailability();
    const { exec, lines } = recorder();
    await probeUpgrades({ root, targets: [target('zod')], exec, fs });
    assert.equal(lines().filter((line) => line === 'npm --version').length, 1);
  });

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

  test('a check executable disappearing during upgrade verification is indeterminate, not breakage', async () => {
    clearToolAvailability();
    let typecheckRuns = 0;
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      if (line === 'npm run typecheck') {
        typecheckRuns += 1;
        if (typecheckRuns > 1) {
          return { code: 1, stdout: '', stderr: 'npm: command not found', failure: 'not-found' as const };
        }
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };

    const results = await probeUpgrades({
      root,
      targets: [target('zod')],
      exec,
      fs: {
        readFile: async () => JSON.stringify({ name: 'app', scripts: { typecheck: 'tsc --noEmit' } }),
        readDirectory: async () => ['package.json', 'package-lock.json'],
        isDirectory: async () => true,
      },
    });

    const verification = results.get('t-zod');
    assert.equal(verification?.status, 'skipped');
    assert.match(verification?.reason ?? '', /`npm` was not found on PATH/);
    assert.equal(verification?.diagnostics, undefined);
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
    // Disposal deletes the directory and then prunes the registration; `git
    // worktree remove` is only the fallback for a delete that failed. Here git
    // is faked and no directory exists, so the prune is the observable half —
    // that the *directory* goes is asserted against a real filesystem in
    // `worktree.test.ts`.
    const pruned = lines().filter((line) => line === 'git worktree prune');

    assert.equal(added.length, 1, 'one worktree for three candidates sharing package.json');
    assert.ok(pruned.length >= 1, 'the worktree is disposed of when the group finishes');
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
describe('installing a batch, and giving up on it early', () => {
  test('the whole batch is applied in one package-manager run when the manager can', async () => {
    const { exec, lines } = recorder();
    const batches: string[][] = [];
    const perTarget: string[] = [];

    const targets = ['zod', 'react', 'vite'].map((name) => ({
      ...target(name),
      install: async () => {
        perTarget.push(name);
      },
    }));

    await probeUpgrades({
      root,
      targets,
      exec,
      fs,
      installTogether: async (_checkout, group) => {
        batches.push(group.map((t) => t.name));
        return true;
      },
    });

    assert.deepEqual(batches, [['zod', 'react', 'vite']], 'one call, carrying all three');
    assert.deepEqual(perTarget, [], 'nothing was installed one at a time');
    assert.ok(lines().length > 0);
  });

  test('a manager that declines falls back to one install per target', async () => {
    const { exec } = recorder();
    const perTarget: string[] = [];

    const targets = ['zod', 'react'].map((name) => ({
      ...target(name),
      install: async () => {
        perTarget.push(name);
      },
    }));

    await probeUpgrades({ root, targets, exec, fs, installTogether: async () => false });

    assert.deepEqual(perTarget, ['zod', 'react']);
  });

  test('the one-at-a-time pass never goes through the batch install', async () => {
    // The batch is red, so each candidate is re-measured alone — and a verdict
    // about one package has to be measured with that package as the only thing
    // that moved, whatever the batch path is capable of.
    let installed = '';
    const targets = ['zod', 'react'].map((name) => ({
      ...target(name),
      install: async () => {
        installed = installed ? `${installed}+${name}` : name;
      },
    }));

    const sizes: number[] = [];
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      if (command === 'git' && args[0] === 'checkout') installed = '';
      const broken = line === 'npm run typecheck' && installed.includes('react');
      return {
        code: broken ? 1 : 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: broken ? 'error TS2554' : '',
      };
    };

    const results = await probeUpgrades({
      root,
      targets,
      exec,
      fs,
      installTogether: async (_checkout, group) => {
        sizes.push(group.length);
        installed = group.map((t) => t.name).join('+');
        return true;
      },
    });

    assert.deepEqual(sizes, [2], 'the batch install is only ever used for the combined pass');
    assert.equal(results.get('t-react')?.status, 'failed');
    assert.equal(results.get('t-zod')?.status, 'passed');
  });

  test('a failing batch stops at the first red check instead of running the rest', async () => {
    // The combined pass is a search: it asks whether this batch is clean, and
    // a red typecheck has answered. Running the build and the suite behind it
    // costs minutes and produces diagnostics nobody reports.
    const ran: string[] = [];
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      if (line.startsWith('npm run')) ran.push(line);
      return {
        code: line === 'npm run typecheck' && ran.filter((l) => l === 'npm run typecheck').length > 1 ? 1 : 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: '',
      };
    };

    await probeUpgrades({
      root,
      targets: [target('zod'), target('react'), target('vite'), target('svelte'), target('esbuild')],
      exec,
      fs,
    });

    // Baseline runs both checks. The combined pass then fails its typecheck,
    // and must not go on to the build.
    const typechecks = ran.filter((line) => line === 'npm run typecheck').length;
    const builds = ran.filter((line) => line === 'npm run build').length;
    assert.ok(typechecks > builds, 'a red combined pass skipped the build behind it');
  });

  test('a candidate measured on its own still runs every check, red or not', async () => {
    // Red only once the upgrade is in, so the baseline keeps both checks
    // usable and the failure is attributable to the candidate.
    let installed = false;
    const zod = {
      ...target('zod'),
      install: async () => {
        installed = true;
      },
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      const broken = installed && line === 'npm run typecheck';
      return {
        code: broken ? 1 : 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: broken ? 'error TS2554' : '',
      };
    };

    const results = await probeUpgrades({ root, targets: [zod], exec, fs });

    assert.deepEqual(
      results.get('t-zod')?.checks.map((check) => check.label),
      ['npm run typecheck', 'npm run build'],
      'the verdict a developer reads is the whole picture, not the first failure',
    );
  });

  test('batch and solo fallback both use the same authoritative usable checks', async () => {
    clearToolAvailability();
    const calls: string[] = [];
    const pythonFs = {
      readFile: async () => '[project]\ndependencies = ["mypy", "pytest"]\n',
      readDirectory: async () => ['pyproject.toml'],
      isDirectory: async () => true,
    };
    let installed: string[] = [];
    const candidate = (name: string) => ({
      id: `t-${name}`,
      name,
      current: '1.0.0',
      selected: '2.0.0',
      manifestPath: 'pyproject.toml',
      packageManager: 'pip' as const,
      install: async () => {
        installed.push(name);
      },
    });
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (command === 'git' && args[0] === 'checkout') installed = [];
      if (line === 'pytest --version') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      const broken = line === 'mypy .' && installed.includes('react');
      return {
        code: broken ? 1 : 0,
        stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '',
        stderr: broken ? 'src/app.py:3: error: incompatible type' : '',
      };
    };

    const results = await probeUpgrades({ root, targets: [candidate('zod'), candidate('react')], exec, fs: pythonFs });

    assert.equal(results.get('t-zod')?.status, 'passed');
    assert.equal(results.get('t-react')?.status, 'failed');
    assert.ok(!calls.includes('pytest'), 'neither batch nor solo fallback runs the unavailable check');
    assert.ok(calls.includes('pytest --version'), 'the unavailable check was still tested for availability');
    assert.ok(calls.filter((line) => line === 'mypy .').length > 2, 'mypy is used in baseline, batch, and solo fallback');
  });
});

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
    const pruned = calls.filter((c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'prune');
    assert.equal(added.length, 1, 'the warmup did prepare one');
    // One prune before the add (clearing an interrupted run's leftovers) and one
    // after the dispose. Two is the shape of "prepared, then thrown away".
    assert.ok(pruned.length >= 2, 'the abandoned worktree was disposed of');
  });

  test('a warmup whose install fails settles its packages with the reason, not a crash', async () => {
    const { exec } = recorder({ 'npm install': 1 });
    const warm = warmProbe({ root, targets: [], exec, fs }, [{ dir: '', packageManager: 'npm' }]);

    const results = await probeUpgrades({ root, targets: [target('zod')], exec, fs, warm });
    await warm.dispose();

    assert.equal(results.get('t-zod')?.status, 'skipped');
    assert.match(results.get('t-zod')?.reason ?? '', /npm install/);
  });

  test('a warmed checkout filters cached baselines through current authoritative availability', async () => {
    clearToolAvailability();
    const calls: string[] = [];
    const pythonFs = {
      readFile: async () => '[project]\ndependencies = ["mypy", "pytest"]\n',
      readDirectory: async () => ['pyproject.toml'],
      isDirectory: async () => true,
    };
    const cachedGreenBaseline = {
      read: async () => [
        { kind: 'typecheck' as const, label: 'mypy .', compileCapable: true, status: 'passed' as const },
        { kind: 'test' as const, label: 'pytest', compileCapable: false, status: 'passed' as const },
      ],
      write: async () => {
        throw new Error('cached baseline should not be rewritten');
      },
    };
    const exec = async (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      if (line === 'pytest --version') {
        return { code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const };
      }
      if (line === 'pytest') {
        throw new Error('warmed cached baseline must not resurrect pytest');
      }
      return { code: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? '.git' : '', stderr: '' };
    };
    const pyTarget = {
      id: 't-httpx',
      name: 'httpx',
      current: '1.0.0',
      selected: '2.0.0',
      manifestPath: 'pyproject.toml',
      packageManager: 'pip' as const,
      install: async () => {},
    };

    const warm = warmProbe({ root, targets: [], exec, fs: pythonFs, baselineCache: cachedGreenBaseline }, [
      { dir: '', packageManager: 'pip' },
    ]);
    const results = await probeUpgrades({ root, targets: [pyTarget], exec, fs: pythonFs, warm });
    await warm.dispose();

    assert.equal(results.get('t-httpx')?.status, 'passed');
    assert.deepEqual(results.get('t-httpx')?.checks.map((check) => check.label), ['mypy .']);
    assert.ok(calls.includes('pytest --version'));
    assert.ok(!calls.includes('pytest'));
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
    upstreamBreakingCount: 2,
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

  test('upstreamBreakingCount is untouched by pruning, whether or not anything was cleared', () => {
    // Same commit, two verification runs: one measured this package alone
    // (clears the compiler-provable finding), one measured it batched with
    // others (clears nothing). What upstream actually published must read the
    // same either way.
    const solo = applyVerificationToPlan(plan(), passed);
    const batch = applyVerificationToPlan(plan(), { ...passed, measuredWith: 3 });

    assert.equal(solo.breakingChanges.length, 1, 'the solo pass did prune a finding');
    assert.equal(batch.breakingChanges.length, 2, 'the batch pass pruned nothing');
    assert.equal(solo.upstreamBreakingCount, 2, 'upstream count is unaffected by the prune');
    assert.equal(batch.upstreamBreakingCount, 2, 'upstream count agrees with the solo run');
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

describe('what a measurement does to a candidate row', () => {
  const change = (id) => ({
    id,
    dependency: 'zod',
    kind: 'signature-change',
    summary: `${id} changed`,
    symbols: [id],
    confidence: 0.9,
    citations: [],
  });

  const planWithTwoUpstreamChanges = () => ({
    schemaVersion: 1,
    id: 'plan-1',
    branchName: 'drift/zod',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [],
    evidence: [],
    breakingChanges: [change('a'), change('b')],
    upstreamBreakingCount: 2,
    impactSites: [],
    commits: [],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'medium',
    gaps: [],
    checkedSurfaces: [],
    blockers: [],
    warnings: [],
    createdAt: new Date().toISOString(),
  });

  const candidate = () => ({
    id: 'zod',
    name: 'zod',
    kind: 'production',
    ecosystem: 'npm',
    packageManager: 'npm',
    manifestPath: 'package.json',
    current: '2.0.0',
    range: '^2.0.0',
    selected: '3.0.0',
    latest: '3.0.0',
    versions: [],
    status: 'ready',
    evidenceCount: 1,
    breakingCount: 2,
    impactCount: 0,
    impactFiles: 0,
    impactConfidence: 'none',
    risk: 'medium',
    summary: '2 breaking changes',
    gaps: [],
    toolRequests: [],
    plan: planWithTwoUpstreamChanges(),
  });

  const compileCapablePass = {
    status: 'passed',
    checks: [
      { kind: 'typecheck', label: 'tsc --noEmit', compileCapable: true, status: 'passed', durationMs: 1, output: '' },
    ],
    failedFiles: [],
  };

  test('the same commit reports the same upstream count whether probed alone or batched', () => {
    // The exact regression this guards: a manifest with an unrelated package
    // failing to install sends verification down the batch fallback path on
    // one run and the solo path on another. Both must show the developer the
    // same "N upstream changes" — only whether that N shrank via a cleared
    // plan should differ, never the headline number.
    const solo = applyVerification(candidate(), compileCapablePass);
    const batch = applyVerification(candidate(), { ...compileCapablePass, measuredWith: 4 });

    assert.equal(solo.plan.breakingChanges.length, 0, 'solo pass cleared both compiler-provable findings');
    assert.equal(batch.plan.breakingChanges.length, 2, 'batch pass cleared nothing');
    assert.equal(solo.breakingCount, 2, 'upstream count is reported, not the post-prune remainder');
    assert.equal(batch.breakingCount, 2, 'and it agrees with the solo run');
  });

  // The deeper case: a compiler-provable breaking change with one localized
  // impact site. Static analysis alone calls this `affected`. A batch pass
  // cannot license clearing it (batch-mates can compensate for each other), so
  // it stays `affected` — but an isolated pass can, and does. Two runs of the
  // same commit must not read as Drift flatly contradicting itself; the scope
  // of what was actually measured has to be visible in the verdict.
  const oneImpactedFinding = () => ({
    id: 'zod',
    name: 'zod',
    kind: 'production',
    ecosystem: 'npm',
    packageManager: 'npm',
    manifestPath: 'package.json',
    current: '2.0.0',
    range: '^2.0.0',
    selected: '3.0.0',
    latest: '3.0.0',
    versions: [],
    status: 'ready',
    evidenceCount: 1,
    breakingCount: 1,
    impactCount: 1,
    impactFiles: 1,
    impactConfidence: 'high',
    risk: 'medium',
    summary: '1 breaking change',
    gaps: [],
    toolRequests: [],
    plan: {
      schemaVersion: 1,
      id: 'plan-2',
      branchName: 'drift/zod',
      baseBranch: 'main',
      headSha: 'abc',
      changes: [],
      evidence: [],
      breakingChanges: [change('signature-changed')],
      upstreamBreakingCount: 1,
      impactSites: [{ id: 's1', breakingChangeId: 'signature-changed', file: 'src/a.ts', line: 1 }],
      commits: [{ id: 'c1', breakingChangeIds: ['signature-changed'], dependsOn: [], dependencyReasons: [] }],
      planEdges: [],
      upgradeCohorts: [],
      risk: 'medium',
      gaps: [],
      checkedSurfaces: [],
      blockers: [],
      warnings: [],
      createdAt: new Date().toISOString(),
    },
  });

  test('a green batch and a green isolated pass agree on everything except what was actually cleared', () => {
    const batch = applyVerification(oneImpactedFinding(), { ...compileCapablePass, measuredWith: 5 });
    const isolated = applyVerification(oneImpactedFinding(), compileCapablePass);

    assert.equal(batch.plan.upstreamBreakingCount, 1, 'upstream count is untouched by batch scope');
    assert.equal(isolated.plan.upstreamBreakingCount, 1, 'and by isolated scope, agreeing with the batch run');

    // The batch never clears the finding — the existing, conservative rule.
    assert.equal(batch.impactCount, 1, 'a batch pass cannot prove this package is safe alone');
    assert.equal(severityOf(batch), 'affected', 'so the site is still reported as affecting the repository');
    assert.match(
      describeSeverity(batch),
      /not yet confirmed alone/,
      'and the verdict says why, instead of reading as a plain, checked "affects"',
    );

    // The isolated pass can, and does.
    assert.equal(isolated.impactCount, 0, 'an isolated compile-capable pass disproves the compiler-provable finding');
    assert.equal(severityOf(isolated), 'upstream-only', 'so the row is reported safe');
    assert.doesNotMatch(
      describeSeverity(isolated),
      /not yet confirmed alone/,
      'a genuinely cleared finding carries no such hedge',
    );
  });

  test('an isolated pass that leaves a finding uncleared for its own reasons is not hedged as "batch-only"', () => {
    // A behavioural change is invisible to a compiler — even an isolated,
    // compile-capable pass cannot clear it, and correctly does not. That
    // absence of clearance is not the batch-scope gap the hedge exists to
    // flag, and mislabeling it as "not yet confirmed alone" would suggest an
    // isolated re-run could fix what a compiler fundamentally cannot see.
    const behavioural = {
      ...oneImpactedFinding(),
      plan: {
        ...oneImpactedFinding().plan,
        breakingChanges: [{ ...change('default-changed'), kind: 'behaviour-change' }],
        impactSites: [{ id: 's1', breakingChangeId: 'default-changed', file: 'src/a.ts', line: 1 }],
      },
    };
    const isolated = applyVerification(behavioural, compileCapablePass);

    assert.equal(isolated.impactCount, 1, 'a compiler cannot clear a behavioural finding, isolated or not');
    assert.equal(severityOf(isolated), 'affected');
    assert.doesNotMatch(
      describeSeverity(isolated),
      /not yet confirmed alone/,
      'this was already given its isolated check and stood by the finding — no batch gap to name',
    );
  });

  test('a genuinely failing isolated probe is still reported as measured breakage, never hedged', () => {
    const failing = {
      status: 'failed',
      checks: [{ kind: 'test', label: 'npm test', status: 'failed', durationMs: 1, output: 'boom' }],
      diagnostics: 'boom',
      failedFiles: [],
    };
    const failed = applyVerification(oneImpactedFinding(), failing);

    // A located impact site already outranks a failed verification in
    // `severityOf` (a static match is a stronger, more specific claim than an
    // aggregate check failure) — this test's job is only to confirm that a
    // real, isolated failure is never mistaken for the batch-scope gap the
    // hedge exists to name.
    assert.equal(severityOf(failed), 'affected');
    assert.equal(failed.impactPendingIsolatedClearance, false, 'nothing here was left unresolved by batch scope');
    assert.doesNotMatch(
      describeSeverity(failed),
      /not yet confirmed alone/,
      'real, measured breakage is never described as merely unconfirmed',
    );
  });

  test('the transient path — batch fails, falls back to solo — lands on the same verdict as a batch that never had to fall back', () => {
    // What actually varies between "a batch happened to succeed" and "a batch
    // happened to fail for an unrelated reason and this package was probed
    // alone" is the scope of the evidence gathered, and that has to be an
    // explicit, inspectable fact — not something a reader infers from which
    // of two contradictory-looking sentences they happened to see.
    const batchSucceeded = applyVerification(oneImpactedFinding(), { ...compileCapablePass, measuredWith: 3 });
    const fellBackToSolo = applyVerification(oneImpactedFinding(), compileCapablePass);

    assert.notEqual(
      severityOf(batchSucceeded),
      severityOf(fellBackToSolo),
      'the verdicts do differ — isolated evidence really is stronger',
    );
    // But the difference is explained, not silent: only the run that actually
    // measured this package alone claims the stronger verdict, and it is
    // named as such rather than looking like an arbitrary flip.
    assert.equal(batchSucceeded.impactPendingIsolatedClearance, true);
    assert.equal(fellBackToSolo.impactPendingIsolatedClearance, false);
    assert.equal(batchSucceeded.plan.upstreamBreakingCount, fellBackToSolo.plan.upstreamBreakingCount);
  });
});
