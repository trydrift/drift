import { fetchJson, fetchText } from '../util/http.js';
import type { BreakingChange, DependencyChange } from '../types.js';
import type { CommunityRecipeCandidate } from './types.js';

/**
 * Live community recipe discovery.
 *
 * Drift does not maintain its own list of which package upgrades map to
 * which recipe — that would mean a maintainer manually curating an entry per
 * migration, which throws away the entire advantage of Codemod.com and
 * OpenRewrite already doing that work. Instead this queries their registries
 * directly, at analysis time, for the exact dependency and version Drift is
 * looking at.
 *
 * The trust boundary is narrow and fixed, not delegated to the repository
 * being analysed:
 *
 *   - Only these two, hardcoded registry hosts are ever queried. There is no
 *     config field, anywhere in Drift, that lets a repository supply its own
 *     registry URL — a `drift.yml` cannot point this at an arbitrary host.
 *   - A query never executes anything. It returns metadata a human or a
 *     config flag still has to explicitly accept before anything runs — see
 *     `src/remediation/partition.ts`.
 *   - The exact version returned is pinned into the candidate immediately;
 *     nothing downstream ever re-resolves "latest" at execution time.
 *   - Every request goes through `util/http.ts`'s shared fetch helper, which
 *     already caches per URL (in-process, and on disk when configured) and
 *     never throws — a slow or unreachable registry degrades to "no
 *     candidate found," the same as a registry that genuinely has nothing,
 *     never a failed run.
 */

const CODEMOD_REGISTRY_HOST = 'https://api.codemod.com';
const MAVEN_CENTRAL_HOST = 'https://search.maven.org';

/** Bounded so an unreachable registry can't stall a whole analysis run. */
const REGISTRY_TIMEOUT_MS = 6_000;

interface CodemodRegistryEntry {
  slug?: string;
  name?: string;
  version?: string;
  latestVersion?: string;
  author?: string;
  publisher?: string;
  owner?: { name?: string; slug?: string };
  verified?: boolean;
  official?: boolean;
  description?: string;
  summary?: string;
  useCaseCategory?: string;
  applicability?: { packages?: string[]; framework?: string }[];
}

interface CodemodRegistryResponse {
  entries?: CodemodRegistryEntry[];
  results?: CodemodRegistryEntry[];
  data?: CodemodRegistryEntry[];
}

/**
 * Search Codemod.com's public registry for a recipe addressing this
 * dependency's upgrade.
 *
 * The registry's exact response shape is not a contract Drift controls, so
 * every field is read defensively — an entry missing a field this needs, or
 * a response shaped differently than expected, is simply not matched rather
 * than guessed at. A registry that changes its API becomes "no candidate
 * found," never a crash and never a wrong one.
 */
export async function queryCodemodRegistry(
  change: BreakingChange,
  dependencyChange: DependencyChange | undefined,
): Promise<CommunityRecipeCandidate | null> {
  if (!dependencyChange) return null;

  const query = normalizePackageName(dependencyChange.name);
  const url = `${CODEMOD_REGISTRY_HOST}/registry?search=${encodeURIComponent(query)}`;

  const response = await fetchJson<CodemodRegistryResponse | CodemodRegistryEntry[]>(url, {
    timeoutMs: REGISTRY_TIMEOUT_MS,
    cacheTtlMs: 60 * 60 * 1000,
  });
  if (!response) return null;

  const entries = Array.isArray(response) ? response : (response.entries ?? response.results ?? response.data ?? []);
  if (!Array.isArray(entries)) return null;

  const matches = entries.filter((entry) => entryMatchesDependency(entry, query));
  if (matches.length === 0) return null;

  // Prefer a verified/official entry over an arbitrary community publisher —
  // still shown to the user either way, never auto-selected into execution.
  matches.sort((a, b) => Number(isOfficialCodemodEntry(b)) - Number(isOfficialCodemodEntry(a)));
  const best = matches[0]!;

  const name = best.slug ?? best.name;
  const version = best.version ?? best.latestVersion;
  if (!name || !version) return null;

  return {
    provider: 'codemod.com',
    name,
    version,
    publisher: best.owner?.name ?? best.author ?? best.publisher ?? 'Codemod.com',
    source: `https://app.codemod.com/registry/${encodeURIComponent(best.slug ?? name)}`,
    migration: best.description ?? best.summary ?? `Migrates ${dependencyChange.name} usages.`,
    official: isOfficialCodemodEntry(best),
  };
}

