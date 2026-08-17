import { test, describe, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanUpgrades } from '../dist/upgrade/scan.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * A scan lists a package the moment its manifest names it, before anything has
 * been checked. That row is a promise that a verdict is coming, so every path
 * out of `scanUpgrades` has to keep it or withdraw it — including the paths
 * nobody plans for. A row left announced and unsettled is a package name with
 * a spinner that never stops, over work that is not happening.
 */

const config = DriftConfigSchema.parse({});
const logger = createLogger('error');
const realFetch = globalThis.fetch;

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-scan-rows-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { left: '1.0.0', right: '2.0.0' } }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
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

/** Every dependency is already at its newest version. */
function stubUpToDate(): void {
  clearHttpCache();
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    const version = url.includes('/left') ? '1.0.0' : '2.0.0';
    return Promise.resolve(
      new Response(JSON.stringify({ 'dist-tags': { latest: version }, versions: { [version]: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

describe('the rows a scan puts on screen', () => {
  test('a package is listed from its manifest before anything has checked it', async () => {
    stubUpToDate();
    const announced: { id: string; status: string; phase?: string }[] = [];

    await scanUpgrades({
      root,
      repo,
      config,
      logger,
      verify: { enabled: false },
      onCandidate: (candidate) =>
        announced.push({ id: candidate.id, status: candidate.status, phase: candidate.phase }),
    });

    const first = announced[0];
    assert.ok(first, 'something was announced');
    assert.equal(first.status, 'pending', 'the first thing a caller hears about is a row with nothing in it');
    assert.ok(first.phase, 'and it says it is waiting rather than showing an empty cell');
    assert.deepEqual(
      [...new Set(announced.map((entry) => entry.id))].sort(),
      ['package.json#left@1.0.0', 'package.json#right@2.0.0'],
      'one row per dependency, keyed on the installed version so it survives being filled in',
    );
  });

  test('a package with no upgrade to offer takes its row back', async () => {
    stubUpToDate();
    const announced = new Set<string>();
    const dropped: string[] = [];

    const result = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      verify: { enabled: false },
      onCandidate: (candidate) => announced.add(candidate.id),
      onDropped: (id) => dropped.push(id),
    });

    assert.equal(result.candidates.length, 0, 'nothing to upgrade');
    assert.deepEqual(
      [...announced].sort(),
      [...dropped].sort(),
      'every row that was put up was taken back down',
    );
  });

  test('a scan that is stopped withdraws the rows it never reached', async () => {
    // The failure this guards: cancellation used to leave every announced row
    // on screen with no verdict and no way to reach one, and each caller had
    // to clean that up itself to avoid a permanent spinner.
    stubUpToDate();
    const announced = new Set<string>();
    const dropped: string[] = [];
    const token = { isCancellationRequested: true };

    const result = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      token,
      verify: { enabled: false },
      onCandidate: (candidate) => announced.add(candidate.id),
      onDropped: (id) => dropped.push(id),
    });

    assert.equal(result.candidates.length, 0);
    assert.ok(announced.size > 0, 'the manifests were read, so rows went up');
    assert.deepEqual(
      [...dropped].sort(),
      [...announced].sort(),
      'and a stopped scan leaves none of them claiming a verdict is coming',
    );
  });
});
