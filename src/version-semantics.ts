import semver from 'semver';
import type { BumpKind, Ecosystem } from './types.js';
import {
  compareMavenVersions,
  mavenIsPrerelease,
  mavenReleaseTuple,
  parseMavenVersion,
  type MavenComparableVersion,
} from './maven-version.js';

/** A registry identity paired with an ecosystem-owned comparison value. */
export interface ParsedPublishedVersion {
  /** Exact spelling supplied by the registry, lockfile, or other authority. */
  raw: string;
  ecosystem: Ecosystem;
  prerelease: boolean;
  comparable: ComparableVersion;
  /** Numeric release tuple when the ecosystem defines one. */
  release: readonly number[] | null;
}

export interface VersionSemantics {
  parse(raw: string): ParsedPublishedVersion | null;
  compare(a: ParsedPublishedVersion, b: ParsedPublishedVersion): number | null;
  satisfies(version: ParsedPublishedVersion, range: string): boolean | null;
  sameCompatibilityLine(
    current: ParsedPublishedVersion,
    candidate: ParsedPublishedVersion,
  ): boolean | null;
  classifyBump(from: ParsedPublishedVersion, to: ParsedPublishedVersion): BumpKind;
  exactVersion(range: string): string | null;
}

type ComparableVersion =
  | { kind: 'semver'; value: string }
  | { kind: 'pep440'; value: Pep440Version }
  | { kind: 'ruby'; value: readonly RubyPart[] }
  | { kind: 'maven'; value: MavenComparableVersion }
  | { kind: 'nuget'; value: NugetVersion }
  | { kind: 'opam'; value: string };

type RubyPart = number | string;

interface Pep440Version {
  epoch: number;
  release: number[];
  pre: [number, number] | null;
  post: number | null;
  dev: number | null;
  local: (number | string)[] | null;
}

interface NugetVersion {
  release: number[];
  prerelease: (number | string)[] | null;
}

const SEMVER_ECOSYSTEMS = new Set<Ecosystem>([
  'npm',
  'cargo',
  'go',
  'swift',
  'packagist',
  'hex',
  'pub',
  'cocoapods',
  'arduino',
]);

/** The single package-version semantics owner used by scan, evidence, and rationale. */
export function versionSemantics(ecosystem: Ecosystem): VersionSemantics {
  return {
    parse: (raw) => parsePublishedVersion(raw, ecosystem),
    compare: compareParsedVersions,
    satisfies: (version, range) => satisfiesRange(version, range),
    sameCompatibilityLine,
    classifyBump: classifyParsedBump,
    exactVersion: (range) => exactVersionFromRange(range, ecosystem),
  };
}

