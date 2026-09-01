import type { BreakingChange, Evidence, ImpactSite } from '../types.js';
import {
  runtimeCompatibilityIsUnresolved,
  completeRuntimeAnalyses,
  worstRuntimeState,
  type RuntimeRequirementAnalysis,
} from './compatibility.js';
import type {
  EvidenceConfidence,
  LicenseFinding,
  MaintenanceAssessment,
  Recommendation,
  SecurityAssessment,
  UpgradeAssessment,
} from './types.js';
import { worstSeverity } from './types.js';
import { deriveBreakingChangeDispositions } from '../disposition.js';

/**
 * The one thing Drift is willing to conclude, and why.
 *
 * This is deliberately a ladder of `if` statements rather than a score. A
 * weighted number would be easier to tune and impossible to argue with: a
 * developer who disagrees with "0.72 — upgrade after review" has nothing to
 * push back on, whereas a developer who disagrees with "one change requires a
 * decision about behaviour, so a person should look" can point at the sentence
 * and say why it is wrong. Every rule that fires records the sentence it fired
 * with, and those sentences are the entire output.
 *
 * The order matters and encodes a priority: *don't make things worse* beats
 * *fix your code* beats *take the security fix* beats *this is fine*.
 */

export interface AssessmentInput {
  dependency: string;
  workspace?: string;
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
  evidence: readonly Evidence[];
  security: SecurityAssessment;
  maintenance: MaintenanceAssessment;
  license: LicenseFinding;
  /** Reasons this analysis is incomplete. Non-empty is itself a finding. */
  gaps: readonly string[];
  /** True when a computed API diff actually ran for this dependency. */
  surfaceCompared: boolean;
  /**
   * How many release notes, changelogs and migration guides were fetched and
   * read — including the ones that turned out to announce nothing.
   *
   * Deliberately not derivable from `evidence`, which only carries the
   * passages that matched a rule. A changelog read end to end with no breaking
   * passage in it produces zero evidence records and is nonetheless an answer;
   * counting records instead of documents is what made Drift file seven
   * Arduino libraries as *not verified* while their release notes sat in its
   * own cache.
   */
  proseRead?: number;
  /**
   * What Drift established about this repository's runtime for each upstream
   * runtime requirement — see `compatibility.ts`.
   *
   * Carried explicitly rather than inferred from `impactSites`, because the
   * two states that matter most produce no sites at all: a workspace with no
   * authoritative declaration, and an upstream range whose grammar Drift
   * could not evaluate. Both are `unknown`, and both used to arrive here as
   * an empty array indistinguishable from "checked, and fine".
   */
  runtimeAnalyses?: readonly RuntimeRequirementAnalysis[];
  /** Whether repository localization actually completed. */
  localizationRan?: boolean;
  /** Whether localization covered the full eligible source set. */
  localizationComplete?: boolean;
}

/**
 * Changes whose fix is a decision, not a substitution.
 *
 * A rename can be applied mechanically and reviewed in a diff. A behaviour
 * change cannot: someone has to decide what the code should now do, and no
 * amount of evidence removes that.
 */
const NEEDS_A_DECISION = new Set([
  'behaviour-change',
  'signature-change',
  'default-change',
  'moved-export',
  'runtime-requirement',
]);

