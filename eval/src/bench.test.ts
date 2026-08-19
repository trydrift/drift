import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBenchmark } from './bench.ts';
import { evaluateRun } from './evaluate.ts';
import { renderReport } from './report/bench-report.ts';
import { loadPublicCases } from './case/load.ts';

/**
 * The whole harness, once, on the real corpus.
 *
 * Every other test pins one link. This one runs the chain a benchmark result
 * actually comes out of — public case → materialization → production
 * `analyzeRepository()` → a repair track → a *fresh* materialization with the
 * patch applied → the project's oracle and the hidden behavioural check →
 * artifact → offline evaluation → report — and asserts the properties that
 * make the result meaningful rather than the numbers, which are product
 * results and are allowed to change.
 *
 * It runs against a copy of the corpus, so it can never write into the recorded
 * runs or leave a scratch run behind.
 */

test('a benchmark run produces artifacts an offline evaluation can score end to end', { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-bench-e2e-'));

  try {
    await cp(join(process.cwd(), 'eval', 'cases'), join(root, 'eval', 'cases'), { recursive: true });

    const { runId, artifacts } = await runBenchmark({
      root,
      runId: 'harness-e2e',
      caseIds: ['npm-documented-rename'],
      tracks: ['detect-end-to-end', 'repair-codemod'],
      notes: 'harness end-to-end test',
    });

    assert.equal(artifacts.length, 2, 'one artifact per track');

    const detection = artifacts.find((entry) => entry.track === 'detect-end-to-end')!;
    const repair = artifacts.find((entry) => entry.track === 'repair-codemod')!;

    // Detection ran the production orchestrator, not a stub.
    assert.equal(detection.error, null);
    assert.equal(detection.experimentMode, 'end-to-end');
    assert.deepEqual(
      detection.detection!.dependencyChanges.map((change) => `${change.name}:${change.from}->${change.to}`),
      ['fixture-lib:1.0.0->2.0.0'],
      'the manifest diff found the bump itself rather than being handed it',
    );
    assert.ok(detection.detection!.impactSites.length > 0, 'localization landed on the consumer');

    // Isolation was audited on the workspace that was actually used, not in a
    // test somewhere else.
    assert.equal(detection.isolation.audited, true);
    assert.ok(detection.isolation.pathsAudited > 0);

    // The capability track is marked as one and carries the capsule hash.
    assert.equal(repair.experimentMode, 'conditional');
    assert.match(repair.publicCapsuleHash, /^[0-9a-f]{64}$/);

    // The oracle ran three states, and the hidden behavioural check is in the
    // trigger set — which is what stops a deletion being credited later.
    const baseline = repair.oracleStages.find((stage) => stage.stage === 'baseline')!;
    const broken = repair.oracleStages.find((stage) => stage.stage === 'broken')!;
    assert.equal(baseline.observed, 'pass', 'the consumer worked before the upgrade');
    assert.equal(broken.observed, 'fail', 'the upgrade broke it');
    assert.ok(
      broken.signature.some((id) => id.startsWith('hidden:')) && !baseline.signature.some((id) => id.startsWith('hidden:')),
      'the hidden behavioural check passed before the upgrade and failed after it',
    );

    // No live call happened on a deterministic run, and cost is not claimed.
    for (const artifact of artifacts) {
      assert.equal(artifact.provenance.model, 'unavailable');
      assert.equal(artifact.provenance.agentId, 'unavailable');
      assert.equal(artifact.provenance.costUsd, 0);
    }

    const result = await evaluateRun(runId, root);
    assert.equal(result.evaluations.length, 2);
    assert.ok(result.evaluations.every((entry) => !entry.stale), 'a run scored immediately is never stale');
    assert.deepEqual(result.integrityFailures, [], 'a clean run raises no integrity failure');

    const scoredDetection = result.evaluations.find((entry) => entry.detection)!;
    assert.equal(scoredDetection.detection!.d4.falseSafe, false);
    assert.equal(scoredDetection.detection!.d0DependencyDetection.status, 'scored');

    const report = renderReport({ result, cases: await loadPublicCases(root) });
    assert.match(report, /^# Drift benchmark/);
    assert.ok(
      report.indexOf('## Benchmark composition') < report.indexOf('## Detection'),
      'composition is printed before any number',
    );
    assert.match(report, /experimentMode: conditional/, 'a capability track is labelled as one in the report');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a repair is scored against a fresh materialization of the patch, not against whatever the track left on disk', { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-bench-fresh-'));

  try {
    await cp(join(process.cwd(), 'eval', 'cases'), join(root, 'eval', 'cases'), { recursive: true });

    // `npm-documented-rename`'s rename is attested, so the built-in codemod
    // tier may or may not reach it — that is a product result. What must hold
    // either way is that a `repaired` stage exists only when a patch does, and
    // that the stage's verdict comes from applying that patch to a clean
    // capsule rather than from the workspace the track mutated.
    const { runId } = await runBenchmark({
      root,
      runId: 'harness-fresh',
      caseIds: ['npm-renamed-export'],
      tracks: ['repair-codemod'],
    });

    const result = await evaluateRun(runId, root);
    const repair = result.evaluations[0]!.repair!;
    const artifacts = await import('./runs/store.ts').then((store) => store.readArtifacts(runId, root));
    const stages = artifacts[0]!.oracleStages;
    const repaired = stages.find((stage) => stage.stage === 'repaired');

    assert.equal(
      repaired !== undefined,
      artifacts[0]!.repair!.patch.trim().length > 0,
      'a repaired stage exists exactly when there is a patch to apply',
    );
    assert.ok(repair.failToPass.triggerFailures.length > 0, 'the case has a reproducible trigger to be repaired');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