/** Parse without ever rewriting the identity held in `raw`. */
export function parsePublishedVersion(raw: string, ecosystem: Ecosystem): ParsedPublishedVersion | null {
  const identity = raw.trim();
  if (!identity || /\s/.test(identity)) return null;

  if (SEMVER_ECOSYSTEMS.has(ecosystem)) {
    const allowV = ecosystem === 'go' || ecosystem === 'swift' || ecosystem === 'cocoapods';
    const comparisonIdentity = allowV ? identity.replace(/^v(?=\d)/, '') : identity;
    let value = semver.valid(comparisonIdentity);
    if (!value) {
      const abbreviated = /^(\d+(?:\.\d+){0,1})([-+][0-9A-Za-z.-]+)?$/.exec(comparisonIdentity);
      if (abbreviated) {
        const release = abbreviated[1]!.split('.');
        value = semver.valid(`${release.join('.')}${'.0'.repeat(3 - release.length)}${abbreviated[2] ?? ''}`);
      }
    }
    if (!value) return null;
    const parsed = semver.parse(value)!;
    return {
      raw: identity,
      ecosystem,
      prerelease: parsed.prerelease.length > 0,
      comparable: { kind: 'semver', value },
      release: [parsed.major, parsed.minor, parsed.patch],
    };
  }

  if (ecosystem === 'pypi') {
    const value = parsePep440(identity);
    return value
      ? {
          raw: identity,
          ecosystem,
          prerelease: value.pre !== null || value.dev !== null,
          comparable: { kind: 'pep440', value },
          release: value.release,
        }
      : null;
  }

  if (ecosystem === 'rubygems') {
    if (!/^\d[0-9A-Za-z._-]*$/.test(identity)) return null;
    const value = rubySegments(identity);
    return {
      raw: identity,
      ecosystem,
      prerelease: value.some((part) => typeof part === 'string'),
      comparable: { kind: 'ruby', value },
      release: leadingRelease(value),
    };
  }

  if (ecosystem === 'maven') {
    // Maven itself accepts any string, but a version Drift cannot anchor to a
    // numeric release (`RELEASE`, `LATEST`, an unresolved `${revision}`) has no
    // safe ordering here, so parsing fails closed rather than inventing one.
    if (!/^\d[0-9A-Za-z._+-]*$/.test(identity)) return null;
    const value = parseMavenVersion(identity);
    return {
      raw: identity,
      ecosystem,
      prerelease: mavenIsPrerelease(value),
      comparable: { kind: 'maven', value },
      release: mavenReleaseTuple(value),
    };
  }

  if (ecosystem === 'nuget') {
    const value = parseNuget(identity);
    return value
      ? {
          raw: identity,
          ecosystem,
          prerelease: value.prerelease !== null,
          comparable: { kind: 'nuget', value },
          release: value.release,
        }
      : null;
  }

  if (ecosystem === 'opam') {
    if (!/\d/.test(identity)) return null;
    const release = /^v?(\d+(?:\.\d+)*)/.exec(identity)?.[1]?.split('.').map(Number) ?? null;
    return {
      raw: identity,
      ecosystem,
      prerelease: /(?:^|[._+-])(?:alpha|beta|pre|preview|rc|dev)\d*/i.test(identity),
      comparable: { kind: 'opam', value: identity },
      release,
    };
  }

  // Conan and vcpkg permit package-authored/version-scheme-specific ordering.
  // Preserving the spelling is possible, but manufacturing a global ordering
  // is not. Failing parsing closes discovery/range/bump operations safely.
  return null;
}

export function compareParsedVersions(a: ParsedPublishedVersion, b: ParsedPublishedVersion): number | null {
  if (a.ecosystem !== b.ecosystem || a.comparable.kind !== b.comparable.kind) return null;
  switch (a.comparable.kind) {
    case 'semver':
      return semver.compare(a.comparable.value, (b.comparable as typeof a.comparable).value);
    case 'pep440':
      return comparePep440(a.comparable.value, (b.comparable as typeof a.comparable).value);
    case 'ruby':
      return compareRuby(a.comparable.value, (b.comparable as typeof a.comparable).value);
    case 'maven':
      return compareMavenVersions(a.comparable.value, (b.comparable as typeof a.comparable).value);
    case 'nuget':
      return compareNuget(a.comparable.value, (b.comparable as typeof a.comparable).value);
    case 'opam':
      return compareOpam(a.comparable.value, (b.comparable as typeof a.comparable).value);
  }
}

export function comparePackageVersions(a: string, b: string, ecosystem: Ecosystem): number | null {
  const semantics = versionSemantics(ecosystem);
  const left = semantics.parse(a);
  const right = semantics.parse(b);
  return left && right ? semantics.compare(left, right) : null;
}

export function satisfiesPackageRange(version: string, range: string, ecosystem: Ecosystem): boolean | null {
  const parsed = parsePublishedVersion(version, ecosystem);
  return parsed ? satisfiesRange(parsed, range) : null;
}

export function classifyPackageBump(
  from: string | null,
  to: string | null,
  ecosystem: Ecosystem,
): BumpKind {
  if (from === null && to !== null) return 'added';
  if (from !== null && to === null) return 'removed';
  if (from === null || to === null) return 'unknown';
  const left = parsePublishedVersion(from, ecosystem);
  const right = parsePublishedVersion(to, ecosystem);
  return left && right ? classifyParsedBump(left, right) : 'unknown';
}

/**
 * Classify movement between declarations without promoting either range
 * boundary into a registry identity. This is descriptive only: callers keep
 * `from`/`to` null until a lock or registry supplies exact identities.
 */
