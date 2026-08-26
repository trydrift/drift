import { createHash } from 'node:crypto';
import type { BreakingChange, Confidence, Evidence, EvidenceSource, ImpactSite } from '../types.js';
import {
  bandFor,
  OVERALL_LABEL,
  type AnalysisGap,
  type CheckedSurface,
  type ConfidenceAssessment,
  type ConfidenceReason,
  type ConfidenceScore,
  type OverallConfidence,
  type VerificationOutcome,
} from './types.js';
import { isLocallyUnprovable, type ChangeTaxonomy } from './taxonomy.js';
import { SPEC_ORIGIN_CLASSES } from '../evidence/spec/index.js';

/**
 * The one calculation.
 *
 * Every confidence value Drift reports comes from here. That is the point:
 * before this, `analyze/index.ts` decided upstream confidence, `localize/
 * index.ts` decided per-site confidence, and `plan/index.ts` compared the
 * result against a threshold — three places with three notions of what the
 * number meant, and no way to explain any of them to a reader.
 *
 * Scores are bounded to [0, 1] and every contribution is recorded, so a report
 * can show its working rather than asserting a band.
 */

/**
 * Bump when weights change.
 *
 * Stored on every score, because a number without the rules that produced it is
 * not interpretable later — and these scores end up in reports, plans, and
 * eventually benchmark baselines.
 */
export const CALIBRATION_VERSION = 'drift-confidence-1';

/**
 * Independent origin classes for evidence.
 *
 * Corroboration is only meaningful across genuinely independent observations,
 * and `EvidenceSource` does not capture that: a GitHub release body and a
 * CHANGELOG entry are routinely *the same text*, published twice. Counting them
 * as two sources is what let a single unverified maintainer sentence reach
 * `high` confidence — the exact over-claim this model exists to stop.
 *
 * A computed artifact diff and a changelog genuinely are independent: one is
 * derived from the shipped package, the other from what someone wrote about it.
 */
const ORIGIN_CLASS: Record<EvidenceSource, string> = {
  'type-surface-diff': 'computed-artifact',
  // Contract-document diffs declare their own class, next to the differ that
  // produces them — a diff of a committed `.proto` is as much a computed
  // artifact as a diff of an OpenAPI document, and neither should have to be
  // remembered here to be scored.
  ...SPEC_ORIGIN_CLASSES,
  // Same author, same release, frequently copy-pasted between the two.
  changelog: 'maintainer-narrative',
  'github-release': 'maintainer-narrative',
  // A deliberate, separately written document — independent of the narrative.
  'migration-guide': 'maintainer-guide',
  'behavioural-diff': 'dynamic-observation',
  'registry-metadata': 'registry',
  'semver-heuristic': 'heuristic',
};

/** How much each origin class is worth on its own. */
const ORIGIN_WEIGHT: Record<string, number> = {
  'computed-artifact': 0.9,
  'maintainer-guide': 0.7,
  'maintainer-narrative': 0.6,
  'dynamic-observation': 0.5,
  registry: 0.4,
  // A version number is not evidence that anything specific broke.
  heuristic: 0.2,
};

/**
 * Evidence snapshots are immutable for the lifetime of an analysis. A single
 * registry or artifact record can support hundreds of findings, and confidence
 * is recalculated more than once while the plan is assembled. Normalising and
 * hashing a multi-megabyte record for every finding caused multi-second event
 * loop stalls, so retain the content fingerprint with the record object.
 * Weak keys let completed scans and their large evidence strings be collected.
 */
const evidenceFingerprints = new WeakMap<Evidence, string>();

export interface UpstreamInput {
  change: BreakingChange;
  evidence: readonly Evidence[];
}

/**
 * How sure are we the upstream change is real?
 *
 * Deliberately says nothing about whether it affects this repository. A
 * computed API diff can be near-certain here and completely irrelevant locally.
 */
