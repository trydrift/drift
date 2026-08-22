import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanUpgrades, verifyUpgradeCandidates } from '../dist/upgrade/scan.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * `verifyUpgradeCandidates` is Deep Verification on its own: given candidates
 * a Quick Scan already produced, it installs and checks a subset of them
 * without repeating the scan. This is exactly the seam "Deep Verify" and
 * "Deep Verify All" call from the extension, and the same seam a cancelled
 * verification has to leave clean — the packages it never reached must fall
 * back to their Quick Scan result, not a stuck "checking" state.
 */

const config = DriftConfigSchema.parse({});
const logger = createLogger('error');
const realFetch = globalThis.fetch;

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-verify-candidates-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', scripts: { typecheck: 'node -e "process.exit(0)"' }, dependencies: { left: '1.0.0', right: '2.0.0' } }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

const repo = { owner: 'acme', name: 'app', defaultBranch: 'main' };

function stubUpToDate(): void {
  clearHttpCache();
  globalThis.fetch = ((input) => {
    const url = String(input);
    const version = url.includes('/left') ? '1.5.0' : '2.5.0';
    return Promise.resolve(
      new Response(JSON.stringify({ 'dist-tags': { latest: version }, versions: { [version]: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

describe('verifyUpgradeCandidates: Deep Verification as its own step', () => {
  test('a Quick Scan produces candidates with no verification field', async () => {
    stubUpToDate();
    const result = await scanUpgrades({ root, repo, config, logger, verify: { enabled: false } });

    assert.ok(result.candidates.length > 0, 'the scan should have found upgrades to report');
    for (const candidate of result.candidates) {
      assert.equal(candidate.verification, undefined, `${candidate.name} must not carry a verdict Quick Scan never measured`);
    }
  });

  test('verifying a subset standalone leaves the rest of a candidate list untouched', async () => {
    stubUpToDate();
    const scan = await scanUpgrades({ root, repo, config, logger, verify: { enabled: false } });
    assert.equal(scan.candidates.length, 2);

    const [toVerify, leaveAlone] = scan.candidates;
    const candidates = [toVerify];

    await verifyUpgradeCandidates({
      root,
      candidates,
      checks: ['typecheck'],
      timeoutMs: 60_000,
      env: process.env,
      logger,
    });

    assert.ok(candidates[0].verification, 'the targeted candidate was measured');
    // Nothing in the *other* candidate's object was ever touched — it was
    // never handed to `verifyUpgradeCandidates` at all.
    assert.equal(leaveAlone.verification, undefined);
  });

  test('cancelling mid-run settles the unreached candidates to skipped, not a stuck verdict', async () => {
    stubUpToDate();
    const scan = await scanUpgrades({ root, repo, config, logger, verify: { enabled: false } });
    const candidates = [...scan.candidates];
    const token = { isCancellationRequested: true };

    await verifyUpgradeCandidates({
      root,
      candidates,
      checks: ['typecheck'],
      timeoutMs: 60_000,
      env: process.env,
      logger,
      token,
    });

    for (const candidate of candidates) {
      assert.equal(candidate.verification?.status, 'skipped', `${candidate.name} must not be left with no verdict at all`);
      assert.match(candidate.verification?.reason ?? '', /cancelled/i);
    }
  });
});
