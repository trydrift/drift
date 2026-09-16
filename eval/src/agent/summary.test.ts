import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary, evaluateGates, writeSummary, type AgentBenchmarkSummary } from './summary.ts';
import { README_BLOCK_BEGIN, README_BLOCK_END, renderPublicCopy, renderReadmeBlock, renderReport } from './report.ts';
import { verifyPublicClaims } from './verify.ts';
import { writeRunManifest, writeTrial } from './store.ts';
import { makeTrial } from './test-helpers.ts';
import type { Condition } from './schema.ts';

/** A repository root with a suite, cases and one or two runs written through the real store. */
async function scaffold(input: { cases: number; runs: number; frozen?: boolean; caseHashMatches?: boolean; provenance?: 'historical' | 'synthetic' }): Promise<{ root: string; runIds: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'drift-agent-summary-'));
  const caseIds = Array.from({ length: input.cases }, (_, i) => `case-${String(i).padStart(2, '0')}`);
  await mkdir(join(root, 'eval', 'agent', 'suites'), { recursive: true });
  for (const id of caseIds) {
    const dir = join(root, 'eval', 'agent', 'cases', id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'case.yml'),
      [
        'schemaVersion: drift-agent-case-v1',
        `id: ${id}`,
        `title: ${id}`,
        `provenance: ${input.provenance ?? 'historical'}`,
        'role: development',
        'ecosystem: npm',
        'source:',
        '  kind: git',
        '  repository: https://example.invalid/repo.git',
        '  licence: MIT',
        `  baseCommit: ${'a'.repeat(40)}`,
        `  startCommit: ${'b'.repeat(40)}`,
        `  fixCommit: ${'c'.repeat(40)}`,
        'dependency: { name: dep, fromVersion: 1.0.0, toVersion: 2.0.0, updateClass: major, category: library }',
        'environment: { packageManager: npm }',
        'commands:',
        '  install: npm ci',
        '  checks: [{ name: test, kind: test, command: npm test }]',
        '  installedVersion: node -p 1',
        'integrity: { manifestPath: package.json }',
        'metadata: { failureMode: runtime, knownAffectedLocations: 1, migrationGuideAvailable: false, multiLocation: false }',
      ].join('\n'),
    );
  }
  await writeFile(
    join(root, 'eval', 'agent', 'suites', 'test-suite.json'),
    JSON.stringify({
      suite: 'test-suite',
      status: input.frozen ? 'frozen' : 'draft',
      description: 'test',
      frozenAt: input.frozen ? '2026-09-16T00:00:00.000Z' : null,
      runsPerCondition: input.runs,
      cases: caseIds.map((id) => ({ id, caseHash: input.caseHashMatches === false ? 'other' : `hash-${id}`, admittedAt: '2026-09-16T00:00:00.000Z', driftCommit: 'd'.repeat(40) })),
      removed: [],
    }),
  );
  const runIds = ['run-1'];
  for (const runId of runIds) {
    await writeRunManifest(
      {
        version: 'drift-agent-run-v1',
        runId,
        suite: 'test-suite',
        suiteStatus: input.frozen ? 'frozen' : 'draft',
        createdAt: '2026-09-16T00:00:00.000Z',
        command: 'test',
        driftCommit: 'd'.repeat(40),
        driftTreeDirty: false,
        provider: 'claude-code',
        requestedModel: 'claude-sonnet-5',
        requestedEffort: 'high',
        agentCliVersion: '2.1.267 (Claude Code)',
        runsPerCondition: input.runs,
        conditions: ['baseline', 'drift'],
        caseIds,
        node: 'v24',
        platform: 'darwin',
        arch: 'arm64',
        notes: '',
      },
      root,
    );
    for (const [ci, caseId] of caseIds.entries()) {
      for (let rep = 1; rep <= input.runs; rep += 1) {
        for (const condition of ['baseline', 'drift'] as Condition[]) {
          const baselineSuccess = (ci + rep) % 3 !== 0;
          const driftSuccess = (ci + rep) % 4 !== 0;
          const trial = makeTrial({
            caseId,
            condition,
            repetition: rep,
            runId,
            gross: condition === 'baseline' ? 100_000 + ci * 5_000 + rep * 1_000 : 45_000 + ci * 2_000 + rep * 500,
            success: condition === 'baseline' ? baselineSuccess : driftSuccess,
          });
          await writeTrial(trial, { diff: '', streamLines: [] }, root);
        }
      }
    }
  }
  return { root, runIds };
}

