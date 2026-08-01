import type {
  BreakingChange,
  Confidence,
  DependencyChange,
  Evidence,
  StructuredFinding,
} from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { stableId } from '../util/id.js';
import {
  kindForFindingCode,
  matchProse,
  remediationForFinding,
  remediationForProse,
  type ProseMatch,
} from './rules.js';
import { extractWithLlm } from './llm.js';

/**
 * Turn evidence into breaking-change records.
 *
 * The central design constraint: a BreakingChange may never exist without at
 * least one Evidence citation. That invariant is what lets the PR say "here is
 * why" for every edit, and it is what a reviewer needs in order to approve a
 * change they did not write.
 */

export interface AnalyzeOptions {
  config: DriftConfig;
  logger: Logger;
}

export async function analyze(
  changes: readonly DependencyChange[],
  evidence: readonly Evidence[],
  options: AnalyzeOptions,
): Promise<BreakingChange[]> {
  const { config, logger } = options;
  const byDependency = groupEvidence(evidence);
  const results: BreakingChange[] = [];

  for (const change of changes) {
    const relevant = byDependency.get(change.name) ?? [];
    results.push(...analyzeDependency(change.name, relevant));
  }

  // Spec-derived evidence is keyed by file path rather than a package name, so
  // it is not covered by the loop above.
  for (const record of evidence) {
    if (record.source !== 'openapi-diff') continue;
    results.push(...fromComputedEvidence(record));
  }

  if (config.llm.enabled) {
    const llmResults = await extractWithLlm(changes, evidence, results, { config, logger });
    results.push(...llmResults);
  }

  return dedupe(results);
}

/** Bucket evidence by the dependency it describes. */
function groupEvidence(evidence: readonly Evidence[]): Map<string, Evidence[]> {
  const byDependency = new Map<string, Evidence[]>();
  for (const record of evidence) {
    const bucket = byDependency.get(record.dependency);
    if (bucket) bucket.push(record);
    else byDependency.set(record.dependency, [record]);
  }
  return byDependency;
}

function analyzeDependency(dependency: string, evidence: readonly Evidence[]): BreakingChange[] {
  const out: BreakingChange[] = [];

  for (const record of evidence) {
    if (record.findings?.length) {
      out.push(...fromComputedEvidence(record));
      continue;
    }
    if (record.source === 'semver-heuristic' || record.source === 'registry-metadata') {
      continue; // Context, not a specific breaking change.
    }
    out.push(...fromProseEvidence(record, dependency));
  }

  return corroborate(out, evidence);
}

/** Computed findings map one-to-one onto breaking changes; no inference needed. */
function fromComputedEvidence(record: Evidence): BreakingChange[] {
  return (record.findings ?? []).map((finding) => ({
    id: stableId('bc', record.dependency, finding.code, finding.symbol),
    dependency: record.dependency,
    kind: kindForFindingCode(finding.code),
    summary: finding.detail,
    remediation: remediationForFinding(finding, record.dependency),
    symbols: symbolsFromFinding(finding),
    // A computed diff is ground truth about the upstream artefact. It is the
    // only source that earns `high` without corroboration.
    confidence: 'high' as Confidence,
    citations: [record.id],
  }));
}

/**
 * Derive searchable symbols from a finding.
 *
 * For a member change like `Client.request`, both the qualified and bare names
 * are useful: the qualified form is precise, the bare form catches destructured
 * and aliased usage that the qualified form would miss.
 *
 * Three or more parts means the leading one is a namespace, not an owner —
 * `unix.NexthopGrp.Resvd1` is a field of `NexthopGrp` in package `unix`. Adding
 * the namespace as a search symbol matched every line that used the package at
 * all, so a repository whose only Go call was `unix.Getpid()` was reported as
 * having three sites affected by a change to a netlink struct it never touches.
 * The owner is the second-to-last part; the leading namespace is never a symbol.
 */
function symbolsFromFinding(finding: StructuredFinding): string[] {
  const symbols = new Set<string>([finding.symbol]);

  // A symbol containing whitespace is a label, not an identifier — the counted
  // aggregate a provider emits when a hundred constants move at once. Splitting
  // `golang.org/x/sys constants` on its dots yielded `golang`, which matched the
  // import line of every file that used the module.
  if (finding.symbol.includes('.') && !/\s/.test(finding.symbol)) {
    const parts = finding.symbol.split('.');
    const last = parts[parts.length - 1];
    if (last) symbols.add(last);

    if (parts.length === 2) {
      const owner = parts[0];
      if (owner) symbols.add(owner);
    } else {
      // `unix.NexthopGrp.Resvd1` → also search `NexthopGrp.Resvd1`, which is how
      // the field is written wherever the package is imported under an alias.
      const owner = parts[parts.length - 2];
      if (owner) symbols.add(`${owner}.${last}`);
    }
  }

  // OpenAPI locations arrive as `GET /users/{id}`; the path alone is what
  // appears in client code.
  const endpoint = /^[A-Z]+\s+(\/\S*)$/.exec(finding.symbol);
  if (endpoint?.[1]) {
    symbols.add(endpoint[1]);
    // Client code usually interpolates the parameter rather than writing it
    // literally, so index on the static prefix too.
    const staticPrefix = endpoint[1].split('{')[0]?.replace(/\/$/, '');
    if (staticPrefix && staticPrefix.length > 1) symbols.add(staticPrefix);
  }

  return [...symbols];
}

