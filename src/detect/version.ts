import semver from 'semver';
import type { BumpKind, Ecosystem } from '../types.js';
import {
  classifyPackageBump,
  isPackageDowngrade,
  isZeroVersionBreaking,
  packageVersionsBetween,
} from '../version-semantics.js';

/**
 * Reduce a version *range* to the concrete version it most likely resolves to.
 *
 * Manifests store ranges (`^1.2.3`, `>=2.0,<3.0`, `~> 4.1`) while breaking-change
 * analysis needs points. We take the lower bound, which is the version the range
 * was authored against and the one release notes are written relative to.
 */
function cleanRangeOperators(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let v = raw.trim();
  if (!v) return null;

  // npm aliases (`npm:foo@1.2.3`, `npm:@scope/foo@1.2.3`) point at a real published
  // version — unwrap them instead of discarding the version they carry.
  const aliasMatch = /^npm:(?:@[^/]+\/)?[^@]+@(.+)$/i.exec(v);
  if (aliasMatch) {
    v = aliasMatch[1]!.trim();
  } else if (/^(git|github|file|link|workspace|npm|https?):/i.test(v)) {
    // Non-versions we can't reason about: git URLs, file paths, tags, wildcards.
    return null;
  }
  if (v === '*' || v === 'latest' || v === '') return null;

  // Take the first component of a compound range: ">=2.0.0 <3.0.0" -> ">=2.0.0".
  v = v.split(/\|\||,/)[0]!.trim();

  // Strip leading operators *before* splitting on whitespace. Ruby writes its
  // pessimistic constraint as `~> 4.1`, with a space, so splitting first would
  // leave us holding the operator and discarding the version.
  v = v.replace(/^[\^~><=!]+\s*/, '').replace(/^[[(]\s*/, '');

  v = v.split(/\s+/)[0]!.trim();

  // Maven's closing bracket, and Go's `v` prefix.
  v = v.replace(/^v/i, '').replace(/[\])]$/, '');

  // Go pseudo-versions and `+incompatible` suffixes.
  v = v.replace(/\+incompatible$/, '');

  return v || null;
}

export function normalizeVersion(raw: string | null | undefined): string | null {
  const v = cleanRangeOperators(raw);
  if (!v) return null;
  const coerced = semver.valid(v) ?? semver.valid(semver.coerce(v) ?? '');
  return coerced ?? null;
}

/**
 * Like `normalizeVersion`, but refuses to coerce non-SemVer strings (Maven's
 * `1.0.0.Final`, `1.0.0.SP1`, ...). Coercion can map genuinely different
 * versions onto the same SemVer point, which is fine for bump classification
 * but wrong for "did this actually change?" comparisons — it would make a
 * real qualifier-only upgrade look like unchanged churn.
 */
export function normalizeVersionExact(raw: string | null | undefined): string | null {
  const v = cleanRangeOperators(raw);
  return v ? (semver.valid(v) ?? null) : null;
}

/**
 * Classify a version move.
 *
 * Anything we cannot parse becomes `unknown` rather than being guessed at —
 * `unknown` is treated as elevated risk downstream, which is the safe default.
 */
export function classifyBump(from: string | null, to: string | null, ecosystem: Ecosystem = 'npm'): BumpKind {
  return classifyPackageBump(from, to, ecosystem);
}

/**
 * True when the move is a downgrade.
 *
 * Downgrades break code just as readily as upgrades but are rarer, so they get
 * flagged explicitly rather than folded into the bump classification.
 */
export function isDowngrade(from: string | null, to: string | null, ecosystem: Ecosystem = 'npm'): boolean {
  return isPackageDowngrade(from, to, ecosystem) === true;
}

/**
 * 0.x releases treat *minor* bumps as breaking, per semver §4. Missing this is
 * one of the most common sources of surprise breakage in practice.
 */
export function isZeroVerBreaking(from: string | null, to: string | null, ecosystem: Ecosystem = 'npm'): boolean {
  return isZeroVersionBreaking(from, to, ecosystem);
}

/** All versions strictly after `from` and up to and including `to`. */
export function versionsBetween(all: string[], from: string, to: string, ecosystem: Ecosystem = 'npm'): string[] {
  return packageVersionsBetween(all, from, to, ecosystem);
}
