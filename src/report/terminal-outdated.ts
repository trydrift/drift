/**
 * What `drift outdated` looks like.
 *
 * The command used to buffer everything and print it in one block at the end,
 * which meant a scan of a real repository showed nothing at all for minutes and
 * then dumped forty packages and their findings at once. Both halves of that
 * were wrong. A developer waiting has no way to tell work from a hang, and a
 * developer reading has no way to find the one row that matters in a wall of
 * paragraphs.
 *
 * So the output is procedural, in three movements, each of which is complete on
 * its own:
 *
 * 1. **The table**, printed as soon as the registries have answered — package,
 *    installed, wanted, latest, where it is declared. This is the `npm
 *    outdated` answer, it arrives in about the time `npm outdated` takes, and
 *    for many developers it is the whole reason they ran the command.
 * 2. **The verdicts**, one line each, as they land. Analysis takes as long as
 *    it takes; every line that appears is one package settled, and the status
 *    line underneath says what the rest are doing.
 * 3. **The report**, grouped by how much a developer has to care, with the
 *    evidence for anything that affects them and the exact command to act on it.
 *
 * The extension's dependency panel groups by the same severities, in the same
 * order, with the same words. Two surfaces onto one engine should not disagree
 * about what a scan found or what to call it.
 */

import type { UpgradeCandidate, UncheckedDependency } from '../upgrade/scan.js';
import { compareSeverity, describeSeverity, severityOf, type UpgradeSeverity } from '../upgrade/severity.js';
import type { StatusLine } from '../util/status-line.js';
import {
  displayWidth,
  padEnd,
  padStart,
  terminalWidth,
  truncate,
  type Palette,
  type GlyphName,
} from '../util/terminal.js';
import { registryUrl } from './registry-url.js';
import { confidenceDisplay } from './confidence.js';

/** How each severity is drawn: its glyph, its colour, and what it is called. */
interface Facade {
  glyph: GlyphName;
  style: 'red' | 'yellow' | 'green' | 'cyan' | 'gray' | 'brightRed';
  /** The heading its group gets in the final report. */
  heading: string;
  /** One line under the heading saying what the group means. */
  gloss: string;
}

/**
 * The groups, named the way the extension's panel names them.
 *
 * `heading` is `groupLabel` from `extension/src/ui/dependencies.ts`, word for
 * word. Two surfaces onto one engine must not invent two vocabularies for the
 * same verdict — somebody who has scanned in the panel and then runs the CLI
 * should recognise what they are reading, and "Affected" and "Affects your
 * code" are two names for one thing that a reader has to work out are the same.
 *
 * `gloss` is the CLI's own addition, and it is where the room a terminal has
 * and a tree view does not gets spent: a panel can afford a bare label because
 * the rows are one click from their evidence, and a report someone scrolls past
 * cannot.
 */
const FACADE: Record<UpgradeSeverity, Facade> = {
  affected: {
    glyph: 'affected',
    style: 'yellow',
    heading: 'Affected',
    gloss: 'These upgrades change an API this repository actually uses.',
  },
  'verification-failed': {
    glyph: 'failed',
    style: 'red',
    heading: 'Checks failed',
    gloss: "Installed for real; the project's own checks failed. Measured, not predicted.",
  },
  error: {
    glyph: 'failed',
    style: 'brightRed',
    heading: 'Failed',
    gloss: 'Something went wrong while checking these. They are not known to be safe.',
  },
  'upstream-only': {
    glyph: 'safe',
    style: 'green',
    heading: 'Safe',
    gloss: 'Breaking changes upstream, none of them on any API this repository uses.',
  },
  unchecked: {
    glyph: 'unknown',
    style: 'cyan',
    heading: 'Unchecked',
    gloss: 'Drift found nothing it could check these against. Not the same as safe.',
  },
  pending: {
    glyph: 'pending',
    style: 'gray',
    heading: 'Being checked',
    gloss: 'The scan ended before these settled.',
  },
  clean: {
    glyph: 'safe',
    style: 'green',
    heading: 'Safe',
    gloss: 'No breaking changes found for these versions.',
  },
};

