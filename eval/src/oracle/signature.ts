/**
 * Failure signatures: *which* checks failed, not merely whether something did.
 *
 * Every prior benchmark in this space that we reviewed decides repair success
 * by comparing a count. `swe-bump-bench` credits a patch when
 * `errsAfter.length <= errsBefore.length`; `bumpgen` stops when the build is
 * green. Both are gameable in the same way and for the same reason: deleting
 * the code that calls the changed API removes the diagnostic without fixing
 * anything, and a count cannot tell that apart from a migration.
 *
 * Defects4J solved the equivalent problem in fault localization with *trigger
 * tests*: a bug is only a bug if a specific, named test fails before the fix
 * and passes after it, and the rest of the suite must keep passing. This
 * module is that idea applied to dependency upgrades. A stage's result is a
 * set of stable diagnostic *identities*, and repair is judged on set algebra
 * over three stages:
 *
 *   trigger set   = broken \ baseline   — what the upgrade actually broke
 *   resolved      = trigger \ repaired  — what the repair actually fixed
 *   new failures  = repaired \ (baseline ∪ broken)  — what the repair broke
 *
 * An identity deliberately excludes line and column numbers, absolute paths,
 * and temp-directory prefixes, because none of those are facts about the
 * breakage — they change when an unrelated import is added above, or when the
 * same fixture is materialized into a different `mkdtemp` directory. It
 * deliberately *includes* the diagnostic code, the repo-relative file, and the
 * normalized message text, because those are what make two failures the same
 * failure.
 */

/** Which check produced a diagnostic. Kept distinct because their normalizations differ, not for reporting cosmetics. */
export type DiagnosticKind = 'tsc' | 'test' | 'runtime' | 'process';

export interface Diagnostic {
  kind: DiagnosticKind;
  /** e.g. a TypeScript `TS2551`, a runtime `TypeError`, or `exit` for a bare non-zero exit. */
  code: string;
  /** Repo-relative where one could be recovered. Absent rather than guessed. */
  file?: string;
  /** Normalized human text, position-free. */
  message: string;
  /** The stable comparison key. Two diagnostics are the same failure iff these match. */
  identity: string;
}

/**
 * `tsc --noEmit` pretty=false form:
 *   `src/app.ts(12,5): error TS2551: Property 'a' does not exist on type 'B'.`
 * Also matches the `error TSxxxx:` form emitted without a file (config errors).
 */
const TSC_WITH_FILE = /^(?<file>[^(\s][^(]*)\((?<line>\d+),(?<col>\d+)\):\s+error\s+(?<code>TS\d+):\s+(?<message>.*)$/;
const TSC_WITHOUT_FILE = /^error\s+(?<code>TS\d+):\s+(?<message>.*)$/;

/** `node --test` TAP: `not ok 3 - resolves the renamed export`. Sub-tests are indented; both count. */
const TAP_FAILURE = /^\s*not ok\s+\d+\s+-\s+(?<name>.+?)\s*(?:#.*)?$/;

/**
 * An uncaught error line, with or without Node's `Uncaught ` / `[ERR_*]`
 * decoration. The class-name prefix is optional so a bare `Error: ...` — what
 * a hand-thrown `new Error()` in a consumer's own check produces, and one of
 * the most common real failure shapes — is captured rather than falling
 * through to the unreadable-failure path.
 */
const RUNTIME_ERROR = /(?<code>(?:[A-Z][A-Za-z]*)?(?:Error|Exception))(?:\s*\[[^\]]+\])?:\s+(?<message>.+)$/;

export interface ExtractOptions {
  /**
   * Absolute directory the command ran in. Paths under it are rewritten
   * relative; without it an absolute path is kept but temp-prefix-scrubbed,
   * which is strictly worse and so worth passing wherever it is known.
   */
  cwd?: string;
}

/**
 * Parses one command's combined output into diagnostics.
 *
 * Order of the returned array is the order encountered; callers that compare
 * should go through `signatureOf`, which sorts and de-duplicates. Unparseable
 * output is not invented into a diagnostic — a command that failed with
 * nothing recognizable yields the single `process:exit` diagnostic the caller
 * adds via `processExitDiagnostic`, so "failed for an unreadable reason" stays
 * visibly distinct from "failed with these named errors".
 */
export function extractDiagnostics(output: string, options: ExtractOptions = {}): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    const tscFile = TSC_WITH_FILE.exec(line);
    if (tscFile?.groups) {
      const file = normalizePath(tscFile.groups['file']!, options.cwd);
      const message = normalizeMessage(tscFile.groups['message']!, options.cwd);
      const code = tscFile.groups['code']!;
      found.push({ kind: 'tsc', code, file, message, identity: `tsc:${code}:${file}:${message}` });
      continue;
    }

    const tscBare = TSC_WITHOUT_FILE.exec(line);
    if (tscBare?.groups) {
      const message = normalizeMessage(tscBare.groups['message']!, options.cwd);
      const code = tscBare.groups['code']!;
      found.push({ kind: 'tsc', code, message, identity: `tsc:${code}::${message}` });
      continue;
    }

    const tap = TAP_FAILURE.exec(line);
    if (tap?.groups) {
      const message = normalizeMessage(tap.groups['name']!, options.cwd);
      found.push({ kind: 'test', code: 'assertion', message, identity: `test:${message}` });
      continue;
    }

    // Only lines that are *not* stack frames: a frame mentioning `Error` is
    // context for the throw above it, not a second failure.
    if (/^\s*at\s/.test(line)) continue;
    const runtime = RUNTIME_ERROR.exec(line);
    if (runtime?.groups) {
      const code = runtime.groups['code']!;
      const message = normalizeMessage(runtime.groups['message']!, options.cwd);
      found.push({ kind: 'runtime', code, message, identity: `runtime:${code}:${message}` });
    }
  }

  return found;
}

