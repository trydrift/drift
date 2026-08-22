/**
 * PEP 440 version specifier comparison, scoped to what `requires-python`
 * strings actually look like in practice.
 *
 * `requires-python` and repository-declared Python floors are overwhelmingly
 * simple interval constraints — `>=3.8`, `>=3.9,<4`, `~=3.10`, `3.8.*` — not
 * the full generality PEP 440 permits (epochs, pre/post/dev releases, local
 * version identifiers). This module represents a specifier set as the
 * interval of releases it allows and answers set-membership questions over
 * that interval, the same shape `semver.subset` answers for Node ranges in
 * `runtime.ts`.
 *
 * Where this cannot be exact, it never guesses in the direction of a false
 * "compatible" verdict: an epoch, a pre/post/dev/local suffix, a bare `!=`,
 * an arbitrary-equality `===` clause, an invalid single-segment `~=X`, a
 * wildcard attached to an operator that does not support one, a
 * self-contradictory range that admits no release at all, or a clause this
 * cannot parse at all marks the whole specifier set `imprecise`, and
 * `isSubsetInterval` refuses to confirm a subset, and `intersectsInterval`
 * refuses to confirm the two do *not* overlap — never a silent maybe read as
 * a confident yes or no — against an imprecise interval on either side.
 */

export interface Bound {
  value: number[];
  inclusive: boolean;
}

export interface VersionInterval {
  min: Bound | null;
  max: Bound | null;
  imprecise: boolean;
}

