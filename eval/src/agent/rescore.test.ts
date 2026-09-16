import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCase } from './cases.ts';
import { rescoreRuns } from './rescore.ts';
import { writeRunManifest, writeTrial } from './store.ts';
import { makeTrial } from './test-helpers.ts';

/**
 * A validation mistake found after a paid run is corrected by narrowing the
 * rule and re-scoring the diff-derivable rules offline — never by rerunning
 * the agent, and never by editing the verdict in place without a record.
 */
describe('rescore', () => {
  test('re-evaluates only diff-derivable rules, records the previous outcome, and adopts the current case hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-agent-rescore-'));
    const caseDir = join(root, 'eval', 'agent', 'cases', 'case-a', 'hidden');
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(root, 'eval', 'agent', 'cases', 'case-a', 'case.yml'), 'placeholder: true\n');
    await writeFile(join(caseDir, 'reference.patch'), 'diff --git a/x b/x\n');
    const hiddenYml = (pattern: string) =>
      [
        'schemaVersion: drift-agent-case-v1',
        'caseId: case-a',
        'referencePatch: reference.patch',
        'referencePatchOrigin: benchmark-author',
        'tests:',
        '  - id: t',
        '    description: d',
        '    command: node -e 1',
        'forbidden:',
        '  - kind: pattern-not-added',
        '    glob: "src/**"',
        `    pattern: "${pattern}"`,
        '    description: no suppression',
        '  - kind: file-present',
        '    paths: [src/a.ts]',
        '    description: kept',
        '',
      ].join('\n');

    // The rule as it was when the trial ran: it fired on a legitimate `any`.
    await writeFile(join(caseDir, 'hidden.yml'), hiddenYml('@ts-ignore|: any'));
    const oldHash = await hashCase('case-a', root);
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,2 @@', '+const x: any = 1;', ' export {};'].join('\n');
    const trial = makeTrial({ caseId: 'case-a', condition: 'drift', repetition: 1, gross: 1000, success: false, reasons: ['prohibited_workaround'], caseHash: oldHash, runId: 'run-x' });
    trial.validation.hiddenTests[0]!.passed = true;
    trial.validation.forbidden = [
      { kind: 'pattern-not-added', description: 'no suppression', passed: false, detail: 'added in: src/a.ts' },
      { kind: 'file-present', description: 'kept', passed: true, detail: '' },
    ];
    trial.patch.files = 1;
    trial.patch.changedFiles = ['src/a.ts'];
    await writeRunManifest(
      {
        version: 'drift-agent-run-v1', runId: 'run-x', suite: 'test-suite', suiteStatus: 'draft', createdAt: '2026-09-16T00:00:00.000Z', command: 'x',
        driftCommit: 'd'.repeat(40), driftTreeDirty: false, provider: 'claude-code', requestedModel: 'm', requestedEffort: 'high', agentCliVersion: 'v',
        runsPerCondition: 1, conditions: ['baseline', 'drift'], caseIds: ['case-a'], node: 'v24', platform: 'darwin', arch: 'arm64', notes: '',
      },
      root,
    );
    await writeTrial(trial, { diff, streamLines: [] }, root);

    // Nothing changed yet: the hash matches, so nothing is re-scored.
    assert.deepEqual(await rescoreRuns(['run-x'], root), []);

    // Narrow the rule, then re-score.
    await writeFile(join(caseDir, 'hidden.yml'), hiddenYml('@ts-ignore'));
    const outcomes = await rescoreRuns(['run-x'], root, new Date('2026-09-17T00:00:00.000Z'));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.changed, true);
    assert.deepEqual(outcomes[0]!.after, { success: true, failureReasons: [] });

    const updated = JSON.parse(await readFile(join(root, 'eval', 'results', 'agent', 'raw', 'run-x', 'trials', 'case-a__drift__rep-01.json'), 'utf8'));
    assert.equal(updated.validation.success, true);
    assert.equal(updated.caseHash, await hashCase('case-a', root));
    assert.deepEqual(updated.rescore.previousFailureReasons, ['prohibited_workaround']);
    assert.equal(updated.rescore.previousCaseHash, oldHash);
    assert.deepEqual(updated.rescore.rulesReevaluated, ['pattern-not-added']);
    // The rule the diff cannot decide kept its recorded outcome.
    assert.deepEqual(updated.validation.forbidden.find((f: { kind: string }) => f.kind === 'file-present'), { kind: 'file-present', description: 'kept', passed: true, detail: '' });
  });
});