function fromProseEvidence(record: Evidence, dependency: string): BreakingChange[] {
  const out: BreakingChange[] = [];
  const seen = new Set<string>();

  for (const line of record.content.split('\n')) {
    for (const match of matchProse(line)) {
      const key = `${match.kind}:${match.symbols.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // A package-wide change (an ESM migration, say) names no export. The
      // package itself becomes the search symbol so localization still finds
      // the import and `require()` sites that need changing.
      const symbols = match.symbols.length > 0 ? match.symbols : [dependency];

      out.push({
        id: stableId('bc', dependency, match.ruleId, match.symbols.join(',')),
        dependency,
        kind: match.kind,
        summary: match.summary,
        remediation: remediationForProse(match, dependency),
        symbols,
        replacementSymbols: match.replacementSymbols.length ? match.replacementSymbols : undefined,
        // Prose starts at `medium`: a maintainer stating "X was removed" is a
        // strong signal, but changelogs are written by humans in a hurry and
        // routinely describe changes that shipped differently.
        confidence: confidenceForSource(record),
        citations: [record.id],
      });
    }
  }

  return out;
}

function confidenceForSource(record: Evidence): Confidence {
  if (record.weight >= 0.95) return 'high';
  if (record.weight >= 0.6) return 'medium';
  return 'low';
}

/**
 * Raise confidence for changes that more than one independent source agrees on.
 *
 * If the changelog says `foo` was removed *and* the .d.ts diff shows `foo`
 * gone, that is far stronger than either alone — and it is exactly the case
 * where an automatic fix is safe.
 */
function corroborate(changes: BreakingChange[], evidence: readonly Evidence[]): BreakingChange[] {
  const bySymbol = new Map<string, Set<string>>();

  for (const change of changes) {
    for (const symbol of change.symbols) {
      const sources = bySymbol.get(symbol) ?? new Set<string>();
      for (const citation of change.citations) {
        const record = evidence.find((e) => e.id === citation);
        if (record) sources.add(record.source);
      }
      bySymbol.set(symbol, sources);
    }
  }

  return changes.map((change) => {
    const sources = new Set<string>();
    for (const symbol of change.symbols) {
      for (const source of bySymbol.get(symbol) ?? []) sources.add(source);
    }

    if (sources.size >= 2 && change.confidence !== 'high') {
      return { ...change, confidence: 'high' as Confidence };
    }
    return change;
  });
}

/**
 * Merge duplicate records, unioning their citations.
 *
 * The same removal legitimately appears in a release note, the changelog, and
 * the type diff. A reviewer should see one finding with three sources, not
 * three findings.
 */
function dedupe(changes: readonly BreakingChange[]): BreakingChange[] {
  const merged = new Map<string, BreakingChange>();

  for (const change of changes) {
    const key = `${change.dependency}|${change.kind}|${[...change.symbols].sort().join(',')}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...change, citations: [...new Set(change.citations)] });
      continue;
    }

    merged.set(key, {
      ...existing,
      // Prefer the more specific summary; computed findings are more precise
      // than a changelog sentence and tend to be longer.
      summary: existing.summary.length >= change.summary.length ? existing.summary : change.summary,
      symbols: [...new Set([...existing.symbols, ...change.symbols])],
      replacementSymbols: [
        ...new Set([...(existing.replacementSymbols ?? []), ...(change.replacementSymbols ?? [])]),
      ].filter(Boolean).length
        ? [...new Set([...(existing.replacementSymbols ?? []), ...(change.replacementSymbols ?? [])])]
        : undefined,
      confidence: maxConfidence(existing.confidence, change.confidence),
      citations: [...new Set([...existing.citations, ...change.citations])],
    });
  }

  const order: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  return [...merged.values()].sort(
    (a, b) => order[a.confidence] - order[b.confidence] || a.dependency.localeCompare(b.dependency),
  );
}

function maxConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function meetsConfidence(actual: Confidence, minimum: Confidence): boolean {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[actual] >= rank[minimum];
}

export * from './rules.js';
export type { ProseMatch };
