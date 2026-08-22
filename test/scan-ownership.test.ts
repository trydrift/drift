import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanUpgrades, reanalyzeUpgrade } from '../dist/upgrade/scan.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * `scanUpgrades({ dirs })` scans a caller-supplied subset of a repository's
 * members, but ownership of every member -- including ones left out of that
 * subset -- has to stay intact, or a directory outside `dirs` gets attributed
 * `owner === null` by `memberOf` and read as repository-global by runtime
 * scoping: a sibling package's `.nvmrc` bleeding into every scanned member's
 * compatibility check.
 *
 * This repository has three workspace members: packages/api, packages/web,
 * packages/worker. Only api and web are scanned (`dirs`). worker's `.nvmrc`
 * declares a Node version that does NOT satisfy the target's raised floor;
 * api's and web's own `.nvmrc`s do. If worker's directory falls out of the
 * ownership universe used for scoping, its incompatible declaration leaks
 * into api's and web's own checks and they wrongly report as incompatible.
 */

const logger = createLogger('error');
const realFetch = globalThis.fetch;

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-scan-ownership-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', private: true, workspaces: ['packages/*'] }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');

  for (const [member, nvmrc] of [
    ['api', '24.0.0'],
    ['web', '24.0.0'],
    ['worker', '14.0.0'],
  ] as const) {
    const dir = join(root, 'packages', member);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `@app/${member}`, dependencies: { left: '1.0.0' } }),
    );
    writeFileSync(join(dir, '.nvmrc'), `${nvmrc}\n`);
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

/** `left` raises its Node floor to >=22.13.0 between 1.0.0 and 2.0.0. */
function stubRegistry(): void {
  clearHttpCache();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          'dist-tags': { latest: '2.0.0' },
          versions: {
            '1.0.0': { engines: { node: '>=14' } },
            '2.0.0': { engines: { node: '>=22.13.0' } },
          },
          time: {},
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )) as typeof fetch;
}

const config = DriftConfigSchema.parse({
  evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
  rationale: { security: false, maintenance: true, summary: false },
});

function runtimeFactOf(candidate: { rationale?: { maintenance: { facts: { statement: string }[] } } }) {
  return candidate.rationale?.maintenance.facts.find((f) => /Node\.js version changed/.test(f.statement));
}

describe('scanUpgrades({ dirs }) preserves true workspace ownership', () => {
  test("a directory left out of dirs does not become global and does not bleed into the scanned members' runtime checks", async () => {
    stubRegistry();

    const result = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      verify: { enabled: false },
      dirs: ['packages/api', 'packages/web'],
    });

    // Only the requested subset was scanned -- worker never appears.
    const members = new Set(result.candidates.map((c) => c.workspace));
    assert.deepEqual([...members].sort(), ['packages/api', 'packages/web']);

    for (const candidate of result.candidates) {
      const fact = runtimeFactOf(candidate);
      assert.ok(fact, `${candidate.workspace} should have a runtime fact`);
      // The bug: worker's incompatible .nvmrc (excluded from `dirs`) leaking
      // in as a false-global declaration would make this say "does not
      // satisfy it: packages/worker/.nvmrc" instead.
      assert.match(
        fact!.statement,
        /already satisfies it/,
        `${candidate.workspace}'s own .nvmrc (24.0.0) should be judged compatible on its own, not against worker's`,
      );
      assert.doesNotMatch(fact!.statement, /worker/);
      assert.equal(fact!.polarity, 'context');

      // worker stays known as its own member in the persisted ownership
      // universe -- not silently dropped just because it was not scanned.
      assert.ok(candidate.allMembers?.includes('packages/worker'));
    }
  });

  test('reanalyzing an api candidate after a custom-dirs scan preserves the same scope and verdict', async () => {
    stubRegistry();

    const result = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      verify: { enabled: false },
      dirs: ['packages/api', 'packages/web'],
    });

    const api = result.candidates.find((c) => c.workspace === 'packages/api');
    assert.ok(api, 'api should have been scanned');

    const reanalyzed = await reanalyzeUpgrade({
      candidate: api!,
      version: api!.selected,
      root,
      repo,
      config,
      logger,
    });

    const originalFact = runtimeFactOf(api!);
    const reanalyzedFact = runtimeFactOf(reanalyzed);
    assert.ok(reanalyzedFact);
    assert.equal(reanalyzedFact!.statement, originalFact!.statement);
    assert.equal(reanalyzedFact!.polarity, 'context');
    assert.equal(reanalyzed.recommendation, api!.recommendation);
  });
});