function entryMatchesDependency(entry: CodemodRegistryEntry, normalizedQuery: string): boolean {
  if (entry.applicability?.some((a) => a.packages?.some((p) => normalizePackageName(p) === normalizedQuery))) {
    return true;
  }
  const haystack = `${entry.slug ?? ''} ${entry.name ?? ''} ${entry.description ?? ''} ${entry.summary ?? ''}`.toLowerCase();
  return haystack.includes(normalizedQuery);
}

function isOfficialCodemodEntry(entry: CodemodRegistryEntry): boolean {
  if (entry.verified || entry.official) return true;
  const publisher = (entry.owner?.name ?? entry.owner?.slug ?? entry.author ?? entry.publisher ?? '').toLowerCase();
  return publisher === 'codemod' || publisher === 'codemod.com';
}

interface MavenSearchDoc {
  g: string;
  a: string;
  latestVersion?: string;
  v?: string;
}

interface MavenSearchResponse {
  response?: { docs?: MavenSearchDoc[] };
}

const RECIPE_ID_PATTERN = /\borg\.openrewrite\.[a-zA-Z0-9_.]*[A-Z][a-zA-Z0-9_]*\b/;

/**
 * Search Maven Central's public index for an OpenRewrite recipe module
 * matching this dependency, then read the module's own published POM for a
 * recipe id it names in its description.
 *
 * Every result lives under the `org.openrewrite.recipe` group id, which is
 * OpenRewrite's own — there is no third-party namespace to accidentally
 * trust here. Maven Central's search index cannot tell Drift *which* of a
 * module's bundled recipes to run non-interactively, so this only proposes a
 * candidate when the module's own POM description names one explicitly
 * (a dotted `org.openrewrite.*` identifier); a module found but not
 * confidently nameable is left unmatched rather than guessed at, since an
 * incorrect recipe id fails the run cleanly but an incorrectly *chosen* one
 * would waste the person reviewing it's time on the wrong migration.
 */
export async function queryOpenRewriteRegistry(
  change: BreakingChange,
  dependencyChange: DependencyChange | undefined,
): Promise<CommunityRecipeCandidate | null> {
  if (!dependencyChange || dependencyChange.ecosystem !== 'maven') return null;

  const normalized = normalizePackageName(dependencyChange.name).replace(/[^a-z0-9]/g, '-');
  const doc = await searchMavenArtifact(`rewrite-${normalized}`) ?? (await searchMavenArtifact(normalized));
  if (!doc?.latestVersion) return null;

  const description = await fetchMavenPomDescription(doc.g, doc.a, doc.latestVersion);
  const recipeId = description ? RECIPE_ID_PATTERN.exec(description)?.[0] : undefined;
  if (!recipeId) return null;

  return {
    provider: 'openrewrite',
    name: recipeId,
    version: doc.latestVersion,
    publisher: 'OpenRewrite',
    source: `${MAVEN_CENTRAL_HOST}/artifact/${doc.g}/${doc.a}/${doc.latestVersion}`,
    migration: description ?? `Runs ${recipeId} from ${doc.g}:${doc.a}.`,
    official: true,
  };
}

async function searchMavenArtifact(artifactId: string): Promise<MavenSearchDoc | null> {
  const q = encodeURIComponent(`g:org.openrewrite.recipe AND a:${artifactId}`);
  const url = `${MAVEN_CENTRAL_HOST}/solrsearch/select?q=${q}&core=gav&rows=1&wt=json`;

  const response = await fetchJson<MavenSearchResponse>(url, {
    timeoutMs: REGISTRY_TIMEOUT_MS,
    cacheTtlMs: 60 * 60 * 1000,
  });
  const doc = response?.response?.docs?.[0];
  return doc?.g === 'org.openrewrite.recipe' ? doc : null;
}

async function fetchMavenPomDescription(groupId: string, artifactId: string, version: string): Promise<string | null> {
  const groupPath = groupId.replace(/\./g, '/');
  const url = `${MAVEN_CENTRAL_HOST}/remotecontent?filepath=${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`;

  const pom = await fetchText(url, { timeoutMs: REGISTRY_TIMEOUT_MS, cacheTtlMs: 24 * 60 * 60 * 1000, immutable: true });
  if (!pom) return null;

  const match = /<description>([\s\S]*?)<\/description>/.exec(pom);
  return match ? match[1]!.trim() : null;
}

function normalizePackageName(name: string): string {
  return name.replace(/^@[^/]+\//, '').toLowerCase();
}
