import type { DetectionArtifact } from '../artifacts/prediction.ts';
import type { Conclusion } from '../review.ts';
import {
  breakingChangeIdentity,
  dependencyChangeIdentity,
  impactFileIdentity,
  impactSiteSymbolIdentity,
  upstreamFindingIdentity,
  scopedTo,
} from '../artifacts/identity.ts';

/**
 * Detection scoring, at four independent levels.
 *
 * One pooled detection F1 cannot be acted on. "Drift never fetched the
 * evidence", "Drift fetched it and classified the removal as a rename",
 * "Drift classified it correctly and missed the wrapper that calls it", and
 * "Drift found everything and still told the user it was safe" are four
 * different defects in four different modules, and they are indistinguishable
 * once averaged. So:
 *
 *   D0  dependency-update detection — did the manifest diff find the bump?
 *   D1  upstream fact discovery     — did evidence state what changed upstream?
 *   D2  breaking-change interpretation — was that turned into the right finding?
 *   D3  consumer localization       — did it land on the right code?
 *   D4  verdict / safety            — was the user told something honest?
 *
 * A level whose ground truth the accepted adjudication does not state is
 * reported `not-adjudicated` and contributes to nothing. It is never
 * zero-filled: scoring an unstated expectation as an empty set would turn
 * "the reviewers did not rule on this" into "Drift correctly predicted
 * nothing", which is the empty-set trap in a new costume.
 */

export type LevelStatus = 'scored' | 'not-adjudicated';

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
}

export interface LevelScore {
  status: LevelStatus;
  confusion: Confusion;
  /** The identities behind the counts, so a report can show *what* was missed rather than how many. */
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
  /** True when both expected and actual were empty. Excluded from macro averages; harmless in micro. */
  vacuous: boolean;
}

export interface DetectionScore {
  caseId: string;
  d0DependencyDetection: LevelScore;
  d1UpstreamFacts: LevelScore;
  d2BreakingChanges: LevelScore;
  d3LocalizationSymbol: LevelScore;
  d3LocalizationFile: LevelScore;
  d4: {
    verdict: string;
    groundTruthSafety: Conclusion['groundTruthSafety'];
    /** Accepted truth says unsafe and Drift's user-facing verdict was safe-equivalent. The one CI-blocking product signal. */
    falseSafe: boolean;
    /** Truth was uncertain and Drift claimed safe. A bad outcome, reported separately — calling it a false-safe would overstate what the benchmark established. */
    unsupportedSafe: boolean;
    /** Truth says safe, Drift said safe-equivalent. */
    correctSafe: boolean;
    /** Truth says unsafe and Drift said affected. */
    correctAffected: boolean;
  };
  taxonomy: { status: LevelStatus; correct: boolean };
  gapRecall: { status: LevelStatus; recall: number };
}

/**
 * Only these two verdicts are a claim of safety.
 *
 * Every other production verdict — `insufficient-evidence`,
 * `verification-incomplete`, `detected-not-locally-reachable`, `unchecked`,
 * `verification-failed`, `upstream-only` — describes an incomplete or
 * inconclusive check, and an incomplete check is not a safe claim. Widening
 * this set is the single easiest way to make a false-safe rate look better
 * without changing the product, which is exactly why it is a named constant
 * with this comment attached to it.
 */
const SAFE_EQUIVALENT = new Set(['no-incompatible-change-in-checked-surfaces', 'clean']);

export function isSafeEquivalent(verdict: string): boolean {
  return SAFE_EQUIVALENT.has(verdict);
}

export interface ScoreDetectionInput {
  caseId: string;
  detection: DetectionArtifact;
  /** Read from the private adjudication. This function is Layer D and nothing else calls it. */
  truth: Conclusion;
}

export function scoreDetection(input: ScoreDetectionInput): DetectionScore {
  const { caseId, detection, truth } = input;
  const scope = (identity: string): string => scopedTo(caseId, identity);

  const d0 = level(
    truth.dependencyChanges,
    detection.dependencyChanges.map((change) =>
      dependencyChangeIdentity({ name: change.name, ecosystem: change.ecosystem, from: change.from, to: change.to, workspace: change.workspace }),
    ),
    scope,
    parseDependencyExpectation,
  );

  const d1 = level(
    truth.evidenceFindings,
    detection.upstreamFindings.map((finding) =>
      upstreamFindingIdentity({ dependency: finding.dependency, code: finding.code, symbol: finding.symbol, workspace: finding.workspace }),
    ),
    scope,
    parseEvidenceExpectation,
  );

  const d2 = level(
    truth.upstreamFindings,
    detection.breakingChanges.map((change) =>
      breakingChangeIdentity({
        dependency: change.dependency,
        workspace: change.workspace,
        kind: change.kind,
        symbols: change.symbols,
        // Deliberately excluded from the comparison until adjudications state
        // expected replacements: including a field ground truth never ruled on
        // would score every correct rename as a mismatch.
        replacementSymbols: [],
      }),
    ),
    scope,
    parseBreakingChangeExpectation,
  );

  const d3Symbol = level(
    truth.impactSites,
    detection.impactSites.map((site) =>
      impactSiteSymbolIdentity({ file: site.file, matchedSymbol: site.matchedSymbol, enclosingSymbol: undefined }),
    ),
    scope,
    parseImpactSiteExpectation,
  );

  const d3File = level(
    truth.impactSites,
    detection.impactSites.map((site) => impactFileIdentity({ file: site.file })),
    scope,
    (expectation) => impactFileIdentity({ file: expectation.split(':')[0] ?? expectation }),
  );

  const driftSaysSafe = isSafeEquivalent(detection.verdict);

  return {
    caseId,
    d0DependencyDetection: d0,
    d1UpstreamFacts: d1,
    d2BreakingChanges: d2,
    d3LocalizationSymbol: d3Symbol,
    d3LocalizationFile: d3File,
    d4: {
      verdict: detection.verdict,
      groundTruthSafety: truth.groundTruthSafety,
      falseSafe: truth.groundTruthSafety === 'unsafe' && driftSaysSafe,
      unsupportedSafe: truth.groundTruthSafety === 'uncertain' && driftSaysSafe,
      correctSafe: truth.groundTruthSafety === 'safe' && driftSaysSafe,
      correctAffected: truth.groundTruthSafety === 'unsafe' && detection.verdict === 'locally-affected',
    },
    taxonomy: scoreTaxonomy(truth, detection),
    gapRecall:
      truth.gaps.length === 0
        ? { status: 'not-adjudicated', recall: 0 }
        : {
            status: 'scored',
            recall: truth.gaps.filter((gap) => detection.gaps.some((actual) => actual.includes(gap))).length / truth.gaps.length,
          },
  };
}