/** The diagnostic for "the command failed and said nothing this module could read". */
export function processExitDiagnostic(exitCode: number): Diagnostic {
  return {
    kind: 'process',
    code: 'exit',
    message: `non-zero exit ${exitCode}`,
    identity: `process:exit:${exitCode}`,
  };
}

/** Sorted, de-duplicated identities — the comparable form of a stage's result. */
export function signatureOf(diagnostics: readonly Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.identity))].sort();
}

export type FailToPassVerdict =
  | 'resolved'
  | 'partially-resolved'
  | 'unresolved'
  | 'regressed'
  | 'no-trigger'
  | 'not-attempted';

export interface FailToPassAnalysis {
  /**
   * Defects4J's trigger tests, generalized: failures the upgrade itself
   * introduced. A failure present in *baseline* is pre-existing breakage in
   * the consumer and is never the upgrade's fault, so it can never be
   * something the repair is credited for fixing.
   */
  triggerFailures: string[];
  resolvedTriggers: string[];
  unresolvedTriggers: string[];
  /** Failures the repair introduced that neither earlier stage had. */
  newFailures: string[];
  /**
   * Baseline-clean checks that the repaired state fails. Distinct from
   * `newFailures` only in emphasis: this is the pass-to-pass violation set,
   * the reason a benchmark cannot score on the trigger set alone.
   */
  regressedChecks: string[];
  verdict: FailToPassVerdict;
}

export interface StageSignatures {
  baseline: readonly string[];
  broken: readonly string[];
  /** Absent when no repair was attempted — scored as `not-attempted`, never as a failure to fix. */
  repaired?: readonly string[];
}

/**
 * The whole judgement, as set algebra. Deliberately total and pure: every
 * input is three string sets, so this is exhaustively testable and cannot
 * silently depend on how a command happened to be spawned.
 *
 * `no-trigger` is its own verdict rather than folded into failure, because a
 * fixture whose broken stage produces no *new* failure has not demonstrated a
 * breakage at all — crediting a repair there would be crediting a fix for
 * nothing, which is precisely the empty-set trap the detection scoring already
 * guards against elsewhere in this harness.
 */
export function analyzeFailToPass(stages: StageSignatures): FailToPassAnalysis {
  const baseline = new Set(stages.baseline);
  const broken = new Set(stages.broken);
  const triggerFailures = [...broken].filter((id) => !baseline.has(id)).sort();

  if (stages.repaired === undefined) {
    return {
      triggerFailures,
      resolvedTriggers: [],
      unresolvedTriggers: [],
      newFailures: [],
      regressedChecks: [],
      verdict: 'not-attempted',
    };
  }

  const repaired = new Set(stages.repaired);
  const resolvedTriggers = triggerFailures.filter((id) => !repaired.has(id));
  const unresolvedTriggers = triggerFailures.filter((id) => repaired.has(id));
  const newFailures = [...repaired].filter((id) => !broken.has(id) && !baseline.has(id)).sort();
  const regressedChecks = [...repaired].filter((id) => !baseline.has(id) && !triggerFailures.includes(id)).sort();

  let verdict: FailToPassVerdict;
  if (triggerFailures.length === 0) verdict = 'no-trigger';
  else if (newFailures.length > 0) verdict = 'regressed';
  else if (unresolvedTriggers.length === 0) verdict = 'resolved';
  else if (resolvedTriggers.length > 0) verdict = 'partially-resolved';
  else verdict = 'unresolved';

  return { triggerFailures, resolvedTriggers, unresolvedTriggers, newFailures, regressedChecks, verdict };
}

/**
 * Rewrites an absolute path under `cwd` to a repo-relative one and strips the
 * platform temp prefix from anything else. A fixture is materialized into a
 * fresh `mkdtemp` directory on every run; without this, no two runs of the
 * same fixture would ever produce equal identities.
 */
function normalizePath(path: string, cwd?: string): string {
  let out = path.trim().replace(/\\/g, '/');
  if (cwd) {
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (out.startsWith(`${root}/`)) out = out.slice(root.length + 1);
  }
  // Any remaining temp path: keep the tail after the last recognizable
  // per-run directory segment rather than the whole machine-specific prefix.
  out = out.replace(/^.*?\/(?:drift-eval|drift-capsule)-[^/]*\//, '');
  return out;
}

/**
 * Message normalization, in the order that matters: paths first (so a path's
 * digits are not mistaken for a position), then positions, then whitespace.
 * Digits inside quoted identifiers survive — `useV2Client` is not noise.
 */
function normalizeMessage(message: string, cwd?: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?[\w./\\-]*\/[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json)/g, (m) => normalizePath(m, cwd))
    .replace(/\(\d+,\d+\)/g, '')
    .replace(/:\d+:\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
