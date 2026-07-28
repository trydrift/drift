import type { BreakingChange, Confidence, DependencyChange, Ecosystem, ImpactSite } from '../types.js';
import type { Logger } from '../util/logger.js';
import { unitAtLine, type FileIndex, type RepoIndex } from '../index/metarag.js';
import type { SourceFile } from '../index/walk.js';

/**
 * Localization: where does this breaking change actually bite?
 *
 * The precision lever is the import graph. A file that never imports `express`
 * cannot be broken by an `express` change, no matter how many times the word
 * "Router" appears in it. Searching only importers is what keeps Drift from
 * producing the kind of noisy, mostly-wrong report that gets a tool switched
 * off after one run.
 *
 * Confidence is assigned per site, because the same breaking change can land
 * with very different certainty in different files:
 *
 *   high   — the file imports the dependency AND the matched symbol is one it
 *            actually bound from that import.
 *   medium — the file imports the dependency and the symbol appears in it.
 *   low    — the symbol appears but the import link could not be established
 *            (dynamic import, re-export barrel, or an ecosystem where the
 *            package name and module name differ).
 */

export interface LocalizeOptions {
  logger: Logger;
  /** Cap per breaking change, so one common word can't flood the plan. */
  maxSitesPerChange?: number;
}

export function localize(
  breakingChanges: readonly BreakingChange[],
  dependencyChanges: readonly DependencyChange[],
  index: RepoIndex,
  files: readonly SourceFile[],
  options: LocalizeOptions,
): ImpactSite[] {
  const { logger, maxSitesPerChange = 100 } = options;

  const contentByPath = new Map(files.map((f) => [f.path, f.content]));
  const indexByPath = new Map(index.files.map((f) => [f.path, f]));
  const ecosystems = new Map(dependencyChanges.map((c) => [c.name, c.ecosystem]));

  const sites: ImpactSite[] = [];

  for (const change of breakingChanges) {
    const candidates = candidateFiles(change, index, ecosystems.get(change.dependency));

    if (candidates.length === 0) {
      logger.debug(`No importers found for ${change.dependency}; ${change.id} has no impact sites`);
      continue;
    }

    const found = searchFiles(change, candidates, contentByPath, indexByPath, maxSitesPerChange);
    sites.push(...found);

    if (found.length >= maxSitesPerChange) {
      logger.warn(
        `${change.dependency}: ${change.summary} matched at least ${maxSitesPerChange} locations; the plan lists the first ${maxSitesPerChange}.`,
      );
    }
  }

  return sites;
}

/**
 * Files worth searching for a given breaking change.
 *
 * OpenAPI-derived changes are the exception to the import-graph rule: an HTTP
 * endpoint has no import edge, so those fall back to a whole-repo search. The
 * symbols there are URL paths, which are specific enough not to over-match.
 */
function candidateFiles(
  change: BreakingChange,
  index: RepoIndex,
  ecosystem: Ecosystem | undefined,
): FileIndex[] {
  const isEndpointChange =
    change.kind === 'removed-endpoint' || change.kind === 'changed-endpoint';
  if (isEndpointChange) return index.files;

  const names = importKeysFor(change.dependency, ecosystem);
  const paths = new Set<string>();

  for (const name of names) {
    for (const path of index.importers.get(name) ?? []) paths.add(path);
  }

  // Prefix match catches Go module paths and Java package prefixes, where the
  // manifest coordinate and the import path share a root but are not equal.
  if (paths.size === 0) {
    for (const [key, importerPaths] of index.importers) {
      if (names.some((name) => key.startsWith(name) || name.startsWith(key))) {
        for (const path of importerPaths) paths.add(path);
      }
    }
  }

  return index.files.filter((f) => paths.has(f.path));
}

/**
 * Candidate module names for a package.
 *
 * Package name and import name diverge often enough to matter: `beautifulsoup4`
 * is imported as `bs4`, `pillow` as `PIL`. A wrong guess here means silently
 * finding nothing, so the aliases are explicit and the raw name is always kept
 * as a candidate.
 */
function importKeysFor(dependency: string, ecosystem: Ecosystem | undefined): string[] {
  const names = new Set<string>([dependency]);

  switch (ecosystem) {
    case 'pypi': {
      const normalized = dependency.toLowerCase().replace(/-/g, '_');
      names.add(normalized);
      const alias = PYPI_MODULE_ALIASES[dependency.toLowerCase()];
      if (alias) names.add(alias);
      break;
    }
    case 'maven': {
      // `group:artifact` -> the group is what appears in an import statement.
      const [group] = dependency.split(':');
      if (group) names.add(group);
      break;
    }
    case 'cargo':
      names.add(dependency.replace(/-/g, '_'));
      break;
    default:
      break;
  }

  return [...names];
}

