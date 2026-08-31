import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discoverNestedProjects } from '../dist/detect/nested.js';

/**
 * Undeclared multi-project layouts — a root manifest plus a sibling
 * subdirectory manifest that no `workspaces` field ties together. Drift's own
 * repository is the motivating case: a root `package.json` and an
 * `extension/package.json`, unrelated as far as npm is concerned.
 */

/** A literal tree: keys are repo-relative paths, values are file contents. */
function tree(files: Record<string, string>) {
  const paths = Object.keys(files);
  const strip = (path: string) => path.replace(/^\/+/, '');

  return {
    async readFile(path: string) {
      return files[strip(path)] ?? null;
    },
    async readDirectory(path: string) {
      const prefix = strip(path) ? `${strip(path)}/` : '';
      const names = new Set<string>();
      for (const file of paths) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (rest) names.add(rest.split('/')[0]!);
      }
      return [...names];
    },
    async isDirectory(path: string) {
      const target = strip(path);
      return paths.some((file) => file.startsWith(`${target}/`));
    },
  };
}

describe('undeclared sibling manifests', () => {
  test('finds a nested manifest no workspaces field declares', async () => {
    const fs = tree({
      'package.json': '{"name":"root"}',
      'extension/package.json': '{"name":"drift"}',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found, [
      { dir: 'extension', ecosystem: 'npm', manifestPath: 'extension/package.json', hasOwnGit: false },
    ]);
  });

  test('a directory already covered by a declared workspace member is not reported again', async () => {
    const fs = tree({
      'package.json': '{"name":"root","workspaces":["packages/api"]}',
      'packages/api/package.json': '{"name":"@acme/api"}',
    });

    const found = await discoverNestedProjects('', fs, ['packages/api']);
    assert.deepEqual(found, []);
  });

  test('reports every undeclared manifest, not just the first', async () => {
    const fs = tree({
      'package.json': '{"name":"root"}',
      'extension/package.json': '{}',
      'tools/cli/Cargo.toml': '[package]\nname = "cli"',
    });

    const found = await discoverNestedProjects('', fs);
    const dirs = found.map((p) => p.dir).sort();
    assert.deepEqual(dirs, ['extension', 'tools/cli']);
    assert.equal(found.find((p) => p.dir === 'tools/cli')?.ecosystem, 'cargo');
  });

  test('finds nested manifests identified by a manager filename pattern', async () => {
    const fs = tree({
      'Directory.Packages.props': '<Project />',
      'src/App/App.csproj': '<Project />',
      'src/App/packages.lock.json': '{}',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found, [
      { dir: 'src/App', ecosystem: 'nuget', manifestPath: 'src/App/App.csproj', hasOwnGit: false },
    ]);
  });
});

describe('nested git boundaries', () => {
  test('a subdirectory with its own .git is flagged and not walked into', async () => {
    const fs = tree({
      'package.json': '{"name":"root"}',
      'external/widget/.git': '',
      'external/widget/package.json': '{"name":"widget"}',
      'external/widget/src/inner/package.json': '{"name":"should-not-surface"}',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found, [
      { dir: 'external/widget', ecosystem: 'npm', manifestPath: 'external/widget/package.json', hasOwnGit: true },
    ]);
  });
});

describe('ignored directories', () => {
  test('never walks into node_modules or other vendored trees', async () => {
    const fs = tree({
      'package.json': '{"name":"root"}',
      'node_modules/some-dep/package.json': '{"name":"some-dep"}',
      'dist/package.json': '{"name":"should-not-surface"}',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found, []);
  });

  test('never descends into .git itself', async () => {
    const fs = tree({
      'package.json': '{"name":"root"}',
      '.git/config': '',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found, []);
  });
});