export function assessUpgrade(input: AssessmentInput): UpgradeAssessment {
  const reasons: string[] = [];
  const { security, maintenance, license, impactSites } = input;

  const affected = impactSites.length;
  const files = new Set(impactSites.map((site) => site.file)).size;
  // A runtime requirement is a package-wide compatibility condition, not a
  // symbol a caller invokes — ".nvmrc" and ".tool-versions" are not API call
  // sites, and reasoning that says a repository "uses an API" for a runtime
  // floor mismatch is simply false. Split by kind up front so every sentence
  // below can name the right kind of fact.
  const changeById = new Map(input.breakingChanges.map((c) => [c.id, c]));
  const apiSites = impactSites.filter((site) => changeById.get(site.breakingChangeId)?.kind !== 'runtime-requirement');
  const apiFiles = new Set(apiSites.map((site) => site.file)).size;
  const runtimeSites = impactSites.filter((site) => changeById.get(site.breakingChangeId)?.kind === 'runtime-requirement');
  const runtimeChanges = input.breakingChanges.filter((change) => change.kind === 'runtime-requirement' && change.runtime?.runtime);
  const completeAnalyses = completeRuntimeAnalyses(input.breakingChanges, input.runtimeAnalyses ?? []);
  const runtimeState = worstRuntimeState(completeAnalyses);
  const runtimeUnresolved = runtimeChanges.length > 0 && runtimeCompatibilityIsUnresolved(runtimeState ?? 'unknown');
  const effectiveRuntimeState = runtimeChanges.length > 0 ? (runtimeState ?? 'unknown') : undefined;
  const dispositions = deriveBreakingChangeDispositions(
    input.breakingChanges,
    impactSites,
    completeAnalyses,
    input.localizationRan ?? true,
    input.localizationComplete ?? true,
  );
  const actionableIds = new Set(
    dispositions.filter((disposition) => disposition.state === 'actionable').map((disposition) => disposition.changeId),
  );
  const actionableChanges = input.breakingChanges.filter((change) => actionableIds.has(change.id));
  const actionableSiteIds = new Set(
    dispositions.flatMap((disposition) => disposition.actionableSites.map((site) => `${site.breakingChangeId}:${site.file}:${site.line}`)),
  );
  const apiReviewSites = apiSites.filter((site) => !actionableSiteIds.has(`${site.breakingChangeId}:${site.file}:${site.line}`));
  const actionableDecisions = actionableChanges.filter((change) => NEEDS_A_DECISION.has(change.kind));
  const actionableMechanical = actionableChanges.length - actionableDecisions.length;
  const roleContract = roleContractForChanges(input.breakingChanges);

  /* Facts first, in the order a reader needs them. */

  if (security.checked) {
    if (security.resolved.length > 0) {
      reasons.push(
        `Fixes ${security.resolved.length} known ${plural(security.resolved.length, 'vulnerability', 'vulnerabilities')} (worst: ${worstSeverity(security.resolved)}).`,
      );
    }
    if (security.introduced.length > 0) {
      reasons.push(
        `Introduces ${security.introduced.length} known ${plural(security.introduced.length, 'vulnerability', 'vulnerabilities')} not present in the installed version (worst: ${worstSeverity(security.introduced)}).`,
      );
    }
    if (security.carried.length > 0) {
      reasons.push(
        `${security.carried.length} known ${plural(security.carried.length, 'vulnerability affects', 'vulnerabilities affect')} both versions; this upgrade does not address ${security.carried.length === 1 ? 'it' : 'them'}.`,
      );
    }
    if (security.resolved.length === 0 && security.target.length === 0) {
      reasons.push('No known vulnerabilities were found for the target version.');
    }
  }

  const apiActionableSites = apiSites.filter((site) => actionableSiteIds.has(`${site.breakingChangeId}:${site.file}:${site.line}`));
  if (apiActionableSites.length > 0) {
    reasons.push(
      roleContract
        ? `${apiActionableSites.length} ${plural(apiActionableSites.length, 'place', 'places')} in ${new Set(apiActionableSites.map((site) => site.file)).size} ${plural(new Set(apiActionableSites.map((site) => site.file)).size, 'file', 'files')} match${apiActionableSites.length === 1 ? 'es' : ''} ${roleContract} entries this upgrade changes.`
        : `${apiActionableSites.length} ${plural(apiActionableSites.length, 'place', 'places')} in ${new Set(apiActionableSites.map((site) => site.file)).size} ${plural(new Set(apiActionableSites.map((site) => site.file)).size, 'file', 'files')} use${apiActionableSites.length === 1 ? 's' : ''} an API this upgrade changes.`,
    );
  }
  if (apiReviewSites.length > 0) {
    reasons.push(`${apiReviewSites.length} local API match${apiReviewSites.length === 1 ? '' : 'es'} require review; Drift did not establish a safe edit.`);
  }
  // The runtime sentence comes from the analysis, not the sites: it is the
  // only place that can say "Drift could not find a declaration at all",
  // which by construction has no site to describe. Rendered from the
  // *completed* set so a runtime requirement whose analysis never ran is
  // explained to the developer ("could not complete runtime compatibility
  // analysis") rather than silently dropped.
  for (const analysis of completeAnalyses) {
    reasons.push(analysis.statement);
  }
  if (runtimeSites.length > 0 && completeAnalyses.length === 0) {
    // A caller that supplied runtime sites without the analyses behind them
    // (an older embedder, a hand-built input) still gets an accurate summary
    // rather than silence.
    reasons.push(...describeRuntimeImpact(runtimeSites));
  }
  if (affected > 0) {
    if (actionableMechanical > 0) {
      reasons.push(`${actionableMechanical} of the locally affected changes can be applied mechanically.`);
    }
    if (actionableDecisions.length > 0) {
      reasons.push(
        `${actionableDecisions.length} locally affected ${plural(actionableDecisions.length, 'change requires', 'changes require')} a developer decision rather than a substitution.`,
      );
    }
  } else if (
    input.breakingChanges.some((change) => change.kind !== 'runtime-requirement') &&
    !runtimeUnresolved
  ) {
    // "None of which this repository uses" is a positive claim about this
    // repository, and it may only be made when compatibility was actually
    // established. With a runtime requirement left `unknown` or `partial`,
    // the true sentence is the analysis statement pushed above — Drift did
    // not find a local use *and* did not establish there isn't one.
    const count = input.breakingChanges.filter((change) => change.kind !== 'runtime-requirement').length;
    reasons.push(roleContract
      ? `${count} published ${roleContract} ${plural(count, 'change', 'changes')} require review; these are package-role contract changes, not ordinary code API changes with call sites.`
      : `${count} upstream API breaking ${plural(count, 'change', 'changes')}, none of which this repository uses.`);
  }

  for (const fact of maintenance.facts) {
    if (fact.concerning) reasons.push(fact.statement);
  }

  // 'changed' is deliberately silent in the rendered License section for a
  // benign change — reasons must not leak it back in through the details
  // block, or the suppression is cosmetic only.
  if (license.verdict === 'policy-violation') {
    reasons.push(license.statement);
  }

  /* Then the conclusion those facts support. */

  const recommendation = decide(input, {
    affected,
    decisions: actionableDecisions.length,
    actionable: actionableChanges.length > 0,
    runtimeUnresolved,
    localizationUnresolved: dispositions.some((disposition) => disposition.reason === 'localization-incomplete'),
    roleContractChanged: roleContract !== null,
  });
  const confidence = judgeConfidence(input);

  if (input.gaps.length > 0) {
    reasons.push(...input.gaps);
  }

  return {
    recommendation,
    reasons,
    confidence: confidence.level,
    confidenceBasis: confidence.basis,
    ...(effectiveRuntimeState ? { runtimeCompatibility: effectiveRuntimeState } : {}),
  };
}

