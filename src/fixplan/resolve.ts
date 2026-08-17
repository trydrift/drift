import type { BreakingChange, DependencyChange, Evidence, ImpactSite } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { AnthropicLike } from '../analyze/llm.js';
import { authorFixPlan } from './author.js';
import { asRestored, migrationKey, noFixPlanCache, type FixPlanCache } from './cache.js';
import { validateFixPlan } from './validate.js';
import type { FixPlan, FixPlanAssessment } from './schema.js';

/**
 * Many proposal sources, one gate.
 *
 * The order below is by cost, not by trust — trust is not ranked here at all,
 * because every source lands at the same `validateFixPlan` call and none of
 * them can skip it. A cached plan is tried first because it is free, not
 * because a cached plan is safer than a fresh one; it is re-validated against
 * *this* repository's own call sites exactly as a freshly authored plan is,
 * and can perfectly well come back `partial` here having been `accepted`
 * wherever it was first written.
 *
 * A source that returns nothing costs the next source nothing. A source whose
 * proposal is rejected does not stop the next source from proposing — a model
 * gets a turn after a recipe's edits proved un-derivable, because the two
 * fail for unrelated reasons. What no source gets is the ability to have a
 * plan applied without passing the gate.
 */

export interface ResolveOptions {
  changes: readonly BreakingChange[];
  sites: readonly ImpactSite[];
  evidence: readonly Evidence[];
  dependencyChanges: readonly DependencyChange[];
  /** Contents of every file named by `sites`, as localization read them. */
  fileContents: ReadonlyMap<string, string>;
  config: DriftConfig;
  logger: Logger;
  cache?: FixPlanCache;
  /** The model client. Absent means the authoring source is simply skipped. */
  client?: AnthropicLike;
  /**
   * Runs a community recipe in a disposable sandbox and returns whatever plan
   * could be re-derived from its edits.
   *
   * Injected rather than imported so this module stays free of git, exec, and
   * the filesystem — and so a surface that has no safe place to run
   * third-party code (a webhook process, a read-only analysis) simply does not
   * supply one, rather than having to remember to disable it.
   */
  proposeFromRecipe?: (change: BreakingChange) => Promise<FixPlan | null>;
}

export interface ResolvedFixPlans {
  /** Accepted or partially accepted plans, by `BreakingChange.id`. */
  accepted: Map<string, FixPlanAssessment>;
  /**
   * Plans that failed the gate, by `BreakingChange.id`.
   *
   * Kept rather than dropped so the report can say *why* a finding went to an
   * agent. "Drift tried a deterministic fix and rejected it because the
   * replacement was not attested" and "Drift never tried" are different
   * facts, and only one of them is a reason to look harder at the agent's
   * output.
   */
  rejected: Map<string, FixPlanAssessment>;
}

export async function resolveFixPlans(options: ResolveOptions): Promise<ResolvedFixPlans> {
  const { changes, sites, evidence, config, logger } = options;
  const cache = options.cache ?? noFixPlanCache();

  const accepted = new Map<string, FixPlanAssessment>();
  const rejected = new Map<string, FixPlanAssessment>();

  const sitesByChange = new Map<string, ImpactSite[]>();
  for (const site of sites) {
    const bucket = sitesByChange.get(site.breakingChangeId);
    if (bucket) bucket.push(site);
    else sitesByChange.set(site.breakingChangeId, [site]);
  }

  const dependencyChangeByKey = new Map(
    options.dependencyChanges.map((change) => [`${change.workspace ?? ''}::${change.name}`, change] as const),
  );

  for (const change of changes) {
    const changeSites = sitesByChange.get(change.id);
    if (!changeSites || changeSites.length === 0) continue;

    const dependencyChange = dependencyChangeByKey.get(`${change.workspace ?? ''}::${change.dependency}`);
    const key = migrationKey(change, dependencyChange);

    let lastRejection: FixPlanAssessment | null = null;

    for (const propose of proposalSources(options, change, dependencyChange, key, cache)) {
      const proposed = await propose();
      if (!proposed) continue;

      const assessment = validateFixPlan({
        plan: proposed,
        change,
        sites: changeSites,
        fileContents: options.fileContents,
        evidence,
      });

      if (assessment.verdict === 'rejected') {
        logger.info(
          `Rejected a ${proposed.provenance.author}-proposed fix plan for ${change.dependency}: ${assessment.rejections[0]}`,
        );
        lastRejection = assessment;
        continue;
      }

      // Coverage is enforced here, once, rather than at each surface. A plan
      // that clears the gate but explains too little of the finding is not
      // attached to the commit at all — which is what keeps the CLI, the
      // Action, and the extension agreeing about which findings even have a
      // deterministic fix, independently of what each does with the ones
      // that do. `dispositionFor` re-checks it as a safety net for callers
      // holding a plan from elsewhere.
      const total = assessment.covered + assessment.residual;
      const coverage = total === 0 ? 0 : assessment.covered / total;
      if (coverage < config.remediation.fixPlans.minCoverage) {
        const shortfall: FixPlanAssessment = {
          ...assessment,
          verdict: 'rejected',
          rejections: [
            `The plan covers ${assessment.covered} of ${total} call sites (${Math.round(coverage * 100)}%), below the configured minimum of ${Math.round(config.remediation.fixPlans.minCoverage * 100)}%. A rule that explains this little of a finding is a coincidence rather than a migration.`,
          ],
        };
        logger.info(`Discarded a fix plan for ${change.dependency}: ${shortfall.rejections[0]}`);
        lastRejection = shortfall;
        continue;
      }

      logger.info(
        `Fix plan for ${change.dependency}: ${assessment.plan.ops.length} rule(s) covering ${assessment.covered}/${assessment.covered + assessment.residual} call site(s), ${assessment.assurance}.`,
      );

      // Only ever cache what passed. A cache of rejected plans would be a
      // cache of work Drift has already decided not to do.
      if (proposed.provenance.author !== 'cache') await cache.put(key, proposed);

      accepted.set(change.id, assessment);
      lastRejection = null;
      break;
    }

    if (lastRejection) rejected.set(change.id, lastRejection);
  }

  if (accepted.size > 0 || rejected.size > 0) {
    logger.info(
      `Fix plans: ${accepted.size} accepted, ${rejected.size} rejected. ${config.remediation.fixPlans.enabled ? '' : '(authoring disabled)'}`.trim(),
    );
  }

  return { accepted, rejected };
}

/** The proposal sources, cheapest first. Each returns `null` to pass. */
function proposalSources(
  options: ResolveOptions,
  change: BreakingChange,
  dependencyChange: DependencyChange | undefined,
  key: string,
  cache: FixPlanCache,
): (() => Promise<FixPlan | null>)[] {
  const sources: (() => Promise<FixPlan | null>)[] = [];

  sources.push(async () => {
    const hit = await cache.get(key);
    return hit ? asRestored(hit) : null;
  });

  if (options.proposeFromRecipe) {
    sources.push(() => options.proposeFromRecipe!(change));
  }

  if (options.client) {
    sources.push(() =>
      authorFixPlan({
        change,
        dependencyChange,
        evidence: options.evidence,
        sites: options.sites,
        fileContents: options.fileContents,
        config: options.config,
        logger: options.logger,
        client: options.client,
      }),
    );
  }

  return sources;
}
