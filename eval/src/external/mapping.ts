import type { MappingStatus } from './record.ts';

/**
 * The layer that translates another benchmark's vocabulary into Drift's, and
 * refuses to when it cannot.
 *
 * Every external dataset has its own taxonomy, built for its own paper's
 * research questions, and none of them is Drift's. The failure mode is
 * seductive and quiet: a category that does not quite fit gets assigned to the
 * nearest Drift kind, the case becomes scoreable, the corpus coverage looks
 * better, and the resulting accuracy figure is partly a measurement of how
 * generously the mapping was written.
 *
 * So a mapping states its own confidence and only two of the four states are
 * ever scored:
 *
 *   `exact`       the two labels mean the same thing.
 *   `compatible`  different words, same observable change, and the difference
 *                 cannot flip a verdict.
 *   `ambiguous`   the external label spans several Drift kinds or vice versa.
 *                 A prediction cannot be adjudicated against it, so it is not.
 *   `unsupported` Drift has no representation of this at all.
 *
 * The last two stay in the report with their counts. "34 of 120 cases could
 * not be mapped" is a finding about Drift's taxonomy coverage, and hiding it
 * by mapping them anyway would convert an honest gap into a dishonest score.
 */

export interface LabelMapping {
  /** The external dataset's label, verbatim. */
  external: string;
  /** The Drift `BreakingChangeKind` it corresponds to, or `null` when none does. */
  drift: string | null;
  status: MappingStatus;
  /** Why. Required for everything but `exact`, and read straight into the report. */
  note: string;
}

export class MappingTable {
  private readonly byExternal: Map<string, LabelMapping>;
  readonly datasetId: string;

  constructor(datasetId: string, mappings: readonly LabelMapping[]) {
    this.datasetId = datasetId;
    this.byExternal = new Map(mappings.map((mapping) => [normalize(mapping.external), mapping]));
  }

  /**
   * The mapping for a label, or an explicit `unsupported` for one the table
   * has never heard of.
   *
   * Deliberately not `undefined`. An unknown label is a real state — the
   * dataset used a category this table does not describe — and returning
   * nothing invites a caller to skip the case silently instead of counting it
   * as unmapped.
   */
  lookup(label: string): LabelMapping {
    return (
      this.byExternal.get(normalize(label)) ?? {
        external: label,
        drift: null,
        status: 'unsupported',
        note: `No mapping is declared for "${label}" in the ${this.datasetId} table, so it is counted as unmapped rather than guessed at.`,
      }
    );
  }

  /** Whether a mapping may be scored. Only `exact` and `compatible` may. */
  static scorable(status: MappingStatus): boolean {
    return status === 'exact' || status === 'compatible';
  }

  get all(): LabelMapping[] {
    return [...this.byExternal.values()];
  }

  /** Coverage, for the report: how much of the corpus this table can actually adjudicate. */
  coverage(labels: readonly string[]): Record<MappingStatus, number> {
    const counts: Record<MappingStatus, number> = { exact: 0, compatible: 0, ambiguous: 0, unsupported: 0 };
    for (const label of labels) counts[this.lookup(label).status] += 1;
    return counts;
  }
}

function normalize(label: string): string {
  return label.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Kong's RQ2 categories → Drift's `BreakingChangeKind`.
 *
 * This table started out generous and the data made it strict. That process is
 * worth recording, because the strict version is the honest one and it costs
 * most of the corpus.
 *
 * Kong annotates with a refactoring vocabulary describing what happened to a
 * *declaration inside the library*: `rename method`, `remove field`,
 * `move class`, `change_signature`, `change_behavior`. Drift's kinds describe
 * what a *consumer* now has to do at the package boundary. The first draft of
 * this table treated those as the same axis with different words and mapped the
 * remove/rename/move families across as `compatible`, on the reasoning that
 * JavaScript has no distinct method/field/class at an export boundary.
 *
 * Running it showed that reasoning to be wrong, in a way that matters. Three
 * examples from the corpus, all of them cases the generous mapping scored as
 * Drift errors:
 *
 *   `remove class`  — "Removes `ViewLoader`, use `XHRImpl` instead."
 *   `remove field`  — "`service.clusterName` has been replaced with `.cluster`."
 *   `remove method` — "`DifferFactory.create` no longer takes ChangeDetectionRef
 *                      as a first argument."
 *
 * The first two are removals in Kong's vocabulary and renames in Drift's, and
 * Drift's reading is the more useful one for a consumer: a symbol withdrawn
 * with a named successor is a migration, not a deletion. The third is labelled
 * a method removal and is a parameter removal — a signature change by any
 * reading. Scoring those as Drift getting the category wrong would be scoring
 * the difference between two vocabularies and calling it tool accuracy.
 *
 * So the remove, rename and move families are `ambiguous`. Kong does not record
 * whether a removal states a successor, and that single fact is what decides
 * between `removed-export` and `renamed-export`, so the comparison cannot be
 * adjudicated from what the dataset stores. That leaves `change_signature` as
 * the one category with a defensible one-to-one reading, and it costs this
 * corpus roughly nine tenths of its category-scoring power. The alternative was
 * a larger denominator and a number that partly measured this file.
 *
 * Detection — "did Drift read *a* breaking change out of this prose?" — is
 * unaffected and is scored on every record, because every record in RQ2 is a
 * known breaking change whatever its category.
 */
const AMBIGUOUS_DECLARATION_NOTE =
  'Kong annotates what happened to a declaration inside the library; Drift names what a consumer must do at the package boundary. The corpus contains removals that state a successor ("Removes ViewLoader, use XHRImpl instead"), which is a rename to a consumer, and Kong does not record whether a removal has one — so the comparison cannot be adjudicated from what the dataset stores.';

export const KONG_CATEGORY_MAPPING = new MappingTable('kong', [
  {
    external: 'change_signature',
    drift: 'signature-change',
    status: 'exact',
    note: '',
  },
  {
    external: 'change_behavior',
    drift: null,
    status: 'ambiguous',
    note: "Kong's largest category covers every change where the surface is unchanged and the semantics moved. It spans Drift's behaviour-change, default-change, type-change and config-change, so a prediction cannot be adjudicated against it without deciding which one Kong meant.",
  },
  ...[
    'remove method', 'remove field', 'remove class', 'remove module', 'remove constant',
    'remove interface', 'remove type', 'remove',
    'rename method', 'rename field', 'rename class', 'rename interface', 'rename module',
    'rename constant', 'rename package', 'rename',
    'move method', 'move class', 'move module', 'move field', 'move',
  ].map((external): LabelMapping => ({ external, drift: null, status: 'ambiguous', note: AMBIGUOUS_DECLARATION_NOTE })),
  {
    external: 'inline',
    drift: null,
    status: 'unsupported',
    note: 'Inlining a function into its caller is an internal refactor. Whether it breaks a consumer depends on whether the inlined symbol was exported, which Kong does not record, and Drift has no kind that means "was inlined".',
  },
]);