/** Distribution name -> import name, for cases the normalisation rule misses. */
const PYPI_MODULE_ALIASES: Record<string, string> = {
  beautifulsoup4: 'bs4',
  pillow: 'PIL',
  'pyyaml': 'yaml',
  'python-dateutil': 'dateutil',
  'msgpack-python': 'msgpack',
  'attrs': 'attr',
  'scikit-learn': 'sklearn',
  'opencv-python': 'cv2',
  'python-dotenv': 'dotenv',
  'protobuf': 'google',
  'google-cloud-storage': 'google',
  'psycopg2-binary': 'psycopg2',
  'mysqlclient': 'MySQLdb',
  'django-cors-headers': 'corsheaders',
  'djangorestframework': 'rest_framework',
  'pytest-cov': 'pytest_cov',
  'typing-extensions': 'typing_extensions',
};

function searchFiles(
  change: BreakingChange,
  candidates: readonly FileIndex[],
  contentByPath: Map<string, string>,
  indexByPath: Map<string, FileIndex>,
  limit: number,
): ImpactSite[] {
  const sites: ImpactSite[] = [];

  for (const candidate of candidates) {
    if (sites.length >= limit) break;

    const content = contentByPath.get(candidate.path);
    if (!content) continue;

    const fileIndex = indexByPath.get(candidate.path);
    const importedNames = new Set(candidate.imports.flatMap((i) => i.bindings));
    const importsDependency = candidate.imports.length > 0;

    const lines = content.split('\n');

    for (const symbol of change.symbols) {
      const matcher = matcherFor(symbol);
      if (!matcher) continue;

      for (let i = 0; i < lines.length && sites.length < limit; i++) {
        const line = lines[i]!;
        if (!matcher.test(line)) continue;
        if (isCommentOnly(line)) continue;

        const unit = fileIndex ? unitAtLine(fileIndex, i + 1) : undefined;

        sites.push({
          breakingChangeId: change.id,
          file: candidate.path,
          line: i + 1,
          excerpt: line.trim().slice(0, 200),
          enclosingSymbol: unit?.name,
          matchedSymbol: symbol,
          confidence: confidenceFor(symbol, importedNames, importsDependency),
        });
      }
    }
  }

  return dedupeSites(sites);
}

/**
 * Build a word-boundary matcher for a symbol.
 *
 * Word boundaries are essential: without them `get` matches `getUserById`,
 * `forget`, and every other substring, which is precisely the over-matching
 * that destroys a reviewer's confidence in the report.
 */
function matcherFor(symbol: string): RegExp | null {
  const trimmed = symbol.trim();
  if (!trimmed || trimmed.length < 2) return null;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // URL paths: match as a quoted or templated string fragment rather than a
  // bare identifier, since `/users` is not an identifier in any language.
  if (trimmed.startsWith('/')) return new RegExp(escaped);

  // Qualified names like `Client.request` need an exact dotted match.
  if (trimmed.includes('.')) return new RegExp(`\\b${escaped}\\b`);

  return new RegExp(`\\b${escaped}\\b`);
}

function confidenceFor(
  symbol: string,
  importedNames: Set<string>,
  importsDependency: boolean,
): Confidence {
  const root = symbol.split('.')[0] ?? symbol;
  if (importedNames.has(symbol) || importedNames.has(root) || importedNames.has('*')) {
    return 'high';
  }
  return importsDependency ? 'medium' : 'low';
}

/**
 * Collapse multiple symbol matches on the same line.
 *
 * A line like `client.request(oldOption)` can match two symbols from the same
 * breaking change; a reviewer should see one site, not two.
 */
function dedupeSites(sites: readonly ImpactSite[]): ImpactSite[] {
  const seen = new Map<string, ImpactSite>();
  for (const site of sites) {
    const key = `${site.breakingChangeId}|${site.file}|${site.line}`;
    const existing = seen.get(key);
    if (!existing || rank(site.confidence) > rank(existing.confidence)) seen.set(key, site);
  }
  return [...seen.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
}

function rank(confidence: Confidence): number {
  return confidence === 'high' ? 2 : confidence === 'medium' ? 1 : 0;
}

/** Line comments only. A trailing comment on real code is still a real site. */
function isCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}