export function classifyPackageRangeBump(
  fromRange: string | null,
  toRange: string | null,
  ecosystem: Ecosystem,
): BumpKind {
  if (fromRange === null || toRange === null) return classifyPackageBump(fromRange, toRange, ecosystem);
  const left = comparisonAnchor(fromRange, ecosystem);
  const right = comparisonAnchor(toRange, ecosystem);
  return left && right ? classifyParsedBump(left, right) : 'unknown';
}

export function isPackageDowngrade(from: string | null, to: string | null, ecosystem: Ecosystem): boolean | null {
  if (!from || !to) return null;
  const compared = comparePackageVersions(to, from, ecosystem);
  return compared === null ? null : compared < 0;
}

export function isZeroVersionBreaking(from: string | null, to: string | null, ecosystem: Ecosystem): boolean {
  if (!from || !to || !SEMVER_ECOSYSTEMS.has(ecosystem)) return false;
  const left = parsePublishedVersion(from, ecosystem);
  const right = parsePublishedVersion(to, ecosystem);
  return Boolean(
    left?.release &&
      right?.release &&
      left.release[0] === 0 &&
      right.release[0] === 0 &&
      left.release[1] !== right.release[1],
  );
}

export function packageVersionsBetween(
  all: readonly string[],
  from: string,
  to: string,
  ecosystem: Ecosystem,
): string[] {
  const semantics = versionSemantics(ecosystem);
  const left = semantics.parse(from);
  const right = semantics.parse(to);
  if (!left || !right) return [];
  const direction = semantics.compare(right, left);
  if (direction === null) return [];
  const [low, high] = direction >= 0 ? [left, right] : [right, left];
  return all
    .map((raw) => ({ raw, parsed: semantics.parse(raw) }))
    .filter((item): item is { raw: string; parsed: ParsedPublishedVersion } => item.parsed !== null)
    .filter((item) => {
      const above = semantics.compare(item.parsed, low);
      const atMost = semantics.compare(item.parsed, high);
      return above !== null && atMost !== null && above > 0 && atMost <= 0;
    })
    .sort((a, b) => semantics.compare(a.parsed, b.parsed) ?? 0)
    .map((item) => item.raw);
}

function classifyParsedBump(from: ParsedPublishedVersion, to: ParsedPublishedVersion): BumpKind {
  const compared = compareParsedVersions(from, to);
  if (compared === null || compared === 0) return 'unknown';
  const a = from.release;
  const b = to.release;
  if (!a || !b) return 'unknown';
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return 'major';
  if ((a[1] ?? 0) !== (b[1] ?? 0)) return 'minor';
  if ((a[2] ?? 0) !== (b[2] ?? 0)) return 'patch';
  return from.prerelease || to.prerelease ? 'prerelease' : 'unknown';
}

function sameCompatibilityLine(current: ParsedPublishedVersion, candidate: ParsedPublishedVersion): boolean | null {
  if (current.ecosystem !== candidate.ecosystem || !current.release || !candidate.release) return null;
  if (current.ecosystem === 'maven' || current.ecosystem === 'opam') return null;
  const major = current.release[0] ?? 0;
  if (major === 0) {
    return (candidate.release[0] ?? 0) === 0 && (candidate.release[1] ?? 0) === (current.release[1] ?? 0);
  }
  return (candidate.release[0] ?? 0) === major;
}

function satisfiesRange(version: ParsedPublishedVersion, rawRange: string): boolean | null {
  const range = rawRange.trim();
  if (!range || range === '*') return true;

  if (version.comparable.kind === 'semver') {
    let normalized = range;
    if (version.ecosystem === 'cargo' && /^v?\d+(?:\.\d+){0,2}$/.test(range)) normalized = `^${range}`;
    const valid = semver.validRange(normalized);
    return valid ? semver.satisfies(version.comparable.value, valid) : null;
  }
  if (version.comparable.kind === 'pep440') return satisfiesPep440(version.comparable.value, range);
  if (version.comparable.kind === 'ruby') return satisfiesRuby(version, range);
  if (version.comparable.kind === 'maven') return satisfiesInterval(version, range, /^([[(])\s*([^,]*)\s*,\s*([^\])]*?)\s*([\])])$/);
  if (version.comparable.kind === 'nuget') {
    if (/^[[(]/.test(range)) return satisfiesInterval(version, range, /^([[(])\s*([^,]*)\s*,?\s*([^\])]*?)\s*([\])])$/);
    const floor = parsePublishedVersion(range, 'nuget');
    const cmp = floor ? compareParsedVersions(version, floor) : null;
    return cmp === null ? null : cmp >= 0;
  }
  if (version.comparable.kind === 'opam') return satisfiesOpam(version, range);
  return null;
}

