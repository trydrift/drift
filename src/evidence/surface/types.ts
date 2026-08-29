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
  /**
   * The published artifact itself could not be retrieved, so nothing about
   * its contents was inspected. Never the same fact as "publishes nothing".
   */
  | 'artifact-unavailable'
  /** The artifact was retrieved but could not be read as an archive. */
  | 'artifact-corrupt'
  /**
   * The package's role is known and is not one Drift compares — a build-tool
   * package, an analyzer, an asset bundle, an unsupported Maven packaging.
   * Distinct from the library artifact unexpectedly going missing.
   */
  | 'artifact-role-unsupported'
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
  /**
   * A Drift-owned helper that can be installed after explicit approval.
   *
   * Runtime toolchains such as Go, Cargo, Python, or Java are facts about the
   * project and stay as prose remedies. Helper analyzers are different: Drift
   * knows the exact command and can ask to run it instead of sending the user
   * off to copy/paste setup instructions.
   */
  install?: ToolInstallRequest;
  /** The tool that was tried, or would have been. */
  tool: string;
}

export interface ToolInstallRequest {
  /** Stable id understood by the extension host. */
  id: 'cargo-public-api' | 'japicmp' | 'rustup-nightly';
  /** Short button label. */
  label: string;
  /** Command line to run after approval. Always argv, never shell text. */
  command: string;
  args: readonly string[];
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

/**
 * Below this, a surface diff is too approximate to count as the strong
 * "a computed API diff actually ran" signal `judgeConfidence` otherwise gives
 * automatic `high` confidence to. Every provider's ordinary weight (0.8 and
 * above — reconstructed-from-source providers like Python, Dart and Hex sit
 * at 0.8–0.9; a true compiler-verified diff is 1.0) clears this, so nothing
 * about their existing behavior changes. It exists for a diff that is
 * approximate *and* was computed from a source the provider cannot vouch for
 * — currently only Python's GitHub-tag fallback (see `python.ts`), which
 * layers an unverified, possibly mismatched archive on top of an already
 * approximate static reconstruction.
 */
export const CONFIDENT_SURFACE_WEIGHT = 0.8;

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
  /**
   * Install a missing helper inline instead of reporting the gap.
   *
   * Sourced from `config.tools.autoInstall`, off by default. When a provider
   * finds its helper missing and this is set, it installs the helper itself
   * (via {@link tryAutoInstall}) and continues the same computation — the
   * point being that the scan that discovered the gap is the one that closes
   * it, rather than requiring a second run after a manual install.
   */
  autoInstall?: boolean;
}

export interface SurfaceProvider {
  ecosystem: Ecosystem;
  /** The external tool this leans on, named in every message about it. */
  tool: string;
  weight: number;
  compute(request: SurfaceRequest): Promise<SurfaceOutcome>;
}

/**
 * One install per tool id, shared by every concurrent caller.
 *
 * A scan checks several dependencies in parallel (see `inParallel` in
 * `upgrade/scan.ts`), and two Rust crates in the same scan both find nightly
 * missing at the same moment. Without this, each would shell out to its own
 * `rustup toolchain install nightly`, and rustup's shared download cache
 * (`~/.rustup/downloads`) is not safe for concurrent invocations: one process
 * renames a partial download out from under another mid-write, which fails
 * with an ENOENT ("could not rename downloaded file... No such file or
 * directory") rather than a meaningful conflict error.
 */
const inFlightInstalls = new Map<string, Promise<boolean>>();

/**
 * Installs a Drift-owned helper inline, when the caller has opted in.
 *
 * Returns whether the install succeeded, so a provider can retry its own
 * `commandWorks`/`isAvailable` check and fall back to the ordinary
 * `unavailable(...)` gap on failure rather than surfacing an install error as
 * if it were the surface diff itself.
 */
export async function tryAutoInstall(
  request: SurfaceRequest,
  install: ToolInstallRequest,
): Promise<boolean> {
  if (!request.autoInstall) return false;

  const existing = inFlightInstalls.get(install.id);
  if (existing) return existing;

  const attempt = runInstall(request, install).finally(() => {
    inFlightInstalls.delete(install.id);
  });
  inFlightInstalls.set(install.id, attempt);
  return attempt;
}

async function runInstall(request: SurfaceRequest, install: ToolInstallRequest): Promise<boolean> {
  request.logger.info(`Installing ${install.label.replace(/^Install\s+/i, '')}...`);
  const result = await request.exec(install.command, install.args, {
    ...(request.env ? { env: request.env } : {}),
    timeoutMs: 10 * 60_000,
  });
  if (result.code !== 0) {
    request.logger.warn(
      `${install.label} failed: ${(result.stderr || result.stdout || 'no output').trim()}`,
    );
    return false;
  }
  request.logger.info(`${install.label.replace(/^Install\s+/i, '')} installed.`);
  return true;
}

export function unavailable(
  tool: string,
  reason: SurfaceUnavailableReason,
  detail: string,
  remedy?: string,
  install?: ToolInstallRequest,
): SurfaceUnavailable {
  return { available: false, reason, detail, ...(remedy ? { remedy } : {}), ...(install ? { install } : {}), tool };
}

/**
 * Wait for `promise`, but never past `budgetMs` of *this caller's own* time.
 *
 * Shared by every surface provider's per-version single-flight cache
 * (`evidence/surface/python.ts`, `evidence/surface/go.ts`): a caller that
 * joins a computation another caller already owns must never wait past its
 * own configured budget for it, and must never cancel or otherwise affect
 * the owner's work just because it stopped waiting — another caller with a
 * longer budget may still need it. Does not cancel `promise`.
 */
export function raceAgainstBudget<T>(
  promise: Promise<T>,
  budgetMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, budgetMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      // A single-flight computation here is designed to always resolve,
      // never reject — every failure path is a value (`{ ok: false, ... }`
      // or `{ failure: ... }`), not a thrown error. This is defensive
      // nonetheless: an unexpected rejection must not become an unhandled
      // rejection just because this particular caller gave up racing it
      // first, and this caller still has budget of its own, so it is free
      // to retry independently rather than propagate someone else's crash.
      () => {
        clearTimeout(timer);
        resolve({ timedOut: true });
      },
    );
  });
}

export type { SurfaceChange };
