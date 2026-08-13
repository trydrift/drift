import type { RemediationPlan } from '../types.js';
import { fetchJson, fetchText } from '../util/http.js';
import { fetchRegistryInfo } from './registry.js';
import { matchesVersion } from './surface/index.js';

/** How many breaking changes one plan will spend a GitHub source lookup on. See `attachGitHubSources`. */
const MAX_GITHUB_SOURCE_LOOKUPS = 12;

/**
 * Best-effort: attach a real GitHub source line to every breaking change in
 * `plan` that actually reaches code in this repository — the ones a reader
 * will actually see in the report.
 *
 * This runs *after* localization deliberately, not during evidence
 * gathering: a computed surface diff can find hundreds of changed symbols
 * in one package, and evidence gathering has no way yet to know which
 * handful of those will turn out to have an impact site here. Spending the
 * lookup budget there means spending it on symbols the report may never
 * show — resolving zod's `setErrorMap` while never trying `boolean`, the
 * one this repository actually calls, which is exactly what happened in
 * practice before this was moved here. Now the resolution runs once for
 * the plan and is spent only on breaking changes already known to matter.
 */
export async function attachGitHubSources(plan: RemediationPlan, token: string | undefined): Promise<RemediationPlan> {
  if (!token) return plan;

  const reachable = plan.breakingChanges.filter(
    (b) => b.symbols.length > 0 && plan.impactSites.some((s) => s.breakingChangeId === b.id),
  );
  if (reachable.length === 0) return plan;

  const repoCache = new Map<string, string | null>();
  const sourceUrls = new Map<string, string>();
  let spent = 0;

  for (const breaking of reachable) {
    if (spent >= MAX_GITHUB_SOURCE_LOOKUPS) break;

    const change = plan.changes.find(
      (c) => c.name === breaking.dependency && (c.workspace ?? '') === (breaking.workspace ?? ''),
    );
    if (!change?.to || change.ecosystem !== 'npm') continue;

    let githubRepo = repoCache.get(change.name);
    if (githubRepo === undefined) {
      const info = await fetchRegistryInfo(change.name, change.ecosystem, change.to);
      githubRepo = info?.githubRepo ?? null;
      repoCache.set(change.name, githubRepo);
    }
    if (!githubRepo) continue;

    spent++;
    const hit = await resolveGitHubDeclaration(githubRepo, change.to, breaking.symbols[0]!, token);
    if (hit) sourceUrls.set(breaking.id, hit.url);
  }

  if (sourceUrls.size === 0) return plan;

  return {
    ...plan,
    breakingChanges: plan.breakingChanges.map((b) => (sourceUrls.has(b.id) ? { ...b, sourceUrl: sourceUrls.get(b.id) } : b)),
  };
}

/**
 * Best-effort resolution of a changed npm export to the real TypeScript
 * source that declares it, as a GitHub blob URL with a line number.
 *
 * The published `.d.ts` a computed type-surface diff compares is compiled
 * output, and for many packages (bundled/rolled-up declarations) a single
 * file with no correspondence to the original multi-file source layout — a
 * citation to line 1 of a several-thousand-line file proves the change
 * happened but does nothing to show a reader where. Every step here can
 * fail for an ordinary reason: no git tag matches this exact version, tag
 * spellings vary too much to guess (`v4.4.3`, `4.4.3`, `zod@4.4.3`);
 * GitHub's code search — which only indexes the *default* branch — doesn't
 * find the symbol, or finds it somewhere that no longer matches at the
 * resolved tag; the search API's own low rate limit is already spent this
 * run. A failure at any step is silent: the caller keeps the published
 * declaration's CDN link, which is always correct for the exact version
 * being compared even when this can't be.
 */
export async function resolveGitHubDeclaration(
  githubRepo: string,
  version: string,
  symbol: string,
  token?: string,
): Promise<{ url: string; line: number } | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const tag = await findVersionTag(githubRepo, version, headers);
  if (!tag) return null;

  const path = await findSymbolFile(githubRepo, symbol, headers);
  if (!path) return null;

  const line = await findSymbolLine(githubRepo, tag, path, symbol);
  if (!line) return null;

  return { url: `https://github.com/${githubRepo}/blob/${tag}/${path.split('/').map(encodeURIComponent).join('/')}#L${line}`, line };
}

/**
 * Tag spellings are not standardised — `v1.3.1`, `1.3.1`, and, for a
 * monorepo package, `zod@1.3.1` all appear in the wild — so the tag list is
 * fetched and matched (`matchesVersion`, shared with the C/Conan evidence
 * path) rather than a tag name being guessed outright.
 */
async function findVersionTag(githubRepo: string, version: string, headers: Record<string, string>): Promise<string | null> {
  const tags = await fetchJson<{ name?: string }[]>(`https://api.github.com/repos/${githubRepo}/tags?per_page=100`, {
    headers,
  });
  const match = (tags ?? []).find((entry) => Boolean(entry.name) && matchesVersion(entry.name!, version));
  return match?.name ?? null;
}

/**
 * A single best-guess file, from GitHub's code search. Deliberately not
 * trusted on its own — it only searches the default branch, which can be
 * ahead of or behind the tag being cited — `findSymbolLine` re-reads this
 * same file *at the resolved tag* and only succeeds if the symbol is still
 * there.
 */
async function findSymbolFile(githubRepo: string, symbol: string, headers: Record<string, string>): Promise<string | null> {
  const query = encodeURIComponent(`${symbol} repo:${githubRepo} language:TypeScript`);
  const result = await fetchJson<{ items?: { path?: string }[] }>(`https://api.github.com/search/code?q=${query}&per_page=5`, {
    headers,
  });
  const candidate = (result?.items ?? [])
    .map((item) => item.path)
    .find((path): path is string => !!path && !path.endsWith('.d.ts') && !path.includes('node_modules/'));
  return candidate ?? null;
}

/** Confirms the symbol is actually declared in this file at this exact tag, and returns its 1-indexed line. */
async function findSymbolLine(githubRepo: string, tag: string, path: string, symbol: string): Promise<number | null> {
  const content = await fetchText(`https://raw.githubusercontent.com/${githubRepo}/${tag}/${path}`);
  if (!content) return null;

  const declaration = new RegExp(`\\b(export\\s+)?(declare\\s+)?(default\\s+)?(function|const|class|interface|type|enum)\\s+${escapeRegExp(symbol)}\\b`);
  const lines = content.split('\n');
  const index = lines.findIndex((line) => declaration.test(line));
  return index === -1 ? null : index + 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