export function assessUpstream(input: UpstreamInput): ConfidenceScore {
  const { change, evidence } = input;
  const cited = evidence.filter((record) => change.citations.includes(record.id));

  const contributions: ConfidenceReason[] = [];
  const penalties: ConfidenceReason[] = [];

  if (cited.length === 0) {
    // The analyser enforces at least one citation, so this is a defect rather
    // than an ordinary outcome — reported as zero rather than silently defaulted.
    return {
      score: 0,
      band: 'none',
      evidence: [],
      penalties: [{ code: 'no-citations', detail: 'No evidence record backs this finding.', delta: 0 }],
      calibration: CALIBRATION_VERSION,
    };
  }

  const independent = independentOrigins(cited);

  // The strongest single origin sets the floor.
  let best = 0;
  let bestClass = '';
  for (const origin of independent.keys()) {
    const weight = ORIGIN_WEIGHT[origin] ?? 0.3;
    if (weight > best) {
      best = weight;
      bestClass = origin;
    }
  }

  contributions.push({
    code: `origin:${bestClass}`,
    detail: `Strongest evidence class is ${describeOrigin(bestClass)}.`,
    delta: best,
  });

  let score = best;

  // Corroboration, counted once per independent class rather than per record.
  const corroborating = independent.size - 1;
  if (corroborating > 0) {
    const bonus = Math.min(0.15, 0.08 * corroborating);
    score += bonus;
    contributions.push({
      code: 'corroborated',
      detail: `Corroborated by ${corroborating} other independent source class(es): ${[...independent.keys()]
        .filter((o) => o !== bestClass)
        .map(describeOrigin)
        .join(', ')}.`,
      delta: bonus,
    });
  } else if (cited.length > 1) {
    // Several records, one origin. Worth stating plainly, because the count of
    // citations in the report otherwise implies corroboration that is not there.
    penalties.push({
      code: 'single-origin',
      detail: `All ${cited.length} citations trace to one source class (${describeOrigin(bestClass)}), so they do not corroborate each other.`,
      delta: 0,
    });
  }

  // A finding that only a heuristic supports is a guess about a version number.
  if (independent.size === 1 && bestClass === 'heuristic') {
    const penalty = -0.1;
    score += penalty;
    penalties.push({
      code: 'heuristic-only',
      detail: 'Only a semver heuristic supports this; no changelog, release note, or API diff was retrieved.',
      delta: penalty,
    });
  }

  return finalize(score, contributions, penalties);
}

/**
 * Group cited evidence into independent origins.
 *
 * Byte-identical content collapses into one entry regardless of declared
 * source, which catches the common case of a release body and a changelog
 * section being literally the same text.
 */
function independentOrigins(cited: readonly Evidence[]): Map<string, Evidence[]> {
  const byOrigin = new Map<string, Evidence[]>();
  const seenContent = new Set<string>();

  for (const record of cited) {
    let fingerprint = evidenceFingerprints.get(record);
    if (fingerprint === undefined) {
      fingerprint = createHash('sha256')
        .update(record.content.replace(/\s+/g, ' ').trim().toLowerCase())
        .digest('hex');
      evidenceFingerprints.set(record, fingerprint);
    }

    if (seenContent.has(fingerprint)) continue;
    seenContent.add(fingerprint);

    const origin = ORIGIN_CLASS[record.source] ?? 'unknown';
    const bucket = byOrigin.get(origin);
    if (bucket) bucket.push(record);
    else byOrigin.set(origin, [record]);
  }

  return byOrigin;
}

function describeOrigin(origin: string): string {
  switch (origin) {
    case 'computed-artifact':
      return 'a computed diff of the shipped artifact';
    case 'maintainer-guide':
      return 'a migration guide';
    case 'maintainer-narrative':
      return 'release notes or a changelog';
    case 'registry':
      return 'registry metadata';
    case 'heuristic':
      return 'a semver heuristic';
    default:
      return origin;
  }
}

export interface LocalImpactInput {
  change: BreakingChange;
  taxonomy: ChangeTaxonomy;
  sites: readonly ImpactSite[];
  /** False when there was no checkout to search. */
  localizationRan: boolean;
}

/**
 * Does this change reach code in this repository?
 *
 * The distinction that matters most here is between "searched, found nothing"
 * and "could not search". Both produce zero impact sites; only one of them is
 * information.
 */