/**
 * Does this site, by itself, establish that the repository must change?
 *
 * For an API site the question is whether the match was semantically
 * resolved, which is what `confidence` measures. For a runtime site it is a
 * *different* question with a different answer, and conflating the two is
 * what turned a partial range overlap into "Migration required": Drift can be
 * completely certain it found `engines.node` (high confidence) and still have
 * established only that the declared range *includes* versions upstream
 * rejects, not that this project actually runs on one (partial).
 *
 * So confidence gates identity, `runtimeVerdict` gates meaning, and only
 * `incompatible` — the repository definitely uses a rejected runtime — is
 * actionable. `partial` and `unknown` are review, never a migration headline
 * and never a reason to call anything safe.
 */
function decide(
  input: AssessmentInput,
  counts: { affected: number; decisions: number; actionable: boolean; runtimeUnresolved: boolean; localizationUnresolved: boolean; roleContractChanged: boolean },
): Recommendation {
  const { security, maintenance, license } = input;

  // Nothing outranks making the repository's position worse.
  if (security.checked && security.introduced.length > 0) return 'do-not-upgrade-yet';
  if (maintenance.deprecated) return 'do-not-upgrade-yet';
  if (license.verdict === 'policy-violation') return 'do-not-upgrade-yet';
  // A fact this repository cannot get past -- most commonly a runtime floor
  // this repository's own declared Node/Python version does not satisfy --
  // must never be papered over as "recommended" or "safe". `concerning` alone
  // cannot carry this: it also flags unverified, merely-worth-a-look facts
  // that must NOT block. Only `polarity: 'blocks'` may.
  if (maintenance.facts.some((fact) => fact.polarity === 'blocks')) return 'do-not-upgrade-yet';

  if (counts.affected > 0) {
    // Lexical or owner-ambiguous matches are useful leads, but they do not
    // establish that this repository needs a migration. Only a semantically
    // resolved (high-confidence) site can support that headline — and, for a
    // runtime requirement, only one whose verdict is `incompatible`. A
    // partial overlap has an independent path to `manual-migration-required`
    // exactly when some *other* finding is genuinely actionable, which is
    // what `counts.decisions` measures after `isActionableSite`.
    if (!counts.actionable) return 'upgrade-after-review';
    return counts.decisions > 0 ? 'manual-migration-required' : 'upgrade-after-review';
  }

  // Zero sites, and a runtime question Drift did not answer. Every branch
  // below this point ends in `safe-to-upgrade`, `upgrade-recommended`, or
  // `insufficient-evidence` — none of which may be said over an unresolved
  // compatibility condition that applies to the whole package.
  if (counts.runtimeUnresolved) return 'upgrade-after-review';
  if (counts.localizationUnresolved) return 'upgrade-after-review';
  // Package-role contracts (parent POMs, NuGet tooling/meta-packages, and Pub
  // assets/tooling) are consumed by manifests and build systems, not ordinary
  // source call sites. A clean source localization therefore cannot turn a
  // real contract change into "Safe to upgrade".
  if (counts.roleContractChanged) return 'upgrade-after-review';

  const securityFavors = security.checked && security.resolved.length > 0;
  const maintenanceFavors = maintenance.facts.some((fact) => fact.polarity === 'favors');

  // "No breaking changes were found" only supports a compatibility claim when
  // something actually looked at compatibility. A clean OSV check, a fine
  // license, and a version that merely exists all answer *other* questions —
  // none of them is an account of whether this code still works. Without a
  // computed surface diff or compatibility prose that was actually fetched
  // and read, Drift has not characterized compatibility at all, and "no
  // breaking changes" here means "none were looked for", not "none exist".
  if (input.breakingChanges.length === 0 && !hasCompatibilityEvidence(input)) {
    // A resolved vulnerability (or other favorable maintenance fact) is still
    // a real reason to move — but say so without implying compatibility was
    // verified, which `upgrade-recommended`'s wording does and `safe-to-upgrade`
    // does not.
    return securityFavors || maintenanceFavors ? 'upgrade-recommended' : 'insufficient-evidence';
  }

  if (securityFavors || maintenanceFavors) return 'upgrade-recommended';

  return 'safe-to-upgrade';
}

