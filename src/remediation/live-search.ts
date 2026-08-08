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

  const baseName = normalizePackageName(dependencyChange.name);
  const fullName = dependencyChange.name.toLowerCase();
  const url = `${CODEMOD_REGISTRY_HOST}/registry?search=${encodeURIComponent(baseName)}`;

  const response = await fetchJson<CodemodRegistryResponse | CodemodRegistryEntry[]>(url, {
    timeoutMs: REGISTRY_TIMEOUT_MS,
    cacheTtlMs: 60 * 60 * 1000,
  });
  if (!response) return null;

  const entries = Array.isArray(response) ? response : (response.entries ?? response.results ?? response.data ?? []);
  if (!Array.isArray(entries)) return null;

  const scored = entries
    .map((entry) => ({ entry, confidence: entryMatchesDependency(entry, fullName, baseName) }))
    .filter((r): r is { entry: CodemodRegistryEntry; confidence: Exclude<MatchConfidence, 'none'> } => r.confidence !== 'none');
  if (scored.length === 0) return null;

  // A full scoped-name match against the entry's own declared applicability
  // is the only certain match: two unrelated packages that merely share a
  // base name (`@foo/core` vs `@bar/core`) must not be treated as the same
  // candidate. Base-name and loose text matches are kept only as a fallback
  // when nothing declares the exact scoped name, and are always ranked below
  // an exact match; a verified/official publisher only breaks ties within
  // the same confidence tier.
  const rank: Record<Exclude<MatchConfidence, 'none'>, number> = { exact: 2, 'base-name': 1, text: 0 };
  scored.sort(
    (a, b) => rank[b.confidence] - rank[a.confidence] || Number(isOfficialCodemodEntry(b.entry)) - Number(isOfficialCodemodEntry(a.entry)),
  );
  const best = scored[0]!.entry;

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

type MatchConfidence = 'exact' | 'base-name' | 'text' | 'none';

/**
 * Whether — and how confidently — an entry's declared applicability (or, as
 * a last resort, its own name/slug) refers to the dependency being upgraded.
 *
 * `'exact'` compares the full scoped package name as declared, so `@foo/core`
 * cannot be confused with `@bar/core` just because both strip to `core`.
 * `'base-name'` is the scope-stripped fallback for entries that only ever
 * declare an unscoped name (npm's unscoped ecosystem, or a registry that
 * never recorded the scope) — a real possibility, but strictly lower
 * confidence than an exact match. `'text'` is a last-resort, word-bounded
 * substring check across the entry's slug, name, and free-text
 * description/summary — looser than the other two tiers (and so always
 * ranked below them), but still anchored to a word boundary rather than a
 * bare substring so `acme-sdk` cannot match inside an unrelated
 * `acme-sdk-legacy-tools`-style token.
 */
function entryMatchesDependency(entry: CodemodRegistryEntry, fullName: string, baseName: string): MatchConfidence {
  const packages = entry.applicability?.flatMap((a) => a.packages ?? []) ?? [];
  if (packages.some((p) => p.toLowerCase() === fullName)) return 'exact';
  if (packages.some((p) => normalizePackageName(p) === baseName)) return 'base-name';

  const haystack = `${entry.slug ?? ''} ${entry.name ?? ''} ${entry.description ?? ''} ${entry.summary ?? ''}`.toLowerCase();
  const boundary = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(baseName)}(?:$|[^a-z0-9])`);
  if (baseName && boundary.test(haystack)) return 'text';

  return 'none';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