describe('canonical summary', () => {
  test('aggregates per case, per condition, and computes the headline as the median of case reductions', async () => {
    const { root, runIds } = await scaffold({ cases: 4, runs: 2 });
    const summary = await buildSummary({ runIds, root, now: new Date('2026-09-17T00:00:00.000Z') });
    assert.equal(summary.caseCount, 4);
    assert.equal(summary.efficiency.pairedCaseCount, 4);
    assert.equal(summary.runsPerCondition, 2);
    assert.ok(summary.efficiency.medianInputTokenReductionPct! > 50 && summary.efficiency.medianInputTokenReductionPct! < 60);
    assert.equal(summary.effectiveness.validBaselineTrials, 8);
    assert.equal(summary.effectiveness.validDriftTrials, 8);
    assert.equal(summary.effectiveness.differencePercentagePoints, (summary.effectiveness.driftSuccessRate! - summary.effectiveness.baselineSuccessRate!) * 100);
    assert.equal(summary.task.identicalAcrossConditions, true);
    assert.equal(summary.publication.eligible, false);
    const failed = summary.publication.gates.filter((g) => !g.passed).map((g) => g.name);
    assert.ok(failed.includes('minimum-cases'));
    assert.ok(failed.includes('frozen-suite'));
    assert.ok(failed.includes('minimum-valid-trials'));
    assert.equal(summary.methodology.bootstrap.length > 20, true);
  });

  test('refuses trials whose case hash a frozen suite does not contain', async () => {
    const { root, runIds } = await scaffold({ cases: 2, runs: 1, frozen: true, caseHashMatches: false });
    await assert.rejects(buildSummary({ runIds, root }), /case hash the frozen suite does not contain/);
  });

  test('gates pass on a frozen, historical, sufficiently large and fresh result', async () => {
    const { root, runIds } = await scaffold({ cases: 12, runs: 3, frozen: true });
    const summary = await buildSummary({ runIds, root, now: new Date('2026-09-17T00:00:00.000Z') });
    assert.deepEqual(summary.publication.gates.filter((g) => !g.passed), []);
    assert.equal(summary.publication.eligible, true);

    // Same data, stale: the freshness gate fails alone.
    const stale = evaluateGates(summary, undefined, new Date('2027-09-17T00:00:00.000Z'));
    assert.deepEqual(stale.gates.filter((g) => !g.passed).map((g) => g.name), ['freshness']);

    // Two confirmed models fail the one-model gate.
    const mixed = evaluateGates({ ...summary, confirmedModels: { 'claude-sonnet-5': 30, 'claude-opus-5': 6 } }, undefined, new Date('2026-09-17T00:00:00.000Z'));
    assert.ok(mixed.gates.find((g) => g.name === 'one-model')!.passed === false);
  });

  test('synthetic cases cannot pass the gates', async () => {
    const { root, runIds } = await scaffold({ cases: 12, runs: 3, frozen: true, provenance: 'synthetic' });
    const summary = await buildSummary({ runIds, root, now: new Date('2026-09-17T00:00:00.000Z') });
    assert.deepEqual(summary.publication.gates.filter((g) => !g.passed).map((g) => g.name), ['no-synthetic-cases']);
  });

  test('writes latest.json and a history copy', async () => {
    const { root, runIds } = await scaffold({ cases: 2, runs: 1 });
    const summary = await buildSummary({ runIds, root, now: new Date('2026-09-17T00:00:00.000Z') });
    const paths = await writeSummary(summary, root);
    assert.equal(JSON.parse(await readFile(paths.latest, 'utf8')).suite, 'test-suite');
    assert.match(paths.history, /history\/2026-09-17T00-00-00-000Z__test-suite__claude-sonnet-5\.json$/);
  });
});

