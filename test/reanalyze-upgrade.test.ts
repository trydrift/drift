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
 * `reanalyzeUpgrade` re-derives the workspace member universe from scratch
 * rather than reusing the scan's own, and it used to do that with
 * `detectWorkspaces` alone -- which only sees *declared* workspace members.
 * Drift's own repository is the standing counter-example: a root
 * `package.json` plus an undeclared `extension/package.json`, tied together
 * by nothing a `workspaces` field would notice. Reanalyzing a candidate from
 * such an undeclared member used to silently lose that member's own runtime
 * declaration, because the member itself was missing from the reconstructed
 * `allMembers` list.
 */

const config = DriftConfigSchema.parse({});
const logger = createLogger('error');
const realFetch = globalThis.fetch;

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-reanalyze-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', dependencies: { right: '3.0.0' } }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');

  mkdirSync(join(root, 'extension'));
  writeFileSync(
    join(root, 'extension', 'package.json'),
    JSON.stringify({ name: 'ext', dependencies: { left: '1.0.0' }, engines: { node: '>=18' } }),
  );
  writeFileSync(join(root, 'extension', 'package-lock.json'), '{}');
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
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/left')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            'dist-tags': { latest: '2.0.0' },
            versions: {
              '1.0.0': { engines: { node: '>=14' } },
              '2.0.0': { engines: { node: '>=20' } },
            },
            time: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url.includes('/right')) {
      // Already current -- no candidate should come of this one. Present
      // purely so the repository root is also a scan target, alongside
      // `extension`, which is what makes this a multi-package scan at all.
      return Promise.resolve(
        new Response(JSON.stringify({ 'dist-tags': { latest: '3.0.0' }, versions: { '3.0.0': {} } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as typeof fetch;
}

describe('reanalyzeUpgrade rediscovers the same member universe the scan used', () => {
  test('an undeclared nested member still owns its own runtime declaration after reanalysis', async () => {
    stubRegistry();
    const scan = await scanUpgrades({ root, repo, config, logger, verify: { enabled: false } });

    const candidate = scan.candidates.find((c) => c.name === 'left');
    assert.ok(candidate, 'left should have an upgrade candidate from the scan');
    assert.equal(candidate!.workspace, 'extension', 'left is declared in the undeclared nested member');

    const runtimeState = (c: typeof candidate) =>
      (c!.plan?.rationale ?? []).flatMap((r: { runtimeAnalyses?: { state: string }[] }) => r.runtimeAnalyses ?? [])[0]
        ?.state;

    // From the initial scan: `extension` declares `>=18`, a range that admits
    // versions left's raised floor of `>=20` rejects. The canonical runtime
    // analysis says so (partial); maintenance only states the upstream fact as
    // context.
    assert.equal(runtimeState(candidate), 'partial', 'extension >=18 only partially satisfies left >=20');
    assert.equal(
      candidate!.rationale?.maintenance.facts.find((f) => /Node\.js/.test(f.statement))?.polarity,
      'context',
    );

    stubRegistry();
    const reanalyzed = await reanalyzeUpgrade({ candidate: candidate!, version: '2.0.0', root, repo, config, logger });

    // Before the fix, `allMembers` reconstructed for reanalysis dropped
    // `extension` entirely (an undeclared member `detectWorkspaces` alone
    // cannot see), so `extension/package.json#engines` could no longer be
    // attributed to the `extension` member and the verdict regressed to
    // unknown. It must survive reanalysis as the same partial result.
    assert.equal(
      runtimeState(reanalyzed as typeof candidate),
      'partial',
      'the same finding must survive reanalysis, not regress to unknown',
    );
  });
});
