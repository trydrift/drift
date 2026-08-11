import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installUpgrade } from '../dist/upgrade/scan.js';

/**
 * A failed upgrade must leave nothing behind.
 *
 * For every manager that needs a manifest rewrite — Bundler, Mix, Rebar3,
 * CocoaPods, Conan, vcpkg, pip's `requirements.txt` — Drift edits the manifest
 * *before* running the install command, because those tools resolve against
 * whatever constraint is on disk rather than taking a version argument. So a
 * command that then fails used to leave the manifest declaring a version that
 * was never installed, and a lockfile that no longer matched it.
 *
 * For a tool whose entire proposition is safe modification, "half applied" is
 * the one outcome that cannot be allowed to exist.
 */

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withRepo<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'drift-install-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, name), content, 'utf8');
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A Bundler candidate: `rewriteManifest` edits the Gemfile, then `bundle` runs. */
const gemCandidate = {
  id: 'Gemfile#rails@7.0.0->7.1.0',
  name: 'rails',
  kind: 'runtime',
  ecosystem: 'rubygems',
  packageManager: 'bundler',
  manifestPath: 'Gemfile',
  current: '7.0.0',
  range: '~> 7.0',
  selected: '7.1.0',
  latest: '7.1.0',
  versions: ['7.1.0'],
  status: 'ready',
  evidenceCount: 0,
  breakingCount: 0,
  impactCount: 0,
  impactFiles: 0,
  risk: 'low',
  summary: '',
  gaps: [],
  toolRequests: [],
};

const GEMFILE = "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\n";
const LOCKFILE = 'GEM\n  specs:\n    rails (7.0.0)\n';

describe('installUpgrade: a failed upgrade rolls back', () => {
  test('the manifest rewrite is undone when the install command fails', async () => {
    await withRepo({ Gemfile: GEMFILE, 'Gemfile.lock': LOCKFILE }, async (root) => {
      // An empty PATH makes `bundle` unresolvable, so the command fails after
      // the manifest has already been rewritten — precisely the window this
      // rollback exists to close.
      await assert.rejects(
        installUpgrade(root, gemCandidate as never, 'safe', { PATH: '' }),
      );

      assert.equal(
        await readFile(join(root, 'Gemfile'), 'utf8'),
        GEMFILE,
        'the Gemfile must be byte-for-byte what it was before the attempt',
      );
    });
  });

  test('the lockfile is restored too, not just the manifest', async () => {
    await withRepo({ Gemfile: GEMFILE, 'Gemfile.lock': LOCKFILE }, async (root) => {
      await assert.rejects(installUpgrade(root, gemCandidate as never, 'safe', { PATH: '' }));

      assert.equal(await readFile(join(root, 'Gemfile.lock'), 'utf8'), LOCKFILE);
    });
  });

  test('a lockfile that did not exist before is not left behind', async () => {
    await withRepo({ Gemfile: GEMFILE }, async (root) => {
      await assert.rejects(installUpgrade(root, gemCandidate as never, 'safe', { PATH: '' }));

      assert.equal(
        await exists(join(root, 'Gemfile.lock')),
        false,
        'a lockfile created by a failed install is as much a leftover as an edit',
      );
    });
  });

  test('a missing package manager still reports the actionable error, not a restore error', async () => {
    await withRepo({ Gemfile: GEMFILE }, async (root) => {
      await assert.rejects(
        installUpgrade(root, gemCandidate as never, 'safe', { PATH: '' }),
        // Rolling back must not replace the error that explains what went wrong.
        /was not found on PATH/,
      );
    });
  });
});
