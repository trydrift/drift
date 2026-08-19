import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspaceRepo, notAttempted, scopeEscapes, type RepairContext, type TrackOutcome } from './context.ts';
import { createRepairCaptureBuilder } from '../adapters/repair-capture.ts';
import { patchStatsOf, type RepairArtifact } from '../artifacts/prediction.ts';
import {
  applyCommitFixPlan,
  assessmentOf,
  buildPlan,
  type CommitUnit,
  type RemediationPlan,
} from '../../../dist/index.js';
import type { CommunityRecipeCandidate } from '../../../dist/remediation/types.js';
import { resolveFixPlans } from '../../../dist/fixplan/resolve.js';
import { fixPlanFromRecipe } from '../../../dist/fixplan/from-recipe.js';
import { connectAnthropic, type AnthropicLike } from '../../../dist/analyze/llm.js';
import { dispositionFor } from '../../../dist/fixplan/policy.js';
import { fileSystemFixPlanCache, noFixPlanCache } from '../../../dist/fixplan/cache.js';
import type { FixPlanAssessment } from '../../../dist/fixplan/schema.js';

/**
 * R2 — a validated fix plan, from each of the three sources production has.
 *
 * One module, three tracks, because the *only* difference between them is
 * which proposal source `resolveFixPlans` is given. Everything after the
 * proposal is identical and is production's: `validateFixPlan` decides whether
 * the rule is grounded in the finding and derivable at this repository's real
 * call sites, `buildPlan` attaches what survived to commit units, `dispositionFor`
 * decides whether policy clears it unattended, and `applyCommitFixPlan` applies
 * it. Writing three tracks would have meant writing that chain three times and
 * eventually differing in one of them.
 *
 * Reporting them separately is not cosmetic. A cached plan costs nothing and a
 * model-authored one costs a call; a recipe's rule is written by a third party
 * and a model's by a model; and they fail for unrelated reasons. Pooled, none
 * of that is recoverable from the number.
 *
 * All three record the two halves apart, because they are opposite results:
 * what the *source* proposed (produced, declined as not-applicable, malformed,
 * errored) and what Drift's *gate* decided (accepted, partial, rejected, with
 * reasons). "The source declined" is a correct abstention; "the source proposed
 * something the validator rejected" is the gate earning its keep.
 *
 * The plan a source authored is the plan that gets applied, and that is not a
 * detail. This previously resolved fresh assessments and then applied
 * `context.plan.commits.filter(commit => commit.fixPlan)` — the plans the
 * *original* production run had already attached. Where detection produced no
 * fix plan, which is the case these tracks exist to measure, the newly authored
 * plan was resolved, paid for, summarized into the artifact, and never applied.
 */

export const TRACK_VERSION = 'repair-fixplan-v2';

export interface FixPlanTrackOptions {
  /**
   * Injected model client, for tests. Production supplies one via
   * `connectAnthropic`; a test supplies a stub so the authoring path can be
   * exercised without a live call, and provenance still records that a model
   * was invoked because one was.
   */
  client?: AnthropicLike | null;
  /**
   * Directory holding previously validated plans, for the cache track.
   *
   * There is no seeded corpus of cached plans and inventing one would be
   * inventing benchmark evidence: a cache entry is a plan some *earlier* run
   * authored and the gate accepted. So the cache track reads a directory a
   * previous `repair-fixplan-model` run populated (`--fixplan-cache DIR`
   * writes it, through production's own `cache.put`), and reports
   * `cache-unavailable` when there is none — excluded from every rate rather
   * than scored as a failure of the mechanism.
   */
  cacheDir?: string;
  /**
   * A community recipe candidate to re-derive a rule from, for the recipe
   * track. Absent means `recipe-unavailable`, for the same reason: this
   * benchmark has no recipe corpus yet, and a track with no input reports that
   * it had none.
   */
  recipe?: CommunityRecipeCandidate;
  /**
   * Command runner for the recipe tier, injected for tests only.
   *
   * Production shells out to the recipe's own tool. A test supplies a runner
   * that performs the recipe's edit directly, so `executeCommunityRecipe`,
   * the re-derivation of a rule from the edits it made, and the gate that
   * judges that rule are all genuinely exercised without a real
   * third-party codemod being downloaded and run.
   */
  exec?: RecipeExec;
}

/** The subset of Drift's `Exec` the recipe tier uses. */
export type RecipeExec = NonNullable<Parameters<typeof fixPlanFromRecipe>[0]['exec']>;