/** Parse a dotted release segment into integers. */
function parseRelease(release: string): number[] {
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

/**
 * Split a version token into its release segment and everything else.
 *
 * Anything left over after an optional epoch (`1!`), the dotted release, and
 * an optional trailing `.*` wildcard is a pre/post/dev/local marker this
 * module does not model — `imprecise: true` says so, so a caller never
 * treats a version like `3.11.0rc1` as if the release number were the whole
 * story.
 */
function analyzeToken(token: string): { release: number[]; wildcard: boolean; imprecise: boolean } {
  const withoutEpoch = /^\d+!(.*)$/.exec(token);
  const hadEpoch = withoutEpoch !== null;
  const body = withoutEpoch ? withoutEpoch[1]! : token;

  const releaseMatch = /^(\d+(?:\.\d+)*)(.*)$/.exec(body);
  if (!releaseMatch) return { release: [0], wildcard: false, imprecise: true };

  const release = parseRelease(releaseMatch[1]!);
  let rest = releaseMatch[2]!;
  let wildcard = false;
  if (rest === '.*') {
    wildcard = true;
    rest = '';
  }

  return { release, wildcard, imprecise: hadEpoch || rest.length > 0 };
}

/** The more restrictive of two lower bounds (the higher floor), keeping either input as-is when the other is absent. */
function tighterMin(a: Bound | null, b: Bound | null): Bound | null {
  if (!a) return b;
  if (!b) return a;
  const cmp = compareTuples(a.value, b.value);
  if (cmp !== 0) return cmp > 0 ? a : b;
  return !a.inclusive || !b.inclusive ? { value: a.value, inclusive: false } : a;
}

/** The more restrictive of two upper bounds (the lower ceiling), keeping either input as-is when the other is absent. */
function tighterMax(a: Bound | null, b: Bound | null): Bound | null {
  if (!a) return b;
  if (!b) return a;
  const cmp = compareTuples(a.value, b.value);
  if (cmp !== 0) return cmp < 0 ? a : b;
  return !a.inclusive || !b.inclusive ? { value: a.value, inclusive: false } : a;
}

/** Combine an existing (possibly absent) bound with a newly parsed clause's bound — the clause's bound is never absent, so the result never is either. */
function narrowMin(existing: Bound | null, clause: Bound): Bound {
  return tighterMin(existing, clause)!;
}

/** See {@link narrowMin}. */
function narrowMax(existing: Bound | null, clause: Bound): Bound {
  return tighterMax(existing, clause)!;
}

/**
 * Parse a comma-separated PEP 440 specifier set (`>=3.9,!=3.9.7,<4`) into the
 * interval of releases it allows.
 *
 * A bare version with no operator (`"3.11"`, as `.python-version` files and
 * some CI `python-version:` fields write it) is read the way `runtime.ts`
 * already reads a bare Node major: as the whole release line it names
 * (`"3.11"` → `[3.11, 3.12)`), not as an exact pin — a repository declaring
 * `.python-version` = `3.11` is not asserting it never runs a patch release.
 * An *explicit* `==3.11` inside a real specifier set means exactly that
 * release, per PEP 440, and is kept exact.
 */
export function parseSpecifierSet(spec: string): VersionInterval {
  const clauses = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (clauses.length === 0) return { min: null, max: null, imprecise: false };

  let min: Bound | null = null;
  let max: Bound | null = null;
  let imprecise = false;

  for (const clause of clauses) {
    const match = /^(===|~=|==|!=|<=|>=|<|>)?\s*v?(\d[\w.*]*)$/.exec(clause);
    if (!match) {
      imprecise = true;
      continue;
    }
    const [, opRaw, versionRaw] = match;
    const bare = !opRaw;
    const op = opRaw ?? '==';
    const token = analyzeToken(versionRaw!);

    if (token.imprecise) {
      imprecise = true;
      continue;
    }
    const { release, wildcard } = token;

    // A trailing `.*` is only valid PEP 440 syntax alongside `==` or `!=`.
    // `>=3.11.*`, `<=3.11.*`, and `~=3.11.*` are not specifiers PEP 440
    // defines at all; silently dropping the wildcard and keeping the bound
    // would treat invalid input as if it had been written correctly.
    if (wildcard && op !== '==' && op !== '!=') {
      imprecise = true;
      continue;
    }

    // ~=X (a single release segment) is invalid: PEP 440 requires at least
    // two segments (major.minor) for the compatible-release operator, since
    // it needs a "last segment" to drop when computing the ceiling.
    if (op === '~=' && release.length < 2) {
      imprecise = true;
      continue;
    }

    // A bare declaration widens to the whole release line it names, the
    // same convention `findNodeDeclarations` uses for a bare Node major —
    // see the doc comment above. An explicit `==` only widens when the
    // caller actually wrote the `.*` wildcard.
    const widen = bare || wildcard;

    switch (op) {
      case '>=':
        min = narrowMin(min, { value: release, inclusive: true });
        break;
      case '>':
        min = narrowMin(min, { value: release, inclusive: false });
        break;
      case '<=':
        max = narrowMax(max, { value: release, inclusive: true });
        break;
      case '<':
        max = narrowMax(max, { value: release, inclusive: false });
        break;
      case '==':
        min = narrowMin(min, { value: release, inclusive: true });
        max = widen
          ? narrowMax(max, { value: nextAtPrecision(release), inclusive: false })
          : narrowMax(max, { value: release, inclusive: true });
        break;
      case '===':
        // PEP 440's arbitrary-equality clause is a literal string comparison
        // with no version semantics at all — it does not zero-pad, does not
        // support a wildcard, and `===3.11` is emphatically not the same
        // claim as `==3.11` (which does admit 3.11.0). There is no interval
        // this can be represented as without guessing at that string match.
        imprecise = true;
        break;
      case '~=':
        // ~=3.10 means >=3.10, ==3.* : compatible within the same release up
        // to (but not including) the next value at one precision coarser.
        min = narrowMin(min, { value: release, inclusive: true });
        max = narrowMax(max, { value: nextAtPrecision(release.slice(0, -1)), inclusive: false });
        break;
      case '!=':
        // A single excluded point does not change the interval this
        // representation can express — noted as imprecise rather than
        // silently ignored, so a caller can decline to say "compatible"
        // when the excluded version happened to matter.
        imprecise = true;
        break;
      default:
        imprecise = true;
    }
  }

  if (!imprecise && isEmptyInterval(min, max)) {
    // A self-contradictory constraint (`>=3.12,<3.11`) admits no release at
    // all. That is a malformed declaration, not a legitimate empty set to
    // reason about confidently in either direction — it must not be allowed
    // to manufacture a confident "compatible" (vacuously, nothing to violate)
    // or "incompatible" verdict downstream.
    return { min, max, imprecise: true };
  }

  return { min, max, imprecise };
}

/** Does this [min, max] admit no release at all? */
function isEmptyInterval(min: Bound | null, max: Bound | null): boolean {
  if (!min || !max) return false;
  const cmp = compareTuples(min.value, max.value);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  return !(min.inclusive && max.inclusive);
}

function minSatisfies(declared: Bound | null, required: Bound | null): boolean {
  if (!required) return true;
  if (!declared) return false;
  const cmp = compareTuples(declared.value, required.value);
  if (cmp !== 0) return cmp > 0;
  return !(declared.inclusive && !required.inclusive);
}

function maxSatisfies(declared: Bound | null, required: Bound | null): boolean {
  if (!required) return true;
  if (!declared) return false;
  const cmp = compareTuples(declared.value, required.value);
  if (cmp !== 0) return cmp < 0;
  return !(declared.inclusive && !required.inclusive);
}

/**
 * Does every release the repository's declared interval allows also satisfy
 * the dependency's newly raised interval?
 *
 * Mirrors `semver.subset`'s question, not `intersects`'s: a repository that
 * *could* run on an old interpreter must actually be bounded above that new
 * floor, not merely overlap with it. Never confirmed when either interval
 * is imprecise — a construct this module could not model safely must never
 * be the reason Drift calls an upgrade compatible.
 */
export function isSubsetInterval(declared: VersionInterval, required: VersionInterval): boolean {
  if (declared.imprecise || required.imprecise) return false;
  return minSatisfies(declared.min, required.min) && maxSatisfies(declared.max, required.max);
}

/**
 * Do the two intervals share any release at all?
 *
 * An imprecise interval — including one this module refused to build because
 * it was self-contradictory — can never confidently be ruled non-overlapping.
 * `checkPythonCompatibility` falls back to this once `isSubsetInterval` says
 * no; answering `true` here means that fallback lands on "partial" (check
 * this yourself) instead of a confident "incompatible" built on a
 * construct that could not be modeled safely in the first place.
 */
export function intersectsInterval(a: VersionInterval, b: VersionInterval): boolean {
  if (a.imprecise || b.imprecise) return true;
  const min = tighterMin(a.min, b.min);
  const max = tighterMax(a.max, b.max);
  if (!min || !max) return true;
  const cmp = compareTuples(min.value, max.value);
  if (cmp !== 0) return cmp < 0;
  return min.inclusive && max.inclusive;
}
