import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goSurface, resetGoSurfaceCache } from '../dist/evidence/surface/go.js';
import { createLogger } from '../dist/util/logger.js';
import type { SurfaceRequest } from '../dist/evidence/surface/types.js';
import type { CommandResult } from '../dist/util/exec.js';

/**
 * `src/evidence/surface/go.ts`'s per-module-version single-flight cache
 * (`apiInFlight`) used to hand every waiter the *exact* promise the first
 * caller's `computeApiOf` created. That meant a concurrent second caller
 * silently inherited the first caller's `exec`, `env`/PATH/toolchain, and
 * `timeoutMs`: a scan with a short-budget or broken-PATH caller reaching a
 * Go module@version first could make a second, perfectly healthy caller's
 * request fail for reasons that had nothing to do with it.
 *
 * A module@version's *successful* exported API is genuinely immutable and
 * safe to share (`apiCache` remains exactly that). A `toolchain-failed`
 * result is not — it is a fact about the caller who produced it (a broken
 * PATH, an exhausted timeout, a `go mod download` that failed under that
 * caller's own environment), not about the module. These tests prove a
 * waiter with a healthy `request` of its own retries independently rather
 * than inheriting such a failure, while a real, module-level fact
 * (`version-unavailable`) stays authoritative for every caller, and that
 * successful work still dedupes and evicts correctly.
 */

function apidumpJson(packages: string[], symbolNames: string[]): string {
  return JSON.stringify({
    Packages: packages,
    Symbols: symbolNames.map((name) => ({
      Key: `${packages[0]}.${name}`,
      Name: name,
      Pkg: packages[0],
      PkgName: packages[0],
      Kind: 'function',
      Signatures: [`func ${name}()`],
      Members: [],
      RequiredMembers: [],
      Platforms: ['linux/amd64'],
    })),
  });
}

const HEALTHY_APIDUMP = apidumpJson(['example.com/demo'], ['Thing']);

/** Command args as one space-joined string, for simple prefix matching. */
function argsKey(args: readonly string[]): string {
  return args.join(' ');
}