/** R2a — a plan restored from cache and revalidated through the normal gate. */
export async function runFixPlanCacheTrack(context: RepairContext, options: FixPlanTrackOptions = {}): Promise<TrackOutcome> {
  if (!options.cacheDir) return { repair: notAttempted('cache-unavailable') };
  return runFixPlanTrack(context, { source: 'cache', cacheDir: options.cacheDir });
}

/**
 * R2b — a plan re-derived from a community recipe's edits in a sandbox.
 *
 * The sandbox is a throwaway copy of the workspace, not the workspace itself,
 * because that is what production does and because the difference is
 * load-bearing: the recipe's own edits are read to learn a rule and then
 * discarded, and only Drift's re-derived ops, applied by Drift's executor to
 * Drift's localized sites, ever reach the repository. Running the recipe
 * directly in the workspace would leave a third party's edits in the result
 * and report them as Drift's.
 *
 * `executeCommunityRecipe` reads the sandbox's git status to bound what the
 * recipe touched, so the sandbox has to be a repository.
 */
export async function runFixPlanRecipeTrack(context: RepairContext, options: FixPlanTrackOptions = {}): Promise<TrackOutcome> {
  if (!options.recipe) return { repair: notAttempted('recipe-unavailable') };

  const sandbox = await mkdtemp(join(tmpdir(), 'drift-recipe-sandbox-'));
  try {
    await cp(context.workspace.root, sandbox, { recursive: true });
    await initWorkspaceRepo(sandbox);
    return await runFixPlanTrack(context, {
      source: 'recipe',
      recipe: options.recipe,
      sandbox,
      ...(options.exec ? { exec: options.exec } : {}),
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

/** R2c — a plan authored by a live model, then validated and applied deterministically. */
export async function runModelFixPlanTrack(context: RepairContext, options: FixPlanTrackOptions = {}): Promise<TrackOutcome> {
  const client = options.client === undefined ? await connectAnthropic(context.config, context.logger) : options.client;
  // Recorded as unavailable, never as a product failure and never faked.
  if (!client) return { repair: notAttempted('model-unavailable') };
  return runFixPlanTrack(context, { source: 'model', client, ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}) });
}

interface ResolvedSource {
  source: 'cache' | 'recipe' | 'model';
  client?: AnthropicLike;
  cacheDir?: string;
  recipe?: CommunityRecipeCandidate;
  sandbox?: string;
  exec?: RecipeExec;
}

async function runFixPlanTrack(context: RepairContext, selection: ResolvedSource): Promise<TrackOutcome> {
  // Counting the calls rather than assuming them. `resolveFixPlans` tries
  // cheaper sources first and skips a finding with no call sites entirely, so
  // "a model client was configured" and "a model authored something" are
  // different facts, and only the second may be written into provenance as a
  // model invocation.
  const counted = selection.client ? countingClient(selection.client) : null;
  const fileContents = await readSiteContents(context);

  const resolved = await resolveFixPlans({
    changes: context.plan.breakingChanges,
    sites: context.plan.impactSites,
    evidence: context.plan.evidence,
    dependencyChanges: context.plan.changes,
    fileContents,
    config: context.config,
    logger: context.logger,
    // The cache is a real proposal source only for the cache track and, for
    // the model track, the place an accepted plan is written so a later cache
    // run has something honest to restore. Every other track gets a cache that
    // answers nothing, so a plan cannot arrive from a source the track is not
    // measuring.
    cache: selection.cacheDir ? fileSystemFixPlanCache(selection.cacheDir) : noFixPlanCache(),
    ...(counted ? { client: counted.client } : {}),
    ...(selection.recipe
      ? {
          proposeFromRecipe: (change) =>
            fixPlanFromRecipe({
              candidate: selection.recipe!,
              change,
              sandbox: selection.sandbox ?? context.workspace.root,
              relevantFiles: new Set(context.plan.impactSites.map((site) => site.file)),
              logger: context.logger,
              ...(selection.exec ? { exec: selection.exec } : {}),
            }),
        }
      : {}),
  });

  const accepted = [...resolved.accepted.values()];
  const rejected = [...resolved.rejected.values()];

  const provenance =
    selection.source === 'model' && counted && counted.calls > 0
      ? modelProvenance(context, accepted[0] ?? rejected[0])
      : undefined;

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
  // Codemods are deliberately not passed. These are capability tracks —
  // "given Drift routed this finding here, does the mechanism work?" — and
  // passing them would let the built-in codemod win the commit and silently
  // benchmark tier 1 under another tier's name. Which mechanism production
  // would actually have chosen is what `repair-full-remediation` measures.
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
    resolvedByTier: applied.map((commit) => ({ commitId: commit.id, tier: `fixplan-${selection.source}` })),
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
