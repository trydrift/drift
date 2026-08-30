import type { Ecosystem } from '../types.js';
import { fetchJson, fetchText } from '../util/http.js';
import { compareParsedVersions, parsePublishedVersion } from '../version-semantics.js';

/** One version's worth of changelog prose. */
export interface ChangelogSection {
  version: string;
  /** Markdown body between this version's heading and the next. */
  body: string;
  /** Line of the heading within the source file, for citation. */
  line: number;
}

const CHANGELOG_FILENAMES = [
  'CHANGELOG.md',
  'CHANGELOG.markdown',
  'CHANGELOG',
  'CHANGES.md',
  'HISTORY.md',
  'NEWS.md',
  'RELEASES.md',
  // Hyphenated and underscored variants are not stylistic near-misses: they are
  // the only changelog several widely-depended-on crates publish. `base64` ships
  // `RELEASE-NOTES.md` and nothing else, and probing only the `CHANGELOG*` forms
  // reported one of the most-depended-on crates in the ecosystem as having no
  // release prose at all.
  'RELEASE-NOTES.md',
  'RELEASE_NOTES.md',
  'CHANGELOG.rst',
  'CHANGES.rst',
  'CHANGELOG.txt',
  'docs/CHANGELOG.md',
  'docs/changelog.md',
  'changelog.md',
];

const MIGRATION_FILENAMES = [
  'MIGRATING.md',
  'MIGRATION.md',
  'UPGRADING.md',
  'UPGRADE.md',
  'docs/migration.md',
  'docs/migrating.md',
  'docs/upgrading.md',
  'docs/MIGRATION.md',
  'docs/UPGRADE.md',
];

export interface FetchedDocument {
  path: string;
  url: string;
  content: string;
  /** Branch the document was found on, so linked documents resolve against it. */
  branch: string;
}

/**
 * Find a changelog in a GitHub repo by probing known filenames on the default
 * branch via `raw.githubusercontent.com`.
 *
 * Raw content is unauthenticated and generously rate-limited, which matters:
 * Drift must work with nothing but a `GITHUB_TOKEN` scoped to the *user's*
 * repo, and it has no credentials for arbitrary third-party repositories.
 */
export async function fetchChangelog(
  githubRepo: string,
  branches: readonly string[] = ['main', 'master'],
  options: { declaredUrl?: string | null } = {},
): Promise<FetchedDocument | null> {
  // A registry-declared changelog URL is a statement by the package author.
  // It outranks every guess Drift could make about a filename.
  if (options.declaredUrl) {
    const declared = await fetchDeclaredChangelog(options.declaredUrl);
    if (declared) return declared;
  }
  const probed = await probe(githubRepo, CHANGELOG_FILENAMES, branches);
  if (probed) return probed;
  // Every conventional spelling missed. Rather than growing the list forever —
  // Sidekiq ships `Changes.md`, which is `CHANGES.md` in every way but case —
  // ask the repository what it actually contains, once.
  return listedChangelog(githubRepo, branches);
}

/**
 * Fetch a changelog the registry named outright.
 *
 * A GitHub blob URL is rewritten to raw content; anything else is fetched as
 * given. `null` means the declared document could not be read — which is a
 * fact about reachability, never proof that no changelog exists.
 */
