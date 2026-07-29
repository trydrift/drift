import semver from 'semver';
import { normalizeVersion } from '../detect/version.js';
import { fetchText } from '../util/http.js';

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
  'docs/CHANGELOG.md',
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
): Promise<FetchedDocument | null> {
  return probe(githubRepo, CHANGELOG_FILENAMES, branches);
}

export async function fetchMigrationGuide(
  githubRepo: string,
  branches: readonly string[] = ['main', 'master'],
): Promise<FetchedDocument | null> {
  return probe(githubRepo, MIGRATION_FILENAMES, branches);
}

async function probe(
  githubRepo: string,
  filenames: readonly string[],
  branches: readonly string[],
): Promise<FetchedDocument | null> {
  for (const branch of branches) {
    for (const filename of filenames) {
      const url = `https://raw.githubusercontent.com/${githubRepo}/${branch}/${filename}`;
      const content = await fetchText(url, { retries: 0 });
      if (content && content.trim()) {
        return {
          path: filename,
          url: `https://github.com/${githubRepo}/blob/${branch}/${filename}`,
          content,
        };
      }
    }
  }
  return null;
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
export function parseChangelogSections(content: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const lines = content.split('\n');

  let current: { version: string; line: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);

    if (heading) {
      const version = extractVersion(heading[2]!);
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
function extractVersion(heading: string): string | null {
  // Strip markdown link syntax so `## [1.2.3](url)` yields `1.2.3`.
  const text = heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)\b/.exec(text);
  if (!match) return null;
  return normalizeVersion(match[1]!);
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
): ChangelogSection[] {
  const lower = normalizeVersion(from);
  const upper = normalizeVersion(to);
  if (!lower || !upper) return [];

  // Downgrades: the relevant prose is what you are losing, i.e. (to, from].
  const [lo, hi] = semver.gt(upper, lower) ? [lower, upper] : [upper, lower];

  return sections
    .filter((s) => {
      const v = normalizeVersion(s.version);
      return v !== null && semver.gt(v, lo) && semver.lte(v, hi);
    })
    .sort((a, b) => semver.rcompare(normalizeVersion(a.version)!, normalizeVersion(b.version)!));
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
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      const title = heading[2]!;
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

    if (BREAKING_INLINE.test(trimmed)) passages.push(trimmed);
  }

  return dedupe(passages);
}

const BREAKING_HEADING =
  /breaking|incompatib|removed|migration|upgrade\s+guide|deprecat|pure esm|esm[\s-]only|commonjs/i;

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
  /\b(BREAKING(\s+CHANGE)?|breaking change|no longer|has been removed|have been removed|was removed|were removed|is removed|renamed to|renamed from|replaced by|replaced with|now requires?|required\s+node|must now|dropped support|drop support|removed support|is now required|are now required|moved to|deprecated in favou?r of|pure ESM|ESM[\s-]only|now ESM|dropped CommonJS|no longer (?:supports|provides) CommonJS|minimum\s+(?:supported\s+)?(?:node|python|go|ruby|java|rust))\b/i;

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
