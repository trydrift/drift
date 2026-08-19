import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notAttempted, scopeEscapes, type RepairContext, type TrackOutcome } from './context.ts';
import { createRepairCaptureBuilder } from '../adapters/repair-capture.ts';
import { patchStatsOf, type RepairArtifact } from '../artifacts/prediction.ts';
import { applyCommitFixPlan, type CommitUnit } from '../../../dist/index.js';
import { resolveFixPlans } from '../../../dist/fixplan/resolve.js';
import { connectAnthropic } from '../../../dist/analyze/llm.js';
import { dispositionFor } from '../../../dist/fixplan/policy.js';
import { noFixPlanCache } from '../../../dist/fixplan/cache.js';

/**
 * R2c — a fix plan authored by a live model, then validated and applied
 * deterministically.
 *
 * This is architecturally unlike coding-agent repair and must never be
 * reported as the same thing. The model is asked once, per breaking change,
 * for a *rule* — rename this identifier, replace this import path — and never
 * for edited code. Drift's own `validateFixPlan` then decides whether the rule
 * is grounded in the finding and derivable at this repository's real call
 * sites, and Drift's deterministic executor applies it. A finding that bites
 * fifty files costs exactly one model call, and a hallucinated rule is caught
 * by the gate rather than landing in fifty files.
 *
 * The benchmark therefore records the two halves separately, because they fail
 * for unrelated reasons and a pooled number would hide both: what the model
 * *proposed* (produced, declined as not-applicable, malformed, errored), and
 * what Drift's gate *decided* (accepted, partial, rejected, with reasons).
 * "The model declined" and "the model proposed something the validator
 * rejected" are opposite results — the first is a correct abstention, the
 * second is the gate earning its keep.
 */

export const TRACK_VERSION = 'repair-fixplan-model-v1';

export async function runModelFixPlanTrack(context: RepairContext): Promise<TrackOutcome> {
  const client = await connectAnthropic(context.config, context.logger);
  if (!client) {
    // Recorded as unavailable, never as a product failure and never faked.
    return { repair: notAttempted('model-unavailable') };
  }

  const fileContents = await readSiteContents(context);

  const resolved = await resolveFixPlans({
    changes: context.plan.breakingChanges,
    sites: context.plan.impactSites,
    evidence: context.plan.evidence,
    dependencyChanges: context.plan.changes,
    fileContents,
    config: context.config,
    logger: context.logger,
    cache: noFixPlanCache(),
    client,
  });

  const accepted = [...resolved.accepted.values()];
  const rejected = [...resolved.rejected.values()];

  const provenance = {
    provider: 'Anthropic',
    model: context.config.llm.model ?? 'unavailable',
    modelVersion: 'unavailable',
    promptVersion: 'drift-authorFixPlan',
    promptHash: 'unavailable',
    agentId: 'fixplan-model',
    agentLabel: 'Model-authored fix plan',
  };

  if (accepted.length === 0) {
    const first = rejected[0];
    return {
      repair: {
        ...notAttempted(first ? 'abstained-by-policy' : 'no-repairable-commit'),
        fixPlan: {
          // A rejected assessment proves a proposal existed; no assessment at
          // all means no source produced one for any finding.
          proposal: first ? 'produced' : 'declined-not-applicable',
          proposalSource: first?.plan.provenance.author ?? 'unavailable',
          operations: (first?.plan.ops ?? []).map((op) => ({ kind: op.kind, detail: JSON.stringify(op) })),
          validation: first ? 'rejected' : 'not-run',
          rejections: first?.rejections ?? [],
          coveredSites: first?.covered ?? 0,
          residualSites: first?.residual ?? 0,
          policyDisposition: first ? dispositionFor(first, context.config, {}).action : 'not-run',
        },
      },
      provenance,
    };
  }

  // Only commits the planner itself attached a fix plan to are applied. The
  // benchmark does not get to decide which findings a plan should cover.
  const commits = context.plan.commits.filter((commit) => commit.fixPlan);
  if (commits.length === 0) {
    return { repair: { ...notAttempted('no-repairable-commit'), fixPlan: summarize(accepted[0]!, context) }, provenance };
  }

  const capture = createRepairCaptureBuilder();
  const consumerDir = context.workspace.root;

  for (const commit of commits) {
    const disposition = dispositionFor(assessmentOf(commit), context.config, {
      verificationPassed: context.plan.verification?.status === 'passed',
    });
    // Production's own policy decides, including its "ask a human" state.
    // Treating `ask` as `apply` here would benchmark an unattended mode Drift
    // does not offer, and would flatter it.
    if (disposition.action !== 'apply') continue;

    const before = await snapshot(consumerDir, commit.fixPlan?.files ?? commit.allowedFiles);
    const result = applyCommitFixPlan(commit, before);
    if (result.status !== 'applied') continue;
    capture.recordCommit(commit.allowedFiles, before, result.edits);
    for (const edit of result.edits) await writeFile(join(consumerDir, edit.path), edit.content, 'utf8');
  }

  const captured = await capture.finalize();
  if (captured.changedFiles.length === 0) {
    return { repair: { ...notAttempted('empty-patch'), fixPlan: summarize(accepted[0]!, context) }, provenance };
  }

  const repair: RepairArtifact = {
    attempted: true,
    notAttemptedReason: null,
    resolvedByTier: commits.map((commit) => ({ commitId: commit.id, tier: 'fixplan-model' })),
    patch: captured.patch,
    changedFiles: captured.changedFiles,
    scopeEscapeFiles: scopeEscapes(captured.changedFiles, commits),
    scopeValidationReasons: [],
    patchStats: patchStatsOf(captured.patch),
    residualImpactSites: commits.reduce((total, commit) => total + (commit.fixPlan?.residual ?? 0), 0),
    fixPlan: summarize(accepted[0]!, context),
  };

  return { repair, provenance };
}