export async function fetchDeclaredChangelog(declaredUrl: string): Promise<FetchedDocument | null> {
  const url = declaredUrl.trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const blob = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/i.exec(url);
  const raw = blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}` : url;

  // A declared URL pointing at a rendered release page (GitHub Releases, a
  // docs site) is not a document this parser can read as changelog prose, and
  // the release-notes provider already covers that ground.
  if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases/i.test(url)) return null;

  const content = await fetchText(raw, { retries: 0 });
  if (!content || !content.trim()) return null;

  return {
    path: blob ? blob[3]! : url,
    url,
    content,
    branch: blob ? blob[2]! : 'HEAD',
  };
}

/**
 * The repository's own root listing, matched case-insensitively.
 *
 * Only reached when every conventional filename missed, so the extra
 * unauthenticated API call is paid exactly where the guessing failed rather
 * than on every package.
 */
async function listedChangelog(
  githubRepo: string,
  branches: readonly string[],
): Promise<FetchedDocument | null> {
  const listing = await fetchJson<{ name?: string; type?: string }[]>(
    `https://api.github.com/repos/${githubRepo}/contents/`,
    { retries: 0 },
  );
  if (!Array.isArray(listing)) return null;

  const wanted = new Set(CHANGELOG_FILENAMES.filter((name) => !name.includes('/')).map(lower));
  const matches = listing
    .filter((entry) => entry.type !== 'dir' && typeof entry.name === 'string')
    .map((entry) => entry.name!)
    .filter((name) => wanted.has(lower(name)))
    // Keep the same priority the probe list encodes, so two runs agree.
    .sort((a, b) => changelogRank(a) - changelogRank(b));

  for (const name of matches) {
    const found = await probe(githubRepo, [name], branches);
    if (found) return found;
  }
  return null;
}

function lower(name: string): string {
  return name.toLowerCase();
}

function changelogRank(name: string): number {
  const at = CHANGELOG_FILENAMES.findIndex((candidate) => lower(candidate) === lower(name));
  return at === -1 ? CHANGELOG_FILENAMES.length : at;
}

export async function fetchMigrationGuide(
  githubRepo: string,
  branches: readonly string[] = ['main', 'master'],
): Promise<FetchedDocument | null> {
  return probe(githubRepo, MIGRATION_FILENAMES, branches);
}

/**
 * How a guess-the-filename probe is paced.
 *
 * There is no API that answers "does this repository have a changelog" without
 * credentials for it, so the only way to find out is to ask for each name in
 * turn. Done strictly one at a time — which is what this used to do — a package
 * with no changelog at all costs thirty-two sequential round trips before
 * answering "no", and a scan of Scrapy's dependencies spent 1,413 requests and
 * half a minute of wall time doing exactly that.
 *
 * Issuing all thirty-two at once would fix the latency and break something
 * else: `raw.githubusercontent.com` is unauthenticated, which is the whole
 * reason it is used here rather than the API, and eight packages each fanning
 * out thirty-two ways is how a scan starts collecting 429s instead of evidence.
 *
 * So: the single overwhelmingly likely candidate on its own, and only if that
 * misses, the rest in bounded waves. A repository with `CHANGELOG.md` on its
 * default branch costs exactly one request, as before. A repository with none
 * costs the same thirty-two requests it always did, in three round trips
 * instead of thirty-two.
 */
const FIRST_WAVE = 1;
const WAVE_SIZE = 16;

function* waves<T>(candidates: readonly T[]): Generator<readonly T[]> {
  if (candidates.length === 0) return;
  yield candidates.slice(0, FIRST_WAVE);
  for (let at = FIRST_WAVE; at < candidates.length; at += WAVE_SIZE) {
    yield candidates.slice(at, at + WAVE_SIZE);
  }
}

async function probe(
  githubRepo: string,
  filenames: readonly string[],
  branches: readonly string[],
): Promise<FetchedDocument | null> {
  const candidates = branches.flatMap((branch) => filenames.map((filename) => ({ branch, filename })));

  for (const wave of waves(candidates)) {
    const fetched = await Promise.all(
      wave.map(({ branch, filename }) =>
        fetchText(`https://raw.githubusercontent.com/${githubRepo}/${branch}/${filename}`, { retries: 0 }),
      ),
    );

    // `find`, so the answer is the first *by priority* rather than the first to
    // come back. Which document wins must not depend on which response was
    // quickest, or two runs of the same scan cite different files.
    const at = fetched.findIndex((content) => content !== null && content.trim() !== '');
    if (at < 0) continue;

    const { branch, filename } = wave[at]!;
    return {
      path: filename,
      url: `https://github.com/${githubRepo}/blob/${branch}/${filename}`,
      content: fetched[at]!,
      branch,
    };
  }

  return null;
}

/**
 * A link out of an index-style changelog to the document that holds the prose.
 */
export interface ChangelogLink {
  /** Repository-relative path of the linked document. */
  path: string;
  /** Version the link is labelled with, normalised. */
  version: string;
}