/**
 * The order the report walks its groups in — what to act on first.
 *
 * Derived from `compareSeverity` rather than written out, because that function
 * is the one place this repository decides how much a developer should care,
 * and it is shared verbatim with the extension for exactly that reason. Two
 * hand-maintained orderings had already drifted apart: the panel led with
 * `affected` and the ranking agreed, while the list here led with
 * `verification-failed` — so the same scan put a different package at the top
 * depending on which surface you read it in.
 */
const GROUP_ORDER: readonly UpgradeSeverity[] = (
  Object.keys(FACADE) as UpgradeSeverity[]
).sort((a, b) => compareSeverity(exemplarOf(a), exemplarOf(b)));

/**
 * The smallest candidate `severityOf` would rank as `severity`.
 *
 * A way to ask `compareSeverity` about a severity directly: it takes candidates
 * because that is what every other caller has, and the ranking it applies is
 * private to it — which is the point, since a second copy of that table here is
 * precisely the drift being removed.
 */
function exemplarOf(severity: UpgradeSeverity): Parameters<typeof compareSeverity>[0] {
  const base = { status: 'ready', breakingCount: 0, impactCount: 0, impactFiles: 0, gaps: [] as string[] };
  switch (severity) {
    case 'affected':
      return { ...base, impactCount: 1 };
    case 'verification-failed':
      return { ...base, verification: { status: 'failed' } };
    case 'error':
      return { ...base, status: 'error' };
    case 'upstream-only':
      return { ...base, breakingCount: 1 };
    case 'unchecked':
      return { ...base, gaps: ['nothing to compare against'] };
    case 'pending':
      return { ...base, status: 'pending' };
    case 'clean':
      return { ...base, recommendation: 'safe-to-upgrade' };
  }
}

export interface OutdatedView {
  /** The banner naming what is being scanned. */
  start(repoLabel: string, workspace: string): void;
  /** The table of what is out of date, printed the moment lookups finish. */
  table(outdated: readonly UpgradeCandidate[], checked: number, upToDate: number): void;
  /** One settled package. Called as each verdict lands, in whatever order. */
  settled(candidate: UpgradeCandidate): void;
  /** The heading that introduces the analysis phase. */
  analysing(count: number): void;
  /** The dependencies no registry would answer for. */
  unchecked(deps: readonly UncheckedDependency[]): void;
  /** The grouped report, and what to run next. */
  report(candidates: readonly UpgradeCandidate[], selectorFor: (c: UpgradeCandidate) => string): void;
  /** Everything is current — the short, happy ending. */
  allCurrent(checked: number): void;
}

