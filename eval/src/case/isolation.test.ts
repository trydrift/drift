import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditWorkspaceIsolation, WorkspaceIsolationError } from './layers.ts';
import { validateCase, publicCaseSchema, type PublicCase } from './schema.ts';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'drift-eval-isolation-'));
}

test('a workspace holding only public material audits clean', async () => {
  const root = await scratch();
  try {
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'package.json'), '{}');
    await writeFile(join(workspace, 'src', 'app.ts'), 'export const a = 1;\n');
    const audited = await auditWorkspaceIsolation(workspace, join(root, 'private'));
    assert.ok(audited >= 3, 'every entry is counted for the isolation record');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a gold patch inside the workspace fails the audit', async () => {
  const root = await scratch();
  try {
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, 'expected'), { recursive: true });
    await writeFile(join(workspace, 'expected', 'gold.patch'), 'diff --git a b\n');
    await assert.rejects(
      () => auditWorkspaceIsolation(workspace, join(root, 'private')),
      (err: Error) => err instanceof WorkspaceIsolationError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an adjudication or reviews directory inside the workspace fails the audit', async () => {
  for (const [dir, file] of [
    ['reviews', 'a.yml'],
    ['.', 'adjudication.yml'],
  ] as const) {
    const root = await scratch();
    try {
      const workspace = join(root, 'workspace');
      await mkdir(join(workspace, dir), { recursive: true });
      await writeFile(join(workspace, dir, file), 'fixtureId: x\n');
      await assert.rejects(() => auditWorkspaceIsolation(workspace, join(root, 'private')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a workspace materialized inside the private case root fails the audit', async () => {
  const root = await scratch();
  try {
    const privateRoot = join(root, 'private');
    const workspace = join(privateRoot, 'case-a', 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'package.json'), '{}');
    await assert.rejects(
      () => auditWorkspaceIsolation(workspace, privateRoot),
      /overlaps the private case root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlink pointing out of the workspace fails the audit', async () => {
  const root = await scratch();
  try {
    const workspace = join(root, 'workspace');
    const outside = join(root, 'private', 'case-a');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'truth.yml'), 'caseId: case-a\n');
    await symlink(outside, join(workspace, 'shortcut'));
    await assert.rejects(() => auditWorkspaceIsolation(workspace, join(root, 'private')), /links outside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The static half of the boundary. A prediction adapter that imports the
 * private loader would defeat every runtime check above, so this asserts the
 * import simply is not there — the cheapest possible check on the property
 * that actually matters, and one that fails the moment someone reintroduces
 * the old `predict(fixture, adjudication)` shape.
 */
test('no prediction adapter or repair tier imports private ground truth', async () => {
  const roots = ['eval/src/adapters', 'eval/src/tiers'];
  const forbidden = [/from\s+['"].*case\/private(\.ts)?['"]/, /\bloadPrivateTruth\b/, /\bloadAdjudication\b/];
  const offenders: string[] = [];

  for (const dir of roots) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const source = await readFile(join(dir, entry.name), 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(`${dir}/${entry.name} matches ${pattern}`);
      }
    }
  }

  assert.deepEqual(offenders, [], 'Layer C must not be able to read Layer D');
});

const MINIMAL: PublicCase = publicCaseSchema.parse({
  schemaVersion: 'drift-bench-case-v1',
  id: 'demo-case',
  provenanceKind: 'historical',
  ecosystem: 'npm',
  status: 'benchmark-ready',
  consumer: {
    repository: 'https://github.com/example/consumer',
    licence: 'MIT',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    migrationCommit: null,
    manifestPaths: ['package.json'],
    lockfilePaths: ['package-lock.json'],
    workspaceDir: '',
  },
  dependency: {
    name: 'left-pad',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    updateClass: 'major',
    section: 'dependencies',
    exposure: 'direct',
    upstreamRepository: 'unavailable',
    upstreamFromRef: 'unavailable',
    upstreamToRef: 'unavailable',
  },
  graph: {
    before: [{ name: 'left-pad', version: '1.0.0' }],
    after: [{ name: 'left-pad', version: '2.0.0' }],
    effectiveChanges: [{ name: 'left-pad', from: '1.0.0', to: '2.0.0' }],
  },
  environment: {
    runtimeVersion: 'v22.16.0',
    packageManager: 'npm',
    packageManagerVersion: '10.0.0',
    containerDigest: 'unavailable',
    platform: 'linux',
    arch: 'x64',
    timezone: 'UTC',
    locale: 'C',
  },
  oracles: {
    install: 'npm ci',
    baseline: { command: 'npm test', expect: 'pass', provenance: 'project-native' },
    broken: { command: 'npm test', expect: 'fail', provenance: 'project-native' },
    repaired: { command: 'npm test', expect: 'pass', provenance: 'project-native' },
  },
  networkPolicy: 'disabled',
  discovery: { source: 'migration-pr', reference: 'https://github.com/example/consumer/pull/1', minedAt: '2026-08-19', minerVersion: 'v1', importedFrom: '' },
  failureCategory: 'test-failure',
  migrationComplexity: 'direct',
  artifactHashes: { consumerTree: 'a', upstreamOld: 'b', upstreamNew: 'c', lockfileBefore: 'd', lockfileAfter: 'e', evidenceBundle: 'f' },
});

test('a benchmark-ready case is valid and needs no status reason', () => {
  assert.deepEqual(validateCase(MINIMAL), []);
});

test('a version range is rejected, because a range is not reproducible', () => {
  const problems = validateCase({ ...MINIMAL, dependency: { ...MINIMAL.dependency, toVersion: '^2.0.0' } });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /exact resolved version/);
});

test('a non-benchmark-ready case must say why, and a ready one must not', () => {
  assert.match(validateCase({ ...MINIMAL, status: 'flaky' })[0]!, /requires a statusReason/);
  assert.match(validateCase({ ...MINIMAL, statusReason: 'leftover' })[0]!, /must not carry a statusReason/);
});

test('a case claiming no failure cannot expect its bump-only state to fail', () => {
  const problems = validateCase({ ...MINIMAL, failureCategory: 'none' });
  assert.ok(problems.some((p) => /contradicts oracles.broken.expect/.test(p)));
});

test('a case whose direct bump is missing from the effective graph delta is rejected', () => {
  const problems = validateCase({
    ...MINIMAL,
    graph: { ...MINIMAL.graph, effectiveChanges: [{ name: 'other-pkg', from: '1.0.0', to: '2.0.0' }] },
  });
  assert.ok(problems.some((p) => /absent from graph.effectiveChanges/.test(p)));
});

test('the case schema is strict, so an expected-findings block cannot re-enter public case data', () => {
  assert.throws(() => publicCaseSchema.parse({ ...MINIMAL, expected: { findings: ['x'] } }));
});
