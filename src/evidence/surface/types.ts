import type { Ecosystem } from '../../types.js';
import type { Logger } from '../../util/logger.js';
import type { Exec } from '../../util/exec.js';
import type { SurfaceChange } from '../type-surface.js';

/**
 * Computed API-surface diffing, per ecosystem.
 *
 * `.d.ts` diffing is the highest-weight evidence Drift produces, and for a long
 * time only npm had it. Every ecosystem here answers the same question the same
 * way — *what did the published public API stop offering?* — and hands back the
 * same `SurfaceChange[]`, so `analyze` never learns which ecosystem produced a
 * diff. That is the point: a guardrail that reasons about ecosystems is a
 * guardrail with six ways to be wrong.
 *
 * Every provider depends on a tool Drift does not ship. A missing toolchain is
 * an ordinary outcome, reported as a stated reason and degraded to prose
 * evidence, never as a silent zero.
 */

export type SurfaceUnavailableReason =
  /** The ecosystem's diffing tool is not installed. */
  | 'tool-missing'
  /** The tool ran and failed — a build error, a private crate, a bad network. */
  | 'toolchain-failed'
  /** The tool succeeded and there was nothing to read: no stubs, no rustdoc. */
  | 'no-public-surface'
  /** One of the two versions could not be fetched (yanked, deleted, private). */
  | 'version-unavailable'
  /** Output arrived in a shape this parser does not understand. */
  | 'parse-failed'
  /** No computed surface exists for this ecosystem at all. */
  | 'unsupported-ecosystem';

export interface SurfaceUnavailable {
  available: false;
  reason: SurfaceUnavailableReason;
  /** One sentence, shown to the developer verbatim. */
  detail: string;
  /** What the developer could install or do to get this evidence next time. */
  remedy?: string;
  /** The tool that was tried, or would have been. */
  tool: string;
}

/**
 * Something the target version gained.
 *
 * Never breaking, and never a reason to edit code — which is exactly why it is
 * kept apart from `changes` rather than mixed in. It exists so the upgrade
 * rationale can say what a developer *gets*, from the same computed source
 * that says what they risk.
 */
export interface SurfaceAddition {
  kind: 'package-added' | 'export-added';
  symbol: string;
}

export interface SurfaceDiff {
  available: true;
  changes: SurfaceChange[];
  /** Additive API, when the provider can distinguish it. Never breaking. */
  additions?: SurfaceAddition[];
  /** Named in the citation, because "computed" without saying by what is a claim. */
  tool: string;
  /**
   * How directly this speaks to breakage.
   *
   * A true computed diff of a published artefact is 1.0. Anything reconstructed
   * from source rather than from what was shipped sits below it.
   */
  weight: number;
  /** Human-readable citation of what was compared. */
  locator: string;
}

export type SurfaceOutcome = SurfaceDiff | SurfaceUnavailable;

export function isSurfaceDiff(outcome: SurfaceOutcome): outcome is SurfaceDiff {
  return outcome.available;
}

export interface SurfaceRequest {
  /** Package name as its registry knows it. */
  name: string;
  from: string;
  to: string;
  exec: Exec;
  /** A scratch directory the provider owns and may fill. */
  workdir: string;
  logger: Logger;
  /** Environment to use for local toolchain commands. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock budget for the whole computation. */
  timeoutMs: number;
  /**
   * Reads a file from the repository under analysis, by repo-relative path.
   *
   * Some toolchains are a fact about the *consumer*, not the dependency: which
   * Go version to advise installing is written in the repository's `go.mod`,
   * and a remedy that names it is an instruction rather than advice. Absent
   * when no checkout or provider is reachable, which every provider treats as
   * an ordinary case.
   */
  readRepoFile?: (path: string) => Promise<string | null>;
}

export interface SurfaceProvider {
  ecosystem: Ecosystem;
  /** The external tool this leans on, named in every message about it. */
  tool: string;
  weight: number;
  compute(request: SurfaceRequest): Promise<SurfaceOutcome>;
}

export function unavailable(
  tool: string,
  reason: SurfaceUnavailableReason,
  detail: string,
  remedy?: string,
): SurfaceUnavailable {
  return { available: false, reason, detail, remedy, tool };
}

export type { SurfaceChange };
