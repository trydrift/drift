import { createHash } from 'node:crypto';
import type { DependencyChange } from '../types.js';

/**
 * Deterministic short identifier.
 *
 * IDs are content-derived rather than random so that re-running Drift on the
 * same commit produces byte-identical plans. That makes runs diffable, makes
 * "did anything actually change?" answerable, and lets the approval flow match
 * a posted plan to a later `/drift apply` without storing state anywhere.
 */
export function stableId(prefix: string, ...parts: (string | number | null | undefined)[]): string {
  const digest = createHash('sha256').update(parts.map((p) => String(p ?? '')).join(' ')).digest('hex');
  return `${prefix}_${digest.slice(0, 10)}`;
}

/**
 * A dependency's identity within one analysis run.
 *
 * `change.name` alone collides in a monorepo: two workspace members can
 * depend on the same package at different versions, and every structure that
 * keyed purely off the name — evidence lookups, computed-surface maps,
 * behavioural-probe grouping — would silently let one member's result
 * overwrite or answer for the other's. The workspace member (`''` for the
 * repository root, absent entirely in a single-package repo) is the missing
 * half of the key.
 *
 * Deliberately *not* ecosystem-qualified: this key also has to match
 * `Evidence` and `BreakingChange` records, neither of which carries an
 * `ecosystem` field, so folding it in here would silently break every
 * evidence/change lookup that crosses between a `DependencyChange` and one of
 * those. Callers that both mint and look up their own keys from
 * `DependencyChange` alone (see `analysis.ts`'s surface-diff maps) can add
 * ecosystem to the key themselves where a same-workspace name collision
 * across ecosystems is a real risk.
 */
export function dependencyKey(change: Pick<DependencyChange, 'name' | 'workspace'>): string {
  // Equal to the bare name in a single-package repository -- the common case,
  // and the format every existing name-keyed map already used -- so this only
  // changes behaviour where a workspace is actually present to disambiguate.
  return change.workspace === undefined ? change.name : `${change.workspace} ${change.name}`;
}

/**
 * A dependency's identity, further qualified by ecosystem.
 *
 * For maps that are only ever written and read from a full `DependencyChange`
 * (the computed-surface-diff maps in `analysis.ts`/`rationale/index.ts`) —
 * where a workspace can otherwise carry, say, an npm `requests` and a pip
 * `requests` at once, and `dependencyKey` alone would let one's computed diff
 * answer for the other's. Not a substitute for `dependencyKey` in general:
 * `Evidence` and `BreakingChange` records don't carry `ecosystem`, so mixing
 * this into a lookup that has to match against either of those would just
 * make every such lookup miss.
 */
export function dependencyEcosystemKey(change: Pick<DependencyChange, 'name' | 'workspace' | 'ecosystem'>): string {
  return `${change.ecosystem} ${dependencyKey(change)}`;
}

/**
 * Strip leading/trailing dashes without an unanchored `-+$`-style regex: a
 * trailing quantifier with no `^` counterpart forces the engine to retry the
 * match at every position, which is quadratic on a long non-terminal run of
 * the trimmed character.
 */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45 /* '-' */) start++;
  while (end > start && value.charCodeAt(end - 1) === 45 /* '-' */) end--;
  return value.slice(start, end);
}

/** Lowercase, hyphenated, filesystem- and git-ref-safe slug. */
export function slugify(input: string, maxLength = 40): string {
  const slug = trimDashes(input.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return trimDashes(slug.slice(0, maxLength)) || 'change';
}