export function createOutdatedView(options: {
  palette: Palette;
  status: StatusLine;
  /** Whether the developer will be offered an upgrade prompt afterwards. */
  interactive: boolean;
  width?: number;
}): OutdatedView {
  const { palette: c, status } = options;
  const width = options.width ?? terminalWidth();
  const line = (text = ''): void => status.print(text);

  /**
   * `name` as a link to its registry page, where the terminal allows one.
   *
   * `linkOnly`, never `link`: every use of this is on a line whose width is
   * already spoken for, and appending a registry URL to each of forty rows
   * turns a table into a wall.
   */
  const packageLink = (candidate: UpgradeCandidate): string =>
    c.linkOnly(candidate.name, registryUrl(candidate.ecosystem, candidate.name) ?? '');

  /**
   * Which file declares this dependency.
   *
   * The manifest path rather than the workspace's package name, and it is the
   * repeated names that decide it: a monorepo lists `@types/node` three times,
   * and `package.json` / `site/package.json` / `extension/package.json` tells a
   * reader which row is which while three package names they have never seen do
   * not.
   */
  const where = (candidate: UpgradeCandidate): string => candidate.manifestPath;

  return {
    start(repoLabel, workspace) {
      line();
      line(`${c('bold', 'drift outdated')}  ${c('gray', repoLabel)}`);
      line(c('gray', workspace));
      line();
    },

    table(outdated, checked, upToDate) {
      const current = checked - outdated.length;
      line(
        `${c('bold', String(outdated.length))} of ${checked} direct dependenc${checked === 1 ? 'y' : 'ies'} ` +
          `${outdated.length === 1 ? 'has' : 'have'} a newer version` +
          (current > 0 ? c('gray', `  ${c.glyph('dot')}  ${upToDate} up to date`) : ''),
      );
      line();
      for (const row of renderTable(outdated, c, width)) line(row);
      line();
    },

    analysing(count) {
      line(
        c('gray',
          `Checking what ${count === 1 ? 'this upgrade' : `these ${count} upgrades`} would do to your code. ` +
            'Each line below is one package settled.'),
      );
      line();
    },

    settled(candidate) {
      const severity = severityOf(candidate);
      const facade = FACADE[severity];
      const versions = `${c('gray', candidate.current)} ${c.glyph('arrow')} ${c('bold', candidate.selected)}`;
      const label = `${c(facade.style, facade.glyph === 'safe' ? c.glyph('safe') : c.glyph(facade.glyph))} ${packageLink(candidate)}`;
      // The verdict, not the whole rationale: the paragraph belongs in the
      // report below, where it is next to the evidence that supports it. A
      // stream of paragraphs is unreadable while it is still moving.
      const verdict = c(facade.style, describeSeverity(candidate).split(' · ')[0] ?? '');
      const detail = describeSeverity(candidate).split(' · ').slice(1).join(' · ');
      line(
        `  ${label} ${versions}  ${verdict}` +
          (detail ? c('gray', ` ${c.glyph('dot')} ${detail}`) : ''),
      );
    },

    unchecked(deps) {
      if (deps.length === 0) return;
      line();
      // Before the verdicts, never after, and never folded into the up-to-date
      // count. "All 47 dependencies are current" when four of them could not be
      // reached is the single most misleading thing this command could say.
      line(
        c('cyan',
          `${c.glyph('unknown')} ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'} could not be checked` +
            ' — this is not the same as up to date'),
      );
      for (const dep of deps) {
        line(`  ${c('bold', dep.name)} ${c('gray', dep.current)} ${c('gray', `${c.glyph('dot')} ${dep.manifestPath}`)}`);
        line(c('gray', `    ${wrap(dep.reason, width - 4, '    ')}`));
      }
    },

    report(candidates, selectorFor) {
      const groups = new Map<UpgradeSeverity, UpgradeCandidate[]>();
      for (const candidate of candidates) {
        const severity = severityOf(candidate);
        // `clean` and `upstream-only` are one group on screen, exactly as they
        // are in the panel: both mean "take it", and splitting them asks a
        // reader to care about a distinction that changes nothing they do.
        const key = severity === 'upstream-only' ? 'clean' : severity;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(candidate);
      }

      line();
      line(c('gray', c.unicode ? '─'.repeat(Math.min(width, 72)) : '-'.repeat(Math.min(width, 72))));

      for (const severity of GROUP_ORDER) {
        const group = groups.get(severity);
        if (!group || group.length === 0) continue;
        const facade = FACADE[severity];
        line();
        line(`${c(facade.style, c.glyph(facade.glyph))} ${c('bold', facade.heading)} ${c('gray', `(${group.length})`)}`);
        line(c('gray', `  ${facade.gloss}`));
        line();

        // The groups a developer has to act on get their reasoning and their
        // evidence. The safe ones get a line each — the whole point of sorting
        // them here is that nobody has to read them.
        const detailed = severity === 'affected' || severity === 'verification-failed' || severity === 'error';
        // Aligned within the group rather than across the whole report: the
        // detailed groups do not use columns at all, so a shared width would be
        // set by names that are never printed beside these.
        const safeNameWidth = Math.max(...group.map((entry) => entry.name.length));
        const safeCurrentWidth = Math.max(...group.map((entry) => entry.current.length));
        const safeSelectedWidth = Math.max(...group.map((entry) => entry.selected.length));
        for (const candidate of group) {
          if (detailed) detailedEntry(candidate, line, c, width, selectorFor, packageLink, where);
          else
            line(
              `  ${padEnd(packageLink(candidate), safeNameWidth)}  ` +
                c('gray', padStart(candidate.current, safeCurrentWidth)) +
                c('gray', ` ${c.glyph('arrow')} `) +
                c('gray', padEnd(candidate.selected, safeSelectedWidth)) +
                c('gray', `  ${where(candidate)}`),
            );
        }
      }

      line();
      const actionable = (groups.get('affected')?.length ?? 0) + (groups.get('verification-failed')?.length ?? 0);
      const first = candidates.find((candidate) => severityOf(candidate) === 'affected') ?? candidates[0];
      if (first) {
        line(c('gray', `${c.glyph('dot')} Upgrade one:  ${c('cyan', `drift outdated --upgrade ${selectorFor(first)}`)}`));
      }
      if (actionable > 0) {
        line(c('gray', `${c.glyph('dot')} Apply the fixes and open a pull request:  ${c('cyan', 'drift fix')}`));
      }
      if (options.interactive && candidates.length > 0) line();
    },

    allCurrent(checked) {
      // "All 0 direct dependencies are up to date" is technically true and
      // reads as a bug. A directory with no dependencies has not been given a
      // clean bill of health; there was nothing to give one to, and the caller
      // says so on its own.
      if (checked === 0) return;
      line(
        `${c('green', c.glyph('safe'))} All ${checked} direct dependenc${checked === 1 ? 'y is' : 'ies are'} up to date.`,
      );
      line();
    },
  };
}

