import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notAttempted, scopeEscapes, type RepairContext, type TrackOutcome } from './context.ts';
import { createRepairCaptureBuilder } from '../adapters/repair-capture.ts';
import { patchStatsOf, type RepairArtifact } from '../artifacts/prediction.ts';
import { applyCommitFixPlan, assessmentOf, buildPlan, type CommitUnit, type RemediationPlan } from '../../../dist/index.js';
import { resolveFixPlans } from '../../../dist/fixplan/resolve.js';
import { connectAnthropic, type AnthropicLike } from '../../../dist/analyze/llm.js';
import { dispositionFor } from '../../../dist/fixplan/policy.js';
import { noFixPlanCache } from '../../../dist/fixplan/cache.js';
import type { FixPlanAssessment } from '../../../dist/fixplan/schema.js';

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
 * The benchmark records the two halves separately, because they fail for
 * unrelated reasons and a pooled number would hide both: what the model
 * *proposed* (produced, declined as not-applicable, malformed, errored), and
 * what Drift's gate *decided* (accepted, partial, rejected, with reasons).
 * "The model declined" and "the model proposed something the validator
 * rejected" are opposite results — the first is a correct abstention, the
 * second is the gate earning its keep.
 *
 * The plan the model authored is the plan that gets applied, and that is not a
 * detail. This track previously resolved fresh assessments and then applied
 * `context.plan.commits.filter(commit => commit.fixPlan)` — the fix plans the
 * *original* production run had already attached. Where detection produced no
 * fix plan, which is the interesting case and the one this track exists to
 * measure, the newly authored plan was resolved, paid for, summarized into the
 * artifact, and then never applied to anything. So the accepted assessments
 * are fed back through production's own `buildPlan`, which is what attaches a
 * plan to a commit unit in production, and the commits that come out of that
 * are the ones applied. No commit construction happens here.
 */

export const TRACK_VERSION = 'repair-fixplan-model-v2';

export interface ModelFixPlanOptions {
  /**
   * Injected model client, for tests. Production supplies one via
   * `connectAnthropic`; a test supplies a stub so the authoring path can be
   * exercised without a live call, and provenance still records that a model
   * was invoked because one was.
   */
  client?: AnthropicLike | null;
}