function summarize(assessment: Parameters<typeof dispositionFor>[0], context: RepairContext) {
  return {
    proposal: 'produced' as const,
    proposalSource: assessment.plan.provenance.author,
    operations: assessment.plan.ops.map((op) => ({ kind: op.kind, detail: JSON.stringify(op) })),
    validation: assessment.verdict === 'accepted' ? ('accepted' as const) : assessment.verdict === 'partial' ? ('partial' as const) : ('rejected' as const),
    rejections: assessment.rejections,
    coveredSites: assessment.covered,
    residualSites: assessment.residual,
    policyDisposition: dispositionFor(assessment, context.config, {}).action,
  };
}

/** The same `FixPlanAssessment` shape production's worktree runner reconstructs from a commit unit. */
function assessmentOf(commit: CommitUnit): Parameters<typeof dispositionFor>[0] {
  const fixPlan = commit.fixPlan!;
  return {
    plan: fixPlan.plan,
    verdict: fixPlan.residual === 0 ? 'accepted' : 'partial',
    assurance: fixPlan.assurance,
    sites: fixPlan.residualSites.map((site) => ({ file: site.file, line: site.line, before: '', status: 'residual' as const, reason: site.reason })),
    covered: fixPlan.covered,
    residual: fixPlan.residual,
    rejections: [],
    anchors: fixPlan.anchors,
  };
}

async function readSiteContents(context: RepairContext): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const site of context.plan.impactSites) {
    if (contents.has(site.file)) continue;
    try {
      contents.set(site.file, await readFile(join(context.workspace.root, site.file), 'utf8'));
    } catch {
      // Localization named a file that is not readable here; the validator
      // treats an absent file as an underivable site rather than a match.
    }
  }
  return contents;
}

async function snapshot(consumerDir: string, files: readonly string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of files) {
    try {
      contents.set(file, await readFile(join(consumerDir, file), 'utf8'));
    } catch {
      // Missing file: the applier skips it too.
    }
  }
  return contents;
}