/**
 * One package a developer has to do something about.
 *
 * Deliberately more than a row: the sentence Drift arrived at, whichever of its
 * checks were run for real, the files it found, and the command that acts on
 * it. Anyone reading this group is deciding whether to spend an afternoon on an
 * upgrade, and a bare count is not enough to decide with.
 */
function detailedEntry(
  candidate: UpgradeCandidate,
  line: (text?: string) => void,
  c: Palette,
  width: number,
  selectorFor: (c: UpgradeCandidate) => string,
  packageLink: (c: UpgradeCandidate) => string,
  where: (c: UpgradeCandidate) => string,
): void {
  const target =
    candidate.selected === candidate.latest
      ? `${candidate.current} ${c.glyph('arrow')} ${candidate.selected}`
      : `${candidate.current} ${c.glyph('arrow')} ${candidate.selected} (latest ${candidate.latest})`;

  line(`  ${c('bold', packageLink(candidate))} ${c('gray', target)}`);
  line(c('gray', `    ${candidate.ecosystem} ${c.glyph('dot')} ${where(candidate)}`));
  if (candidate.summary) line(`    ${wrap(candidate.summary, width - 4, '    ')}`);

  for (const change of candidate.plan?.breakingChanges ?? []) {
    line(`    ${change.kind}`);
    line(`    ${confidenceDisplay(change).text}`);
    line(`    ${wrap(change.summary, width - 4, '    ')}`);
    line();
  }

  // What was actually run, and what it said. A prediction and a measurement
  // read identically on the page unless the page says which it is.
  const verification = candidate.verification;
  if (verification && verification.status !== 'skipped') {
    const passed = verification.checks.filter((check) => check.status === 'passed').map((check) => check.label);
    const failed = verification.checks.filter((check) => check.status === 'failed').map((check) => check.label);
    if (failed.length > 0) {
      line(`    ${c('red', `${c.glyph('failed')} ${failed.join(', ')} failed with this installed`)}`);
    }
    if (passed.length > 0) {
      line(c('gray', `    ${c.glyph('safe')} ${passed.join(', ')} passed with this installed`));
    }
  }

  // The files, not the count. "12 sites in 4 files" is a number; the four
  // paths are the thing someone opens next.
  const files = [...new Set((candidate.plan?.impactSites ?? []).map((site) => site.file))];
  if (files.length > 0) {
    const shown = files.slice(0, 5);
    for (const file of shown) {
      const sites = (candidate.plan?.impactSites ?? []).filter((site) => site.file === file);
      const first = sites[0];
      line(
        `    ${c('cyan', first ? `${file}:${first.line}` : file)}` +
          c('gray', sites.length > 1 ? `  (${sites.length} sites)` : ''),
      );
    }
    if (files.length > shown.length) {
      line(c('gray', `    and ${files.length - shown.length} more file${files.length - shown.length === 1 ? '' : 's'}`));
    }
  }

  // Where the claim came from. An upgrade report that cannot be checked is an
  // opinion, and the link is what makes it something else.
  const cited = (candidate.plan?.evidence ?? []).filter((entry) => entry.url).slice(0, 2);
  for (const entry of cited) {
    line(c('gray', `    ${c.glyph('dot')} ${c.link(truncate(entry.title, 70, c), entry.url!)}`));
  }

  line(c('gray', `    ${c('cyan', `drift outdated --upgrade ${selectorFor(candidate)}`)}`));
  line();
}

