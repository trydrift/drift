import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_STAGES,
  ECOSYSTEM_CAPABILITIES,
  capabilitiesFor,
  supportFor,
} from '../dist/detect/capabilities.js';
import { packageManagerById } from '../dist/detect/package-manager.js';
import { discoverTargets } from '../dist/upgrade/scan.js';
import { nodeWorkspaceFs } from '../dist/detect/workspace.js';

/**
 * "Sixteen ecosystems" was one claim covering several different capabilities.
 *
 * The commit-diff engine really does recognise sixteen. But *finding* an
 * available upgrade, and *installing* a chosen version, are separate abilities
 * that a row reading "detect: full" quietly implied. Swift and opam had no
 * version discovery at all while the matrix looked complete, and Gradle, sbt
 * and SwiftPM cannot pin a version from the command line at all.
 */

describe('the support matrix separates upgrade discovery from upgrade install', () => {
  test('both stages exist for every ecosystem', () => {
    for (const capability of ECOSYSTEM_CAPABILITIES) {
      assert.ok(capability.support['upgrade-discovery'], `${capability.ecosystem} has no discovery row`);
      assert.ok(capability.support['upgrade-install'], `${capability.ecosystem} has no install row`);
    }
  });

  test('every stage in every row carries a note unless it is full', () => {
    for (const capability of ECOSYSTEM_CAPABILITIES) {
      for (const stage of CAPABILITY_STAGES) {
        const support = capability.support[stage];
        if (support.level === 'full') continue;
        assert.ok(
          support.note && support.note.length > 0,
          `${capability.ecosystem}/${stage} is ${support.level} with no explanation`,
        );
      }
    }
  });

  test('install support is derived from the package managers, never restated', () => {
    // The table must agree with the only thing that actually decides it.
    for (const capability of ECOSYSTEM_CAPABILITIES) {
      const managers = capability.managers.length;
      const level = capability.support['upgrade-install'].level;
      assert.ok(managers > 0 && ['full', 'partial', 'none'].includes(level));
    }
  });

  test('SwiftPM cannot pin a version, and the matrix says so', () => {
    assert.equal(packageManagerById('swiftpm')!.upgrade({ name: 'x', version: '1.0.0', kind: 'runtime' }), null);
    assert.equal(supportFor('swift', 'upgrade-install').level, 'none');
  });

  test('Maven is partial because Gradle and sbt share its ecosystem and cannot pin', () => {
    const support = supportFor('maven', 'upgrade-install');
    assert.equal(support.level, 'partial');
    assert.match(support.note!, /Gradle/);
    assert.match(support.note!, /sbt/);
  });

  test('Swift and opam discovery is partial, since neither has a package registry', () => {
    assert.equal(supportFor('swift', 'upgrade-discovery').level, 'partial');
    assert.equal(supportFor('opam', 'upgrade-discovery').level, 'partial');
    assert.match(supportFor('swift', 'upgrade-discovery').note!, /git tags/);
    assert.match(supportFor('opam', 'upgrade-discovery').note!, /opam-repository/);
  });

  test('registry-backed ecosystems have full discovery', () => {
    for (const ecosystem of ['npm', 'pypi', 'cargo', 'go', 'rubygems', 'nuget'] as const) {
      assert.equal(supportFor(ecosystem, 'upgrade-discovery').level, 'full');
    }
  });

  test('the upgrade stages are not implied by the stages before them', () => {
    // The exact confusion the two new stages exist to prevent: a reader must
    // not be able to infer "Drift can upgrade this for me" from the earlier
    // columns. Both stages have to carry information the others do not, or
    // they are decoration.
    const rank = { full: 2, partial: 1, none: 0 } as const;

    const weakerThanEarlierStages = ECOSYSTEM_CAPABILITIES.filter((capability) => {
      const earliest = Math.min(
        rank[capability.support.detect.level],
        rank[capability.support.evidence.level],
      );
      return (
        rank[capability.support['upgrade-install'].level] < earliest ||
        rank[capability.support['upgrade-discovery'].level] < earliest
      );
    });

    assert.ok(
      weakerThanEarlierStages.length > 0,
      'no ecosystem has an upgrade stage weaker than its detect/evidence stages, ' +
        'which would mean the new columns add nothing a reader could not already infer',
    );

    // Swift is the concrete case: Drift reads Package.swift and researches the
    // package fine, and can neither enumerate versions off a registry nor pin
    // one from the command line.
    assert.equal(supportFor('swift', 'upgrade-install').level, 'none');
    assert.equal(capabilitiesFor('swift').support.evidence.level !== 'none', true);
  });
});

