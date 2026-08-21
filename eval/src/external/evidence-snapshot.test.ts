import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { DATASETS } from './dataset.ts';
import { EvidenceSnapshotError, safeEvidenceCaseId, withEvidenceSnapshot } from './evidence-snapshot.ts';
import { rescoreExternal } from './cli.ts';
import { RUN_MANIFEST_VERSION } from './results.ts';
import { EXTERNAL_RECORD_VERSION, type ExternalCaseResult } from './record.ts';

const gzip = promisify(gzipCallback);

test('captured evidence replays with network unavailable and stable observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-evidence-'));
  let calls = 0;
  await usingFetch(async () => {
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ breaking: [1, 2, 3] });
    }) as typeof fetch;

    const first = await withEvidenceSnapshot(
      paths(root, 'case-a', 'capture'),
      async () => ((await (await fetch('https://registry.example.test/pkg')).json()) as { breaking: number[] }).breaking.length,
    );
    assert.equal(first.value, 3);
    assert.equal(first.evidence.mode, 'capture');
    assert.equal(first.evidence.requestCount, 1);

    globalThis.fetch = (async () => {
      throw new Error('network unavailable');
    }) as typeof fetch;

    const second = await withEvidenceSnapshot(
      paths(root, 'case-a', 'replay'),
      async () => ((await (await fetch('https://registry.example.test/pkg')).json()) as { breaking: number[] }).breaking.length,
    );
    assert.equal(second.value, 3);
    assert.equal(second.evidence.snapshotHash, first.evidence.snapshotHash);
    assert.equal(calls, 1);
  });
});

test('replay ignores changed upstream responses after capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-evidence-'));
  await usingFetch(async () => {
    globalThis.fetch = (async () => Response.json({ value: 'original' })) as typeof fetch;
    await withEvidenceSnapshot(paths(root, 'case-b', 'capture'), async () => (await (await fetch('https://example.test/a')).json()) as unknown);

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ value: 'changed' });
    }) as typeof fetch;
    const replayed = await withEvidenceSnapshot(
      paths(root, 'case-b', 'replay'),
      async () => ((await (await fetch('https://example.test/a')).json()) as { value: string }).value,
    );
    assert.equal(replayed.value, 'original');
    assert.equal(called, false);
  });
});

test('evidence hashes detect corrupted captured blobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-evidence-'));
  await usingFetch(async () => {
    globalThis.fetch = (async () => new Response('good')) as typeof fetch;
    const captured = await withEvidenceSnapshot(paths(root, 'case-c', 'capture'), async () => (await fetch('https://example.test/blob')).text());
    assert.equal(captured.value, 'good');

    const manifest = JSON.parse(await readFile(join(root, safeEvidenceCaseId('case-c'), 'snapshot.json'), 'utf8')) as {
      entries: { bodySha256: string }[];
    };
    await writeFile(join(root, 'blobs', manifest.entries[0]!.bodySha256), 'bad', 'utf8');

    await assert.rejects(
      () => withEvidenceSnapshot(paths(root, 'case-c', 'replay'), async () => (await fetch('https://example.test/blob')).text()),
      EvidenceSnapshotError,
    );
  });
});

test('rescoring stored external results does not perform network calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-rescore-'));
  const dir = join(root, 'eval', 'results', 'stored');
  await writeFile(join(await mkdir(dir, { recursive: true }).then(() => dir), 'manifest.json'), JSON.stringify(manifest(), null, 2));
  await writeFile(join(dir, 'selection.json'), JSON.stringify({ mode: 'all', limit: null, seed: 1, ids: ['case'], available: 1, dataset: DATASETS['roseau'] }, null, 2));
  await writeFile(join(dir, 'environment.json'), JSON.stringify({ tools: [] }, null, 2));
  await writeFile(join(dir, 'metrics.json'), JSON.stringify({ available: 1 }, null, 2));
  await writeFile(join(dir, 'cases.jsonl.gz'), await gzip(`${JSON.stringify(caseResult())}\n`));

  await usingFetch(async () => {
    globalThis.fetch = (async () => {
      throw new Error('rescore must not fetch');
    }) as typeof fetch;
    await rescoreExternal({ datasetId: '', benchmarksRoot: 'benchmarks', outRoot: root, rescore: 'stored' });
  });
});

test('fresh evidence fetches live content and records distinct provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-evidence-'));
  await usingFetch(async () => {
    globalThis.fetch = (async () => new Response('one')) as typeof fetch;
    const first = await withEvidenceSnapshot(paths(root, 'case-d-one', 'fresh'), async () => (await fetch('https://example.test/fresh')).text());

    globalThis.fetch = (async () => new Response('two')) as typeof fetch;
    const second = await withEvidenceSnapshot(paths(root, 'case-d-two', 'fresh'), async () => (await fetch('https://example.test/fresh')).text());

    assert.equal(first.value, 'one');
    assert.equal(second.value, 'two');
    assert.equal(first.evidence.mode, 'fresh');
    assert.equal(second.evidence.mode, 'fresh');
    assert.notEqual(first.evidence.snapshotHash, second.evidence.snapshotHash);
  });
});

function paths(root: string, caseId: string, mode: 'capture' | 'replay' | 'fresh') {
  return { mode, caseId, caseDir: join(root, safeEvidenceCaseId(caseId)), blobDir: join(root, 'blobs') };
}

async function usingFetch(work: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = original;
  }
}

function manifest() {
  return {
    version: RUN_MANIFEST_VERSION,
    runId: 'stored',
    datasetId: 'roseau',
    createdAt: '2026-08-21T00:00:00.000Z',
    driftCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    driftTreeDirty: false,
    harnessVersion: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    datasetVersion: 'test',
    command: 'test',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    notes: '',
  };
}

function caseResult(): ExternalCaseResult {
  return {
    schemaVersion: EXTERNAL_RECORD_VERSION,
    caseId: 'case',
    provenance: {
      dataset: 'roseau',
      datasetVersion: 'test',
      recordId: 'case',
      repository: 'https://example.test/repo',
      commit: 'test',
      baseCommit: null,
      dependency: 'x',
      fromVersion: '1',
      toVersion: '2',
      packageManager: 'maven',
      requiredRuntime: null,
      oracleCommand: null,
      containerImage: null,
      sourceHash: createHash('sha256').update('case').digest('hex'),
      extra: {},
    },
    truth: { label: 'not-binary-breaking', mappedTo: 'not-breaking', mappingStatus: 'exact', mappingNote: '', polarity: 'negative' },
    prediction: { changes: [], changeCount: 0 },
    outcomes: {},
    predictedPositive: false,
    excluded: null,
    durationMs: 1,
  };
}