/**
 * Did Drift obtain evidence that actually bears on *compatibility* — as
 * opposed to evidence that merely answers some other question about the
 * upgrade (a clean security advisory lookup, a fine license, proof the target
 * version exists)?
 *
 * This is the one gate that may unlock `safe-to-upgrade` or let "no breaking
 * changes found" stand as a finding rather than a blank. A successful OSV
 * check answers "does this introduce a known vulnerability", not "does this
 * repository's code still work" — the two are independent facts, and treating
 * the first as proof of the second is exactly what let Drift call a major
 * version bump with no reachable changelog, no TypeScript declarations, and no
 * resolvable source repository "Safe to upgrade".
 *
 * A computed API surface diff is direct evidence: an observation of the
 * shipped artefact itself. Release notes, changelogs and migration guides
 * that were actually fetched and read are weaker but still real: they report
 * what the maintainer chose to write down, and a document read end to end
 * with no breaking passage in it is an answer, not a blank — see
 * `judgeConfidence`, which caps a prose-only basis at `medium` rather than
 * treating it as equivalent to a diff.
 */
export function hasCompatibilityEvidence(input: AssessmentInput): boolean {
  return input.surfaceCompared || (input.proseRead ?? 0) > 0 || proseEvidence(input).length > 0;
}

/** Release notes, changelogs and migration guides read for this dependency. */
function proseEvidence(input: AssessmentInput): readonly Evidence[] {
  return input.evidence.filter(
    (record) =>
      record.dependency === input.dependency &&
      record.workspace === input.workspace &&
      (record.source === 'github-release' ||
        record.source === 'changelog' ||
        record.source === 'migration-guide'),
  );
}

