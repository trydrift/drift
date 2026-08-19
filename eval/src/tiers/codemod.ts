import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notAttempted, scopeEscapes, type RepairContext, type TrackOutcome } from './context.ts';
import { createRepairCaptureBuilder } from '../adapters/repair-capture.ts';
import { patchStatsOf } from '../artifacts/prediction.ts';
import { applyBuiltinCodemod, type CommitUnit } from '../../../dist/index.js';

/**
 * R1 — Drift's built-in deterministic codemod.
 *
 * The narrowest and the most trustworthy tier: no model, no network, and a
 * scope of exactly one rule (`rename-identifier`) anchored to already-localized
 * impact-site lines. It is the tier whose correctness is provable by
 * construction, so a failure here is a much more serious signal than a failure
 * in any later tier.
 *
 * Only commit units the *plan* marked as codemod-resolvable are attempted.
 * Deciding here which commits look mechanical enough would be the benchmark
 * making Drift's own remediation-priority decision for it, and would measure
 * the harness's judgement rather than the product's.
 */

export const TRACK_VERSION = 'repair-codemod-v1';

export async function runCodemodTrack(context: RepairContext): Promise<TrackOutcome> {
  const commits = context.plan.commits.filter((commit) => commit.codemod);
  if (commits.length === 0) return { repair: notAttempted('no-repairable-commit') };

  const capture = createRepairCaptureBuilder();
  const consumerDir = context.workspace.root;

  for (const commit of commits) {
    const before = await snapshot(consumerDir, commit);
    const result = applyBuiltinCodemod(commit, before);
    capture.recordCommit(commit.allowedFiles, before, result.edits);
    for (const edit of result.edits) {
      await writeFile(join(consumerDir, edit.path), edit.content, 'utf8');
    }
  }

  const captured = await capture.finalize();

  // A tier that reports "attempted" and changed nothing has not repaired
  // anything, and must not reach the oracle where a still-green check could
  // be mistaken for a fix. It is recorded as an empty patch, which is a
  // distinct and diagnosable outcome from an abstention.
  if (captured.changedFiles.length === 0) return { repair: notAttempted('empty-patch') };

  return {
    repair: {
      attempted: true,
      notAttemptedReason: null,
      resolvedByTier: commits.map((commit) => ({ commitId: commit.id, tier: 'codemod' })),
      patch: captured.patch,
      changedFiles: captured.changedFiles,
      scopeEscapeFiles: scopeEscapes(captured.changedFiles, commits),
      scopeValidationReasons: [],
      patchStats: patchStatsOf(captured.patch),
      residualImpactSites: residualSites(context, commits),
    },
  };
}

/**
 * Impact sites this repair left untouched.
 *
 * A tier that fixed nine of ten call sites has not finished, and a benchmark
 * that only asks "did the check go green" would miss the tenth whenever the
 * check does not happen to exercise it — which is exactly the second-order
 * effect a build-error-driven tool cannot see.
 */
function residualSites(context: RepairContext, commits: readonly CommitUnit[]): number {
  const addressed = new Set(commits.flatMap((commit) => commit.breakingChangeIds));
  return context.plan.impactSites.filter((site) => !addressed.has(site.breakingChangeId)).length;
}

async function snapshot(consumerDir: string, commit: CommitUnit): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of commit.allowedFiles.length > 0 ? commit.allowedFiles : commit.files) {
    try {
      contents.set(file, await readFile(join(consumerDir, file), 'utf8'));
    } catch {
      // A file the plan named but that does not exist is skipped by the
      // applier too; recording it as empty would fabricate a deletion.
    }
  }
  return contents;
}
