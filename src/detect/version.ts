import semver from 'semver';
import type { BumpKind } from '../types.js';

/**
 * Reduce a version *range* to the concrete version it most likely resolves to.
 *
 * Manifests store ranges (`^1.2.3`, `>=2.0,<3.0`, `~> 4.1`) while breaking-change
 * analysis needs points. We take the lower bound, which is the version the range
 * was authored against and the one release notes are written relative to.
 */
export function normalizeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let v = raw.trim();
  if (!v) return null;

  // Non-versions we can't reason about: git URLs, file paths, tags, wildcards.
  if (/^(git|github|file|link|workspace|npm|https?):/i.test(v)) return null;
  if (v === '*' || v === 'latest' || v === '') return null;

  // Take the first component of a compound range: ">=2.0.0 <3.0.0" -> ">=2.0.0".
  const firstPart = v.split(/\s*(?:\|\||,)\s*/)[0]!.trim();
  v = firstPart.split(/\s+/)[0]!.trim();

  // Strip range operators, Ruby's `~>`, Maven brackets, Go's `v` prefix.
  v = v.replace(/^[\^~><=!]+/, '').replace(/^v/i, '').replace(/^[[(]/, '').replace(/[\])]$/, '');

  // Go pseudo-versions and `+incompatible` suffixes.
  v = v.replace(/\+incompatible$/, '');

  if (!v) return null;

  const coerced = semver.valid(v) ?? semver.valid(semver.coerce(v) ?? '');
  return coerced ?? null;
}

/**
 * Classify a version move.
 *
 * Anything we cannot parse becomes `unknown` rather than being guessed at —
 * `unknown` is treated as elevated risk downstream, which is the safe default.
 */
export function classifyBump(from: string | null, to: string | null): BumpKind {
  if (from === null && to !== null) return 'added';
  if (from !== null && to === null) return 'removed';
  if (from === null || to === null) return 'unknown';

  const a = normalizeVersion(from);
  const b = normalizeVersion(to);
  if (!a || !b) return 'unknown';
  if (semver.eq(a, b)) return 'unknown';

  const diff = semver.diff(a, b);
  switch (diff) {
    case 'major':
    case 'premajor':
      return 'major';
    case 'minor':
    case 'preminor':
      return 'minor';
    case 'patch':
    case 'prepatch':
      return 'patch';
    case 'prerelease':
      return 'prerelease';
    default:
      return 'unknown';
  }
}

/**
 * True when the move is a downgrade.
 *
 * Downgrades break code just as readily as upgrades but are rarer, so they get
 * flagged explicitly rather than folded into the bump classification.
 */
export function isDowngrade(from: string | null, to: string | null): boolean {
  const a = normalizeVersion(from);
  const b = normalizeVersion(to);
  if (!a || !b) return false;
  return semver.lt(b, a);
}

/**
 * 0.x releases treat *minor* bumps as breaking, per semver §4. Missing this is
 * one of the most common sources of surprise breakage in practice.
 */
export function isZeroVerBreaking(from: string | null, to: string | null): boolean {
  const a = normalizeVersion(from);
  const b = normalizeVersion(to);
  if (!a || !b) return false;
  if (semver.major(a) !== 0 || semver.major(b) !== 0) return false;
  return semver.minor(a) !== semver.minor(b);
}

/** All versions strictly after `from` and up to and including `to`. */
export function versionsBetween(all: string[], from: string, to: string): string[] {
  const a = normalizeVersion(from);
  const b = normalizeVersion(to);
  if (!a || !b) return [];
  return all
    .map((v) => ({ raw: v, norm: normalizeVersion(v) }))
    .filter((v): v is { raw: string; norm: string } => v.norm !== null)
    .filter((v) => semver.gt(v.norm, a) && semver.lte(v.norm, b))
    .sort((x, y) => semver.compare(x.norm, y.norm))
    .map((v) => v.raw);
}
