import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuplicateTrialError, readArtifacts, writeArtifact, writeManifest, RUN_MANIFEST_VERSION } from './store.ts';
import { ARTIFACT_SCHEMA_VERSION, deterministicProvenance, isLiveTrial, UNAVAILABLE, type PredictionArtifact } from '../artifacts/prediction.ts';

function artifact(overrides: Partial<PredictionArtifact> = {}): PredictionArtifact {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    runId: 'r1',
    caseId: 'case-a',
    publicCapsuleHash: 'abc',
    track: 'repair-codemod',
    experimentMode: 'end-to-end',
    provenance: deterministicProvenance({
      driftCommit: 'deadbeef',
      driftTreeDirty: false,
      adapterVersion: 'v1',
      startedAt: '2026-08-19T00:00:00.000Z',
      finishedAt: '2026-08-19T00:00:01.000Z',
      latencyMs: 1000,
    }),
    isolation: { level: 'workspace-audit' as const, groundTruthReadableOnHost: true, spawnsSubprocesses: false, audited: true, pathsAudited: 12, networkPolicy: 'disabled' },
    oracleStages: [],
    observedCommands: [],
    error: null,
    ...overrides,
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'drift-store-'));
}

test('a deterministic track records no model and no agent, which is how CI proves it made no live call', () => {
  const deterministic = artifact();
  assert.equal(deterministic.provenance.model, UNAVAILABLE);
  assert.equal(deterministic.provenance.agentId, UNAVAILABLE);
  assert.equal(isLiveTrial(deterministic), false);
});

test('an artifact naming a model or an agent is a live trial', () => {
  const live = artifact({ provenance: { ...artifact().provenance, agentId: 'codex', model: 'gpt-5.5' } });
  assert.equal(isLiveTrial(live), true);
});

test('a repeated trial index is refused rather than overwriting, so a run cannot become best-of-k', async () => {
  const root = await scratch();
  try {
    await writeManifest(
      {
        version: RUN_MANIFEST_VERSION,
        runId: 'r1',
        createdAt: '2026-08-19T00:00:00.000Z',
        driftCommit: 'deadbeef',
        driftTreeDirty: false,
        scoringVersion: 'v1',
        command: 'test',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cases: [{ caseId: 'case-a', publicCapsuleHash: 'abc' }],
        notes: '',
      },
      root,
    );

    await writeArtifact(artifact(), root);
    await assert.rejects(() => writeArtifact(artifact(), root), (err: Error) => err instanceof DuplicateTrialError);

    // The next index is accepted, so a genuine second trial is recordable.
    await writeArtifact(artifact({ provenance: { ...artifact().provenance, trial: 2 } }), root);
    assert.equal((await readArtifacts('r1', root)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every attempt is retained, including the ones that failed', async () => {
  const root = await scratch();
  try {
    await writeArtifact(artifact({ provenance: { ...artifact().provenance, trial: 1 }, error: 'agent exited 1' }), root);
    await writeArtifact(artifact({ provenance: { ...artifact().provenance, trial: 2 } }), root);
    const stored = await readArtifacts('r1', root);
    assert.equal(stored.length, 2);
    assert.equal(stored.filter((entry) => entry.error !== null).length, 1, 'a failed attempt is not discarded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an artifact that never audited its workspace is representable, so the evaluator can reject it', () => {
  const unaudited = artifact({ isolation: { level: 'workspace-audit' as const, groundTruthReadableOnHost: true, spawnsSubprocesses: false, audited: false, pathsAudited: 0, networkPolicy: 'allowed' } });
  assert.equal(unaudited.isolation.audited, false);
});
