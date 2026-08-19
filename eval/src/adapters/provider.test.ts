import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASE_AFTER_REF, CASE_BEFORE_REF, CaseRepoProvider } from './case-repo-provider.ts';
import { toDetectionArtifact } from './detection-artifact.ts';

async function fixture(): Promise<{ root: string; provider: CaseRepoProvider }> {
  const root = await mkdtemp(join(tmpdir(), 'drift-provider-'));
  const workspaceRoot = join(root, 'consumer');
  const beforeDir = join(root, 'before');
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await mkdir(beforeDir, { recursive: true });
  await writeFile(join(beforeDir, 'package.json'), JSON.stringify({ dependencies: { lib: '1.0.0' } }));
  await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({ dependencies: { lib: '2.0.0' } }));
  await writeFile(join(workspaceRoot, 'src', 'app.ts'), 'export const a = 1;\n');
  return { root, provider: new CaseRepoProvider({ workspaceRoot, beforeDir }) };
}

test('end-to-end detection really starts from a manifest diff between two refs', async () => {
  const { root, provider } = await fixture();
  try {
    assert.deepEqual(await provider.changedFiles(), ['package.json']);
    assert.match((await provider.readFile('package.json', CASE_BEFORE_REF))!, /1\.0\.0/);
    assert.match((await provider.readFile('package.json', CASE_AFTER_REF))!, /2\.0\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a manifest that did not move is not reported as changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-provider-'));
  try {
    const workspaceRoot = join(root, 'consumer');
    const beforeDir = join(root, 'before');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(beforeDir, { recursive: true });
    const manifest = JSON.stringify({ dependencies: { lib: '1.0.0' } });
    await writeFile(join(beforeDir, 'package.json'), manifest);
    await writeFile(join(workspaceRoot, 'package.json'), manifest);
    assert.deepEqual(await new CaseRepoProvider({ workspaceRoot, beforeDir }).changedFiles(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the before ref cannot be listed, because claiming it is empty is a lie production acts on', async () => {
  const { root, provider } = await fixture();
  try {
    assert.equal(await provider.listFiles(CASE_BEFORE_REF), null, 'null means unknown; [] would mean "no files exist"');
    assert.ok((await provider.listFiles(CASE_AFTER_REF))!.includes('src/app.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file absent at a ref reads as null, which is how a newly added manifest is detected', async () => {
  const { root, provider } = await fixture();
  try {
    assert.equal(await provider.readFile('packages/api/package.json', CASE_BEFORE_REF), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const MULTI_CHANGE_PLAN = {
  changes: [{ name: 'lib', ecosystem: 'npm', from: '1.0.0', to: '2.0.0' }],
  evidence: [{ findings: [{ code: 'export-removed', symbol: 'alpha', detail: 'gone' }, { code: 'signature-changed', symbol: 'beta', detail: 'moved' }] }],
  breakingChanges: [
    { id: 'bc1', dependency: 'lib', kind: 'removed-export', symbols: ['alpha'], summary: 'alpha removed', taxonomy: { nature: 'api-shape', detectability: ['compile-time'], scope: 'symbol', visibility: ['direct'] } },
    { id: 'bc2', dependency: 'lib', kind: 'signature-change', symbols: ['beta'], summary: 'beta changed', taxonomy: { nature: 'behaviour', detectability: ['runtime'], scope: 'symbol', visibility: ['direct'] } },
  ],
  impactSites: [
    { breakingChangeId: 'bc1', file: 'src/a.ts', line: 3, matchedSymbol: 'alpha', excerpt: 'alpha()' },
    { breakingChangeId: 'bc2', file: 'src/b.ts', line: 9, matchedSymbol: 'beta', excerpt: 'beta()' },
  ],
  gaps: [],
};

test('a case with several breaking changes keeps all of them, each with its own taxonomy', () => {
  const artifact = toDetectionArtifact(MULTI_CHANGE_PLAN, {
    includeDependencyChanges: true,
    triageSkipped: [],
    checkedSurfaces: [],
    verificationOutcomes: [],
    verdictByChangeId: new Map([['bc1', 'locally-affected'], ['bc2', 'verification-incomplete']]),
    verdict: 'locally-affected',
  });

  assert.equal(artifact.breakingChanges.length, 2, 'no breakingChanges[0] assumption survives');
  assert.deepEqual(artifact.breakingChanges.map((change) => change.taxonomy?.nature), ['api-shape', 'behaviour']);
  assert.deepEqual(artifact.breakingChanges.map((change) => change.verdict), ['locally-affected', 'verification-incomplete']);
});

test('each impact site carries the kind of the change it belongs to, not the first one', () => {
  const artifact = toDetectionArtifact(MULTI_CHANGE_PLAN, {
    includeDependencyChanges: true,
    triageSkipped: [],
    checkedSurfaces: [],
    verificationOutcomes: [],
    verdictByChangeId: new Map(),
    verdict: 'locally-affected',
  });
  assert.deepEqual(artifact.impactSites.map((site) => site.breakingChangeKind), ['removed-export', 'signature-change']);
});

test('the known-bump adapter reports no dependency change, because it was given one rather than finding it', () => {
  const artifact = toDetectionArtifact(MULTI_CHANGE_PLAN, {
    includeDependencyChanges: false,
    triageSkipped: [],
    checkedSurfaces: [],
    verificationOutcomes: [],
    verdictByChangeId: new Map(),
    verdict: 'locally-affected',
  });
  assert.deepEqual(artifact.dependencyChanges, [], 'a diagnostic track must not claim credit for D0');
});
