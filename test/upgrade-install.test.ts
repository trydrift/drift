import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installUpgrade, installUpgrades } from '../dist/upgrade/scan.js';

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

/**
 * A manifest with twenty outdated packages used to mean twenty package-manager
 * runs before a single check ran — twenty resolutions of a dependency graph
 * that barely changed between them, and twenty lockfile writes.
 */
describe('installUpgrades: a whole batch in as few runs as possible', () => {
  const gem = (name: string, version: string) => ({
    ...gemCandidate,
    id: `Gemfile#${name}`,
    name,
    selected: version,
  });

  test('rewrites every manifest entry before running anything', async () => {
    const gemfile = "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\ngem 'puma', '~> 6.0'\n";
    await withRepo({ Gemfile: gemfile }, async (root) => {
      // `bundle` is unresolvable, so this fails after the rewrites — which is
      // what makes the rollback observable.
      await assert.rejects(
        installUpgrades(root, [gem('rails', '7.1.0'), gem('puma', '6.4.0')] as never, 'safe', { PATH: '' }),
      );

      assert.equal(
        await readFile(join(root, 'Gemfile'), 'utf8'),
        gemfile,
        'a batch is as transactional as a single install',
      );
    });
  });

  test('declines a batch that does not share one manifest', async () => {
    await withRepo({ Gemfile: GEMFILE }, async (root) => {
      const elsewhere = { ...gem('puma', '6.4.0'), manifestPath: 'api/Gemfile' };
      assert.equal(
        await installUpgrades(root, [gem('rails', '7.1.0'), elsewhere] as never, 'safe', { PATH: '' }),
        false,
        'two manifests are two resolutions, whatever the manager can take',
      );
    });
  });

  test('declines a manager that takes one package per command', async () => {
    const project = '<Project><ItemGroup></ItemGroup></Project>';
    await withRepo({ 'app.csproj': project }, async (root) => {
      const nuget = (name: string) => ({
        ...gemCandidate,
        id: `csproj#${name}`,
        name,
        ecosystem: 'nuget',
        packageManager: 'dotnet',
        manifestPath: 'app.csproj',
        selected: '2.0.0',
      });

      assert.equal(
        await installUpgrades(root, [nuget('Serilog'), nuget('Polly')] as never, 'safe', { PATH: '' }),
        false,
        '`dotnet add package` names exactly one package',
      );
      assert.equal(await readFile(join(root, 'app.csproj'), 'utf8'), project);
    });
  });

  test('an empty batch is nothing to do, not an error', async () => {
    await withRepo({ Gemfile: GEMFILE }, async (root) => {
      assert.equal(await installUpgrades(root, [] as never, 'safe', { PATH: '' }), false);
    });
  });
});

describe('installUpgrade: Cargo placement metadata reaches cargo add', () => {
  const cargoCandidate = {
    ...gemCandidate,
    id: 'Cargo.toml#sha2@0.10.0->0.11.0',
    name: 'sha2',
    kind: 'runtime',
    cargo: { section: 'dependencies', target: 'cfg(not(target_arch = "wasm32"))' },
    ecosystem: 'cargo',
    packageManager: 'cargo',
    manifestPath: 'Cargo.toml',
    current: '0.10.0',
    range: '0.10',
    selected: '0.11.0',
    latest: '0.11.0',
  };

  test('target-specific dependencies are not re-added as unconditional dependencies', async () => {
    const manifest = `[package]
name = "probe"
version = "0.1.0"
edition = "2021"

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
sha2 = "0.10"
`;

    await withRepo({ 'Cargo.toml': manifest }, async (root) => {
      const bin = join(root, 'bin');
      await mkdir(bin);
      const fakeCargo = join(bin, 'cargo');
      await writeFile(
        fakeCargo,
        `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const manifest = 'Cargo.toml';
let content = readFileSync(manifest, 'utf8');
if (args.includes('--target')) {
  content = content.replace('sha2 = "0.10"', 'sha2 = "=0.11.0"');
} else {
  content += '\\n[dependencies]\\nsha2 = "=0.11.0"\\n';
}
writeFileSync(manifest, content);
`,
        'utf8',
      );
      await chmod(fakeCargo, 0o755);

      await installUpgrade(root, cargoCandidate as never, 'safe', {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      });

      const updated = await readFile(join(root, 'Cargo.toml'), 'utf8');
      assert.equal((updated.match(/^\[dependencies\]$/gm) ?? []).length, 0);
      assert.match(updated, /\[target\.'cfg\(not\(target_arch = "wasm32"\)\)'\.dependencies\]/);
      assert.match(updated, /sha2 = "=0\.11\.0"/);
    });
  });
});
