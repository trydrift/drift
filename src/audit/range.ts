import semver from 'semver';
import type { Ecosystem } from '../types.js';
import { normalizeVersion } from '../detect/version.js';

/**
 * The oldest version a declared range admits.
 *
 * This is the whole premise of the audit. A manifest range is a statement about
 * what the project is *willing* to run; the lockfile records what it actually
 * runs. When the two differ, the gap between them is a set of upstream releases
 * that landed in this project without anyone reading them — a resolver moved
 * the code, not a person. Anything breaking in that window is breaking *now*,
 * which is a different and more urgent claim than "this would break if you
 * upgraded".
 *
 * An exact pin has no such gap by construction: floor equals installed, the
 * window is empty, and the audit correctly has nothing to say. That is the
 * right answer, not a miss — a pinned dependency was reviewed by whoever
 * pinned it.
 *
 * Ranges are parsed per ecosystem because the notations genuinely disagree:
 * `~> 3.0` is Ruby's pessimistic operator, `~=1.4.2` is Python's compatible
 * release, `1.2` is a caret in Cargo and an exact pin in Maven. Returning
 * `null` for a notation we cannot read is deliberate — a guessed floor would
 * invent a window and therefore invent findings, which is the one failure mode
 * this feature must not have.
 */
export function rangeFloor(range: string, ecosystem: Ecosystem): string | null {
  const raw = range.trim();
  if (!raw) return null;

  // A wildcard states no lower bound at all. There is no floor to compute, and
  // treating "any version" as "version 0" would open a window spanning the
  // package's entire history — every release it ever made, reported as
  // unreviewed drift. Technically true, uselessly so.
  if (raw === '*' || raw === 'x' || raw === '' || raw === 'latest' || raw === 'any') return null;

  switch (ecosystem) {
    case 'npm':
    case 'pub':
      return semverFloor(raw);
    case 'hex':
      return semverFloor(hexRange(raw) ?? raw);
    case 'cargo':
      // Cargo's bare `1.2` is `^1.2`, which `semver` already reads as a caret
      // range; the operator-less form needs no special handling here.
      return semverFloor(raw);
    case 'pypi':
      return pythonFloor(raw);
    case 'rubygems':
      return rubyFloor(raw);
    case 'packagist':
      return semverFloor(raw.replace(/\s*\|\|\s*/g, ' || '));
    case 'nuget':
      return bracketFloor(raw);
    case 'maven':
      return bracketFloor(raw);
    default:
      // Go, Swift, CocoaPods, OPAM: the manifest coordinate is an exact version
      // in ordinary use. `normalizeVersion` returning a version means it was a
      // pin, which yields an empty window — the honest outcome.
      return normalizeVersion(raw);
  }
}

/** Does the installed version actually satisfy what the manifest declared? */
export function satisfiesRange(version: string, range: string, ecosystem: Ecosystem): boolean | null {
  const raw = range.trim();
  if (!raw || raw === '*' || raw === 'x' || raw === 'latest' || raw === 'any') return true;

  // Only asked where the notation is unambiguous enough that a `false` is a
  // real finding rather than a parser limitation. `null` means "not checked",
  // which callers must not render as "violated".
  if (ecosystem !== 'npm' && ecosystem !== 'cargo' && ecosystem !== 'hex' && ecosystem !== 'pub') {
    return null;
  }

  const normalized = normalizeVersion(version);
  if (!normalized) return null;

  const translated = ecosystem === 'hex' ? hexRange(raw) : raw;
  if (translated === null || !semver.validRange(translated)) return null;

  return semver.satisfies(normalized, translated, { includePrerelease: true });
}

/**
 * Hex's `~>` is Ruby's pessimistic operator, not npm's tilde.
 *
 * They look identical and differ on the most common declaration in the whole
 * Elixir ecosystem. `~> 4.0` in `mix.exs` means *4.0.0 up to but not including
 * 5.0.0*; node-semver reads `~4.0` as *4.0.0 up to 4.1.0*. So every Phoenix
 * project on `{:ecto, "~> 3.0"}` with 3.14 resolved was reported as running a
 * version its own manifest forbids — twenty-five such findings on Phoenix
 * itself, every one of them wrong, and wrong in the direction that costs the
 * most: a confident, specific, actionable claim about a file that is fine.
 *
 * The rule is that `~>` pins every segment *except* the last one written:
 *
 *   `~> 2`        >= 2.0.0  < 3.0.0     (also what a bare major means)
 *   `~> 2.1`      >= 2.1.0  < 3.0.0
 *   `~> 2.1.3`    >= 2.1.3  < 2.2.0
 *   `~> 2.1.3-rc` >= 2.1.3-rc < 2.2.0
 *
 * Hex also joins requirements with `and` / `or` rather than with spaces and
 * `||`, which is a spelling difference and translates directly.
 */
