import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanUpgrades } from '../dist/upgrade/scan.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * `scanUpgrades`'s phase-one version-discovery loop dedupes identical
 * `(ecosystem, name, current, range)` registry lookups via a scan-local
 * `versionLookups` map, so two manifest rows asking about the exact same
 * package never spend two registry requests on it. That map used to evict
 * its entry in a `.finally`, which only helps two lookups that happen to
 * overlap in time -- if the first finishes before the second worker even
 * reaches it, the entry is already gone and the registry is queried again.
 *
 * `DRIFT_NETWORK_CONCURRENCY=1` forces the two workspace rows to be
 * processed strictly one after another (never overlapping), so a naive
 * "count registry fetches" assertion is not enough on its own: `util/http.ts`
 * keeps its own process-lifetime response cache keyed by URL, and a second,
 * genuinely fresh network call for the same URL would silently hit *that*
 * cache and never reach `fetch` at all -- masking whether `versionLookups`
 * itself deduped anything. Both tests below clear that HTTP-level cache
 * (`clearHttpCache`) right after the first row's lookup settles but before
 * the second row starts, via `onProgress`. That isolates what is actually
 * being tested: whether the *second* row's registry request is skipped
 * because it joined the first row's still-referenced `versionLookups` entry,
 * not because an unrelated cache happened to still be warm.
 */

const logger = createLogger('error');
const realFetch = globalThis.fetch;
const realEnv = process.env.DRIFT_NETWORK_CONCURRENCY;

let root = '';

// A fresh workspace root per test: these tests count registry calls, so a
// workspace member left over from a previous test (e.g. `packages/one` still
// declaring `left`) would silently inflate the count and defeat the point.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-scan-version-dedupe-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', private: true, workspaces: ['packages/*'] }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  clearHttpCache();
});

after(() => {
  if (realEnv === undefined) delete process.env.DRIFT_NETWORK_CONCURRENCY;
  else process.env.DRIFT_NETWORK_CONCURRENCY = realEnv;
});

const repo = { owner: 'acme', name: 'app', defaultBranch: 'main' } as never;

const config = DriftConfigSchema.parse({
  evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
  rationale: { security: false, maintenance: false, summary: false },
});

describe('scan-local version-lookup dedupe survives non-overlapping calls', () => {
  test('two sequential identical lookups within one scan share the in-flight lookup', async () => {
    // Force the version-discovery phase to process rows one at a time, so
    // the second row's lookup only starts once the first has fully settled
    // -- the exact case a `.finally`-based eviction would miss.
    process.env.DRIFT_NETWORK_CONCURRENCY = '1';

    for (const member of ['one', 'two']) {
      const dir = join(root, 'packages', member);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: `@app/${member}`, dependencies: { left: '1.0.0' } }),
      );
    }

    let registryCalls = 0;
    clearHttpCache();
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org/left')) {
        registryCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              'dist-tags': { latest: '2.0.0' },
              versions: { '1.0.0': {}, '2.0.0': {} },
              time: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;

    // Clears `util/http.ts`'s own response cache the instant the first
    // row's version lookup has reported its outcome, so the second row's
    // lookup (which starts right after, thanks to concurrency 1) can only
    // avoid a real network round trip by joining `versionLookups`' retained
    // promise -- not by an unrelated cache still being warm.
    let clearedOnce = false;
    const result = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      verify: { enabled: false },
      onProgress: ({ detail }) => {
        if (!clearedOnce && detail.startsWith('left ')) {
          clearedOnce = true;
          clearHttpCache();
        }
      },
    });

    assert.ok(clearedOnce, 'expected the first row to report its outcome so the HTTP cache could be cleared');

    const rows = result.candidates.filter((c) => c.name === 'left');
    assert.equal(rows.length, 2, 'each workspace still gets its own candidate row');
    // One request for the shared version-discovery lookup itself; a second,
    // independent registry request happens later when rationale/evidence
    // gathering asks the registry for this same package's metadata (a
    // different, already-deduped cache -- `upstreamCache` -- unrelated to
    // `versionLookups`). If `versionLookups` regressed to evicting on every
    // settle, the second *row* would also force its own fresh lookup right
    // here, landing on the just-cleared HTTP cache and adding a third call.
    assert.equal(
      registryCalls,
      2,
      `expected exactly 2 registry requests (one shared version lookup, one shared rationale lookup), got ${registryCalls}`,
    );
  });

  test('a failed lookup is evicted and retried by a later independent call', async () => {
    process.env.DRIFT_NETWORK_CONCURRENCY = '1';

    for (const member of ['three', 'four']) {
      const dir = join(root, 'packages', member);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: `@app/${member}`, dependencies: { flaky: '1.0.0' } }),
      );
    }

    let registryCalls = 0;
    // Flips only once the first row has fully reported its ('Could not
    // check') outcome, via `onProgress` below -- not after the *first HTTP
    // attempt*, since `fetchJson` itself retries a 500 up to twice more
    // before giving up. Flipping on the first attempt would let one of
    // those internal retries accidentally succeed and turn the first row's
    // lookup into a success, defeating the point of this test.
    let allowSuccess = false;
    clearHttpCache();
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org/flaky')) {
        registryCalls += 1;
        if (!allowSuccess) return Promise.resolve(new Response('server error', { status: 500 }));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              'dist-tags': { latest: '2.0.0' },
              versions: { '1.0.0': {}, '2.0.0': {} },
              time: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;

    const result = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      verify: { enabled: false },
      onProgress: ({ phase, detail }) => {
        if (!allowSuccess && phase === 'Could not check' && detail.startsWith('flaky@')) {
          allowSuccess = true;
          // `util/http.ts` also remembers a failed JSON fetch for a full
          // minute (so a genuinely unreachable registry is not hammered by
          // every dependency needing it); without clearing it here, the
          // second row's lookup would silently read that remembered failure
          // back and never even reach `fetch`, making this test unable to
          // tell "retried and failed again" apart from "retried and would
          // have succeeded."
          clearHttpCache();
        }
      },
    });

    // Not asserted as an exact count: `fetchJson` itself retries a 500 (up
    // to 3 attempts) before the first row's lookup gives up, so the raw call
    // count is a property of that retry policy, not of `versionLookups`.
    // What matters here is that the failure was NOT permanently cached --
    // the second row still reached the registry on its own and could
    // succeed, which the outcome assertions below establish directly.
    assert.ok(registryCalls >= 2, `expected more than one registry attempt, got ${registryCalls}`);
    const uncheckedFlaky = result.unchecked.filter((u) => u.name === 'flaky');
    const outdatedFlaky = result.candidates.filter((c) => c.name === 'flaky');
    assert.equal(uncheckedFlaky.length, 1, 'exactly one row should have hit the failing first attempt');
    assert.equal(outdatedFlaky.length, 1, 'the other row must retry independently and succeed');
  });
});