/**
 * Links to per-version changelog files, from a changelog that is an index.
 *
 * A large project eventually stops appending to one file. Phaser's root
 * `CHANGELOG.md` is a table of contents — a table of `[3.90](changelog/v3/3.90/
 * CHANGELOG-v3.90.md)` rows and nothing else — and every heading in it is a
 * product name rather than a version, so section parsing returns *nothing*.
 * Drift fetched the file, parsed zero sections, and reported that no changelog
 * existed for a project that maintains one of the most thorough changelogs in
 * the JavaScript ecosystem.
 *
 * Links are matched on the version in their text or their path, so both
 * `[3.90](…)` and `[Full changelog](changelog/v3/3.90/…)` resolve.
 */
export function changelogIndexLinks(content: string, ecosystem: Ecosystem = 'npm'): ChangelogLink[] {
  const links: ChangelogLink[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const text = match[1]!;
    const href = match[2]!;

    // Only same-repository markdown documents. An absolute URL is somebody
    // else's page, and a non-markdown target is not prose to read.
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue;
    if (!/\.(md|markdown|rst|txt)$/i.test(href)) continue;

    const version = extractVersion(text, ecosystem) ?? extractVersion(href.replace(/[/\\]/g, ' '), ecosystem);
    if (!version) continue;

    const path = href.replace(/^\.?\//, '').split('#')[0]!;
    if (seen.has(path)) continue;
    seen.add(path);
    links.push({ path, version });
  }

  return links;
}

/**
 * The changelog prose for `(from, to]`, following an index when it finds one.
 *
 * A document that already contains version sections is returned as-is; the
 * common case does not pay for a second round of fetches. Only when the file
 * yields no section covering the range does Drift treat it as an index and
 * fetch the documents it points at — which is exactly the situation where the
 * alternative was reporting that no changelog exists.
 */
export async function fetchChangelogDocuments(
  githubRepo: string,
  from: string,
  to: string,
  ecosystem: Ecosystem = 'npm',
  options: { branches?: readonly string[]; maxDocuments?: number; declaredUrl?: string | null } = {},
): Promise<FetchedDocument[]> {
  const { branches = ['main', 'master'], maxDocuments = 12, declaredUrl = null } = options;

  const root = await fetchChangelog(githubRepo, branches, { declaredUrl });
  if (!root) return [];

  if (sectionsBetween(parseChangelogSections(root.content, ecosystem), from, to, ecosystem).length > 0) return [root];

  const wanted = changelogIndexLinks(root.content, ecosystem).filter((link) =>
    withinRange(link.version, from, to, ecosystem),
  );
  if (wanted.length === 0) return [root];

  const documents = await Promise.all(
    // Newest first, so the cap keeps the releases nearest the target version.
    [...wanted]
      .sort((a, b) => compareRawVersions(b.version, a.version, ecosystem))
      .slice(0, maxDocuments)
      .map(async (link): Promise<FetchedDocument | null> => {
        const content = await fetchText(
          `https://raw.githubusercontent.com/${githubRepo}/${root.branch}/${link.path}`,
          { retries: 0 },
        );
        if (!content || !content.trim()) return null;
        return {
          path: link.path,
          url: `https://github.com/${githubRepo}/blob/${root.branch}/${link.path}`,
          content,
          branch: root.branch,
        };
      }),
  );

  const found = documents.filter((doc): doc is FetchedDocument => doc !== null);
  return found.length > 0 ? found : [root];
}

/**
 * Migration guides, including any the changelog index links to.
 *
 * The fixed-filename probe finds a guide at the root of the repository, which
 * is where most projects put one. Phaser's Phaser 3 → 4 guide lives at
 * `changelog/v4/4.0/MIGRATION-GUIDE.md`, reachable only by reading the index —
 * and it is the single most useful document for the upgrade it describes.
 */
export async function fetchMigrationGuides(
  githubRepo: string,
  branches: readonly string[] = ['main', 'master'],
): Promise<FetchedDocument[]> {
  const [direct, index] = await Promise.all([
    fetchMigrationGuide(githubRepo, branches),
    fetchChangelog(githubRepo, branches),
  ]);

  const guides = direct ? [direct] : [];
  if (!index) return guides;

  const linked = [...index.content.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)]
    .filter(([, text, href]) => MIGRATION_LINK.test(text!) || MIGRATION_LINK.test(href!))
    .map(([, , href]) => href!.replace(/^\.?\//, '').split('#')[0]!)
    .filter((path) => /\.(md|markdown|rst|txt)$/i.test(path) && !/^[a-z]+:/i.test(path));

  for (const path of [...new Set(linked)].slice(0, 4)) {
    if (guides.some((guide) => guide.path === path)) continue;
    const content = await fetchText(
      `https://raw.githubusercontent.com/${githubRepo}/${index.branch}/${path}`,
      { retries: 0 },
    );
    if (!content || !content.trim()) continue;
    guides.push({
      path,
      url: `https://github.com/${githubRepo}/blob/${index.branch}/${path}`,
      content,
      branch: index.branch,
    });
  }

  return guides;
}

const MIGRATION_LINK = /migrat|upgrad/i;

/** Is `version` inside `(from, to]`, in whichever direction the move goes? */
function withinRange(version: string, from: string, to: string, ecosystem: Ecosystem): boolean {
  const lower = parsePublishedVersion(from, ecosystem);
  const upper = parsePublishedVersion(to, ecosystem);
  const target = parsePublishedVersion(version, ecosystem);
  if (!lower || !upper || !target) return false;

  const direction = compareParsedVersions(upper, lower);
  if (direction === null) return false;
  const [lo, hi] = direction > 0 ? [lower, upper] : [upper, lower];
  const above = compareParsedVersions(target, lo);
  const atMost = compareParsedVersions(target, hi);
  return above !== null && atMost !== null && above > 0 && atMost <= 0;
}

/**
 * Split a changelog into per-version sections.
 *
 * Changelog formats are a zoo. Rather than trying to match a specific
 * convention, we look for any markdown heading containing something that
 * parses as a version and treat everything up to the next such heading as that
 * version's body. This handles Keep-a-Changelog, `## v1.2.3 (2024-01-01)`,
 * `## [1.2.3](link)`, and bare `# 1.2.3` alike.
 */
export function parseChangelogSections(content: string, ecosystem: Ecosystem = 'npm'): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const lines = content.split('\n');

  let current: { version: string; line: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,4})\s(.*)$/.exec(line);

    if (heading) {
      const version = extractVersion(heading[2]!.trimStart(), ecosystem);
      if (version) {
        if (current) {
          sections.push({ version: current.version, body: current.body.join('\n').trim(), line: current.line });
        }
        current = { version, line: i + 1, body: [] };
        continue;
      }
    }

    if (current) current.body.push(line);
  }

  if (current) {
    sections.push({ version: current.version, body: current.body.join('\n').trim(), line: current.line });
  }

  return sections;
}

