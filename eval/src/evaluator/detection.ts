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

/**
 * Taxonomy needs a third state the confusion levels do not.
 *
 * An adjudication states *one* taxonomy for the case, so when reviewers ruled
 * on more than one breaking change there is no way to say which of them that
 * taxonomy describes. Scoring it anyway would mean crediting (or charging) a
 * classification against a finding nobody attributed it to. `not-attributable`
 * says so and contributes to nothing, exactly as `not-adjudicated` does — the
 * two are kept apart because they call for different fixes: one needs a
 * reviewer to rule, the other needs the adjudication schema to say which
 * finding it is ruling about.
 */
export type TaxonomyStatus = LevelStatus | 'not-attributable';

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
    /** Truth says safe and Drift's verdict was not a safety claim at all. Neither correct nor a safety failure. */
    safeButInconclusive: boolean;
  };
  taxonomy: {
    status: TaxonomyStatus;
    correct: boolean;
    /**
     * Predicted breaking changes that matched adjudicated truth at D2 — the
     * only ones whose taxonomy may be credited. A prediction nobody asked for
     * cannot earn a taxonomy point by guessing a label that happens to be
     * right about a different symbol.
     */
     matchedChanges: number;
  };
  gapRecall: { status: LevelStatus; recall: number };
}

/**
 * The verdicts that tell a user this upgrade does not affect their repository.
 *
 * Widening this set is the single easiest way to make a false-safe rate look
 * better without changing the product, so it is a named constant with its
 * reasoning attached, and every member has to be defended.
 *
 * `no-incompatible-change-in-checked-surfaces` and `clean` are the two.
 * `detected-not-locally-reachable` was previously included on the grounds that
 * "we searched and found nothing" is a conclusion about the user's code. That
 * reasoning is now rejected in production: a completed syntactic search misses
 * structural typing, inferred types, wrappers, generated code, dynamic
 * dispatch, behavioural changes and ownership relationships, so production
 * treats that verdict as "review needed", not a safety claim. It is excluded
 * here to match — a known-breaking upgrade Drift reports that way is a
 * conservative miss, not a false-safe.
 *
 * Every remaining verdict — `insufficient-evidence`, `verification-incomplete`,
 * `unchecked`, `verification-failed`, `upstream-only`, `detected-not-locally-
 * reachable` — describes a check that did not complete or did not establish
 * safety, and neither is a claim that the repository is unaffected.
 */
const SAFE_EQUIVALENT = new Set([
  'no-incompatible-change-in-checked-surfaces',
  'clean',
]);

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
      /**
       * Truth says safe and Drift did not establish it either way. Not a
       * failure of safety — nothing unsafe was claimed — and not a success
       * either. Reported so a control case that produced no conclusion cannot
       * be mistaken for one that produced the right conclusion.
       */
      safeButInconclusive: truth.groundTruthSafety === 'safe' && !driftSaysSafe,
    },
    taxonomy: scoreTaxonomy(truth, detection, d2, scope),
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

function scoreTaxonomy(
  truth: Conclusion,
  detection: DetectionArtifact,
  d2: LevelScore,
  scope: (identity: string) => string,
): DetectionScore['taxonomy'] {
  if (!truth.taxonomy) return { status: 'not-adjudicated', correct: false, matchedChanges: 0 };

  /**
   * Only predictions that matched adjudicated truth at D2 are eligible.
   *
   * This was previously `detection.breakingChanges.some(...)`, which credited
   * the case whenever *any* prediction carried the expected labels — including
   * a prediction that was itself a false positive about an unrelated symbol.
   * A tool that misclassified the real change and hallucinated a second one
   * with the right label scored a correct taxonomy, which is the opposite of
   * what the metric is for. Taxonomy is a property of a finding, so it is
   * scored on the findings truth actually recognised.
   */
  const matched = new Set(d2.truePositives);
  const matchedChanges = detection.breakingChanges.filter((change) =>
    matched.has(
      scope(
        breakingChangeIdentity({
          dependency: change.dependency,
          workspace: change.workspace,
          kind: change.kind,
          symbols: change.symbols,
          replacementSymbols: [],
        }),
      ),
    ),
  );

  /**
   * One adjudicated taxonomy cannot be attributed across several adjudicated
   * findings. Reported rather than guessed at; no case in the corpus is in
   * this state today, and the day one is, the adjudication schema — not this
   * function — is what needs to change.
   */
  if ((truth.upstreamFindings?.length ?? 0) > 1) {
    return { status: 'not-attributable', correct: false, matchedChanges: matchedChanges.length };
  }

  // Nothing matched: Drift did not produce the finding this taxonomy belongs
  // to, so it did not classify it correctly either. Scored, and wrong.
  const correct = matchedChanges.some(
    (change) =>
      change.taxonomy !== undefined &&
      change.taxonomy.nature === truth.taxonomy!.nature &&
      change.taxonomy.scope === truth.taxonomy!.scope &&
      sameSet(change.taxonomy.detectability, truth.taxonomy!.detectability) &&
      sameSet(change.taxonomy.visibility, truth.taxonomy!.visibility),
  );
  return { status: 'scored', correct, matchedChanges: matchedChanges.length };
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
