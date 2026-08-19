/**
 * Canonical identities for the objects detection is scored on.
 *
 * The previous harness flattened every prediction into a string built from
 * `${dependency}:${symbol}:${kind}` before it ever reached scoring, and one of
 * those components — `kind` — was recovered by pattern-matching English out of
 * a finding's `detail` prose. Two things were wrong with that. Prose is not a
 * stable key: rewording a message in `src/evidence/` silently changes a
 * benchmark result, which is the definition of a measurement that drifts. And
 * flattening discards the fields a *diagnosable* miss needs — a benchmark that
 * can only say "F1 0.6" cannot say whether Drift never fetched the evidence or
 * saw the removal and failed to localize the wrapper around it.
 *
 * So predictions are stored structured and canonicalized here, at scoring
 * time, from typed fields only. Every identity function is pure, total, and
 * deterministic under reordering, because the sets they feed are compared with
 * set algebra and a set whose membership depends on iteration order is not a
 * set.
 */

/** Lowercased, whitespace-collapsed, punctuation-trimmed. Applied to every free-text component of an identity. */
function norm(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** `''` for the single-package case, so a workspace-less repo and `workspace: ''` never split into two identities. */
function workspaceKey(workspace: string | undefined | null): string {
  return norm(workspace);
}

export interface DependencyChangeFacts {
  name: string;
  ecosystem: string;
  from: string | null;
  to: string | null;
  workspace?: string;
}

/**
 * D0's unit. Includes both versions because "Drift noticed left-pad moved" and
 * "Drift noticed left-pad moved from 1.0.0 to 2.0.0" are different claims, and
 * a benchmark that cannot distinguish them cannot score version correctness.
 */
export function dependencyChangeIdentity(facts: DependencyChangeFacts): string {
  return [
    'dep',
    norm(facts.ecosystem),
    workspaceKey(facts.workspace),
    norm(facts.name),
    norm(facts.from) || 'absent',
    norm(facts.to) || 'absent',
  ].join('|');
}

export interface UpstreamFindingFacts {
  dependency: string;
  workspace?: string;
  /** The provider's own rule code — `export-removed`, `member-removed`, ... Never English prose. */
  code: string;
  symbol: string;
}

/**
 * D1's unit: one upstream fact, as the evidence layer stated it. Deliberately
 * excludes `detail`, `before` and `after` — those are what a reviewer reads to
 * decide whether the fact is right, not what makes two statements of the same
 * fact equal.
 */
export function upstreamFindingIdentity(facts: UpstreamFindingFacts): string {
  return ['upstream', workspaceKey(facts.workspace), norm(facts.dependency), norm(facts.code), norm(facts.symbol)].join('|');
}

export interface BreakingChangeFacts {
  dependency: string;
  workspace?: string;
  kind: string;
  symbols: readonly string[];
  replacementSymbols?: readonly string[];
}

/**
 * D2's unit: Drift's *interpretation* of the upstream facts.
 *
 * `symbols` and `replacementSymbols` are sorted before joining, so a change
 * reporting `[a, b]` and one reporting `[b, a]` are the same interpretation.
 * Replacements participate because a rename claiming the wrong new name is a
 * materially different (and more dangerous) answer than one claiming the right
 * one — it is the difference between an abstention and a wrong codemod.
 */
export function breakingChangeIdentity(facts: BreakingChangeFacts): string {
  const symbols = [...facts.symbols].map(norm).sort().join(',');
  const replacements = [...(facts.replacementSymbols ?? [])].map(norm).sort().join(',');
  return ['break', workspaceKey(facts.workspace), norm(facts.dependency), norm(facts.kind), symbols, replacements].join('|');
}

export interface ImpactSiteFacts {
  file: string;
  matchedSymbol: string;
  /** 1-indexed. Used only by the line-level view; the symbol-level view ignores it. */
  line?: number;
  enclosingSymbol?: string;
}

/**
 * D3 has two views, and both are reported, because they answer different
 * questions and neither alone is honest.
 *
 * The SYMBOL view (`file` + matched symbol + enclosing symbol) survives
 * harmless reformatting: adding an import above a call site moves every line
 * number in the file without changing what Drift found. Scoring only on line
 * numbers would report a false negative for a correct localization, which is
 * a benchmark bug reported as a product failure.
 *
 * The LINE view keeps the exact anchor, because a tool that names the right
 * file and the wrong line has not actually localized anything a developer can
 * use, and a symbol-only score would hide that.
 */
export function impactSiteSymbolIdentity(facts: ImpactSiteFacts): string {
  return ['site', norm(facts.file), norm(facts.matchedSymbol), norm(facts.enclosingSymbol)].join('|');
}

export function impactSiteLineIdentity(facts: ImpactSiteFacts): string {
  return ['site-line', norm(facts.file), String(facts.line ?? 0), norm(facts.matchedSymbol)].join('|');
}

/** File-level rollup of D3, for cases where ground truth can name the file but not defensibly name every site. */
export function impactFileIdentity(facts: Pick<ImpactSiteFacts, 'file'>): string {
  return ['file', norm(facts.file)].join('|');
}

/**
 * Namespacing, applied by the evaluator before any comparison.
 *
 * Two cases can legitimately contain the same package at the same versions
 * with the same symbol; without this, one case's prediction could satisfy
 * another's ground truth. Applied at comparison time rather than baked into
 * the identity functions so the identities stay meaningful (and readable) on
 * their own in a report.
 */
export function scopedTo(caseId: string, identity: string): string {
  return `${caseId}::${identity}`;
}
