import type { BreakingChangeKind } from '../types.js';

/**
 * What kind of break is this?
 *
 * `BreakingChangeKind` answers "what should the fix do" — it drives remediation
 * text and commit grouping, and it stays exactly as it was. This module answers
 * four different questions that were previously collapsed into that one field,
 * or not asked at all:
 *
 *   nature        — what sort of contract broke
 *   detectability — what would have to run to notice
 *   scope         — how much surface it covers
 *   visibility    — how the consumer reaches it
 *
 * The distinction that motivates the whole thing is `detectability`. A removed
 * export and a changed default are both "breaking", but one stops the build and
 * the other ships to production and misbehaves quietly. Reporting them at the
 * same severity, as a single `kind` field forces you to, is how a tool teaches
 * people that its warnings are interchangeable noise.
 */

/** The sort of contract that broke. */
export type ChangeNature =
  | 'api-shape'
  | 'type-contract'
  | 'behaviour'
  | 'data-schema'
  | 'configuration'
  | 'runtime-environment'
  | 'protocol'
  | 'packaging';

/**
 * What would have to happen to notice.
 *
 * Ordered loosely from cheapest to most expensive. A change may be detectable
 * several ways, so this is a list — and a change detectable only at
 * `runtime-only` or `external-observation` is one Drift cannot prove locally,
 * which is a fact the report must carry rather than round off.
 */
export type ChangeDetectability =
  | 'manifest'
  | 'link-or-import'
  | 'compile-time'
  | 'static-semantic'
  | 'test-time'
  | 'runtime-only'
  | 'external-observation';

/** How much surface the change covers. */
export type ChangeScope =
  | 'symbol'
  | 'type'
  | 'module'
  | 'package'
  | 'dependency-cohort'
  | 'runtime'
  | 'ecosystem';

/**
 * How a consumer reaches the changed thing.
 *
 * `unknown` is a real answer and is used freely. Localization can establish a
 * direct import edge; it cannot generally prove the absence of reflection, so
 * claiming `direct` when the evidence only rules out the others would be an
 * over-claim.
 */
export type ChangeVisibility =
  | 'direct'
  | 'transitive'
  | 'wrapper-mediated'
  | 're-exported'
  | 'reflection-or-dynamic'
  | 'generated'
  | 'unknown';

export interface ChangeTaxonomy {
  nature: ChangeNature;
  detectability: ChangeDetectability[];
  scope: ChangeScope;
  visibility: ChangeVisibility[];
  /**
   * How this classification was reached.
   *
   * `computed` and `rule` are deterministic. `llm-normalized` means a model
   * proposed it and it survived schema validation and normalization — recorded
   * because a reader weighing a finding deserves to know which it was.
   */
  origin: 'computed' | 'rule' | 'llm-normalized' | 'default';
}

const NATURES: readonly ChangeNature[] = [
  'api-shape',
  'type-contract',
  'behaviour',
  'data-schema',
  'configuration',
  'runtime-environment',
  'protocol',
  'packaging',
];

const DETECTABILITIES: readonly ChangeDetectability[] = [
  'manifest',
  'link-or-import',
  'compile-time',
  'static-semantic',
  'test-time',
  'runtime-only',
  'external-observation',
];

const SCOPES: readonly ChangeScope[] = [
  'symbol',
  'type',
  'module',
  'package',
  'dependency-cohort',
  'runtime',
  'ecosystem',
];

const VISIBILITIES: readonly ChangeVisibility[] = [
  'direct',
  'transitive',
  'wrapper-mediated',
  're-exported',
  'reflection-or-dynamic',
  'generated',
  'unknown',
];

export const TAXONOMY_VALUES = {
  nature: NATURES,
  detectability: DETECTABILITIES,
  scope: SCOPES,
  visibility: VISIBILITIES,
} as const;

/**
 * Classification for a computed finding code.
 *
 * Computed findings are the precise case: the code already says exactly what
 * the differ observed, so the mapping is a lookup rather than an inference.
 * Anything absent here falls through to the `kind`-based mapping below and is
 * marked `default`, which keeps "we did not really classify this" visible
 * instead of dressing it up as `api-shape`.
 */
