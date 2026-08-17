import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BreakingChange, DependencyChange } from '../types.js';
import { stableId } from '../util/id.js';
import { FIX_PLAN_SCHEMA_VERSION, type FixPlan } from './schema.js';

/**
 * Fix plans on disk, addressed by the migration they describe.
 *
 * A fix plan is the first artefact in Drift's pipeline that is worth keeping
 * *between* repositories. Everything else — evidence, impact sites, commit
 * units — is either about one codebase or already cheap to recompute. A plan
 * is neither: it cost a model call, and it is a statement about the
 * dependency's API rather than about any particular consumer of it. Two
 * repositories upgrading `acme-sdk` from 1.x to 2.x hit the same break and
 * need the same rule.
 *
 * So the key is the migration and nothing else — dependency, version range,
 * change kind, symbols — and deliberately not the repository, the file
 * paths, or the call sites. Those are recomputed on every use: a restored
 * plan goes through `validate.ts` against *this* repository's own localized
 * sites exactly as a freshly authored one does, and can perfectly well come
 * back `partial` here having been `accepted` there. The cache saves the
 * authoring call. It never saves the checking.
 *
 * Every function here fails soft. A cache that cannot be read is a cache
 * miss, and a cache that cannot be written is a plan that gets authored
 * again next time — neither is a reason to fail a run.
 */

export interface FixPlanCache {
  get(key: string): Promise<FixPlan | null>;
  put(key: string, plan: FixPlan): Promise<void>;
  /** Every plan held, for `drift fixplan list` and the extension's library view. */
  all(): Promise<FixPlan[]>;
}

/**
 * The lookup key: what migration is this?
 *
 * Note what is absent. No workspace, no file, no site count, no repository.
 * Two consumers of the same upgrade compute the same key, which is the
 * entire point — and a key that accidentally included a local detail would
 * silently turn a shared artefact back into a per-repo memo while still
 * appearing to work.
 */
export function migrationKey(change: BreakingChange, dependencyChange?: DependencyChange): string {
  return stableId(
    'mig',
    String(FIX_PLAN_SCHEMA_VERSION),
    change.dependency,
    dependencyChange?.from ?? '',
    dependencyChange?.to ?? '',
    change.kind,
    [...change.symbols].sort().join(','),
  );
}

/** Where plans live. `DRIFT_CACHE_DIR` moves the whole cache, as it does for HTTP. */
export function defaultFixPlanCacheDir(): string | null {
  if (process.env.DRIFT_NO_CACHE === '1') return null;
  const base = process.env.DRIFT_CACHE_DIR || join(homedir(), '.drift', 'cache');
  return join(base, 'fixplans');
}

export function fileSystemFixPlanCache(dir: string): FixPlanCache {
  return {
    async get(key) {
      try {
        const raw = await readFile(join(dir, `${key}.json`), 'utf8');
        const plan = JSON.parse(raw) as FixPlan;
        // A plan written by a newer build may use ops this one cannot
        // execute. Treat it as a miss rather than reading it optimistically.
        if (plan.schemaVersion !== FIX_PLAN_SCHEMA_VERSION) return null;
        return plan;
      } catch {
        return null;
      }
    },

    async put(key, plan) {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${key}.json`), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      } catch {
        // A plan that could not be cached is a plan that gets authored again.
      }
    },

    async all() {
      try {
        const entries = await readdir(dir);
        const plans: FixPlan[] = [];
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue;
          try {
            const plan = JSON.parse(await readFile(join(dir, entry), 'utf8')) as FixPlan;
            if (plan.schemaVersion === FIX_PLAN_SCHEMA_VERSION) plans.push(plan);
          } catch {
            // Skip an unreadable entry rather than failing the listing.
          }
        }
        return plans.sort((a, b) => a.dependency.localeCompare(b.dependency) || a.id.localeCompare(b.id));
      } catch {
        return [];
      }
    },
  };
}

/** An in-memory cache, for tests and for runs that must not touch disk. */
export function memoryFixPlanCache(seed: Iterable<[string, FixPlan]> = []): FixPlanCache {
  const store = new Map<string, FixPlan>(seed);
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, plan) {
      store.set(key, plan);
    },
    async all() {
      return [...store.values()];
    },
  };
}

/** A cache that holds nothing, for `DRIFT_NO_CACHE=1` and read-only environments. */
export function noFixPlanCache(): FixPlanCache {
  return {
    async get() {
      return null;
    },
    async put() {
      /* nothing is kept */
    },
    async all() {
      return [];
    },
  };
}

/**
 * Re-stamp a restored plan so its provenance records that it was restored,
 * without losing who originally authored it.
 *
 * An audit reading `author: 'cache'` should be able to ask "cached from
 * what?" and get an answer, which is what `sourceId` and the retained model
 * or recipe fields are for.
 */
export function asRestored(plan: FixPlan): FixPlan {
  return {
    ...plan,
    provenance: {
      ...plan.provenance,
      author: 'cache',
      sourceId: plan.id,
    },
  };
}