/** Pull a semver-parseable version out of a heading, ignoring dates and links. */
function extractVersion(heading: string, ecosystem: Ecosystem): string | null {
  // Strip markdown link syntax so `## [1.2.3](url)` yields `1.2.3`.
  const text = heading.replace(/\[([^\]]{0,300})\]\([^)]{0,2000}\)/g, '$1');
  const candidates = text.match(/(?:\d+!)?v?\d+(?:\.\d+)+(?:[A-Za-z][0-9A-Za-z.-]*|[-+][\w.-]+)?/g) ?? [];
  for (const candidate of candidates) {
    const direct = parsePublishedVersion(candidate, ecosystem);
    if (direct) return direct.raw;
    if (candidate.startsWith('v')) {
      const stripped = parsePublishedVersion(candidate.slice(1), ecosystem);
      if (stripped) return stripped.raw;
    }
  }
  return null;
}

/**
 * Select the changelog sections covering `(from, to]`.
 *
 * The exclusive lower bound matters: the notes for the version you were
 * already on describe changes you already absorbed. Only what came after can
 * break you.
 */
export function sectionsBetween(
  sections: readonly ChangelogSection[],
  from: string,
  to: string,
  ecosystem: Ecosystem = 'npm',
): ChangelogSection[] {
  const lower = parsePublishedVersion(from, ecosystem);
  const upper = parsePublishedVersion(to, ecosystem);
  if (!lower || !upper) return [];

  // Downgrades: the relevant prose is what you are losing, i.e. (to, from].
  const direction = compareParsedVersions(upper, lower);
  if (direction === null) return [];
  const [lo, hi] = direction > 0 ? [lower, upper] : [upper, lower];

  return sections
    .filter((s) => {
      const version = parsePublishedVersion(s.version, ecosystem);
      if (!version) return false;
      const above = compareParsedVersions(version, lo);
      const atMost = compareParsedVersions(version, hi);
      return above !== null && atMost !== null && above > 0 && atMost <= 0;
    })
    .sort((a, b) => compareRawVersions(b.version, a.version, ecosystem));
}