function satisfiesInterval(
  version: ParsedPublishedVersion,
  range: string,
  pattern: RegExp,
): boolean | null {
  const match = pattern.exec(range);
  if (!match) {
    const exact = parsePublishedVersion(range, version.ecosystem);
    const compared = exact ? compareParsedVersions(version, exact) : null;
    return compared === null ? null : compared === 0;
  }
  const [, leftBracket, lowRaw, highRaw, rightBracket] = match;
  if (lowRaw) {
    const low = parsePublishedVersion(lowRaw, version.ecosystem);
    const cmp = low ? compareParsedVersions(version, low) : null;
    if (cmp === null) return null;
    if (cmp < 0 || (cmp === 0 && leftBracket === '(')) return false;
  }
  if (highRaw) {
    const high = parsePublishedVersion(highRaw, version.ecosystem);
    const cmp = high ? compareParsedVersions(version, high) : null;
    if (cmp === null) return null;
    if (cmp > 0 || (cmp === 0 && rightBracket === ')')) return false;
  }
  return true;
}

function exactVersionFromRange(range: string, ecosystem: Ecosystem): string | null {
  const value = range.trim();
  if (ecosystem === 'npm') return semver.valid(value) ? value : null;
  if (ecosystem === 'cargo') {
    const match = /^=\s*(v?\d+(?:\.\d+){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(value);
    return match && parsePublishedVersion(match[1]!, ecosystem) ? match[1]! : null;
  }
  if (ecosystem === 'pypi') {
    const match = /^==\s*([^,;\s]+)$/.exec(value);
    return match && !match[1]!.includes('*') && parsePublishedVersion(match[1]!, ecosystem) ? match[1]! : null;
  }
  if (ecosystem === 'rubygems') {
    const match = /^(?:=|==)\s*([^,\s]+)$/.exec(value);
    return match && parsePublishedVersion(match[1]!, ecosystem) ? match[1]! : null;
  }
  if (ecosystem === 'nuget') {
    const match = /^\[\s*([^,\]]+)\s*\]$/.exec(value);
    return match && parsePublishedVersion(match[1]!, ecosystem) ? match[1]! : null;
  }
  if (parsePublishedVersion(value, ecosystem)) return value;
  return null;
}

function comparisonAnchor(range: string, ecosystem: Ecosystem): ParsedPublishedVersion | null {
  const exact = exactVersionFromRange(range, ecosystem);
  if (exact) return parsePublishedVersion(exact, ecosystem);

  // Lower-bound spellings emitted by the manifest parsers. The extracted
  // token is only a comparison operand and is never returned as identity.
  const match = range.trim().match(/(?:^|[<>=~^\[(,{"'\s])(v?\d+(?:!\d+)?(?:\.\d+)*(?:(?:a|b|rc)\d+|[-.](?:alpha|beta|rc)[-.]?\d*)?)/i);
  return match ? parsePublishedVersion(match[1]!, ecosystem) : null;
}

function parsePep440(raw: string): Pep440Version | null {
  const value = raw.toLowerCase().replace(/[-_]/g, '.');
  const match = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(?:\.)?(a|b|c|rc|alpha|beta|pre|preview)(?:\.)?(\d+)?)?(?:(?:\.(post|rev|r)(?:\.)?(\d+)?)|-(\d+))?(?:\.?(dev)(?:\.)?(\d+)?)?(?:\+([a-z0-9]+(?:[._-][a-z0-9]+)*))?$/.exec(value);
  if (!match) return null;
  const preLabel = match[3];
  const preRank = preLabel ? (/^(a|alpha)$/.test(preLabel) ? 0 : /^(b|beta)$/.test(preLabel) ? 1 : 2) : null;
  return {
    epoch: Number(match[1] ?? 0),
    release: match[2]!.split('.').map(Number),
    pre: preRank === null ? null : [preRank, Number(match[4] ?? 0)],
    post: match[7] !== undefined ? Number(match[7]) : match[5] ? Number(match[6] ?? 0) : null,
    dev: match[8] ? Number(match[9] ?? 0) : null,
    local: match[10]
      ? match[10].split(/[._-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : null,
  };
}

function comparePep440(a: Pep440Version, b: Pep440Version): number {
  let cmp = compareNumber(a.epoch, b.epoch) || compareNumericTuples(a.release, b.release);
  if (cmp) return cmp;
  cmp = comparePepPre(a, b);
  if (cmp) return cmp;
  cmp = compareNullableNumber(a.post, b.post, -1);
  if (cmp) return cmp;
  cmp = compareNullableNumber(a.dev, b.dev, 1);
  if (cmp) return cmp;
  return compareLocal(a.local, b.local);
}

function comparePepPre(a: Pep440Version, b: Pep440Version): number {
  // A development release without an explicit pre marker sorts before alpha.
  const left: readonly number[] = a.pre ?? (a.dev !== null && a.post === null ? [-1, 0] : [3, 0]);
  const right: readonly number[] = b.pre ?? (b.dev !== null && b.post === null ? [-1, 0] : [3, 0]);
  return compareNumericTuples(left, right);
}

function compareLocal(a: (number | string)[] | null, b: (number | string)[] | null): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === 'number' && typeof right === 'string') return 1;
    if (typeof left === 'string' && typeof right === 'number') return -1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function satisfiesPep440(version: Pep440Version, range: string): boolean | null {
  const clauses = range.split(',').map((part) => part.trim()).filter(Boolean);
  if (!clauses.length) return true;
  for (const clause of clauses) {
    const match = /^(~=|==|!=|<=|>=|<|>)\s*v?(.+)$/.exec(clause);
    if (!match) return null;
    const [, operator, raw] = match;
    if ((operator === '==' || operator === '!=') && raw!.endsWith('.*')) {
      const prefix = raw!.slice(0, -2).split('.').map(Number);
      if (prefix.some(Number.isNaN)) return null;
      const equal = prefix.every((part, index) => (version.release[index] ?? 0) === part);
      if ((operator === '==' && !equal) || (operator === '!=' && equal)) return false;
      continue;
    }
    const other = parsePep440(raw!);
    if (!other) return null;
    const cmp = comparePep440(version, other);
    if (operator === '>=' && cmp < 0) return false;
    if (operator === '>' && cmp <= 0) return false;
    if (operator === '<=' && cmp > 0) return false;
    if (operator === '<' && cmp >= 0) return false;
    if (operator === '==' && cmp !== 0) return false;
    if (operator === '!=' && cmp === 0) return false;
    if (operator === '~=') {
      if (cmp < 0 || other.release.length < 2) return false;
      const prefix = other.release.slice(0, -1);
      if (!prefix.every((part, index) => (version.release[index] ?? 0) === part)) return false;
    }
  }
  return true;
}

function rubySegments(raw: string): RubyPart[] {
  return raw.replace(/-/g, '.pre.').match(/[0-9]+|[A-Za-z]+/g)?.map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase())) ?? [];
}

function compareRuby(a: readonly RubyPart[], b: readonly RubyPart[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'string') return 1;
    if (typeof left === 'string' && typeof right === 'number') return -1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function satisfiesRuby(version: ParsedPublishedVersion, range: string): boolean | null {
  const clauses = range.split(',').map((part) => part.trim()).filter(Boolean);
  if (!clauses.length) return true;
  for (const clause of clauses) {
    const match = /^(~>|>=|<=|>|<|=|==)?\s*([^\s]+)$/.exec(clause);
    if (!match) return null;
    const operator = match[1] ?? '=';
    const other = parsePublishedVersion(match[2]!, 'rubygems');
    if (!other) return null;
    const cmp = compareParsedVersions(version, other)!;
    if ((operator === '=' || operator === '==') && cmp !== 0) return false;
    if (operator === '>=' && cmp < 0) return false;
    if (operator === '>' && cmp <= 0) return false;
    if (operator === '<=' && cmp > 0) return false;
    if (operator === '<' && cmp >= 0) return false;
    if (operator === '~>') {
      if (cmp < 0 || !other.release) return false;
      const declaredParts = match[2]!.match(/\d+/g)?.length ?? 0;
      const upper = [...other.release];
      const index = declaredParts >= 3 ? 1 : 0;
      upper[index] = (upper[index] ?? 0) + 1;
      upper.splice(index + 1);
      const releaseCmp = compareNumericTuples(version.release ?? [], upper);
      if (releaseCmp >= 0) return false;
    }
  }
  return true;
}

function parseNuget(raw: string): NugetVersion | null {
  const match = /^[vV]?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!match) return null;
  return {
    release: match[1]!.split('.').map(Number),
    prerelease: match[2]
      ? match[2].toLowerCase().split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : null,
  };
}

function compareNuget(a: NugetVersion, b: NugetVersion): number {
  const release = compareNumericTuples(a.release, b.release);
  if (release) return release;
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === 'number' && typeof right === 'string') return -1;
    if (typeof left === 'string' && typeof right === 'number') return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** opam's alternating non-digit/digit ordering, including its special low `~`. */
function compareOpam(a: string, b: string): number {
  let left = 0;
  let right = 0;
  while (left < a.length || right < b.length) {
    while ((a[left] && !/\d/.test(a[left]!)) || (b[right] && !/\d/.test(b[right]!))) {
      const cmp = compareOpamChar(a[left], b[right]);
      if (cmp) return cmp;
      if (left < a.length) left++;
      if (right < b.length) right++;
    }
    const leftStart = left;
    const rightStart = right;
    while (/\d/.test(a[left] ?? '')) left++;
    while (/\d/.test(b[right] ?? '')) right++;
    const leftDigits = a.slice(leftStart, left).replace(/^0+/, '') || '0';
    const rightDigits = b.slice(rightStart, right).replace(/^0+/, '') || '0';
    if (leftDigits.length !== rightDigits.length) return leftDigits.length < rightDigits.length ? -1 : 1;
    if (leftDigits !== rightDigits) return leftDigits < rightDigits ? -1 : 1;
  }
  return 0;
}

function compareOpamChar(a: string | undefined, b: string | undefined): number {
  const rank = (value: string | undefined): number => {
    if (value === '~') return -1;
    if (value === undefined) return 0;
    if (/[A-Za-z]/.test(value)) return value.charCodeAt(0);
    return value.charCodeAt(0) + 256;
  };
  return compareNumber(rank(a), rank(b));
}

function satisfiesOpam(version: ParsedPublishedVersion, range: string): boolean | null {
  const body = range.trim().replace(/^\{\s*|\s*\}$/g, '');
  const clauses = body.split(/\s*(?:&|&&)\s*/).filter(Boolean);
  if (!clauses.length) return null;
  for (const clause of clauses) {
    const match = /^(>=|<=|>|<|=)?\s*["']?([^"'\s]+)["']?$/.exec(clause);
    if (!match) return null;
    const other = parsePublishedVersion(match[2]!, 'opam');
    const cmp = other ? compareParsedVersions(version, other) : null;
    if (cmp === null) return null;
    const op = match[1] ?? '=';
    if (op === '=' && cmp !== 0) return false;
    if (op === '>=' && cmp < 0) return false;
    if (op === '>' && cmp <= 0) return false;
    if (op === '<=' && cmp > 0) return false;
    if (op === '<' && cmp >= 0) return false;
  }
  return true;
}

function leadingRelease(parts: readonly (number | string)[]): number[] | null {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part !== 'number') break;
    out.push(part);
  }
  return out.length ? out : null;
}

function compareNumericTuples(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const cmp = compareNumber(a[i] ?? 0, b[i] ?? 0);
    if (cmp) return cmp;
  }
  return 0;
}

function compareNullableNumber(a: number | null, b: number | null, absentRank: number): number {
  return compareNumber(a ?? absentRank * Number.MAX_SAFE_INTEGER, b ?? absentRank * Number.MAX_SAFE_INTEGER);
}

function compareNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
