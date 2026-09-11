import semver from 'semver';
import type { DependencyChange, Ecosystem } from '../types.js';
import type { Logger } from '../util/logger.js';
import { fetchRegistryInfo } from '../evidence/registry.js';
import { classifyBump } from './version.js';

/**
 * Fill in `from`/`to` for a manifest-only bump whose specifiers are ranges.
 *
 * `computeDependencyChanges` leaves `from`/`to` `null` when the manifest states
 * a range (`^8.0.1`) and no lockfile pins it to a point version. `triage` then
 * rejects that change ("target manifest range has no exact resolved registry
 * version"), so a package.json-only bump — `"pkg": "^5"` → `"^8"`, which is the
 * shape of most Renovate/Dependabot manifest PRs and of a hand-edited upgrade —
 * produced no analysis at all.
 *
 * This asks the registry what each range resolves to and fills the point
 * versions in, so the surface diff, the changelog fetch and localization have
 * concrete versions to work from. It runs only for the changes that need it
 * (a range with no resolved version, seen in a manifest rather than a
 * lockfile), so a repository whose lockfile already pins everything makes no
 * extra request.
 *
 * The resolution is "what the range points at now", which for a range is the
 * only answer there is; a lockfile is still always preferred when present.
 */
export async function resolveManifestRanges(
  changes: readonly DependencyChange[],
  opts: {
    logger?: Logger;
    /** Injectable for tests; defaults to the real registry lookup. */
    lookup?: (name: string, ecosystem: Ecosystem) => Promise<{ versions: string[] } | null>;
  } = {},
): Promise<DependencyChange[]> {
  const lookup = opts.lookup ?? ((name, ecosystem) => fetchRegistryInfo(name, ecosystem, null));

  return Promise.all(
    changes.map(async (change) => {
      const needsFrom = change.rawFrom != null && change.from === null;
      const needsTo = change.rawTo != null && change.to === null;
      if ((!needsFrom && !needsTo) || change.source === 'lockfile') return change;

      // Only semver ecosystems have a range grammar `maxSatisfying` understands.
      // Others (Maven, Go) do not put a range in a manifest the way npm does, so
      // an unresolved `to` there is genuinely unresolvable and left as it was.
      if (!SEMVER_RANGE_ECOSYSTEMS.has(change.ecosystem)) return change;

      const info = await lookup(change.name, change.ecosystem).catch((err) => {
        opts.logger?.debug?.(`range resolution: registry lookup for ${change.name} failed: ${String(err)}`);
        return null;
      });
      const versions = info?.versions ?? [];
      if (versions.length === 0) return change;

      const resolvedFrom = needsFrom ? maxSatisfying(versions, change.rawFrom!) : change.from;
      const resolvedTo = needsTo ? maxSatisfying(versions, change.rawTo!) : change.to;
      // If a side that needed resolving still has none, the change stays as it
      // was and `triage` makes the same call it did before — no silent guess.
      if ((needsFrom && !resolvedFrom) || (needsTo && !resolvedTo)) return change;

      const from = resolvedFrom ?? change.from;
      const to = resolvedTo ?? change.to;
      opts.logger?.debug?.(
        `range resolution: ${change.name} ${change.rawFrom} → ${change.rawTo} resolves to ${from} → ${to}`,
      );
      return {
        ...change,
        from,
        to,
        bump: from && to ? classifyBump(from, to, change.ecosystem) : change.bump,
      };
    }),
  );
}

const SEMVER_RANGE_ECOSYSTEMS = new Set<Ecosystem>(['npm']);

/** `semver.maxSatisfying`, tolerant of a `v` prefix and an already-exact input. */
function maxSatisfying(versions: readonly string[], range: string): string | null {
  const cleaned = range.trim().replace(/^v(?=\d)/, '');
  if (semver.valid(cleaned)) return versions.includes(cleaned) ? cleaned : semver.valid(cleaned);
  if (!semver.validRange(cleaned)) return null;
  return semver.maxSatisfying([...versions], cleaned, { includePrerelease: false });
}