function compareRawVersions(a: string, b: string, ecosystem: Ecosystem): number {
  const left = parsePublishedVersion(a, ecosystem);
  const right = parsePublishedVersion(b, ecosystem);
  return left && right ? (compareParsedVersions(left, right) ?? 0) : 0;
}

/**
 * Extract only the passages that discuss breakage.
 *
 * Feeding a whole major-version changelog downstream buries the signal. This
 * keeps headings that announce breaking changes plus any bullet whose text
 * carries a breakage marker, and drops the rest.
 */
export function extractBreakingPassages(body: string): string[] {
  const passages: string[] = [];
  const lines = body.split('\n');

  let inBreakingSection = false;
  let sectionDepth = 0;

  for (const line of lines) {
    const heading = /^(#{1,6})\s(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      const title = heading[2]!.trimStart();
      if (BREAKING_HEADING.test(title)) {
        inBreakingSection = true;
        sectionDepth = depth;
        passages.push(line.trim());
        continue;
      }
      // A heading at the same or shallower level closes the breaking section.
      if (inBreakingSection && depth <= sectionDepth) inBreakingSection = false;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (inBreakingSection) {
      passages.push(trimmed);
      continue;
    }

    if (isBreakingInline(trimmed)) passages.push(trimmed);
  }

  return dedupe(passages);
}

const PACKAGE_MODULE_SYSTEM =
  /\b(?:this|the)\s+(?:package|project|library|module)\s+(?:is\s+)?now\s+(?:pure\s+ESM|ESM[\s-]only|an?\s+ESM\s+package)\b|\b(?:migrated|converted|switched)\s+(?:this|the)\s+(?:package|project|library|module)\s+to\s+ESM\b|\b(?:dropped|removed)\s+CommonJS\s+support\b|\b(?:dropped|removed|no longer (?:supports|provides))\s+CommonJS\b|\bCommonJS\s+(?:is\s+)?no\s+longer\s+supported\b|\brequire\(\)\s+(?:is\s+)?no\s+longer\s+supported\b/i;

const BREAKING_HEADING =
  /breaking|incompatib|removed|migration|upgrade\s+guide|deprecat|commonjs/i;

/**
 * Inline breakage markers.
 *
 * The ESM and runtime-version clauses are here because they are the two most
 * consequential breaking changes in the modern JS ecosystem and neither is
 * phrased like an API change. A package going ESM-only breaks every CommonJS
 * consumer without renaming a single export, and maintainers announce it as a
 * statement of fact ("This package is now pure ESM") rather than as a warning.
 *
 * `required` is matched alongside `requires` for the same reason: real release
 * notes say "**Required Node.js >=14.16**", not "now requires Node.js".
 */
const BREAKING_INLINE =
  /\b(BREAKING(\s+CHANGE)?|breaking change|no longer|has been removed|have been removed|was removed|were removed|is removed|renamed to|renamed from|replaced by|replaced with|now requires?|required\s+node|must now|dropped support|drop support|removed support|is now required|are now required|moved to|deprecated in favou?r of|minimum\s+(?:supported\s+)?(?:node|python|go|ruby|java|rust))\b/i;

function isBreakingInline(text: string): boolean {
  return BREAKING_INLINE.test(text) || PACKAGE_MODULE_SYSTEM.test(text);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
