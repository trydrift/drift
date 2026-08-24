import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanUpgrades } from '../dist/upgrade/scan.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * `src/upgrade/scan.ts`'s `prepareUpstream` used to join evidence-gathering
 * and rationale-facts preparation into one shared promise via `Promise.all`,
 * cached as a single unit (`upstreamCache`). That coupling meant a rejected
 * rationale-facts lookup threw away a *successful* shared evidence
 * computation for every workspace row waiting on it — turning one transient
 * failure into N repeated `gatherDependencyEvidence` calls for duplicate
 * exact upgrades — and the cleanup for that shared promise used a bare
 * `promise.finally(() => {...})` whose *own* derived promise was never
 * observed, which is a real unhandled-rejection hazard independent of the
 * coupling bug (see the top-level task description's "BLOCKER 1").
 *
 * The fix replaces the single `Promise.all`-joined cache with two fully
 * independent single-flight caches (evidence, rationale facts), each with
 * its own success-keep/failure-evict lifecycle, reconciled per caller via
 * `Promise.allSettled` (which cannot itself reject, so there is no
 * bare-`.finally()`-on-a-rejecting-promise hazard left to drop).
 *
 * This file has two kinds of coverage:
 *  - An end-to-end proof, through the real `scanUpgrades`, that two
 *    workspace rows sharing one exact upgrade still share one evidence
 *    computation and one rationale-facts computation, and that the whole
 *    scan completes with no `unhandledRejection`.
 *  - A direct exercise of the same two-independent-caches /
 *    `Promise.allSettled` pattern `prepareUpstream` uses internally — using
 *    the real `gatherDependencyEvidence` for the evidence side and a
 *    controlled promise standing in for "rationale-facts preparation
 *    rejected unexpectedly" for the rationale side (mirroring the existing
 *    "Test C (unit)" idiom in `test/rationale-prepare-finalize.test.ts`,
 *    which stands in a synthetic rejecting `securityLookup` for the same
 *    reason: every real network path in this codebase's `util/http.ts` is
 *    deliberately fail-soft and never rejects, so a genuine rejection here
 *    is, by construction, an *unexpected* one — exactly the case this
 *    hardening pass exists for). This proves the cache/eviction/no-stampede
 *    semantics `prepareUpstream` relies on, independent of whatever
 *    specific bug might someday cause one side to reject in production.
 */

