import type { DetectionArtifact } from '../artifacts/prediction.ts';

/**
 * One conversion from a production `RemediationPlan` into the benchmark's
 * structured detection artifact, shared by every detection adapter.
 *
 * Shared deliberately: two adapters each flattening the plan their own way is
 * how "the end-to-end adapter scores worse" turns out to mean "the end-to-end
 * adapter's flattening dropped a field". The only difference between the
 * tracks should be which production code ran, never how its output was read.
 */

/** The subset of a production plan this conversion reads. Structural, so `dist/` types are not re-declared here. */
export interface PlanLike {
  changes: readonly {
    name: string;
    ecosystem: string;
    from: string | null;
    to: string | null;
    workspace?: string | undefined;
  }[];
  evidence: readonly {
    findings?: readonly { code: string; symbol: string; detail: string }[] | undefined;
    source?: string;
  }[];
  breakingChanges: readonly {
    id: string;
    dependency: string;
    workspace?: string | undefined;
    kind: string;
    symbols: readonly string[];
    replacementSymbols?: readonly string[] | undefined;
    summary: string;
    citations?: readonly { id?: string; url?: string }[] | undefined;
    taxonomy?: { nature: string; detectability: readonly string[]; scope: string; visibility: readonly string[] } | undefined;
  }[];
  impactSites: readonly {
    breakingChangeId: string;
    file: string;
    line: number;
    matchedSymbol: string;
    enclosingSymbol?: string | undefined;
    excerpt: string;
  }[];
  gaps: readonly { reason: string }[];
}

export interface ConvertOptions {
  /** Dependency-change identity is only a *prediction* on the end-to-end track; on known-bump it was supplied. */
  includeDependencyChanges: boolean;
  triageSkipped: readonly { dependency: string; reason: string }[];
  /**
   * Surfaces production recorded, in production's own vocabulary
   * (`api-surface`, `release-notes`, `localization`, `behavioural-diff`). The
   * artifact's `name` carries the dependency where the row is per-dependency,
   * so a monorepo row stays distinguishable.
   */
  checkedSurfaces: readonly { surface: string; dependency?: string; status: string }[];
  verificationOutcomes: readonly { kind: string; status: string }[];
  /** Per-breaking-change verdict, keyed by the production `BreakingChange.id`. */
  verdictByChangeId: ReadonlyMap<string, string>;
  /** The single case-level verdict, already reduced by production's own precedence. */
  verdict: string;
}

export function toDetectionArtifact(plan: PlanLike, options: ConvertOptions): DetectionArtifact {
  return {
    dependencyChanges: options.includeDependencyChanges
      ? plan.changes.map((change) => ({
          name: change.name,
          ecosystem: change.ecosystem,
          from: change.from,
          to: change.to,
          ...(change.workspace ? { workspace: change.workspace } : {}),
        }))
      : [],
    triageSkipped: options.triageSkipped.map((entry) => ({ ...entry })),

    // Every structured finding every evidence record carried, de-duplicated by
    // its own identity fields. `detail` is carried along for the report and
    // for a reviewer, and is never part of the comparison key — see
    // `eval/src/artifacts/identity.ts` for why prose cannot be a key.
    upstreamFindings: dedupe(
      plan.evidence.flatMap((record) =>
        (record.findings ?? []).map((finding) => ({
          dependency: dependencyOf(plan, finding.symbol),
          code: finding.code,
          symbol: finding.symbol,
          detail: finding.detail,
        })),
      ),
      (finding) => `${finding.dependency}|${finding.code}|${finding.symbol}`,
    ),

    checkedSurfaces: options.checkedSurfaces.map((surface) => ({
      name: surface.dependency ? `${surface.surface}:${surface.dependency}` : surface.surface,
      status: surface.status,
    })),

    // Every breaking change, each with its own taxonomy. No index-zero
    // assumption: a real historical major bump routinely carries several
    // independent breaks, and taking only the first would score a tool that
    // found three of them as though it had claimed one.
    breakingChanges: plan.breakingChanges.map((change) => {
      return {
        dependency: change.dependency,
        ...(change.workspace ? { workspace: change.workspace } : {}),
        kind: change.kind,
        symbols: [...change.symbols],
        replacementSymbols: [...(change.replacementSymbols ?? [])],
        summary: change.summary,
        citations: (change.citations ?? []).map((citation) => citation.id ?? citation.url ?? '').filter(Boolean),
        ...(change.taxonomy
          ? {
              taxonomy: {
                nature: change.taxonomy.nature,
                detectability: [...change.taxonomy.detectability],
                scope: change.taxonomy.scope,
                visibility: [...change.taxonomy.visibility],
              },
            }
          : {}),
        verdict: options.verdictByChangeId.get(change.id) ?? 'unchecked',
      };
    }),

    impactSites: plan.impactSites.map((site) => ({
      breakingChangeKind: kindOfSite(plan, site.breakingChangeId),
      file: site.file,
      line: site.line,
      matchedSymbol: site.matchedSymbol,
      ...(site.enclosingSymbol ? { enclosingSymbol: site.enclosingSymbol } : {}),
      excerpt: site.excerpt,
    })),

    gaps: plan.gaps.map((gap) => gap.reason),
    verificationOutcomes: options.verificationOutcomes.map((outcome) => ({ ...outcome })),
    verdict: options.verdict,
  };
}

/**
 * Which dependency an evidence finding belongs to.
 *
 * Evidence records do not carry the dependency on the finding itself, so this
 * attributes through the breaking changes that name the same symbol, and falls
 * back to the single dependency when the case only has one. It returns `''`
 * rather than guessing when neither resolves — an unattributed finding is
 * still a real fact and belongs in the artifact; silently assigning it to the
 * wrong package would corrupt a multi-dependency case's D1 score.
 */
function dependencyOf(plan: PlanLike, symbol: string): string {
  const owner = plan.breakingChanges.find((change) => change.symbols.includes(symbol));
  if (owner) return owner.dependency;
  const dependencies = new Set(plan.changes.map((change) => change.name));
  return dependencies.size === 1 ? [...dependencies][0]! : '';
}

function kindOfSite(plan: PlanLike, breakingChangeId: string): string {
  return plan.breakingChanges.find((change) => change.id === breakingChangeId)?.kind ?? 'unknown';
}

function dedupe<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}