/**
 * Gradle keeps its versions in `gradle/libs.versions.toml`, which is not an
 * entry in the project directory — so a discovery pass built on `readdir()`
 * could never hand the scanner the file where the versions actually are.
 */
describe('Gradle version catalog discovery', () => {
  async function withProject(
    files: Record<string, string>,
    fn: (root: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'drift-gradle-'));
    try {
      for (const [path, content] of Object.entries(files)) {
        const full = join(root, path);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content, 'utf8');
      }
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test('the version catalog is discovered even though it is a nested path', async () => {
    await withProject(
      {
        'build.gradle': 'dependencies { implementation libs.guava }\n',
        'gradle/libs.versions.toml': '[libraries]\nguava = { module = "com.google.guava:guava", version = "33.0.0" }\n',
      },
      async (root) => {
        const { targets } = await discoverTargets(root, [''], new Map(), nodeWorkspaceFs());
        const gradle = targets.find((target) => target.manager.id === 'gradle');
        assert.ok(gradle, 'Gradle should be detected');
        assert.equal(
          gradle.manifestPath,
          'gradle/libs.versions.toml',
          'the catalog holds the versions, so it is the manifest to read',
        );
      },
    );
  });

  test('a Gradle project without a catalog still resolves to its build script', async () => {
    await withProject({ 'build.gradle': "dependencies { implementation 'com.google.guava:guava:33.0.0' }\n" }, async (root) => {
      const { targets } = await discoverTargets(root, [''], new Map(), nodeWorkspaceFs());
      const gradle = targets.find((target) => target.manager.id === 'gradle');
      assert.ok(gradle);
      assert.equal(gradle.manifestPath, 'build.gradle');
    });
  });
});

/**
 * pnpm/Yarn/Bun keep one lockfile at the repository root; a workspace member
 * usually has nothing but its own `package.json`. Detecting a member on its
 * own therefore matches every npm-ecosystem manager equally, and used to
 * settle on whichever sorted first in the manager table — npm — regardless of
 * what the repository actually uses.
 */
describe('workspace members inherit the root package manager', () => {
  async function withProject(
    files: Record<string, string>,
    fn: (root: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'drift-workspace-manager-'));
    try {
      for (const [path, content] of Object.entries(files)) {
        const full = join(root, path);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content, 'utf8');
      }
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test('a member with no lockfile of its own is resolved as the root’s pnpm, not npm', async () => {
    await withProject(
      {
        'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
        'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
        'packages/api/package.json': JSON.stringify({ name: 'api', dependencies: { zod: '^3.0.0' } }),
      },
      async (root) => {
        const { targets, ambiguities } = await discoverTargets(
          root,
          ['packages/api'],
          new Map(),
          nodeWorkspaceFs(),
        );
        const npmEcosystemTarget = targets.find((t) => t.manager.ecosystem === 'npm');
        assert.ok(npmEcosystemTarget, 'the member should still be detected');
        assert.equal(npmEcosystemTarget.manager.id, 'pnpm', 'the root lockfile decides, not manager-table order');
        assert.equal(ambiguities.length, 0, 'the root default resolves it without asking');
      },
    );
  });

  test('a member with its own lockfile is trusted over the root', async () => {
    await withProject(
      {
        'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
        'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
        'packages/legacy/package.json': JSON.stringify({ name: 'legacy', dependencies: { zod: '^3.0.0' } }),
        'packages/legacy/package-lock.json': JSON.stringify({ lockfileVersion: 3 }),
      },
      async (root) => {
        const { targets } = await discoverTargets(root, ['packages/legacy'], new Map(), nodeWorkspaceFs());
        const npmEcosystemTarget = targets.find((t) => t.manager.ecosystem === 'npm');
        assert.equal(npmEcosystemTarget?.manager.id, 'npm', 'this member genuinely opts out with its own lockfile');
      },
    );
  });
});
