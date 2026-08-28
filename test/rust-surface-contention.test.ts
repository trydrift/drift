import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSurfaceDiff } from '../dist/evidence/surface/index.js';
import { isCargoLockContention } from '../dist/evidence/surface/rust.js';
import { configureHttpDiskCache, clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * The scratch crate directories are isolated but `$CARGO_HOME` is shared, so
 * running the old and new `cargo public-api` probes at once made Cargo race
 * itself on the package-cache lock. A bounded probe pool removes the
 * self-inflicted contention; genuine external contention is retried within the
 * caller's budget; a real compile failure is not mistaken for it; and a
 * successful surface is cached by (crate, version, analyzer identity).
 */

const logger = createLogger('error');
const realFetch = globalThis.fetch;

const change = (over: Record<string, unknown> = {}) =>
  ({
    name: 'serde',
    ecosystem: 'cargo',
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime',
    bump: 'major',
    manifestPath: 'Cargo.toml',
    rawFrom: '1.0.0',
    rawTo: '2.0.0',
    ...over,
  }) as never;

const PROBE = 'public-api --simplified';
const surfaceLine = 'pub fn serde::from_str<T>(s: &str) -> T\n';

interface ExecOptions {
  /** `rustup run nightly rustc --version` output — the compiler identity. */
  nightly?: string;
  /** Whether `rustup` is on PATH at all. */
  rustup?: boolean;
  /** How long each probe occupies the pool. */
  probeDelayMs?: number;
}

/** An exec that answers every provisioning check and delegates the probe. */
function execWith(
  probe: (version: string, call: number) => {
    code: number;
    stdout: string;
    stderr: string;
  },
  opts: ExecOptions = {},
) {
  const { nightly = 'rustc 1.90.0-nightly (abc 2025-01-01)', rustup = true, probeDelayMs = 15 } = opts;
  const probeCalls = new Map<string, number>();
  let running = 0;
  let peak = 0;

  const exec = async (command: string, args: readonly string[]) => {
    const joined = args.join(' ');
    if (command === 'cargo' && joined === '--version') return { code: 0, stdout: 'cargo 1.90.0', stderr: '' };
    if (command === 'cargo' && joined === 'public-api --version') {
      return { code: 0, stdout: 'cargo-public-api 0.50.0', stderr: '' };
    }
    if (command === 'rustup' && joined === '--version') {
      return rustup
        ? { code: 0, stdout: 'rustup 1.27', stderr: '' }
        : { code: 1, stdout: '', stderr: '', failure: 'not-found' as const };
    }
    if (command === 'rustup') {
      return rustup
        ? { code: 0, stdout: nightly, stderr: '' }
        : { code: 1, stdout: '', stderr: '', failure: 'not-found' as const };
    }

    if (command === 'cargo' && joined.startsWith(PROBE)) {
      running += 1;
      peak = Math.max(peak, running);
      // Version is not actually in argv (probe is `--package serde`); track by
      // call order instead, which is deterministic under concurrency 1.
      const key = 'probe';
      const n = (probeCalls.get(key) ?? 0) + 1;
      probeCalls.set(key, n);
      await new Promise((r) => setTimeout(r, probeDelayMs));
      running -= 1;
      return probe(String(n), n);
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };

  return { exec, peak: () => peak, probeCount: () => probeCalls.get('probe') ?? 0 };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
});

describe('isCargoLockContention', () => {
  test('true for a bare package-cache lock message', () => {
    assert.equal(
      isCargoLockContention('    Blocking waiting for file lock on package cache\n'),
      true,
    );
  });
  test('false when a real compile error is also present', () => {
    assert.equal(
      isCargoLockContention(
        'Blocking waiting for file lock on package cache\nerror[E0432]: unresolved import\n',
      ),
      false,
    );
  });
  test('false for an ordinary build failure', () => {
    assert.equal(isCargoLockContention('error: could not compile `serde`'), false);
  });
});

describe('cargo probe scheduling', () => {
  test('never runs two Cargo probes at once', async () => {
    const h = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }));
    const outcome = await computeSurfaceDiff(change(), { logger, exec: h.exec });
    assert.equal(outcome.available, true);
    assert.equal(h.peak(), 1, 'the probe pool serialized the old/new builds');
    assert.equal(h.probeCount(), 2);
  });

  test('retries a package-cache lock race within budget, then succeeds', async () => {
    let attempts = 0;
    const h = execWith(() => {
      attempts += 1;
      // First probe attempt loses the lock race; the rest succeed.
      if (attempts === 1) {
        return { code: 1, stdout: '', stderr: 'Blocking waiting for file lock on package cache' };
      }
      return { code: 0, stdout: surfaceLine, stderr: '' };
    });
    const outcome = await computeSurfaceDiff(change(), { logger, exec: h.exec });
    assert.equal(outcome.available, true, 'contention was retried, not surfaced as a failure');
    assert.ok(attempts >= 3, 'the first probe retried at least once before the two versions resolved');
  });

  test('a queued probe whose deadline expired while waiting never starts cargo', async () => {
    // Probe A occupies the single pool slot for longer than the whole budget.
    // Probe B waits behind it; by the time B acquires the slot the shared
    // deadline is already gone, so cargo must never be spawned for B.
    const h = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }), { probeDelayMs: 220 });
    const outcome = await computeSurfaceDiff(change(), { logger, exec: h.exec, timeoutMs: 100 });
    assert.equal(outcome.available, false, 'the second version could not be produced within the deadline');
    assert.match((outcome as { detail: string }).detail, /ran out of time/);
    assert.equal(h.probeCount(), 1, 'only the first probe ran; the queued one was abandoned pre-spawn');
  });

  test('a real compile failure is reported, not retried', async () => {
    let attempts = 0;
    const h = execWith(() => {
      attempts += 1;
      return { code: 101, stdout: '', stderr: 'error[E0433]: failed to resolve' };
    });
    const outcome = await computeSurfaceDiff(change(), { logger, exec: h.exec });
    assert.equal(outcome.available, false);
    // One attempt per version, and no more — a build error is not retried.
    assert.ok(attempts <= 2, `expected no retries, saw ${attempts} probe attempts`);
  });
});

