import type { BreakingChangeKind, StructuredFinding } from '../../types.js';
import type { ChangeTaxonomy } from '../../confidence/taxonomy.js';
import type { DriftConfig } from '../../config/schema.js';
import type { Logger } from '../../util/logger.js';
import type { Exec } from '../../util/exec.js';
import type { SpecEvidenceSource } from './sources.js';

/**
 * Contract-document diffing, per format.
 *
 * The sibling of `surface/types.ts`, for the other half of the same problem. A
 * `SurfaceProvider` answers *what did a published package stop offering?*; a
 * `SpecProvider` answers *what did a contract this repository consumes stop
 * promising?* — an OpenAPI document, a `.proto`, a GraphQL schema. Neither has
 * a version number to read: the document is committed in the repository, and
 * the two sides of the diff are two commits of the same path.
 *
 * OpenAPI was the first, and for a long time the only, so it was wired in by
 * hand: its evidence source, its weight, its origin class, its taxonomy and its
 * remediation text each lived in a different file from the differ itself.
 * Adding a second format meant editing five files that have nothing to do with
 * each other, and forgetting one of them fails silently — a finding with no
 * taxonomy entry is classified `default`, which reads as "we could not tell"
 * rather than as "nobody registered this code".
 *
 * A provider therefore owns everything true about its own format:
 *
 *   - which documents it recognises (`handles`)
 *   - how to diff two versions of one (`compute`)
 *   - what the evidence is called and how much it weighs (`source`, `weight`)
 *   - whether it corroborates other evidence (`originClass`)
 *   - what each finding code *means* (`codes` — kind, taxonomy, remediation)
 *
 * Everything downstream reads those declarations. Registration is one line in
 * `SPEC_PROVIDERS` and one in `SPEC_EVIDENCE_SOURCES`.
 */

export type SpecUnavailableReason =
  /** The format's diffing tool is not installed. */
  | 'tool-missing'
  /** The tool ran and failed — a bad import path, a broken document. */
  | 'toolchain-failed'
  /** One of the two documents could not be understood as this format. */
  | 'parse-failed'
  /** Output arrived in a shape this parser does not understand. */
  | 'unexpected-output';

export interface SpecUnavailable {
  available: false;
  reason: SpecUnavailableReason;
  /** One sentence, shown to the developer verbatim. */
  detail: string;
  /** What the developer could install or do to get this evidence next time. */
  remedy?: string;
  /** The tool that was tried, or would have been. */
  tool: string;
}

/**
 * One consumer-breaking difference between two versions of a document.
 *
 * Mirrors `SurfaceChange`: `code` is the machine vocabulary a taxonomy and a
 * remediation are looked up by, `detail` is the sentence a developer reads.
 */
export interface SpecChange {
  /** Finding code, registered in the provider's own `codes` table. */
  code: string;
  /** What changed, as a consumer names it: `GET /users/{id}`, `User.email`. */
  location: string;
  /** Precise citation within the document — a JSON pointer, a line, a path. */
  pointer: string;
  detail: string;
  before?: string;
  after?: string;
}

export interface SpecDiff {
  available: true;
  changes: SpecChange[];
  /** Named in the citation, because "computed" without saying by what is a claim. */
  tool: string;
  /** How directly this speaks to breakage. A computed document diff is 1.0. */
  weight: number;
  /** Human-readable citation of what was compared. */
  locator: string;
}

export type SpecOutcome = SpecDiff | SpecUnavailable;

export function isSpecDiff(outcome: SpecOutcome): outcome is SpecDiff {
  return outcome.available;
}

export interface SpecRequest {
  /** Repo-relative path of the document, as configured. */
  path: string;
  /** The document as it was before the analysed change. */
  before: string;
  /** The document as it is after it. */
  after: string;
  /** A scratch directory the provider owns and may fill. */
  workdir: string;
  exec: Exec;
  logger: Logger;
  /** Environment to use for local toolchain commands. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock budget for the whole computation. */
  timeoutMs: number;
}

/**
 * What one finding code means, everywhere it is read.
 *
 * The three questions the rest of the pipeline asks about a computed finding —
 * what should the fix do, how should this be classified, what do we tell the
 * agent — answered next to the differ that emits the code rather than in three
 * unrelated switch statements.
 */
export interface SpecFindingCode {
  /** Drift's fix-strategy taxonomy. Drives remediation grouping. */
  kind: BreakingChangeKind;
  /** Nature, detectability, scope, visibility. Origin is always `computed`. */
  taxonomy: Omit<ChangeTaxonomy, 'origin'>;
  /** Imperative remediation text, fed to the agent verbatim. */
  remediation: (finding: StructuredFinding) => string;
}

/** The `config.evidence` keys that switch a provider on and point it at files. */
export interface SpecConfigKeys {
  /** Boolean key, e.g. `openapi`. */
  enabled: keyof DriftConfig['evidence'];
  /** String-array key of repo-relative paths, e.g. `openapiSpecs`. */
  paths: keyof DriftConfig['evidence'];
}

export interface SpecProvider {
  /** Stable short id, used in evidence ids and messages. */
  id: string;
  /** The evidence source this publishes under. */
  source: SpecEvidenceSource;
  /** The tool this leans on, named in every message about it. */
  tool: string;
  weight: number;
  /**
   * Which independent class of observation this belongs to, for corroboration.
   *
   * A diff of the document itself is a `computed-artifact`, exactly like an API
   * surface diff — derived from the shipped contract rather than from what
   * somebody wrote about it.
   */
  originClass: string;
  config: SpecConfigKeys;
  /** Every finding code this provider can emit, and what it means. */
  codes: Record<string, SpecFindingCode>;
  /**
   * Whether this provider recognises the document.
   *
   * Checked before diffing so a path configured for one format is not diffed
   * by another — and so a file that is not a contract document at all yields
   * nothing rather than a confident diff of arbitrary YAML.
   */
  handles(path: string, content: string): boolean;
  compute(request: SpecRequest): Promise<SpecOutcome>;
}

export function unavailableSpec(
  tool: string,
  reason: SpecUnavailableReason,
  detail: string,
  remedy?: string,
): SpecUnavailable {
  return { available: false, reason, detail, ...(remedy ? { remedy } : {}), tool };
}