export function assessLocalImpact(input: LocalImpactInput): ConfidenceScore {
  const { taxonomy, sites, localizationRan } = input;

  const contributions: ConfidenceReason[] = [];
  const penalties: ConfidenceReason[] = [];

  if (!localizationRan) {
    return {
      score: 0,
      band: 'none',
      evidence: [],
      penalties: [
        {
          code: 'localization-unavailable',
          detail:
            'No checkout was available, so Drift could not search this repository. This is not evidence that the change is unused.',
          delta: 0,
        },
      ],
      calibration: CALIBRATION_VERSION,
    };
  }

  if (sites.length === 0) {
    // Searched and found nothing. That is a real, useful answer — but only for
    // the surfaces a search can cover. An endpoint change has no import edge,
    // so finding nothing says almost nothing.
    const unprovable = isLocallyUnprovable(taxonomy);
    // A runtime requirement has no symbol and no call site, so "searched the
    // importers and found no usage" is not merely unhelpful here -- it is
    // false, and it is the sentence that made an unresolved runtime condition
    // read as a clean search. The runtime scope gets its own honest wording:
    // where the answer lives is the declared runtime, not the source tree.
    const runtimeScoped = taxonomy.scope === 'runtime';
    return {
      score: 0,
      band: 'none',
      evidence: [],
      penalties: [
        {
          code: runtimeScoped ? 'runtime-compatibility-unresolved' : unprovable ? 'not-locally-checkable' : 'no-usage-found',
          detail: runtimeScoped
            ? "This is a requirement on the runtime this repository builds and deploys on, not on any code it calls. No source search can answer it; the repository's own declared runtime version is what decides."
            : unprovable
              ? 'This change is only observable at runtime, so a source search cannot establish whether this repository is affected.'
              : 'Drift searched the files that import this dependency and found no usage of the affected symbols.',
          delta: 0,
        },
      ],
      calibration: CALIBRATION_VERSION,
    };
  }

  // The strongest site sets the score: one confidently-bound usage is what
  // makes the change locally real, regardless of how many weak matches follow.
  const strongest = sites.reduce((best, site) => (rank(site.confidence) > rank(best.confidence) ? site : best));

  const base =
    strongest.confidence === 'high' ? 0.85 : strongest.confidence === 'medium' ? 0.6 : 0.3;

  contributions.push({
    code: `site:${strongest.confidence}`,
    detail:
      strongest.confidence === 'high'
        ? `\`${strongest.matchedSymbol}\` is bound from an import of this dependency in ${strongest.file}.`
        : strongest.confidence === 'medium'
          ? `${strongest.file} imports this dependency and uses \`${strongest.matchedSymbol}\`, but the symbol was not traced to the import.`
          : `\`${strongest.matchedSymbol}\` appears in ${strongest.file}, but no import of this dependency was established — the match may be coincidental.`,
    delta: base,
  });

  let score = base;

  if (sites.length > 1) {
    const bonus = Math.min(0.05, 0.01 * (sites.length - 1));
    score += bonus;
    contributions.push({
      code: 'multiple-sites',
      detail: `${sites.length} affected locations across ${new Set(sites.map((s) => s.file)).size} file(s).`,
      delta: bonus,
    });
  }

  // Reachability qualifiers. Each of these means the fix may be correct at the
  // site Drift found and wrong about what actually depends on it.
  const generated = sites.filter((s) => isGeneratedPath(s.file));
  if (generated.length === sites.length) {
    const penalty = -0.25;
    score += penalty;
    penalties.push({
      code: 'generated-only',
      detail: `Every affected location is in generated code (${generated[0]!.file}). Editing it is usually wrong; the generator is the real site.`,
      delta: penalty,
    });
  } else if (generated.length > 0) {
    const penalty = -0.05;
    score += penalty;
    penalties.push({
      code: 'some-generated',
      detail: `${generated.length} affected location(s) are in generated code.`,
      delta: penalty,
    });
  }

  if (taxonomy.visibility.includes('reflection-or-dynamic')) {
    const penalty = -0.2;
    score += penalty;
    penalties.push({
      code: 'dynamic-access',
      detail: 'Dynamic or reflective access was detected, so the affected set cannot be enumerated by search.',
      delta: penalty,
    });
  }

  if (taxonomy.visibility.includes('wrapper-mediated')) {
    const penalty = -0.1;
    score += penalty;
    penalties.push({
      code: 'wrapper-mediated',
      detail: 'Usage is mediated by a local wrapper, so downstream callers of the wrapper are not enumerated here.',
      delta: penalty,
    });
  }

  const onlyTextual = sites.every((s) => s.confidence === 'low');
  if (onlyTextual) {
    const penalty = -0.1;
    score += penalty;
    penalties.push({
      code: 'textual-only',
      detail: 'Every match is textual — no import edge was established for any of them.',
      delta: penalty,
    });
  }

  return finalize(score, contributions, penalties);
}

/** Generated output, where the fix belongs upstream of the file. */
function isGeneratedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(generated|__generated__|gen|dist|build|out|vendor|node_modules)\//.test(lower) ||
    /\.(g|generated)\.[a-z]+$/.test(lower) ||
    /\.pb\.(go|ts|js|py)$/.test(lower) ||
    /_pb2?\.py$/.test(lower) ||
    /\.d\.ts$/.test(lower)
  );
}