describe('persistent rust surface cache', () => {
  test('a computed surface is replayed without a second build', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-rust-cache-'));
    configureHttpDiskCache(cacheDir);
    try {
      const first = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }));
      const a = await computeSurfaceDiff(change(), { logger, exec: first.exec });
      assert.equal(a.available, true);
      assert.equal(first.probeCount(), 2);

      // Second run: the probe now fails hard. The cache must answer anyway.
      const second = execWith(() => ({ code: 101, stdout: '', stderr: 'error: could not compile' }));
      const b = await computeSurfaceDiff(change(), { logger, exec: second.exec });
      assert.equal(b.available, true, 'both versions served from the persistent surface cache');
      assert.equal(second.probeCount(), 0, 'no build ran on the cached path');
    } finally {
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('the nightly compiler identity is part of the cache key', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-rust-cache-'));
    configureHttpDiskCache(cacheDir);
    try {
      // First run under nightly A. cargo-public-api version and the ambient
      // stable rustc are irrelevant here — only the nightly that emits rustdoc
      // JSON changed between the runs.
      const a = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }), {
        nightly: 'rustc 1.90.0-nightly (aaaaaaa 2025-01-01)',
      });
      const first = await computeSurfaceDiff(change(), { logger, exec: a.exec });
      assert.equal(first.available, true);
      assert.equal(a.probeCount(), 2);

      // Second run: nightly rolled to B. The surface produced under A must not
      // be replayed — the probe has to run again.
      const b = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }), {
        nightly: 'rustc 1.90.0-nightly (bbbbbbb 2025-02-01)',
      });
      const second = await computeSurfaceDiff(change(), { logger, exec: b.exec });
      assert.equal(second.available, true);
      assert.equal(b.probeCount(), 2, 'a changed nightly invalidated the cached surface');
    } finally {
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('a surface is not persisted when the compiler identity cannot be established', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-rust-cache-'));
    configureHttpDiskCache(cacheDir);
    try {
      // No rustup on PATH: the analyzer can still run (nightly may be the
      // ambient default), but Drift cannot name the compiler behind
      // `cargo public-api`, so nothing may be written to the persistent cache.
      const first = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }), { rustup: false });
      const a = await computeSurfaceDiff(change(), { logger, exec: first.exec });
      assert.equal(a.available, true, 'analysis still succeeds without a provable compiler identity');
      assert.equal(first.probeCount(), 2);

      // Next invocation, same inputs: it must probe again rather than replay an
      // identity-unknown surface.
      const second = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }), { rustup: false });
      const b = await computeSurfaceDiff(change(), { logger, exec: second.exec });
      assert.equal(b.available, true);
      assert.equal(second.probeCount(), 2, 'no identity-unknown surface was persisted or replayed');
    } finally {
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('a failed probe is never cached as a surface', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-rust-cache-'));
    configureHttpDiskCache(cacheDir);
    try {
      const failing = execWith(() => ({ code: 101, stdout: '', stderr: 'error[E0433]: failed to resolve' }));
      await computeSurfaceDiff(change(), { logger, exec: failing.exec });

      const ok = execWith(() => ({ code: 0, stdout: surfaceLine, stderr: '' }));
      const retry = await computeSurfaceDiff(change(), { logger, exec: ok.exec });
      assert.equal(retry.available, true);
      assert.equal(ok.probeCount(), 2, 'the earlier failure did not poison the cache');
    } finally {
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