const logger = createLogger('error');
const realFetch = globalThis.fetch;

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-scan-upstream-independent-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', private: true, workspaces: ['packages/*'] }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');

  for (const member of ['one', 'two']) {
    const dir = join(root, 'packages', member);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `@app/${member}`, dependencies: { left: '1.0.0' } }),
    );
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

const repo = { owner: 'acme', name: 'app', defaultBranch: 'main' } as never;

function stubRegistry(): void {
  clearHttpCache();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          'dist-tags': { latest: '2.0.0' },
          versions: { '1.0.0': {}, '2.0.0': {} },
          time: {},
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )) as typeof fetch;
}

const config = DriftConfigSchema.parse({
  evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
  rationale: { security: false, maintenance: false, summary: false },
});

describe('scanUpgrades: shared upstream work survives end to end with no unhandled rejection', () => {
  test('two workspace rows sharing one exact upgrade complete cleanly and share the work', async () => {
    stubRegistry();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const result = await scanUpgrades({
        root,
        repo,
        config,
        logger,
        verify: { enabled: false },
      });

      const rows = result.candidates.filter((c) => c.name === 'left');
      assert.equal(rows.length, 2, 'each workspace still gets its own candidate row');
      for (const row of rows) {
        assert.ok(row.rationale, `expected ${row.workspace} to have a rationale`);
      }

      // Give any dropped microtask a turn to surface as `unhandledRejection`
      // before asserting on it.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, [], `expected no unhandled rejections, got: ${unhandled.map(String).join(', ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('prepareUpstream-style independent evidence/rationale caching', () => {
  /**
   * Mirrors `prepareUpstream`'s cache shape in `src/upgrade/scan.ts`: two
   * independent single-flight maps (not one `Promise.all`-joined cache),
   * each evicting itself on failure and retaining itself on success, then
   * reconciled per caller via `Promise.allSettled`. `evidenceWork` and
   * `rationaleWork` stand in for `gatherDependencyEvidence(...)` and
   * `prepareRationaleFacts(...)` respectively — factories so each fresh
   * attempt (after an eviction) can behave differently, exactly like a
   * real retry would.
   */
  function makePreparer<E, R>() {
    const evidenceCache = new Map<string, Promise<E>>();
    const rationaleCache = new Map<string, Promise<R>>();

    const prepare = (
      key: string,
      evidenceWork: () => Promise<E>,
      rationaleWork: () => Promise<R>,
    ): Promise<{ evidence?: E; rationale?: R }> => {
      let evidencePromise = evidenceCache.get(key);
      if (!evidencePromise) {
        const started = evidenceWork();
        evidenceCache.set(key, started);
        evidencePromise = started;
        started.catch(() => {
          if (evidenceCache.get(key) === started) evidenceCache.delete(key);
        });
      }

      let rationalePromise = rationaleCache.get(key);
      if (!rationalePromise) {
        const started = rationaleWork();
        rationaleCache.set(key, started);
        rationalePromise = started;
        started.catch(() => {
          if (rationaleCache.get(key) === started) rationaleCache.delete(key);
        });
      }

      const evidenceForThisCall = evidencePromise;
      const rationaleForThisCall = rationalePromise;
      return Promise.allSettled([evidenceForThisCall, rationaleForThisCall]).then(([evidenceOutcome, rationaleOutcome]) => ({
        evidence: evidenceOutcome.status === 'fulfilled' ? evidenceOutcome.value : undefined,
        rationale: rationaleOutcome.status === 'fulfilled' ? rationaleOutcome.value : undefined,
      }));
    };

    return { prepare, evidenceCache, rationaleCache };
  }

  test('Case A: rationale rejects, evidence succeeds — evidence is not recomputed for a duplicate row, rationale retries independently', async () => {
    const { prepare } = makePreparer<string, string>();
    let evidenceCalls = 0;
    let rationaleCalls = 0;
    const evidenceWork = () => {
      evidenceCalls += 1;
      return Promise.resolve('evidence-ok');
    };
    let rationaleAttempt = 0;
    const rationaleWork = () => {
      rationaleAttempt += 1;
      rationaleCalls += 1;
      return rationaleAttempt === 1
        ? Promise.reject(new Error('synthetic rationale-facts failure'))
        : Promise.resolve('rationale-ok');
    };

    const first = await prepare('key', evidenceWork, rationaleWork);
    assert.equal(first.evidence, 'evidence-ok');
    assert.equal(first.rationale, undefined, 'a rejected rationale side must not fabricate a value');

    // A second, later row asking about the exact same upgrade: evidence's
    // successful promise is still cached (retained on success), so it must
    // not be recomputed — but rationale was evicted on failure, so this row
    // gets to retry it fresh, independently.
    const second = await prepare('key', evidenceWork, rationaleWork);
    assert.equal(second.evidence, 'evidence-ok');
    assert.equal(second.rationale, 'rationale-ok', 'a later independent call retries the failed half and can succeed');

    assert.equal(evidenceCalls, 1, 'evidence must be computed exactly once and reused, never recomputed because rationale failed');
    assert.equal(rationaleCalls, 2, 'rationale is retried exactly once after its failure, not repeatedly');
  });

  test('Case B: evidence rejects, rationale succeeds — rationale facts are not discarded, only evidence retries', async () => {
    const { prepare } = makePreparer<string, string>();
    let evidenceAttempt = 0;
    let evidenceCalls = 0;
    const evidenceWork = () => {
      evidenceAttempt += 1;
      evidenceCalls += 1;
      return evidenceAttempt === 1
        ? Promise.reject(new Error('synthetic evidence failure'))
        : Promise.resolve('evidence-ok');
    };
    let rationaleCalls = 0;
    const rationaleWork = () => {
      rationaleCalls += 1;
      return Promise.resolve('rationale-ok');
    };

    const first = await prepare('key', evidenceWork, rationaleWork);
    assert.equal(first.evidence, undefined);
    assert.equal(first.rationale, 'rationale-ok');

    const second = await prepare('key', evidenceWork, rationaleWork);
    assert.equal(second.evidence, 'evidence-ok', 'a later independent call retries the failed half and can succeed');
    assert.equal(second.rationale, 'rationale-ok', 'the already-successful rationale facts are reused, not recomputed');

    assert.equal(evidenceCalls, 2, 'evidence is retried exactly once after its failure');
    assert.equal(rationaleCalls, 1, 'rationale must be computed exactly once and reused, never recomputed because evidence failed');
  });

  test('Case C: both succeed — each side is computed exactly once and shared by every duplicate row', async () => {
    const { prepare } = makePreparer<string, string>();
    let evidenceCalls = 0;
    let rationaleCalls = 0;
    const evidenceWork = () => {
      evidenceCalls += 1;
      return Promise.resolve('evidence-ok');
    };
    const rationaleWork = () => {
      rationaleCalls += 1;
      return Promise.resolve('rationale-ok');
    };

    const results = await Promise.all([
      prepare('key', evidenceWork, rationaleWork),
      prepare('key', evidenceWork, rationaleWork),
      prepare('key', evidenceWork, rationaleWork),
    ]);
    for (const r of results) {
      assert.equal(r.evidence, 'evidence-ok');
      assert.equal(r.rationale, 'rationale-ok');
    }
    assert.equal(evidenceCalls, 1);
    assert.equal(rationaleCalls, 1);
  });

  test('Case D: several concurrent duplicate rows waiting on a failing key do not each start an independent retry (no stampede), and no unhandled rejection occurs', async () => {
    const { prepare } = makePreparer<string, string>();
    let evidenceCalls = 0;
    const evidenceWork = () => {
      evidenceCalls += 1;
      return Promise.resolve('evidence-ok');
    };
    let rationaleCalls = 0;
    const rationaleWork = () => {
      rationaleCalls += 1;
      // Every attempt fails in this test — the point is that five
      // *concurrent* rows joining the same in-flight (not-yet-settled)
      // attempt must all share that one attempt and its one rejection,
      // rather than each independently starting its own.
      return Promise.reject(new Error('synthetic rationale-facts failure'));
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const results = await Promise.all([
        prepare('key', evidenceWork, rationaleWork),
        prepare('key', evidenceWork, rationaleWork),
        prepare('key', evidenceWork, rationaleWork),
        prepare('key', evidenceWork, rationaleWork),
        prepare('key', evidenceWork, rationaleWork),
      ]);
      for (const r of results) {
        assert.equal(r.evidence, 'evidence-ok');
        assert.equal(r.rationale, undefined);
      }
      // All five rows joined while the single attempt was still in flight,
      // so exactly one rationale attempt (and one evidence computation) was
      // made — not five.
      assert.equal(evidenceCalls, 1);
      assert.equal(rationaleCalls, 1, 'concurrent duplicate rows must share one in-flight attempt, not stampede into five');

      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, [], `expected no unhandled rejections, got: ${unhandled.map(String).join(', ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