/**
 * One level's confusion matrix, or `not-adjudicated` when truth is silent.
 *
 * `undefined` and `[]` mean different things and must keep meaning different
 * things: `undefined` is "no reviewer ruled on this level", `[]` is "reviewers
 * ruled that there is nothing here", and only the second is scorable — it is
 * how a negative/control case correctly punishes a false positive.
 */
function level(
  expected: readonly string[] | undefined,
  actual: readonly string[],
  scope: (identity: string) => string,
  parse: (expectation: string) => string,
): LevelScore {
  if (expected === undefined) {
    return { status: 'not-adjudicated', confusion: { tp: 0, fp: 0, fn: 0 }, truePositives: [], falsePositives: [], falseNegatives: [], vacuous: false };
  }

  const expectedSet = new Set(expected.map((expectation) => scope(parse(expectation))));
  const actualSet = new Set(actual.map(scope));

  const truePositives = [...expectedSet].filter((id) => actualSet.has(id)).sort();
  const falseNegatives = [...expectedSet].filter((id) => !actualSet.has(id)).sort();
  const falsePositives = [...actualSet].filter((id) => !expectedSet.has(id)).sort();

  return {
    status: 'scored',
    confusion: { tp: truePositives.length, fp: falsePositives.length, fn: falseNegatives.length },
    truePositives,
    falsePositives,
    falseNegatives,
    vacuous: expectedSet.size === 0 && actualSet.size === 0,
  };
}

function scoreTaxonomy(truth: Conclusion, detection: DetectionArtifact): { status: LevelStatus; correct: boolean } {
  if (!truth.taxonomy) return { status: 'not-adjudicated', correct: false };
  // Correct when *any* predicted breaking change carries the adjudicated
  // taxonomy. A multi-change migration legitimately produces several, and
  // requiring the first one to match would score a correct multi-change
  // analysis as wrong for ordering reasons.
  const correct = detection.breakingChanges.some(
    (change) =>
      change.taxonomy !== undefined &&
      change.taxonomy.nature === truth.taxonomy!.nature &&
      change.taxonomy.scope === truth.taxonomy!.scope &&
      sameSet(change.taxonomy.detectability, truth.taxonomy!.detectability) &&
      sameSet(change.taxonomy.visibility, truth.taxonomy!.visibility),
  );
  return { status: 'scored', correct };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/*
 * Expectation parsers.
 *
 * Adjudicated conclusions are written by reviewers in a compact textual form.
 * Parsing happens here, in the evaluator, rather than at review time, so the
 * review records stay human-readable and reviewable, and so a change to how
 * identities are computed cannot silently invalidate every stored review.
 *
 * A malformed expectation is returned verbatim rather than dropped: it will
 * fail to match anything and surface as a false negative with a visibly
 * unparseable identity, which is a loud, diagnosable failure. Silently
 * discarding it would quietly shrink the denominator.
 */

/** `npm:left-pad:1.0.0->2.0.0`, optionally `npm:pkg@workspace:1.0.0->2.0.0`. */
function parseDependencyExpectation(expectation: string): string {
  const match = /^(?<ecosystem>[^:]+):(?<name>[^:@]+)(?:@(?<workspace>[^:]+))?:(?<from>[^>]+)->(?<to>.+)$/.exec(expectation);
  if (!match?.groups) return expectation;
  return dependencyChangeIdentity({
    ecosystem: match.groups['ecosystem']!,
    name: match.groups['name']!,
    from: match.groups['from']!,
    to: match.groups['to']!,
    ...(match.groups['workspace'] ? { workspace: match.groups['workspace'] } : {}),
  });
}

/** `dependency:code:symbol` — the evidence layer's own rule code, not prose. */
function parseEvidenceExpectation(expectation: string): string {
  const parts = expectation.split(':');
  if (parts.length < 3) return expectation;
  return upstreamFindingIdentity({ dependency: parts[0]!, code: parts[1]!, symbol: parts.slice(2).join(':') });
}

/** `dependency:symbol:kind` — the historical adjudication format, which states an interpretation and so scores D2. */
function parseBreakingChangeExpectation(expectation: string): string {
  const parts = expectation.split(':');
  if (parts.length < 3) return expectation;
  const kind = parts[parts.length - 1]!;
  const symbol = parts.slice(1, -1).join(':');
  return breakingChangeIdentity({ dependency: parts[0]!, kind, symbols: [symbol], replacementSymbols: [] });
}

/** `file:symbol`. */
function parseImpactSiteExpectation(expectation: string): string {
  const index = expectation.lastIndexOf(':');
  if (index <= 0) return expectation;
  return impactSiteSymbolIdentity({ file: expectation.slice(0, index), matchedSymbol: expectation.slice(index + 1) });
}