const BY_FINDING_CODE: Record<string, Omit<ChangeTaxonomy, 'origin'>> = {
  /* --- npm/TypeScript declaration surface ------------------------------- */
  'export-removed': {
    nature: 'api-shape',
    detectability: ['link-or-import', 'compile-time'],
    scope: 'symbol',
    visibility: ['direct'],
  },
  'member-removed': {
    nature: 'api-shape',
    detectability: ['compile-time'],
    scope: 'symbol',
    visibility: ['direct'],
  },
  'signature-changed': {
    nature: 'type-contract',
    detectability: ['compile-time', 'static-semantic'],
    scope: 'symbol',
    visibility: ['direct'],
  },
  'kind-changed': {
    nature: 'type-contract',
    detectability: ['compile-time'],
    scope: 'type',
    visibility: ['direct'],
  },
  'member-now-required': {
    nature: 'type-contract',
    detectability: ['compile-time'],
    scope: 'type',
    visibility: ['direct'],
  },
  'entry-point-moved': {
    nature: 'packaging',
    detectability: ['manifest', 'link-or-import'],
    scope: 'package',
    visibility: ['direct'],
  },
  'package-removed': {
    nature: 'packaging',
    detectability: ['manifest', 'link-or-import'],
    scope: 'package',
    visibility: ['direct'],
  },
  // Compiles either way — the name and type are untouched, only the value
  // underneath moved — so it belongs with the other behaviour-only class
  // rather than with the compile-time type-contract findings above.
  'constant-value-changed': {
    nature: 'behaviour',
    detectability: ['static-semantic', 'runtime-only'],
    scope: 'symbol',
    visibility: ['direct'],
  },

  /* --- OpenAPI ----------------------------------------------------------- */
  // Endpoints have no import edge and no compile step, so nothing local proves
  // a consumer is affected. `external-observation` is the honest floor.
  'path-removed': {
    nature: 'protocol',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'module',
    visibility: ['unknown'],
  },
  'operation-removed': {
    nature: 'protocol',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'response-status-removed': {
    nature: 'protocol',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'parameter-removed': {
    nature: 'protocol',
    detectability: ['runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'parameter-type-changed': {
    nature: 'data-schema',
    detectability: ['runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'parameter-now-required': {
    nature: 'protocol',
    detectability: ['runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'response-field-removed': {
    nature: 'data-schema',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'response-field-type-changed': {
    nature: 'data-schema',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'request-field-type-changed': {
    nature: 'data-schema',
    detectability: ['runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'request-field-now-required': {
    nature: 'data-schema',
    detectability: ['runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'request-enum-narrowed': {
    nature: 'data-schema',
    detectability: ['runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'response-enum-widened': {
    nature: 'data-schema',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'security-added': {
    nature: 'configuration',
    detectability: ['runtime-only'],
    scope: 'module',
    visibility: ['unknown'],
  },
};

/**
 * Fallback classification from the remediation kind.
 *
 * Coarser than the finding-code table by construction — `kind` was never meant
 * to answer these questions — but deterministic, which is the requirement.
 */
const BY_KIND: Record<BreakingChangeKind, Omit<ChangeTaxonomy, 'origin'>> = {
  'removed-export': {
    nature: 'api-shape',
    detectability: ['link-or-import', 'compile-time'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'renamed-export': {
    nature: 'api-shape',
    detectability: ['link-or-import', 'compile-time'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'moved-export': {
    nature: 'packaging',
    detectability: ['link-or-import', 'compile-time'],
    scope: 'module',
    visibility: ['unknown'],
  },
  'signature-change': {
    nature: 'type-contract',
    detectability: ['compile-time', 'static-semantic'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'type-change': {
    nature: 'type-contract',
    detectability: ['compile-time'],
    scope: 'type',
    visibility: ['unknown'],
  },
  // The dangerous class: compiles either way, so nothing short of running the
  // code tells you the fix was wrong.
  'behaviour-change': {
    nature: 'behaviour',
    detectability: ['test-time', 'runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'default-change': {
    nature: 'behaviour',
    detectability: ['test-time', 'runtime-only'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'removed-endpoint': {
    nature: 'protocol',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'module',
    visibility: ['unknown'],
  },
  'changed-endpoint': {
    nature: 'protocol',
    detectability: ['runtime-only', 'external-observation'],
    scope: 'symbol',
    visibility: ['unknown'],
  },
  'required-field-added': {
    nature: 'data-schema',
    detectability: ['compile-time', 'runtime-only'],
    scope: 'type',
    visibility: ['unknown'],
  },
  'config-change': {
    nature: 'configuration',
    detectability: ['static-semantic', 'runtime-only'],
    scope: 'module',
    visibility: ['unknown'],
  },
  'runtime-requirement': {
    nature: 'runtime-environment',
    detectability: ['manifest', 'runtime-only'],
    scope: 'runtime',
    visibility: ['direct'],
  },
  // Genuinely unclassified. Everything about this entry is deliberately the
  // most pessimistic option available, because "we could not tell" must not
  // read as "nothing to worry about".
  unknown: {
    nature: 'behaviour',
    detectability: ['runtime-only'],
    scope: 'module',
    visibility: ['unknown'],
  },
};

/**
 * Classify a breaking change.
 *
 * `findingCode` is passed when the change came from a computed differ, which is
 * the only case where a precise classification is available for free.
 */
export function classify(kind: BreakingChangeKind, findingCode?: string): ChangeTaxonomy {
  const computed = findingCode ? BY_FINDING_CODE[findingCode] : undefined;
  if (computed) return { ...cloneTaxonomy(computed), origin: 'computed' };

  const byKind = BY_KIND[kind];
  return {
    ...cloneTaxonomy(byKind),
    origin: kind === 'unknown' ? 'default' : 'rule',
  };
}

function cloneTaxonomy(value: Omit<ChangeTaxonomy, 'origin'>): Omit<ChangeTaxonomy, 'origin'> {
  return {
    nature: value.nature,
    detectability: [...value.detectability],
    scope: value.scope,
    visibility: [...value.visibility],
  };
}

/**
 * The taxonomy of a finding, deriving one if it has none.
 *
 * The single read path, so a hand-constructed finding degrades to the
 * deterministic `kind` mapping rather than crashing a caller that reasonably
 * assumed the field was there.
 */
export function taxonomyOf(change: {
  kind: BreakingChangeKind;
  taxonomy?: ChangeTaxonomy;
}): ChangeTaxonomy {
  return change.taxonomy ?? classify(change.kind);
}

/**
 * Validate and normalize a taxonomy an LLM proposed.
 *
 * A model may suggest a classification, but it may never define one. Anything
 * outside the closed vocabulary is dropped rather than coerced to the nearest
 * neighbour — a plausible-looking wrong label is worse here than an absent one,
 * because the whole value of the field is that it can be trusted at a glance.
 *
 * Returns `null` when nothing usable survives, and the caller falls back to the
 * deterministic mapping.
 */
export function normalizeProposedTaxonomy(
  proposed: unknown,
  fallback: ChangeTaxonomy,
): ChangeTaxonomy {
  if (!proposed || typeof proposed !== 'object') return fallback;

  const raw = proposed as Record<string, unknown>;

  const nature = pickOne(raw.nature, NATURES);
  const scope = pickOne(raw.scope, SCOPES);
  const detectability = pickMany(raw.detectability, DETECTABILITIES);
  const visibility = pickMany(raw.visibility, VISIBILITIES);

  // A proposal missing either required singular field is not a classification,
  // so the deterministic one stands rather than being half-overwritten.
  if (!nature || !scope) return fallback;

  return {
    nature,
    scope,
    detectability: detectability.length > 0 ? detectability : [...fallback.detectability],
    visibility: visibility.length > 0 ? visibility : ['unknown'],
    origin: 'llm-normalized',
  };
}

function pickOne<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function pickMany<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<T>();
  for (const item of value) {
    if (typeof item === 'string' && (allowed as readonly string[]).includes(item)) {
      seen.add(item as T);
    }
  }
  // Sorted against the declared order so the same set always serializes
  // identically — plans are digested, and a set that reordered between runs
  // would invalidate approvals for no reason.
  return allowed.filter((candidate) => seen.has(candidate));
}

/**
 * True when nothing local could prove this change bites.
 *
 * Used by reporting to pick honest wording: a change only observable at runtime
 * with no import edge to follow has not been "checked and found clean", it has
 * not been checked.
 */
export function isLocallyUnprovable(taxonomy: ChangeTaxonomy): boolean {
  const provable: ChangeDetectability[] = [
    'manifest',
    'link-or-import',
    'compile-time',
    'static-semantic',
  ];
  return !taxonomy.detectability.some((d) => provable.includes(d));
}