export function hexRange(range: string): string | null {
  const clauses = range.split(/\s+or\s+/i).map((clause) =>
    clause
      .split(/\s+and\s+/i)
      .map((term) => hexTerm(term.trim()))
      .join(' '),
  );

  return clauses.some((clause) => clause.includes('!')) ? null : clauses.join(' || ');
}

function hexTerm(term: string): string {
  const pessimistic = /^~>\s*(.+)$/.exec(term);
  if (!pessimistic?.[1]) return term;

  const version = pessimistic[1].trim();
  // Split off any pre-release or build metadata before counting segments, so
  // `2.1.3-rc.1` is read as three segments rather than four.
  const [core = ''] = version.split(/[-+]/);
  const segments = core.split('.').filter((segment) => segment !== '');
  const major = Number(segments[0] ?? 0);
  const minor = Number(segments[1] ?? 0);

  if (segments.length <= 2) {
    // `~> 2` and `~> 2.1` both stop at the next major.
    const floor = segments.length === 1 ? `${major}.0.0` : `${major}.${minor}.0`;
    return `>=${floor} <${major + 1}.0.0`;
  }

  // Three or more segments: the ceiling is the next minor. Anything past the
  // patch is a pre-release or build tag, which does not move the ceiling.
  return `>=${version} <${major}.${minor + 1}.0`;
}

function semverFloor(range: string): string | null {
  if (!semver.validRange(range)) return normalizeVersion(range);
  try {
    const min = semver.minVersion(range);
    return min ? min.version : null;
  } catch {
    return null;
  }
}

/**
 * PEP 440 specifier sets: `>=2.0,<3`, `~=1.4.2`, `==1.2.3`, `!=1.5`.
 *
 * The floor is the highest lower bound across the clauses, since every clause
 * has to hold at once. `!=` and bare `<`/`<=` clauses state no lower bound and
 * are skipped rather than misread as one.
 */
function pythonFloor(range: string): string | null {
  let floor: string | null = null;

  for (const clause of range.split(',')) {
    const match = /^\s*(===|==|>=|~=|>|<=|<|!=)?\s*([^\s,]+)\s*$/.exec(clause);
    if (!match) continue;

    const operator = match[1] ?? '==';
    if (operator === '<' || operator === '<=' || operator === '!=') continue;

    // `==1.2.*` pins a prefix; its floor is that prefix zero-filled, which is
    // exactly what `normalizeVersion` produces once the wildcard is dropped.
    const version = normalizeVersion(match[2]!.replace(/\.\*$/, ''));
    if (!version) continue;

    // `>1.2.3` admits nothing at 1.2.3 itself, but the next release after it is
    // unknowable without the registry. 1.2.3 is the tightest floor we can state
    // from the manifest alone, and it can only ever widen the window by one
    // patch — never narrow it, so it cannot hide a finding.
    if (!floor || semver.gt(version, floor)) floor = version;
  }

  return floor;
}

/**
 * RubyGems requirements: `~> 3.0`, `>= 2.1`, `= 1.4.2`, `>= 2.1, < 4`.
 *
 * Same rule as Python — the highest lower bound wins — over Ruby's operator
 * set, in which `~>` is a lower bound with an implied ceiling.
 */
function rubyFloor(range: string): string | null {
  let floor: string | null = null;

  for (const clause of range.split(',')) {
    const match = /^\s*(~>|>=|>|<=|<|!=|=)?\s*([^\s,]+)\s*$/.exec(clause);
    if (!match) continue;

    const operator = match[1] ?? '=';
    if (operator === '<' || operator === '<=' || operator === '!=') continue;

    const version = normalizeVersion(match[2]!);
    if (!version) continue;
    if (!floor || semver.gt(version, floor)) floor = version;
  }

  return floor;
}

/**
 * Maven / NuGet interval notation: `[1.0,2.0)`, `(1.0,]`, or a bare version.
 *
 * A bare version means "1.0 or newer, preferring 1.0" in Maven and an exact
 * minimum in NuGet; both make it the floor.
 */
function bracketFloor(range: string): string | null {
  const interval = /^[\[(]\s*([^,\]\s)]*)\s*,/.exec(range);
  if (interval) {
    const lower = interval[1]!.trim();
    return lower ? normalizeVersion(lower) : null;
  }
  return normalizeVersion(range);
}
