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
 * Two workspace members declare the exact same upgrade (`left` 1.0.0 ->
 * 2.0.0). `scanUpgrades` shares the upstream evidence-gathering work between
 * them (one `upstream.analysis`, one shared promise) but each row used to sit
 * on a stale "Waiting to be checked" for however long the *other* row's
 * upstream work took, because nothing fanned the owner's progress out onto
 * the row that was only waiting on it. This asserts both rows observe live
 * phase updates from the single shared computation, and that ownership/output
 * stays otherwise per-workspace (dedupe does not merge results across rows).
 */

const logger = createLogger('error');
const realFetch = globalThis.fetch;

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-scan-shared-progress-'));
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

describe('shared upstream work fans progress out to every waiting row', () => {
  test('both rows observe a shared phase, and results stay per-workspace', async () => {
    stubRegistry();

    const phasesById = new Map<string, string[]>();

    const result = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      verify: { enabled: false },
      onCandidate: (candidate) => {
        const phase = (candidate as { phase?: string }).phase;
        if (!phase) return;
        const list = phasesById.get(candidate.id) ?? [];
        list.push(phase);
        phasesById.set(candidate.id, list);
      },
    });

    // Both workspace members produced their own candidate row for the same
    // exact upgrade — dedupe shares the upstream computation, not the output.
    const rows = result.candidates.filter((c) => c.name === 'left');
    assert.equal(rows.length, 2, 'each workspace still gets its own candidate row');
    assert.deepEqual(
      [...new Set(rows.map((r) => r.workspace))].sort(),
      ['packages/one', 'packages/two'],
    );

    // The fan-out itself: whichever row ends up waiting on the other's shared
    // upstream work must still see the owner's phase reported on its own
    // row, not just its own eventual "Checked" — one row is genuinely doing
    // the upstream analysis, the other is only riding along on it.
    for (const row of rows) {
      const phases = phasesById.get(row.id) ?? [];
      assert.ok(
        phases.includes('Reading release notes and changelog'),
        `expected ${row.id} to observe the shared upstream phase, saw: ${JSON.stringify(phases)}`,
      );
    }
  });
});
