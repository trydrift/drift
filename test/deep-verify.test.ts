import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeRepository, deepVerify } from '../dist/analysis.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * `analyzeRepository` is Quick Scan — it must never create a worktree,
 * install anything, or run the project's own checks, even when
 * `config.verify.enabled` is true and a real checkout is available.
 * `deepVerify` is the one function that does that, and only when explicitly
 * called with a plan Quick Scan already produced.
 */

const logger = createLogger('error');
const NO_NETWORK_CONFIG = {
  evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
  rationale: { security: false, maintenance: false, summary: false },
};

const PKG_BEFORE = JSON.stringify({ name: 'app', dependencies: { 'acme-sdk': '1.0.0' } });
const PKG_AFTER = JSON.stringify({ name: 'app', dependencies: { 'acme-sdk': '2.0.0' } });
const BEFORE_REF = 'sha-before';
const AFTER_REF = 'sha-after';

function fakeProvider() {
  return {
    changedFiles: async () => ['package.json'],
    readFile: async (path: string, ref: string) =>
      path === 'package.json' ? (ref === BEFORE_REF ? PKG_BEFORE : PKG_AFTER) : null,
  };
}

describe('analyzeRepository never verifies, even when it is asked to', () => {
  test('with no workspace, a plan is produced but never installed or checked', async () => {
    const config = DriftConfigSchema.parse({ verify: { enabled: true }, ...NO_NETWORK_CONFIG });
    const result = await analyzeRepository({
      repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
      config,
      logger,
      provider: fakeProvider(),
    });

    assert.ok(result.plan, 'the fixture should produce a plan');
    assert.equal(result.plan.verification, undefined, 'nothing measured this — Quick Scan never runs verification');
  });

  test('a real checkout with verify.enabled: true never grows a worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-quick-scan-noverify-'));
    try {
      writeFileSync(join(root, 'package.json'), PKG_AFTER);
      writeFileSync(join(root, 'package-lock.json'), '{}');
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
      const afterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

      const config = DriftConfigSchema.parse({ verify: { enabled: true }, ...NO_NETWORK_CONFIG });
      await analyzeRepository({
        repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha },
        config,
        logger,
        provider: fakeProvider(),
        workspace: root,
      });

      // No `git worktree add` was ever run against this checkout.
      const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: root }).toString().trim().split('\n');
      assert.equal(worktrees.length, 1, 'only the primary checkout should be listed');
      assert.ok(!existsSync(join(root, '.git', 'drift-worktrees')), 'no worktree scratch directory was created');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('deepVerify: continuing from a Quick Scan result', () => {
  test('a null plan is a no-op', async () => {
    const result = { plan: null, summary: 'nothing changed' };
    const config = DriftConfigSchema.parse({ verify: { enabled: true } });
    const verified = await deepVerify(result, {
      repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
      config,
      logger,
      provider: fakeProvider(),
    });
    assert.equal(verified, result);
  });

  test('no workspace to install into is a no-op, plan reference untouched', async () => {
    const config = DriftConfigSchema.parse({ verify: { enabled: true }, ...NO_NETWORK_CONFIG });
    const quick = await analyzeRepository({
      repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
      config,
      logger,
      provider: fakeProvider(),
    });

    const verified = await deepVerify(quick, {
      repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
      config,
      logger,
      provider: fakeProvider(),
    });

    assert.equal(verified.plan, quick.plan, 'without a workspace, deepVerify cannot measure anything');
  });

  test('verify.enabled: false is a hard ceiling deepVerify does not override', async () => {
    const config = DriftConfigSchema.parse({ verify: { enabled: false }, ...NO_NETWORK_CONFIG });
    const quick = await analyzeRepository({
      repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
      config,
      logger,
      provider: fakeProvider(),
    });

    const verified = await deepVerify(quick, {
      repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: AFTER_REF },
      config,
      logger,
      provider: fakeProvider(),
      workspace: tmpdir(),
    });

    assert.equal(verified.plan, quick.plan, 'a repository with verification switched off stays off');
  });
});
