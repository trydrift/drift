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

describe('checked-in fixtures are inputs, not projects', () => {
  test('a fixture root is recognised wherever it sits below the test directory', async () => {
    // Poetry's real shape: one root manifest, and 96 under `tests/` at three
    // different depths. Requiring the fixture root to sit directly under
    // `tests/` found `tests/fixtures` and missed the other two.
    const fs = tree({
      'pyproject.toml': '[project]\nname = "poetry"',
      'tests/fixtures/sample_project/pyproject.toml': '[project]\nname = "sample"',
      'tests/fixtures/invalid_pyproject/pyproject.toml': 'this is deliberately not valid',
      'tests/utils/fixtures/pyproject.toml': '[project]\nname = "utils-fixture"',
      'tests/masonry/builders/fixtures/excluded_subpackage/pyproject.toml': '[project]\nname = "excluded"',
      'tests/registry/demo/package.json': '{"name":"demo"}',
      'tests/testdata/app/package.json': '{"name":"testdata-app"}',
    });

    assert.deepEqual(await discoverNestedProjects('', fs), []);
  });

  test('a real sibling project under tests/ is still found', async () => {
    // The rule is "below a fixture root", not "below tests/". A repository
    // that keeps a genuine helper package next to its tests still owns it.
    const fs = tree({
      'package.json': '{"name":"root"}',
      'tests/helper-app/package.json': '{"name":"helper-app"}',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found.map((project) => project.dir), ['tests/helper-app']);
  });

  test('a fixtures directory outside any test directory is still a project', async () => {
    // `fixtures/` at the root of a repository is as likely to be a package
    // that serves fixtures as it is to be a pile of them, and nothing here
    // marks it as test input. Left alone deliberately.
    const fs = tree({
      'package.json': '{"name":"root"}',
      'fixtures/package.json': '{"name":"@acme/fixtures"}',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found.map((project) => project.dir), ['fixtures']);
  });

  test('a fixture that is its own repository is still reported as one', async () => {
    // A vendored checkout under a fixture root is a separate repository, and
    // the caller is entitled to offer it as its own scan root.
    const fs = tree({
      'package.json': '{"name":"root"}',
      'tests/fixtures/vendored/.git': '',
      'tests/fixtures/vendored/package.json': '{"name":"vendored"}',
    });

    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found, [
      { dir: 'tests/fixtures/vendored', ecosystem: 'npm', manifestPath: 'tests/fixtures/vendored/package.json', hasOwnGit: true },
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
