import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeRepository } from '../dist/analysis.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * Regression coverage for analyzeRepository() gathering this repository's own
 * runtime declarations (.nvmrc, package.json#engines, etc.) independent of
 * whether any BreakingChange was found.
 *
 * Runtime collection used to live inside `if (breakingChanges.length > 0 &&
 * workspace)`, alongside localization/codemod work. But a raised runtime
 * floor can be visible from registry metadata alone -- no API surface diff,
 * no prose finding, nothing that would ever populate `breakingChanges` -- and
 * in that case the old gate meant `repoRuntime`/`pythonRuntime` stayed empty,
 * so `assessMaintenance`'s runtime check never had this repository's own
 * declaration to compare against and fell back to the generic "check this by
 * hand" prompt instead of catching a real, provable incompatibility.
 */

const logger = createLogger('error');

const BEFORE_REF = 'sha-before';
const AFTER_REF = 'sha-after';

const PKG_BEFORE = JSON.stringify({ name: 'app', dependencies: { 'acme-runtime-sdk': '1.0.0' } });
const PKG_AFTER = JSON.stringify({ name: 'app', dependencies: { 'acme-runtime-sdk': '2.0.0' } });

function fakeProvider() {
  return {
    changedFiles: async () => ['package.json'],
    readFile: async (path: string, ref: string) =>
      path === 'package.json' ? (ref === BEFORE_REF ? PKG_BEFORE : PKG_AFTER) : null,
  };
}

/** A registry packument with zero API-shape signal, only a raised Node floor. */
function mockRegistryFetch() {
  return (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          versions: {
            '1.0.0': { engines: { node: '>=14' } },
            '2.0.0': { engines: { node: '>=22.13.0' } },
          },
          time: {},
        }),
      ),
    )) as typeof fetch;
}

describe('analyzeRepository gathers runtime declarations even with zero breaking changes', () => {
  test('a registry-only runtime floor raise is still caught against an incompatible .nvmrc', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-runtime-gating-'));
    const realFetch = globalThis.fetch;
    clearHttpCache();
    globalThis.fetch = mockRegistryFetch();

    try {
      writeFileSync(join(root, 'package.json'), PKG_AFTER);
      writeFileSync(join(root, '.nvmrc'), '18.0.0\n');

      const config = DriftConfigSchema.parse({
        evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
        rationale: { security: false, maintenance: true, summary: false },
      });

      const result = await analyzeRepository({
        repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
        config,
        logger,
        provider: fakeProvider(),
        workspace: root,
      });

      assert.ok(result.plan, 'a dependency version move should still produce a plan');
      // The whole point: no API/prose breaking finding exists for this made-up
      // package, so this is exercising the registry-metadata-only path.
      assert.equal(result.plan!.breakingChanges.length, 0);

      const rationale = result.plan!.rationale?.find((r) => r.dependency === 'acme-runtime-sdk');
      assert.ok(rationale, 'rationale should still be computed for this dependency');

      const runtimeFact = rationale!.maintenance.facts.find((f) => /Node\.js version changed/.test(f.statement));
      assert.ok(runtimeFact, 'the raised Node.js floor should be reported as a maintenance fact');
      assert.match(runtimeFact!.statement, /does not satisfy it: \.nvmrc/);
      assert.equal(runtimeFact!.polarity, 'blocks');
      assert.equal(rationale!.assessment.recommendation, 'do-not-upgrade-yet');
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the same registry-only runtime floor raise is silent when this repository already satisfies it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-runtime-gating-ok-'));
    const realFetch = globalThis.fetch;
    clearHttpCache();
    globalThis.fetch = mockRegistryFetch();

    try {
      writeFileSync(join(root, 'package.json'), PKG_AFTER);
      writeFileSync(join(root, '.nvmrc'), '22.13.0\n');

      const config = DriftConfigSchema.parse({
        evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
        rationale: { security: false, maintenance: true, summary: false },
      });

      const result = await analyzeRepository({
        repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
        config,
        logger,
        provider: fakeProvider(),
        workspace: root,
      });

      const rationale = result.plan!.rationale?.find((r) => r.dependency === 'acme-runtime-sdk');
      assert.ok(rationale);

      const runtimeFact = rationale!.maintenance.facts.find((f) => /Node\.js version changed/.test(f.statement));
      assert.ok(runtimeFact);
      assert.match(runtimeFact!.statement, /already satisfies it \(\.nvmrc\)/);
      assert.equal(runtimeFact!.polarity, 'context');
      assert.notEqual(rationale!.assessment.recommendation, 'do-not-upgrade-yet');
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