/**
 * The `npm outdated` table, because it is the table developers already know.
 *
 * Same columns in the same order — Package, Current, Wanted, Latest, Location —
 * and the same colour rule, which is the part that carries meaning: a `Wanted`
 * that differs from `Current` is an upgrade the declared range already permits,
 * and a `Latest` beyond `Wanted` is one that needs the range widened first.
 * Those are different amounts of work and the colours are how a reader tells
 * them apart at a glance.
 *
 * The one added column is `Impact`, left empty here and filled in by the
 * verdicts below it: this table is printed before anything has been analysed,
 * and a column of guesses would be worse than a column of blanks.
 */
function renderTable(rows: readonly UpgradeCandidate[], c: Palette, width: number): string[] {
  if (rows.length === 0) return [];

  const headers = ['Package', 'Current', 'Wanted', 'Latest', 'Declared in'];
  const cells = rows.map((row) => [
    row.name,
    row.current,
    // `safeLatest` is the newest release the manifest's own range allows —
    // exactly npm's "wanted". When there is none, the range forbids everything
    // newer, and saying so beats repeating the installed version as though it
    // were a choice.
    row.safeLatest ?? row.current,
    row.latest,
    row.manifestPath,
  ]);

  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...cells.map((row) => displayWidth(row[column] ?? ''))),
  );

  // The package name is the one column worth spending the terminal on, so it
  // absorbs the overflow rather than every column shrinking together into
  // uselessness.
  const total = widths.reduce((sum, w) => sum + w + 2, 0);
  if (total > width) widths[0] = Math.max(12, widths[0]! - (total - width));

  const out: string[] = [];
  out.push(
    c('gray',
      headers
        .map((header, column) => padEnd(header, widths[column]!))
        .join('  ')
        .trimEnd()),
  );

  for (const [index, row] of cells.entries()) {
    const candidate = rows[index]!;
    const inRange = row[2] !== row[1];
    const beyondRange = row[3] !== row[2];
    const url = registryUrl(candidate.ecosystem, candidate.name) ?? '';
    const name = truncate(row[0]!, widths[0]!, c);

    out.push(
      [
        padEnd(c.linkOnly(name, url), widths[0]!),
        c('gray', padStart(row[1]!, widths[1]!)),
        // Green when the range already allows it — a one-command upgrade.
        (inRange ? c('green', padStart(row[2]!, widths[2]!)) : c('gray', padStart(row[2]!, widths[2]!))),
        // Magenta when the newest release is outside the declared range, which
        // is npm's colour for the same fact and means "this one needs a
        // decision, not just an install".
        (beyondRange ? c('magenta', padStart(row[3]!, widths[3]!)) : c('gray', padStart(row[3]!, widths[3]!))),
        c('gray', row[4]!),
      ].join('  ').trimEnd(),
    );
  }

  return out;
}

/** Fold `text` to `width` columns, indenting every line after the first. */
export function wrap(text: string, width: number, indent = ''): string {
  if (width < 20) return text;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && displayWidth(current) + 1 + displayWidth(word) > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join(`\n${indent}`);
}
