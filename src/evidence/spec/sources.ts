/**
 * The evidence sources contract-diff providers publish under.
 *
 * Deliberately import-free. `EvidenceSource` in `types.ts` is built from this
 * union, and `types.ts` is the module every other module depends on — deriving
 * the union from the provider registry instead would route the domain model
 * through zod-inferred config types and the GraphQL parser, which is a lot of
 * type machinery to hang off `Evidence.source`.
 *
 * So a new provider adds one line here and one line to `SPEC_PROVIDERS`. The
 * test suite asserts the two lists agree, so neither can rot: a source listed
 * here with no provider, or a provider whose source is not listed, fails.
 */

export const SPEC_EVIDENCE_SOURCES = ['openapi-diff', 'protobuf-diff', 'graphql-diff'] as const;

export type SpecEvidenceSource = (typeof SPEC_EVIDENCE_SOURCES)[number];

/** Whether an evidence record came from a diffed contract document. */
export function isSpecEvidenceSource(source: string): source is SpecEvidenceSource {
  return (SPEC_EVIDENCE_SOURCES as readonly string[]).includes(source);
}