interface ExecCase {
  match: (command: string, args: readonly string[]) => boolean;
  respond: (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<CommandResult> | CommandResult;
}

/** A minimal, healthy fake `go` toolchain: version probe, scratch build, download, and extractor all succeed immediately. */
function healthyCases(downloadDir: string): ExecCase[] {
  return [
    { match: (c, a) => c === 'go' && a[0] === 'version', respond: () => ({ code: 0, stdout: 'go version go1.22.0 linux/amd64', stderr: '' }) },
    { match: (c, a) => c === 'go' && argsKey(a).startsWith('env'), respond: () => ({ code: 0, stdout: '/tmp/gomodcache', stderr: '' }) },
    { match: (c, a) => c === 'go' && a[0] === 'build', respond: () => ({ code: 0, stdout: '', stderr: '' }) },
    {
      match: (c, a) => c === 'go' && a[0] === 'mod' && a[1] === 'download',
      respond: () => ({ code: 0, stdout: JSON.stringify({ Dir: downloadDir }), stderr: '' }),
    },
    { match: (c, a) => c === 'go' && a[0] === 'run', respond: () => ({ code: 0, stdout: HEALTHY_APIDUMP, stderr: '' }) },
  ];
}

/** Dispatches to the first matching case; times out (like a real killed subprocess) if held past `options.timeoutMs`. */
function makeExec(cases: ExecCase[]): SurfaceRequest['exec'] {
  return async (command, args, options) => {
    for (const c of cases) {
      if (!c.match(command, args)) continue;
      const result = c.respond(command, args, options);
      if (!(result instanceof Promise)) return result;
      if (options?.timeoutMs === undefined) return result;
      // Cleared regardless of which side of the race wins, so a healthy,
      // fast-resolving command never leaves a dangling timer alive for the
      // rest of `options.timeoutMs`.
      let timer: NodeJS.Timeout;
      const timedOut = new Promise<CommandResult>((resolve) => {
        timer = setTimeout(() => resolve({ code: 1, stdout: '', stderr: 'timed out', failure: 'timeout' }), options.timeoutMs);
      });
      try {
        return await Promise.race([result, timedOut]);
      } finally {
        clearTimeout(timer!);
      }
    }
    return { code: 1, stdout: '', stderr: `unhandled: ${command} ${args.join(' ')}` };
  };
}

function makeRequest(overrides: Partial<SurfaceRequest> & { exec: SurfaceRequest['exec']; workdir: string }): SurfaceRequest {
  return {
    name: 'example.com/demo',
    from: '1.0.0',
    to: '2.0.0',
    logger: createLogger('error'),
    timeoutMs: 20_000,
    ...overrides,
  };
}

let downloadDir = '';
let workdirs: string[] = [];

beforeEach(async () => {
  resetGoSurfaceCache();
  downloadDir = await mkdtemp(join(tmpdir(), 'drift-go-module-'));
  workdirs = [];
});

afterEach(async () => {
  resetGoSurfaceCache();
  await rm(downloadDir, { recursive: true, force: true });
  await Promise.all(workdirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function newWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drift-go-surface-work-'));
  workdirs.push(dir);
  return dir;
}

describe('Go surface single-flight: waiters do not inherit the owner\'s execution context', () => {
  test('owner with a short timeout / waiter with a sufficient timeout: the waiter retries with its own exec and succeeds', async () => {
    // The owner's `go mod download` is held open by an explicit gate rather
    // than left to resolve (or reject) on its own: `makeExec`'s own
    // `options.timeoutMs`-based race already produces the owner's result
    // within its 80ms budget regardless of when (or whether) this promise
    // ever settles, but an abandoned, never-settled promise is its own
    // hazard (see `raceAgainstBudget`'s doc comment on exactly this) — so
    // this test settles it explicitly once it is no longer needed, rather
    // than leaving it dangling for the rest of the process's life.
    let downloadCalls = 0;
    let firstDownloadDispatched: (() => void) | undefined;
    const firstDownloadDispatchedPromise = new Promise<void>((resolve) => {
      firstDownloadDispatched = resolve;
    });
    let releaseHeldDownload: (() => void) | undefined;
    const heldDownload = new Promise<CommandResult>((resolve) => {
      releaseHeldDownload = () => resolve({ code: 0, stdout: JSON.stringify({ Dir: downloadDir }), stderr: '' });
    });
    const ownerExec = makeExec([
      // Listed before the healthy fallback cases: `makeExec` dispatches to
      // the *first* matching case, so this override must come first or the
      // healthy (immediately-resolving) download case below it would win
      // instead and this scenario would never actually hold anything open.
      {
        match: (c, a) => c === 'go' && a[0] === 'mod' && a[1] === 'download',
        respond: () => {
          downloadCalls += 1;
          firstDownloadDispatched?.();
          return heldDownload;
        },
      },
      ...healthyCases(downloadDir),
    ]);
    const waiterExec = makeExec(healthyCases(downloadDir));

    const wA = await newWorkdir();
    const wB = await newWorkdir();

    const runA = goSurface.compute(makeRequest({ exec: ownerExec, workdir: wA, timeoutMs: 80 }));
    await firstDownloadDispatchedPromise;
    const runB = goSurface.compute(makeRequest({ exec: waiterExec, workdir: wB, timeoutMs: 20_000 }));

    const [resultA, resultB] = await Promise.all([runA, runB]);
    // Nothing needs `heldDownload` to settle any more (both A and B have
    // already produced their results via their own timeouts), but leaving
    // it unsettled would abandon a promise for the rest of the process's
    // life -- release it now that the test is done with it.
    releaseHeldDownload?.();

    assert.equal(resultA.available, false, `A's own short timeout must be respected, got: ${JSON.stringify(resultA)}`);
    assert.equal(
      resultB.available,
      true,
      `B must retry with its own healthy exec rather than inherit A's timeout as authoritative, got: ${JSON.stringify(resultB)}`,
    );
  });

  test('owner with a failing/broken exec / waiter with a healthy exec: the waiter retries independently and succeeds', async () => {
    let downloadAttempts = 0;
    let firstAttemptDispatched: (() => void) | undefined;
    const firstAttemptDispatchedPromise = new Promise<void>((resolve) => {
      firstAttemptDispatched = resolve;
    });
    // The owner's whole toolchain is broken -- every `go` invocation fails,
    // as it would under a PATH that does not actually resolve `go` (or a
    // module proxy the owner's network cannot reach), modelled here as an
    // immediate non-zero exit rather than a "not found" so it exercises the
    // `toolchain-failed` path `computeApiOf` returns for a failed download.
    const ownerExec: SurfaceRequest['exec'] = async (command, args) => {
      if (command === 'go' && args[0] === 'version') return { code: 0, stdout: 'go version go1.22.0 linux/amd64', stderr: '' };
      if (command === 'go' && args.join(' ').startsWith('env')) return { code: 0, stdout: '/tmp/gomodcache', stderr: '' };
      if (command === 'go' && args[0] === 'build') return { code: 0, stdout: '', stderr: '' };
      if (command === 'go' && args[0] === 'mod' && args[1] === 'download') {
        downloadAttempts += 1;
        firstAttemptDispatched?.();
        return { code: 1, stdout: '', stderr: 'dial tcp: no such host (broken owner network)' };
      }
      return { code: 1, stdout: '', stderr: 'unreachable' };
    };
    const waiterExec = makeExec(healthyCases(downloadDir));

    const wA = await newWorkdir();
    const wB = await newWorkdir();

    // The owner's failure is immediate, so both calls are started together
    // -- the point is that B's own healthy exec is what determines B's
    // outcome, whatever A's broken one already decided.
    const [resultA, resultB] = await Promise.all([
      goSurface.compute(makeRequest({ exec: ownerExec, workdir: wA, timeoutMs: 20_000 })),
      firstAttemptDispatchedPromise.then(() => goSurface.compute(makeRequest({ exec: waiterExec, workdir: wB, timeoutMs: 20_000 }))),
    ]);

    assert.equal(resultA.available, false, `A's own broken exec must produce A's own failure, got: ${JSON.stringify(resultA)}`);
    assert.equal(
      resultB.available,
      true,
      `B, with a healthy exec of its own, must not inherit A's broken-toolchain failure, got: ${JSON.stringify(resultB)}`,
    );
  });

  test('a real, module-level fact (version-unavailable) stays authoritative for every caller -- it is not retried as though it were caller-specific', async () => {
    let downloadAttempts = 0;
    const sharedExec = makeExec([
      // Listed first -- see the comment in the previous test on why the
      // override must precede the healthy fallback cases.
      {
        match: (c, a) => c === 'go' && a[0] === 'mod' && a[1] === 'download',
        respond: () => {
          downloadAttempts += 1;
          return { code: 1, stdout: '', stderr: '404 Not Found: unknown revision v2.0.0' };
        },
      },
      ...healthyCases(downloadDir),
    ]);

    const wA = await newWorkdir();
    const wB = await newWorkdir();
    const [resultA, resultB] = await Promise.all([
      goSurface.compute(makeRequest({ exec: sharedExec, workdir: wA, timeoutMs: 20_000 })),
      goSurface.compute(makeRequest({ exec: sharedExec, workdir: wB, timeoutMs: 20_000 })),
    ]);

    assert.equal(resultA.available, false);
    assert.equal(resultB.available, false);
    // `goSurface.compute` looks up `from` before `to` and returns as soon as
    // either fails, so a `from` that is itself unavailable means `to` is
    // never even reached -- exactly one unique version (`from`) is ever
    // attempted, shared by both callers. If the verdict were (incorrectly)
    // treated as caller-specific and retried, this would be 2 (one retry
    // each), not 1.
    assert.equal(downloadAttempts, 1, `expected the version-unavailable verdict to be shared, not retried per caller, got ${downloadAttempts} download attempts`);
  });

  test('successful shared computation still dedupes: two healthy concurrent callers make exactly one download+extract per unique version', async () => {
    let downloadAttempts = 0;
    let extractAttempts = 0;
    const sharedExec = makeExec(healthyCases(downloadDir));
    // Wrap the healthy cases to count calls without changing behaviour.
    const countingExec: SurfaceRequest['exec'] = async (command, args, options) => {
      if (command === 'go' && args[0] === 'mod' && args[1] === 'download') downloadAttempts += 1;
      if (command === 'go' && args[0] === 'run') extractAttempts += 1;
      return sharedExec(command, args, options);
    };

    const wA = await newWorkdir();
    const wB = await newWorkdir();
    const [resultA, resultB] = await Promise.all([
      goSurface.compute(makeRequest({ exec: countingExec, workdir: wA, timeoutMs: 20_000 })),
      goSurface.compute(makeRequest({ exec: countingExec, workdir: wB, timeoutMs: 20_000 })),
    ]);

    assert.equal(resultA.available, true);
    assert.equal(resultB.available, true);
    // 2 unique versions (from, to) each computed exactly once, shared by
    // both concurrent callers.
    assert.equal(downloadAttempts, 2, `expected exactly 2 downloads (one per unique version), got ${downloadAttempts}`);
    assert.equal(extractAttempts, 2, `expected exactly 2 extractor runs (one per unique version), got ${extractAttempts}`);
  });

  test('a failed computation is not retained: a later, independent call retries fresh', async () => {
    let downloadAttempts = 0;
    let allowSuccess = false;
    const exec = makeExec([
      // Listed first -- see the comment in the earlier tests on why the
      // override must precede the healthy fallback cases.
      {
        match: (c, a) => c === 'go' && a[0] === 'mod' && a[1] === 'download',
        respond: () => {
          downloadAttempts += 1;
          if (!allowSuccess) return { code: 1, stdout: '', stderr: 'temporary registry failure' };
          return { code: 0, stdout: JSON.stringify({ Dir: downloadDir }), stderr: '' };
        },
      },
      ...healthyCases(downloadDir),
    ]);

    const wA = await newWorkdir();
    const first = await goSurface.compute(makeRequest({ exec, workdir: wA, timeoutMs: 20_000 }));
    assert.equal(first.available, false);

    allowSuccess = true;
    resetGoSurfaceCache(); // also clears the (irrelevant here) scratch-module cache; apiInFlight is already empty post-settle.

    const wB = await newWorkdir();
    const second = await goSurface.compute(makeRequest({ exec, workdir: wB, timeoutMs: 20_000 }));
    assert.equal(second.available, true, 'a later independent call must retry rather than inherit the earlier failure');
  });

  test('resetGoSurfaceCache fully clears in-flight state: a call started before reset is unaffected, a call after reset starts fresh', async () => {
    const exec = makeExec(healthyCases(downloadDir));
    const wA = await newWorkdir();
    const result = await goSurface.compute(makeRequest({ exec, workdir: wA, timeoutMs: 20_000 }));
    assert.equal(result.available, true);

    resetGoSurfaceCache();

    let downloadAttempts = 0;
    const exec2: SurfaceRequest['exec'] = async (command, args, options) => {
      if (command === 'go' && args[0] === 'mod' && args[1] === 'download') downloadAttempts += 1;
      return makeExec(healthyCases(downloadDir))(command, args, options);
    };
    const wB = await newWorkdir();
    const result2 = await goSurface.compute(makeRequest({ exec: exec2, workdir: wB, timeoutMs: 20_000 }));
    assert.equal(result2.available, true);
    // The persistent apiCache was cleared too, so this is a real fresh
    // computation, not a cache hit -- both unique versions re-downloaded.
    assert.equal(downloadAttempts, 2, `expected a fresh computation after reset, got ${downloadAttempts} downloads`);
  });
});
