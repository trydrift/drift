import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateRun } from './evaluate.ts';
import { writeArtifact } from './runs/store.ts';
import { hashPublicCapsule } from './runs/capsule.ts';
import { ARTIFACT_SCHEMA_VERSION, deterministicProvenance, type PredictionArtifact } from './artifacts/prediction.ts';

/**
 * Staleness, end to end through the evaluator rather than through the hash
 * function alone.
 *
 * The hash tests prove the hash notices a change. These prove the evaluator
 * *acts* on it: a trial whose capsule no longer matches is reported stale, is
 * not scored, and raises an integrity failure naming the case — never silently
 * re-scored against evidence it never saw.
 */

const CASE_ID = 'npm-documented-rename';

/** A working copy of the corpus, so a test can mutate a case without touching the repository. */
async function corpus(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'drift-eval-run-'));
  await cp(join(process.cwd(), 'eval', 'cases'), join(root, 'eval', 'cases'), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function artifactFor(capsuleHash: string): PredictionArtifact {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    runId: 'staleness-run',
    caseId: CASE_ID,
    publicCapsuleHash: capsuleHash,
    track: 'detect-end-to-end',
    experimentMode: 'end-to-end',
    provenance: deterministicProvenance({
      driftCommit: 'deadbeef',
      driftTreeDirty: false,
      adapterVersion: 'test',
      startedAt: '2026-08-19T00:00:00.000Z',
      finishedAt: '2026-08-19T00:00:01.000Z',
      latencyMs: 1,
    }),
    isolation: { audited: true, pathsAudited: 1, networkPolicy: 'disabled' },
    detection: {
      dependencyChanges: [{ name: 'fixture-lib', ecosystem: 'npm', from: '1.0.0', to: '2.0.0' }],
      triageSkipped: [],
      upstreamFindings: [],
      checkedSurfaces: [],
      breakingChanges: [],
      impactSites: [],
      gaps: [],
      verificationOutcomes: [],
      verdict: 'locally-affected',
    },
    oracleStages: [],
    observedCommands: [],
    error: null,
  };
}

test('a matching capsule is scored, and the adjudication revision it was scored against is recorded', async () => {
  const { root, cleanup } = await corpus();
  try {
    await writeArtifact(artifactFor(await hashPublicCapsule(CASE_ID, root)), root);
    const result = await evaluateRun('staleness-run', root);

    assert.equal(result.evaluations.length, 1);
    assert.equal(result.evaluations[0]!.stale, false);
    assert.ok(result.evaluations[0]!.detection, 'a current artifact is scored');
    assert.match(result.evaluations[0]!.adjudicationRevision, /^[0-9a-f]{16}$/);
    assert.deepEqual(result.integrityFailures, []);
  } finally {
    await cleanup();
  }
});

test('a public capsule change makes the artifact stale, unscored, and named in the integrity failures', async () => {
  const { root, cleanup } = await corpus();
  try {
    await writeArtifact(artifactFor(await hashPublicCapsule(CASE_ID, root)), root);

    const consumer = join(root, 'eval', 'cases', 'public', CASE_ID, 'consumer', 'src', 'app.js');
    await writeFile(consumer, `${await readFile(consumer, 'utf8')}\n// edited after the prediction\n`, 'utf8');

    const result = await evaluateRun('staleness-run', root);
    assert.equal(result.evaluations[0]!.stale, true);
    assert.equal(result.evaluations[0]!.detection, null, 'a stale artifact is never re-scored');
    assert.equal(result.integrityFailures.length, 1);
    assert.match(result.integrityFailures[0]!, new RegExp(`^${CASE_ID}: the public case capsule has changed`));
  } finally {
    await cleanup();
  }
});

test('an artifact that records no capsule hash is stale, because what it saw cannot be established', async () => {
  const { root, cleanup } = await corpus();
  try {
    await writeArtifact(artifactFor('unavailable'), root);
    const result = await evaluateRun('staleness-run', root);
    assert.equal(result.evaluations[0]!.stale, true);
    assert.equal(result.evaluations[0]!.detection, null);
    assert.match(result.integrityFailures[0]!, /records no public-capsule hash/);
  } finally {
    await cleanup();
  }
});

test('a changed adjudication re-scores the same artifact rather than staling it', async () => {
  const { root, cleanup } = await corpus();
  try {
    await writeArtifact(artifactFor(await hashPublicCapsule(CASE_ID, root)), root);

    const path = join(root, 'eval', 'cases', 'private', CASE_ID, 'adjudication.yml');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('groundTruthSafety: unsafe', 'groundTruthSafety: uncertain'), 'utf8');

    const result = await evaluateRun('staleness-run', root);
    assert.equal(result.evaluations[0]!.stale, false, 'truth revising itself is not evidence staleness');
    assert.ok(result.evaluations[0]!.detection, 'the artifact is re-scored against the new truth');
    assert.equal(result.evaluations[0]!.detection!.d4.groundTruthSafety, 'uncertain');
  } finally {
    await cleanup();
  }
});
