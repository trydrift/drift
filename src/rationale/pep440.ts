/**
 * PEP 440 version specifier comparison, scoped to what `requires-python`
 * strings actually look like in practice.
 *
 * `requires-python` and repository-declared Python floors are overwhelmingly
 * simple interval constraints — `>=3.8`, `>=3.9,<4`, `~=3.10`, `3.8.*` — not
 * the full generality PEP 440 permits (epochs, pre/post/dev releases, local
 * version identifiers). This module represents a specifier set as the
 * half-open interval of releases it allows and answers set-membership
 * questions over that interval, the same shape `semver.subset` answers for
 * Node ranges in `runtime.ts`. A specifier this cannot represent as an
 * interval (a bare `!=` with no accompanying bound, for instance) is treated
 * as a bound it cannot confirm, and comparisons involving it come back
 * `partial` rather than a confident yes or no — never a wrong yes.
 */

export interface VersionInterval {
  /** Inclusive lower bound, or null for "no floor". */
  min: number[] | null;
  /** Exclusive upper bound, or null for "no ceiling". */
  maxExclusive: number[] | null;
  /** True when a specifier here could not be represented as a bound (e.g. a lone `!=`). */
  imprecise: boolean;
}

/** Parse a dotted release segment, ignoring any pre/post/dev/local suffix. */
function parseRelease(version: string): number[] {
  const release = /^\s*v?(\d+(?:\.\d+)*)/.exec(version)?.[1] ?? '0';
  return release.split('.').map((n) => Number.parseInt(n, 10));
}

function compareTuples(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The smallest release strictly greater than `version` at its own precision — used to turn `==3.8.*` into `[3.8, 3.9)`. */
function nextAtPrecision(version: readonly number[]): number[] {
  const bumped = [...version];
  bumped[bumped.length - 1] = (bumped[bumped.length - 1] ?? 0) + 1;
  return bumped;
}

function tighterMin(a: number[] | null, b: number[] | null): number[] | null {
  if (!a) return b;
  if (!b) return a;
  return compareTuples(a, b) >= 0 ? a : b;
}

function tighterMax(a: number[] | null, b: number[] | null): number[] | null {
  if (!a) return b;
  if (!b) return a;
  return compareTuples(a, b) <= 0 ? a : b;
}

/**
 * Parse a comma-separated PEP 440 specifier set (`>=3.9,!=3.9.7,<4`) into the
 * interval of releases it allows.
 *
 * A bare version with no operator (`"3.11"`, as `.python-version` files and
 * some CI `python-version:` fields write it) is treated as `==3.11`, pinning
 * an exact minor/micro line rather than a floor — the same convention
 * `runtime.ts` uses for a bare Node major.
 */
export function parseSpecifierSet(spec: string): VersionInterval {
  const clauses = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (clauses.length === 0) return { min: null, maxExclusive: null, imprecise: false };

  let min: number[] | null = null;
  let maxExclusive: number[] | null = null;
  let imprecise = false;

  for (const clause of clauses) {
    const match = /^(===|~=|==|!=|<=|>=|<|>)?\s*v?(\d[\w.*]*)$/.exec(clause);
    if (!match) {
      imprecise = true;
      continue;
    }
    const [, opRaw, versionRaw] = match;
    const op = opRaw ?? '==';
    const wildcard = versionRaw!.endsWith('.*');
    const version = parseRelease(versionRaw!.replace(/\.\*$/, ''));

    switch (op) {
      case '>=':
        min = tighterMin(min, version);
        break;
      case '>':
        min = tighterMin(min, nextAtPrecision([...version, 0]));
        break;
      case '<=':
        maxExclusive = tighterMax(maxExclusive, nextAtPrecision(version));
        break;
      case '<':
        maxExclusive = tighterMax(maxExclusive, version);
        break;
      case '==':
      case '===':
        if (wildcard) {
          min = tighterMin(min, version);
          maxExclusive = tighterMax(maxExclusive, nextAtPrecision(version));
        } else {
          min = tighterMin(min, version);
          maxExclusive = tighterMax(maxExclusive, nextAtPrecision(version));
        }
        break;
      case '~=':
        // ~=3.10 means >=3.10, ==3.* : compatible within the same release up
        // to (but not including) the next value at one precision coarser.
        min = tighterMin(min, version);
        maxExclusive = tighterMax(maxExclusive, nextAtPrecision(version.slice(0, -1)));
        break;
      case '!=':
        // A single excluded point does not change the interval this
        // representation can express — noted as imprecise rather than
        // silently ignored, so a caller can decline to say "compatible" when
        // the excluded version happened to matter.
        imprecise = true;
        break;
      default:
        imprecise = true;
    }
  }

  return { min, maxExclusive, imprecise };
}

/**
 * Does every release the repository's declared interval allows also satisfy
 * the dependency's newly raised interval?
 *
 * Mirrors `semver.subset`'s question, not `intersects`'s: a repository that
 * *could* run on an old interpreter must actually be bounded above that new
 * floor, not merely overlap with it.
 */
export function isSubsetInterval(declared: VersionInterval, required: VersionInterval): boolean {
  if (declared.imprecise || required.imprecise) return false;

  const minOk =
    required.min === null || (declared.min !== null && compareTuples(declared.min, required.min) >= 0);
  const maxOk =
    required.maxExclusive === null ||
    (declared.maxExclusive !== null && compareTuples(declared.maxExclusive, required.maxExclusive) <= 0);

  return minOk && maxOk;
}

/** Do the two intervals share any release at all? */
export function intersectsInterval(a: VersionInterval, b: VersionInterval): boolean {
  const lower = tighterMin(a.min, b.min);
  const upper = tighterMax(a.maxExclusive, b.maxExclusive);
  if (lower === null || upper === null) return true;
  return compareTuples(lower, upper) < 0;
}