describe('report generation', () => {
  test('the report carries the headline block, per-case table, gates and limitations', async () => {
    const { root, runIds } = await scaffold({ cases: 3, runs: 2 });
    const summary = await buildSummary({ runIds, root, now: new Date('2026-09-17T00:00:00.000Z') });
    const report = renderReport(summary);
    assert.match(report, /Dependency Upgrade Agent Benchmark/);
    assert.match(report, /Without Drift\s+\d+\.\d%/);
    assert.match(report, /\| case-00 \|/);
    assert.match(report, /Publication gates/);
    assert.match(report, /## Limitations/);
    assert.match(report, /Median case-level reduction: \d+\.\d%/);
  });

  test('the README block and public copy are withheld until the gates pass', async () => {
    const { root, runIds } = await scaffold({ cases: 3, runs: 2 });
    const summary = await buildSummary({ runIds, root, now: new Date('2026-09-17T00:00:00.000Z') });
    const block = renderReadmeBlock(summary);
    assert.ok(block.startsWith(README_BLOCK_BEGIN) && block.endsWith(README_BLOCK_END));
    assert.match(block, /does not yet meet the publication gates/);
    assert.doesNotMatch(block, /fewer agent input tokens/);
    assert.match(renderPublicCopy(summary), /Not generated/);
    assert.match(renderReadmeBlock(null), /No result has been generated yet/);

    const eligible: AgentBenchmarkSummary = { ...summary, publication: { ...summary.publication, eligible: true } };
    assert.match(renderReadmeBlock(eligible), /fewer agent input tokens/);
    assert.match(renderReadmeBlock(eligible), /Successful fixes/);
    assert.match(renderPublicCopy(eligible), /Product Hunt/);
    assert.match(renderPublicCopy(eligible), /successful remediations increased from \d+\.\d% to \d+\.\d%/);
  });
});

describe('stale public metric detection', () => {
  test('a README block that does not match latest.json, and an ungated claim, are reported', async () => {
    const { root, runIds } = await scaffold({ cases: 2, runs: 1 });
    const summary = await buildSummary({ runIds, root, now: new Date('2026-09-17T00:00:00.000Z') });
    await writeSummary(summary, root);
    await mkdir(join(root, 'site', 'src', 'data', 'benchmarks'), { recursive: true });
    await writeFile(join(root, 'site', 'src', 'data', 'benchmarks', 'agent.json'), JSON.stringify(summary), 'utf8');

    await writeFile(join(root, 'README.md'), `# x\n\n${renderReadmeBlock(summary)}\n`, 'utf8');
    assert.deepEqual(await verifyPublicClaims(root), []);

    await writeFile(join(root, 'README.md'), `# x\n\n${README_BLOCK_BEGIN}\n**67% fewer agent input tokens**\n${README_BLOCK_END}\n`, 'utf8');
    const findings = await verifyPublicClaims(root);
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.problem, /differs from what latest\.json generates/);

    await writeFile(join(root, 'README.md'), `# x\n\n${renderReadmeBlock(summary)}\n\nDrift gives 66.8% fewer agent input tokens.\n`, 'utf8');
    const ungated = await verifyPublicClaims(root);
    assert.ok(ungated.some((f) => /quantitative claim without a publishable result/.test(f.problem)));

    await writeFile(join(root, 'site', 'src', 'data', 'benchmarks', 'agent.json'), JSON.stringify({ ...summary, caseCount: 99 }), 'utf8');
    await writeFile(join(root, 'README.md'), `# x\n\n${renderReadmeBlock(summary)}\n`, 'utf8');
    const siteStale = await verifyPublicClaims(root);
    assert.ok(siteStale.some((f) => f.file.endsWith('agent.json')));
  });
});

describe('infrastructure retries', () => {
  test('an excluded trial is set aside for a retry and a valid one is refused', async () => {
    const { setAsideInfrastructureFailure, readTrials } = await import('./store.ts');
    const { root, runIds } = await scaffold({ cases: 1, runs: 1 });
    const valid = await setAsideInfrastructureFailure(runIds[0]!, 'case-00', 'baseline', 1, root);
    assert.equal(valid.setAside, false);
    const excluded = makeTrial({ caseId: 'case-00', condition: 'drift', repetition: 2, gross: 1, success: false, valid: false, infrastructureFailure: 'provider_error', runId: runIds[0] });
    await (await import('./store.ts')).writeTrial(excluded, { diff: '', streamLines: [] }, root);
    assert.equal((await readTrials(runIds[0]!, root)).length, 3);
    const retry = await setAsideInfrastructureFailure(runIds[0]!, 'case-00', 'drift', 2, root);
    assert.equal(retry.setAside, true);
    assert.match(retry.reason, /provider_error set aside as attempt 1/);
    // The set-aside attempt is no longer a trial, and the slot is free.
    assert.equal((await readTrials(runIds[0]!, root)).length, 2);
    await (await import('./store.ts')).writeTrial(excluded, { diff: '', streamLines: [] }, root);
    assert.equal((await readTrials(runIds[0]!, root)).length, 3);
  });
});