/**
 * How much the sources agree, and about what.
 *
 * Reported alongside the recommendation rather than folded into it. A
 * high-confidence "safe to upgrade" and a low-confidence one are the same
 * advice resting on different amounts of ground, and the reader deserves to
 * know which they are looking at.
 */
function judgeConfidence(input: AssessmentInput): { level: EvidenceConfidence; basis: string } {
  // Documents read, not passages matched — a changelog that announced nothing
  // was still consulted, and the basis line has to be able to say so.
  const prose = Math.max(proseEvidence(input).length, input.proseRead ?? 0);

  const sources: string[] = [];
  if (input.surfaceCompared) {
    const roleContract = roleContractForChanges(input.breakingChanges);
    sources.push(roleContract ? `the computed ${roleContract} diff` : 'the computed API diff');
  }
  if (prose > 0) sources.push(prose === 1 ? 'release notes' : 'release notes and changelog');
  if (input.security.checked) sources.push('the OSV advisory database');

  if (sources.length === 0) {
    return {
      level: 'low',
      basis: 'Nothing but the version numbers could be read for this dependency.',
    };
  }

  // A computed diff is a direct observation of the shipped artefact; anything
  // else is somebody's account of it. Two independent sources agreeing is the
  // only thing that earns "high" without one.
  const level: EvidenceConfidence =
    input.surfaceCompared || sources.length >= 2 ? 'high' : 'medium';

  return { level, basis: `${capitalize(joinList(sources))} agree.` };
}

export function roleContractForChanges(changes: readonly BreakingChange[]): string | null {
  const structural = changes.filter((change) => change.kind !== 'runtime-requirement');
  if (structural.length === 0) return null;
  // Localization deliberately adds shorter aliases to a canonical contract
  // symbol (for example `pom:pluginManagement:g:a` also yields `g:a`). The
  // aliases help find a manifest reference, but do not change what kind of
  // evidence produced the finding. Classify each finding by the presence of
  // its canonical prefixed identity, not by requiring every search alias to
  // retain that prefix.
  if (structural.every((change) => change.symbols.some((symbol) => symbol.startsWith('pom:')))) return 'Maven POM contract';
  if (structural.every((change) => change.symbols.some((symbol) => symbol.startsWith('nuget:')))) return 'NuGet package contract';
  if (structural.every((change) => change.symbols.some((symbol) => symbol.startsWith('pub:')))) return 'Pub package contract';
  return null;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Rationale for runtime-requirement impact sites, kept apart from the
 * API-usage sentence above because "N places use an API" is simply false for
 * a `.nvmrc` or a CI `node-version:` line — the repository's declared runtime
 * either satisfies a floor or it does not, and no call site is involved.
 */
function describeRuntimeImpact(sites: readonly ImpactSite[]): string[] {
  const out: string[] = [];
  const incompatible = sites.filter((site) => site.runtimeVerdict !== 'partial' && site.runtimeVerdict !== 'unknown');
  const partial = sites.filter((site) => site.runtimeVerdict === 'partial');
  const unknown = sites.filter((site) => site.runtimeVerdict === 'unknown');

  if (incompatible.length > 0) {
    const n = incompatible.length;
    out.push(
      `${n} runtime ${plural(n, 'declaration', 'declarations')} in this repository ${plural(n, 'does not satisfy', 'do not satisfy')} this upgrade's runtime requirement.`,
    );
  }
  if (partial.length > 0) {
    const n = partial.length;
    out.push(
      `${n} runtime ${plural(n, 'declaration allows', 'declarations allow')} versions this upgrade's runtime requirement rejects.`,
    );
  }
  if (unknown.length > 0) {
    const n = unknown.length;
    out.push(
      `${n} runtime ${plural(n, 'declaration is', 'declarations are')} dynamically defined; Drift could not determine whether ${plural(n, 'it satisfies', 'they satisfy')} this upgrade's runtime requirement.`,
    );
  }
  return out;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The headline shown against the recommendation. */
export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  'safe-to-upgrade': 'Safe to upgrade',
  'upgrade-recommended': 'Upgrade recommended',
  'upgrade-after-review': 'Upgrade after review',
  'manual-migration-required': 'Migration required',
  'insufficient-evidence': 'Insufficient evidence',
  'do-not-upgrade-yet': 'Do not upgrade yet',
};