export interface VerificationInput {
  outcomes: readonly VerificationOutcome[];
  /** Files this finding would have changed, for coverage comparison. */
  affectedFiles: readonly string[];
  taxonomy: ChangeTaxonomy;
}

/**
 * Did anything actually run to confirm the fix holds?
 *
 * Currently `none` for every finding in the core pipeline, because the core
 * pipeline does not run checks — the editor does. That is reported as a gap
 * rather than papered over, and it is the honest state of things: nothing has
 * been verified, so verification confidence is zero.
 */
export function assessVerification(input: VerificationInput): ConfidenceScore {
  const { outcomes, affectedFiles, taxonomy } = input;

  if (outcomes.length === 0) {
    return {
      score: 0,
      band: 'none',
      evidence: [],
      penalties: [
        {
          code: 'nothing-ran',
          detail: 'No checks were run against this finding, so nothing confirms the change was understood correctly.',
          delta: 0,
        },
      ],
      calibration: CALIBRATION_VERSION,
    };
  }

  const contributions: ConfidenceReason[] = [];
  const penalties: ConfidenceReason[] = [];

  const passed = outcomes.filter((o) => o.status === 'passed');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const didNotRun = outcomes.filter(
    (o) => o.status === 'skipped' || o.status === 'unavailable' || o.status === 'timed-out',
  );

  if (failed.length > 0) {
    // A failing check is information, but it is not confidence.
    return {
      score: 0,
      band: 'none',
      evidence: [],
      penalties: [
        {
          code: 'checks-failed',
          detail: `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}.`,
          delta: 0,
        },
      ],
      calibration: CALIBRATION_VERSION,
    };
  }

  let score = 0;

  // A type checker proves a great deal about a compile-time break and nothing
  // at all about a behaviour change. Weighting by what the check can actually
  // see is the difference between verification and ceremony.
  const compileTime = taxonomy.detectability.some(
    (d) => d === 'compile-time' || d === 'link-or-import' || d === 'manifest',
  );

  for (const outcome of passed) {
    const isTypeCheck = /type|compile|build|lint/i.test(outcome.name);
    const isTest = /test|spec/i.test(outcome.name);

    const weight = isTest ? 0.45 : isTypeCheck ? (compileTime ? 0.4 : 0.15) : 0.1;
    score += weight;

    contributions.push({
      code: `passed:${outcome.name}`,
      detail:
        isTypeCheck && !compileTime
          ? `\`${outcome.name}\` passed, but this change is not detectable at compile time — it does not confirm the behaviour is right.`
          : `\`${outcome.name}\` passed.`,
      delta: weight,
    });
  }

  for (const outcome of didNotRun) {
    penalties.push({
      code: `did-not-run:${outcome.name}`,
      detail: `\`${outcome.name}\` was ${outcome.status} and proves nothing.`,
      delta: 0,
    });
  }

  // Coverage: a passing test suite that never touches the changed files has not
  // exercised the change.
  const covered = new Set(passed.flatMap((o) => o.covers ?? []));
  if (covered.size > 0 && affectedFiles.length > 0) {
    const hit = affectedFiles.filter((f) => covered.has(f));
    if (hit.length === 0) {
      const penalty = -0.2;
      score += penalty;
      penalties.push({
        code: 'no-coverage',
        detail: 'The checks that passed do not cover any of the affected files.',
        delta: penalty,
      });
    }
  } else if (affectedFiles.length > 0) {
    penalties.push({
      code: 'coverage-unknown',
      detail: 'Which code paths the passing checks cover could not be established.',
      delta: 0,
    });
  }

  return finalize(score, contributions, penalties);
}

export interface AssessmentInput {
  change: BreakingChange;
  taxonomy: ChangeTaxonomy;
  evidence: readonly Evidence[];
  sites: readonly ImpactSite[];
  localizationRan: boolean;
  outcomes?: readonly VerificationOutcome[];
  checkedSurfaces?: readonly CheckedSurface[];
  gaps?: readonly AnalysisGap[];
}