export async function runModelFixPlanTrack(
  context: RepairContext,
  options: ModelFixPlanOptions = {},
): Promise<TrackOutcome> {
  const client = options.client === undefined ? await connectAnthropic(context.config, context.logger) : options.client;
  if (!client) {
    // Recorded as unavailable, never as a product failure and never faked.
    return { repair: notAttempted('model-unavailable') };
  }

  // Counting the calls rather than assuming them. `resolveFixPlans` tries
  // cheaper sources first and skips a finding with no call sites entirely, so
  // "a model client was configured" and "a model authored something" are
  // different facts, and only the second may be written into provenance as a
  // model invocation.
  const counted = countingClient(client);

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
    client: counted.client,
  });

  const accepted = [...resolved.accepted.values()];
  const rejected = [...resolved.rejected.values()];

  const provenance = counted.calls === 0 ? undefined : modelProvenance(context, accepted[0] ?? rejected[0]);

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
      ...(provenance ? { provenance } : {}),
    };
  }

  // Production's own commit construction, handed the plans that were just
  // accepted. `buildPlan` is what attaches a `FixPlanAssessment` to a
  // `CommitUnit` for the CLI, the Action and the extension alike; rebuilding
  // that mapping here would be benchmarking the harness's idea of it.
  //
  // Codemods are deliberately not passed. This is a capability track — "given
  // Drift routed this finding to model authoring, does the mechanism work?" —
  // and passing them would let the built-in codemod win the commit and silently
  // benchmark tier 1 under tier 2c's name. Which mechanism production would
  // have chosen is what `repair-full-remediation` measures.
  const replanned = buildPlan({
    repo: {
      owner: 'drift-bench',
      repo: context.publicCase.id,
      baseBranch: 'main',
      beforeSha: context.plan.headSha,
      afterSha: context.plan.headSha,
      workspace: context.workspace.root,
    },
    config: context.config,
    changes: context.plan.changes,
    evidence: context.plan.evidence,
    breakingChanges: context.plan.breakingChanges,
    impactSites: context.plan.impactSites,
    checkedSurfaces: (context.plan as RemediationPlan).checkedSurfaces ?? [],
    fixPlans: resolved.accepted,
  });

  const commits = replanned.commits.filter((commit) => commit.fixPlan);
  if (commits.length === 0) {
    return { repair: { ...notAttempted('no-repairable-commit'), fixPlan: summarize(accepted[0]!, context) }, ...(provenance ? { provenance } : {}) };
  }

  const capture = createRepairCaptureBuilder();
  const consumerDir = context.workspace.root;
  const applied: CommitUnit[] = [];
  let declinedByPolicy = false;

  for (const commit of commits) {
    // Production's own reconstruction of the assessment from a commit unit,
    // imported rather than re-derived, and production's own policy decision
    // over it — including its "ask a human" state. Treating `ask` as `apply`
    // would benchmark an unattended mode Drift does not offer.
    const disposition = dispositionFor(assessmentOf(commit), context.config, {
      verificationPassed: (context.plan as RemediationPlan).verification?.status === 'passed',
    });
    if (disposition.action !== 'apply') {
      declinedByPolicy = true;
      continue;
    }

    const before = await snapshot(consumerDir, commit.fixPlan?.files ?? commit.allowedFiles);
    const result = applyCommitFixPlan(commit, before);
    if (result.status !== 'applied') continue;
    applied.push(commit);
    capture.recordCommit(commit.allowedFiles, before, result.edits);
    for (const edit of result.edits) await writeFile(join(consumerDir, edit.path), edit.content, 'utf8');
  }

  const captured = await capture.finalize();
  if (captured.changedFiles.length === 0) {
    return {
      repair: {
        ...notAttempted(declinedByPolicy ? 'abstained-by-policy' : 'empty-patch'),
        fixPlan: summarize(accepted[0]!, context),
      },
      ...(provenance ? { provenance } : {}),
    };
  }

  const repair: RepairArtifact = {
    attempted: true,
    notAttemptedReason: null,
    resolvedByTier: applied.map((commit) => ({ commitId: commit.id, tier: 'fixplan-model' })),
    patch: captured.patch,
    changedFiles: captured.changedFiles,
    scopeEscapeFiles: scopeEscapes(captured.changedFiles, applied),
    scopeValidationReasons: [],
    patchStats: patchStatsOf(captured.patch),
    // Residual sites are counted across every commit the fix plans covered,
    // applied or not: a site nothing reached is still unrepaired, and counting
    // only the applied commits would report a partial repair as complete.
    residualImpactSites: commits.reduce((total, commit) => total + (commit.fixPlan?.residual ?? 0), 0),
    fixPlan: summarize(accepted[0]!, context),
  };

  return { repair, ...(provenance ? { provenance } : {}) };
}

/**
 * Provenance for a trial where the model genuinely ran.
 *
 * `model` is what Drift was configured to ask for; the Anthropic API does not
 * hand `authorFixPlan` back a resolved model id through Drift's own client
 * wrapper, so `modelVersion` stays `unavailable` rather than being filled with
 * the request. `proposalSource` in the fix-plan artifact records which source
 * actually authored the accepted plan, which is the fact that would otherwise
 * be guessed.
 */
function modelProvenance(context: RepairContext, assessment: FixPlanAssessment | undefined): TrackOutcome['provenance'] {
  return {
    provider: 'Anthropic',
    model: context.config.llm.model ?? 'unavailable',
    modelVersion: 'unavailable',
    promptVersion: 'drift-authorFixPlan',
    promptHash: 'unavailable',
    agentId: 'fixplan-model',
    agentLabel: `Model-authored fix plan${assessment ? ` (${assessment.plan.provenance.author})` : ''}`,
  };
}

/** Wraps a client so the track can say whether the model was actually asked anything. */
function countingClient(client: AnthropicLike): { client: AnthropicLike; readonly calls: number } {
  let calls = 0;
  const wrapped: AnthropicLike = {
    messages: {
      create: (...args: Parameters<AnthropicLike['messages']['create']>) => {
        calls += 1;
        return client.messages.create(...args);
      },
    },
  };
  return {
    client: wrapped,
    get calls() {
      return calls;
    },
  };
}

function summarize(assessment: FixPlanAssessment, context: RepairContext) {
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
