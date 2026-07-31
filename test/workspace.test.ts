import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
import { createLogger } from '../dist/util/logger.js';
import {
  detectWorkspaces,
  expandPattern,
  memberDirectories,
  memberOf,
  withinMember,
} from '../dist/detect/workspace.js';

/**
 * A monorepo is many projects sharing a checkout, not one project with many
 * manifests. Getting the boundary wrong is what made a bump in `packages/api`
 * surface impact sites in `packages/web`, so these tests are about exactly
 * where each package ends.
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

describe('npm and pnpm workspaces', () => {
  const files = {
    'package.json': '{"name":"root","workspaces":["packages/*"]}',
    'packages/api/package.json': '{"name":"@acme/api"}',
    'packages/web/package.json': '{"name":"@acme/web"}',
    'packages/web/src/index.ts': '',
  };

  test('expands the members and names them', async () => {
    const [layout] = await detectWorkspaces('', tree(files));
    assert.equal(layout!.kind, 'npm-workspaces');
    assert.deepEqual(
      layout!.members.map((m) => [m.dir, m.name]),
      [
        ['', 'root'],
        ['packages/api', '@acme/api'],
        ['packages/web', '@acme/web'],
      ],
    );
  });

  test('pnpm-workspace.yaml wins, because it is the file pnpm reads', async () => {
    const layouts = await detectWorkspaces(
      '',
      tree({ ...files, 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n' }),
    );
    assert.deepEqual(layouts.map((l) => l.kind), ['pnpm-workspace']);
    assert.equal(layouts[0]!.members.length, 3);
  });

  test('a plain package is not a workspace', async () => {
    assert.deepEqual(await detectWorkspaces('', tree({ 'package.json': '{"name":"solo"}' })), []);
  });

  test('the object form of `workspaces` is read too', async () => {
    const [layout] = await detectWorkspaces(
      '',
      tree({ ...files, 'package.json': '{"name":"root","workspaces":{"packages":["packages/*"]}}' }),
    );
    assert.equal(layout!.members.length, 3);
  });
});

describe('cargo workspaces', () => {
  test('a virtual manifest is not a member of its own workspace', async () => {
    const [layout] = await detectWorkspaces(
      '',
      tree({
        'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/cli"]\n',
        'crates/core/Cargo.toml': '[package]\nname = "acme-core"\n',
        'crates/cli/Cargo.toml': '[package]\nname = "acme-cli"\n',
      }),
    );

    assert.equal(layout!.kind, 'cargo-workspace');
    assert.deepEqual(
      layout!.members.map((m) => [m.dir, m.name]),
      [
        ['crates/cli', 'acme-cli'],
        ['crates/core', 'acme-core'],
      ],
    );
  });

  test('a root that is also a package is a member', async () => {
    const [layout] = await detectWorkspaces(
      '',
      tree({
        'Cargo.toml': '[package]\nname = "acme"\n\n[workspace]\nmembers = ["xtask"]\n',
        'xtask/Cargo.toml': '[package]\nname = "xtask"\n',
      }),
    );
    assert.deepEqual(layout!.members.map((m) => m.dir), ['', 'xtask']);
  });
});

describe('go, maven and gradle', () => {
  test('go.work `use` blocks and single lines', async () => {
    const [layout] = await detectWorkspaces(
      '',
      tree({
        'go.work': 'go 1.22\n\nuse (\n\t./api\n\t./worker\n)\n\nuse ./tools\n',
        'api/go.mod': 'module example.com/api\n',
        'worker/go.mod': 'module example.com/worker\n',
        'tools/go.mod': 'module example.com/tools\n',
      }),
    );
    assert.deepEqual(layout!.members.map((m) => m.dir), ['api', 'tools', 'worker']);
    assert.equal(layout!.members[0]!.name, 'example.com/api');
  });

  test('maven `<modules>` in the parent pom', async () => {
    const [layout] = await detectWorkspaces(
      '',
      tree({
        'pom.xml': '<project><artifactId>parent</artifactId><modules><module>core</module><module>web</module></modules></project>',
        'core/pom.xml': '<project><artifactId>core</artifactId></project>',
        'web/pom.xml': '<project><artifactId>web</artifactId></project>',
      }),
    );
    assert.equal(layout!.kind, 'maven-modules');
    assert.deepEqual(layout!.members.map((m) => m.dir), ['', 'core', 'web']);
  });

  test('gradle project paths become directories', async () => {
    const [layout] = await detectWorkspaces(
      '',
      tree({
        'settings.gradle.kts': 'rootProject.name = "acme"\ninclude(":app", ":core:data")\n',
        'app/build.gradle.kts': '',
        'core/data/build.gradle.kts': '',
      }),
    );
    assert.deepEqual(layout!.members.map((m) => m.dir), ['app', 'core/data']);
  });
});

describe('pattern expansion', () => {
  const files = tree({
    'packages/api/package.json': '',
    'packages/web/package.json': '',
    'packages/nested/inner/package.json': '',
    'apps/site/package.json': '',
  });

  test('a literal path is itself', async () => {
    assert.deepEqual(await expandPattern('', files, './packages/api'), ['packages/api']);
  });

  test('a trailing star lists the directories one level down', async () => {
    assert.deepEqual((await expandPattern('', files, 'packages/*')).sort(), [
      'packages/api',
      'packages/nested',
      'packages/web',
    ]);
  });

  test('a double star descends', async () => {
    assert.ok((await expandPattern('', files, 'packages/**')).includes('packages/nested/inner'));
  });

  test('negations are not members', async () => {
    assert.deepEqual(await expandPattern('', files, '!packages/web'), []);
  });
});

describe('the boundary itself', () => {
  const members = ['', 'packages/api', 'packages/web', 'packages/web/plugins/auth'];

  test('the longest matching prefix owns a file', () => {
    assert.equal(memberOf('packages/api/src/db.ts', members), 'packages/api');
    assert.equal(memberOf('packages/web/plugins/auth/index.ts', members), 'packages/web/plugins/auth');
    assert.equal(memberOf('tsconfig.json', members), '');
  });

  test('a file with no owning member is not forced into one', () => {
    assert.equal(memberOf('scripts/release.ts', ['packages/api']), null);
  });

  test('a prefix that is not a path boundary does not match', () => {
    assert.equal(memberOf('packages/api-client/src/x.ts', ['packages/api']), null);
    assert.equal(withinMember('packages/api-client/x.ts', 'packages/api'), false);
    assert.equal(withinMember('packages/api/x.ts', 'packages/api'), true);
  });

  test('the root member contains everything', () => {
    assert.equal(withinMember('anything/at/all.ts', ''), true);
  });

  test('a repository with no workspace still yields one directory to scan', () => {
    assert.deepEqual(memberDirectories([]), ['']);
  });
});

describe('localization respects the boundary', () => {
  const source = (path: string) =>
    ({
      path,
      language: 'typescript' as never,
      content: "import { createClient } from 'acme-sdk';\n\nexport const client = createClient();\n",
      lineCount: 3,
    });

  const files = [source('packages/api/src/db.ts'), source('packages/web/src/page.ts')];
  const index = buildIndex(files);

  const breaking = [
    {
      id: 'bc1',
      dependency: 'acme-sdk',
      kind: 'removed-export' as never,
      summary: '`createClient` was removed',
      symbols: ['createClient'],
      evidenceIds: ['ev1'],
      confidence: 'high' as never,
    },
  ];

  const change = (dir: string) => ({
    name: 'acme-sdk',
    ecosystem: 'npm' as never,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as never,
    bump: 'major' as never,
    manifestPath: `${dir}/package.json`,
    workspace: dir,
  });

  test("a bump in one package does not reach its sibling", () => {
    const sites = localize(breaking, [change('packages/api')], index, files, {
      logger: createLogger('error'),
      member: 'packages/api',
    });

    assert.deepEqual([...new Set(sites.map((s) => s.file))], ['packages/api/src/db.ts']);
  });

  test('without a member, the whole repository is still in scope', () => {
    const sites = localize(breaking, [change('packages/api')], index, files, {
      logger: createLogger('error'),
    });

    assert.deepEqual([...new Set(sites.map((s) => s.file))].sort(), [
      'packages/api/src/db.ts',
      'packages/web/src/page.ts',
    ]);
  });
});