/** Assemble the full assessment for one finding. */
export function assess(input: AssessmentInput): ConfidenceAssessment {
  const upstream = assessUpstream({ change: input.change, evidence: input.evidence });
  const localImpact = assessLocalImpact({
    change: input.change,
    taxonomy: input.taxonomy,
    sites: input.sites,
    localizationRan: input.localizationRan,
  });
  const verification = assessVerification({
    outcomes: input.outcomes ?? [],
    affectedFiles: [...new Set(input.sites.map((s) => s.file))],
    taxonomy: input.taxonomy,
  });

  const gaps = [...(input.gaps ?? [])];
  const reasons: ConfidenceReason[] = [];

  // A finding nothing local supports is not a candidate for automatic
  // execution, however certain the upstream evidence is. This is the
  // distinction the old single field could not express.
  if (upstream.band === 'high' && localImpact.band === 'none') {
    reasons.push({
      code: 'upstream-only',
      detail:
        'The upstream change is well established, but nothing in this repository was shown to be affected. High upstream confidence is not a reason to edit code.',
      delta: 0,
    });
  }

  const automaticExecutionEligible =
    upstream.band === 'high' &&
    (localImpact.band === 'high' || localImpact.band === 'medium') &&
    !gaps.some((gap) => gap.automaticExecution === 'blocks');

  return {
    upstream,
    localImpact,
    verification,
    automaticExecutionEligible,
    reasons,
    checkedSurfaces: [...(input.checkedSurfaces ?? [])],
    gaps,
  };
}

/**
 * The single customer-facing score, derived from the same three dimensions.
 *
 * Weighted toward the weaker of upstream and local impact rather than
 * averaged, for the same reason `deriveLegacyConfidence` is: a finding is only
 * as trustworthy as its weakest necessary link, and averaging a certain
 * upstream diff against an unestablished local match would print a
 * reassuring number for a claim nothing local actually supports.
 *
 * When local impact is `none` — Drift never searched, or searched and could
 * not tell — the score is capped well short of "confident", because the
 * question a customer is really asking ("does this break my code?") has not
 * been answered either way. That is the case this whole feature exists to
 * make legible: it is fine for Drift to say it is not sure, but it must not
 * dress up "not sure" as a middling verdict about the change itself.
 */
export function deriveOverallConfidence(assessment: ConfidenceAssessment): OverallConfidence {
  const { upstream, localImpact, verification } = assessment;

  const base =
    localImpact.band === 'none'
      ? Math.min(upstream.score, 0.55)
      : Math.min(upstream.score, localImpact.score);

  // A check that actually ran and passed against this change is the strongest
  // thing Drift can report; it only ever adds, and only once verification has
  // something to show (an absent or failed check should not subtract from a
  // score already earned on upstream and local grounds — `verification.score`
  // is already 0 in both of those cases).
  const verifiedBonus = verification.score > 0 ? Math.min(0.1, verification.score * 0.15) : 0;

  const score = Math.round(Math.max(0, Math.min(1, base + verifiedBonus)) * 100);
  const band = bandFor(score / 100);
  return { score, band, label: OVERALL_LABEL[band] };
}

/**
 * The legacy three-band value, derived.
 *
 * Kept so existing consumers — the extension's severity mapping, the report's
 * grouping, `minConfidence` — keep working through the migration. It is a view
 * of the assessment, never an independent calculation.
 *
 * Deliberately the *lower* of upstream and local impact: the old field was read
 * as "how much should I trust this finding", and a finding is only as
 * trustworthy as its weakest necessary link.
 */
export function deriveLegacyConfidence(assessment: ConfidenceAssessment): Confidence {
  const upstream = assessment.upstream.band;
  const local = assessment.localImpact.band;

  // No local impact established: fall back to upstream alone, capped at medium
  // so an unlocalized finding can never present as `high`.
  if (local === 'none') return upstream === 'high' ? 'medium' : toLegacy(upstream);

  return toLegacy(weaker(upstream, local));
}

function toLegacy(band: string): Confidence {
  return band === 'high' ? 'high' : band === 'medium' ? 'medium' : 'low';
}

function weaker(a: string, b: string): string {
  const order = ['none', 'low', 'medium', 'high'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

function rank(confidence: Confidence): number {
  return confidence === 'high' ? 2 : confidence === 'medium' ? 1 : 0;
}

function finalize(
  raw: number,
  evidence: ConfidenceReason[],
  penalties: ConfidenceReason[],
): ConfidenceScore {
  // Rounded so a score is stable in a digest and readable in a report; clamped
  // because contributions are additive and must not escape the range.
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
  return { score, band: bandFor(score), evidence, penalties, calibration: CALIBRATION_VERSION };
}
