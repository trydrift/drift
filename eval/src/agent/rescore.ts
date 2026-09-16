import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashCase, loadHidden } from './cases.ts';
import { trialSchema, type ForbiddenRule, type TrialArtifact } from './schema.ts';
import { readTrials, runDir, trialBaseName } from './store.ts';
import { deriveFailureReasons, evaluateForbidden } from './validation.ts';

/**
 * Re-scoring recorded trials after a case's validation changed.
 *
 * Only rules that can be decided from the recorded diff are re-evaluated:
 * `pattern-not-added`, `no-test-deletions` and `path-unchanged`. Rules that
 * need the final tree (`pattern-absent`, `file-present`,
 * `manifest-scripts-unchanged`) keep their recorded outcome, and so do the
 * checks, the hidden tests and the integrity result — those were observed,
 * and nothing offline can observe them again.
 *
 * The artifact keeps its original outcome under `rescore`, so a reader can
 * see what changed and why; the suite manifest's `changes` log says why the
 * case changed. This is the free, offline half of the evaluator, and it
 * exists so a validation mistake found after a paid run can be corrected
 * without either re-running the agent (a new sample) or leaving a wrong
 * verdict in place.
 */

const DIFF_DERIVABLE: ReadonlySet<ForbiddenRule['kind']> = new Set(['pattern-not-added', 'no-test-deletions', 'path-unchanged']);

export interface RescoreOutcome {
  runId: string;
  trialId: string;
  changed: boolean;
  before: { success: boolean; failureReasons: string[] };
  after: { success: boolean; failureReasons: string[] };
}

export async function rescoreRuns(runIds: readonly string[], root = process.cwd(), now = new Date()): Promise<RescoreOutcome[]> {
  const outcomes: RescoreOutcome[] = [];
  const hashes = new Map<string, string>();
  for (const runId of runIds) {
    for (const trial of await readTrials(runId, root)) {
      if (!trial.validity.valid || trial.condition === undefined) continue;
      const currentHash = hashes.get(trial.caseId) ?? (await hashCase(trial.caseId, root));
      hashes.set(trial.caseId, currentHash);
      if (trial.caseHash === currentHash) continue;

      const hidden = await loadHidden(trial.caseId, root);
      const diffPath = join(runDir(runId, root), 'trials', `${trialBaseName(trial.caseId, trial.condition, trial.repetition)}.diff`);
      const diff = await readFile(diffPath, 'utf8').catch(() => trial.patch.diff);
      const patch = { ...trial.patch };

      const derivable = hidden.forbidden.filter((rule) => DIFF_DERIVABLE.has(rule.kind));
      const reevaluated = await evaluateForbidden(derivable, {
        diff,
        patch,
        readFinal: async () => null,
        readStart: async () => null,
        listFinal: async () => [],
      });
      // Recorded outcomes for rules the diff cannot decide are carried over by kind + description.
      const kept = trial.validation.forbidden.filter((entry) => !DIFF_DERIVABLE.has(entry.kind as ForbiddenRule['kind']));
      const forbidden = [...kept, ...reevaluated];

      const failureReasons = deriveFailureReasons({
        agentStatus: trial.agent.status,
        changedFiles: trial.patch.files,
        dependencyIntegrity: trial.validation.dependencyIntegrity,
        checks: trial.validation.checks,
        hiddenTests: trial.validation.hiddenTests,
        forbidden,
      });
      const success =
        trial.agent.status === 'completed' &&
        failureReasons.length === 0 &&
        trial.validation.hiddenTests.length > 0 &&
        trial.validation.hiddenTests.every((test) => test.passed);

      const updated: TrialArtifact = trialSchema.parse({
        ...trial,
        caseHash: currentHash,
        validation: { ...trial.validation, forbidden, success, failureReasons },
        rescore: {
          rescoredAt: now.toISOString(),
          previousCaseHash: trial.rescore?.previousCaseHash ?? trial.caseHash,
          previousSuccess: trial.rescore?.previousSuccess ?? trial.validation.success,
          previousFailureReasons: trial.rescore?.previousFailureReasons ?? trial.validation.failureReasons,
          rulesReevaluated: derivable.map((rule) => rule.kind),
        },
      });
      const path = join(runDir(runId, root), 'trials', `${trialBaseName(trial.caseId, trial.condition, trial.repetition)}.json`);
      await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      outcomes.push({
        runId,
        trialId: trial.trialId,
        changed: success !== trial.validation.success || failureReasons.join(',') !== trial.validation.failureReasons.join(','),
        before: { success: trial.validation.success, failureReasons: trial.validation.failureReasons },
        after: { success, failureReasons },
      });
    }
  }
  return outcomes;
}
