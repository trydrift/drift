/**
 * Turning a wall of compiler output into something worth putting in a prompt.
 *
 * After a major upgrade the project's own typecheck is the single most valuable
 * signal available about what actually broke — it is ground truth, it costs
 * nothing, and it names exact files and lines. It is also enormous and almost
 * entirely repetition: one root cause routinely prints two hundred errors, and
 * a TypeScript 5 → 7 bump can produce more output than the agent's entire
 * context budget.
 *
 * Handing an agent the last forty lines is the obvious compression and the
 * wrong one, because the tail of a compiler run is alphabetically last, not
 * most important. Handing it everything is worse: the real breakage drowns in
 * two hundred copies of a single missing type definition, and the model spends
 * its attention on the loudest problem rather than the actual one.
 *
 * So the output is grouped by what is really the same error, each group is
 * reported once with a count and a few concrete examples, and anything landing
 * on a file the upgrade was already known to affect is ranked first. What comes
 * out is a page, not a book, and it says "one problem, 187 times" where the raw
 * output said the same thing 187 times without ever saying it once.
 */

export interface DiagnosticSite {
  file: string;
  line: number;
  column?: number;
  message: string;
}

export interface DiagnosticGroup {
  /** Compiler code, e.g. `TS2591`. Empty when the tool does not emit one. */
  code: string;
  /** The message with its varying parts blanked, which is what defines a group. */
  template: string;
  /** Occurrences, truncated for display. `total` is the real count. */
  sites: DiagnosticSite[];
  /**
   * How many occurrences there really were.
   *
   * Held separately because `sites` is truncated, and counting a truncated list
   * would under-report — the one direction that matters, since the count is the
   * whole argument for treating a group as a single root cause.
   */
  total: number;
  /** Distinct files this group touches. */
  files: string[];
  /**
   * The identifiers that varied within the group — the `process`, `Buffer` and
   * `console` of "Cannot find name '…'".
   *
   * This is the part that makes a collapsed group still actionable: without it
   * "187 × Cannot find name" names no name at all.
   */
  subjects: string[];
  /** Whether this lands on a file the upgrade was already known to affect. */
  focused: boolean;
}

/**
 * The marker a clean typecheck leaves in the digest handed to the fix flow.
 *
 * Both the sentence the developer reads and the check `clearedByCompiler`
 * makes are built from this one constant, so "the compiler said nothing is
 * wrong" cannot come to mean two different things in two files. Rewording the
 * prose around it is free; changing this line is a deliberate act.
 */
export const CLEAN_TYPECHECK_MARKER = 'reports no errors at all';

export interface DiagnosticsDigest {
  /** Total parsed diagnostics, before any grouping. */
  total: number;
  /** Distinct files with at least one diagnostic. */
  fileCount: number;
  groups: DiagnosticGroup[];
  /** Groups left out of `groups` by the budget. */
  omittedGroups: number;
  /** Diagnostics inside those omitted groups. */
  omittedDiagnostics: number;
  /**
   * True when nothing in the output looked like a diagnostic.
   *
   * The caller then falls back to the raw tail rather than claiming a clean
   * run: a tool this cannot parse has still failed, and saying nothing about
   * why would be worse than saying it unparsed.
   */
  unparsed: boolean;
}

export interface DigestOptions {
  /**
   * Files the upgrade's evidence already pointed at.
   *
   * Their groups sort first. A diagnostic on a file Drift independently proved
   * was affected is far more likely to be the breakage being fixed than one in
   * a corner of the repository the upgrade never touched.
   */
  focusFiles?: readonly string[];
  maxGroups?: number;
  maxSitesPerGroup?: number;
}

const DEFAULT_MAX_GROUPS = 12;
const DEFAULT_MAX_SITES = 3;

/**
 * `path(12,5): error TS2591: message`, which is what `tsc` prints by default,
 * and `path:12:5 - error TS2591: message`, which is what it prints with
 * `--pretty` disabled in some versions. Both appear in the wild in the same
 * repository depending on how the script invokes the compiler.
 */
const TSC_PAREN = /^(?<file>[^\s(][^(]*?)\((?<line>\d+),(?<col>\d+)\):\s*(?:error|warning)\s+(?<code>[A-Z]+\d+):\s*(?<message>.+)$/;
const TSC_COLON = /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?<col>\d+)\s*-\s*(?:error|warning)\s+(?<code>[A-Z]+\d+):\s*(?<message>.+)$/;
/** Generic `path:line:col: message`, which covers eslint's unix formatter and friends. */
const GENERIC = /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?<col>\d+):?\s+(?:error|warning)?:?\s*(?<message>.+)$/;

export function parseDiagnostics(output: string): DiagnosticSite[] {
  const sites: DiagnosticSite[] = [];

  for (const raw of output.split(/\r?\n/)) {
    const line = stripAnsi(raw).trimEnd();
    if (!line.trim()) continue;

    const match = TSC_PAREN.exec(line) ?? TSC_COLON.exec(line) ?? GENERIC.exec(line);
    if (!match?.groups) continue;

    const parsed = Number(match.groups.line);
    if (!Number.isFinite(parsed)) continue;

    const code = match.groups.code ?? '';
    sites.push({
      file: match.groups.file!.trim(),
      line: parsed,
      column: Number(match.groups.col) || undefined,
      message: code ? `${code}: ${match.groups.message!.trim()}` : match.groups.message!.trim(),
    });
  }

  return sites;
}

export function digestDiagnostics(output: string, options: DigestOptions = {}): DiagnosticsDigest {
  const sites = parseDiagnostics(output);
  const maxGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS;
  const maxSites = options.maxSitesPerGroup ?? DEFAULT_MAX_SITES;

  if (sites.length === 0) {
    return { total: 0, fileCount: 0, groups: [], omittedGroups: 0, omittedDiagnostics: 0, unparsed: true };
  }

  const focus = new Set((options.focusFiles ?? []).map(normalizePath));
  const byKey = new Map<string, DiagnosticGroup>();

  for (const site of sites) {
    const { code, template, subjects } = shapeOf(site.message);
    const key = `${code}|${template}`;
    let group = byKey.get(key);
    if (!group) {
      group = { code, template, sites: [], total: 0, files: [], subjects: [], focused: false };
      byKey.set(key, group);
    }

    group.sites.push(site);
    group.total += 1;
    if (!group.files.includes(site.file)) group.files.push(site.file);
    for (const subject of subjects) {
      if (!group.subjects.includes(subject)) group.subjects.push(subject);
    }
    if (focus.has(normalizePath(site.file))) group.focused = true;
  }

  // Files the upgrade was proved to affect first; then the biggest groups,
  // because a group of two hundred is one root cause worth naming, not two
  // hundred problems worth listing.
  const ranked = [...byKey.values()].sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    return b.total - a.total;
  });

  const kept = ranked.slice(0, maxGroups);
  const dropped = ranked.slice(maxGroups);

  return {
    total: sites.length,
    fileCount: new Set(sites.map((site) => site.file)).size,
    groups: kept.map((group) => ({ ...group, sites: exemplars(group.sites, maxSites) })),
    omittedGroups: dropped.length,
    omittedDiagnostics: dropped.reduce((sum, group) => sum + group.total, 0),
    unparsed: false,
  };
}

/**
 * A few sites that show the spread of a group rather than the top of its list.
 *
 * Taking the first N gave three copies of the same file and line, because a
 * single line commonly produces several diagnostics — which reads as though the
 * problem occurs in one place, the opposite of what a count of sixty means. One
 * per file first, then fill from what is left.
 */
function exemplars(sites: readonly DiagnosticSite[], limit: number): DiagnosticSite[] {
  const chosen: DiagnosticSite[] = [];
  const seenLocation = new Set<string>();
  const seenFile = new Set<string>();

  for (const site of sites) {
    const location = `${site.file}:${site.line}`;
    if (seenLocation.has(location) || seenFile.has(site.file)) continue;
    seenLocation.add(location);
    seenFile.add(site.file);
    chosen.push(site);
    if (chosen.length === limit) return chosen;
  }

  for (const site of sites) {
    const location = `${site.file}:${site.line}`;
    if (seenLocation.has(location)) continue;
    seenLocation.add(location);
    chosen.push(site);
    if (chosen.length === limit) break;
  }

  return chosen;
}

/**
 * What varies inside a message, blanked out so two of the same error group.
 *
 * The quoted identifiers are the whole point: `Cannot find name 'process'` and
 * `Cannot find name 'Buffer'` are one problem reported twice, and keeping the
 * names as `subjects` means collapsing them loses the count, not the content.
 *
 * Each quote style is matched against its own kind. A character class that lets
 * a `'` open a span and a `"` close it looks equivalent and is not: TypeScript
 * writes types like `'typeof import("typescript")'`, and the loose version
 * pairs the wrong delimiters, producing subjects such as `typeof import(` and
 * leaving the rest of the message in the template — which then splits one
 * problem into a dozen near-identical groups, the exact failure this is for.
 */
function shapeOf(message: string): { code: string; template: string; subjects: string[] } {
  const codeMatch = /^([A-Z]+\d+):\s*(.+)$/.exec(message);
  const code = codeMatch?.[1] ?? '';
  const body = codeMatch?.[2] ?? message;

  const subjects: string[] = [];
  const capture = (subject: string): string => {
    const cleaned = shortenPaths(subject);
    if (cleaned) subjects.push(cleaned);
    return "'…'";
  };

  const template = body
    // No length cap. A quoted span left in place because it was "too long" is a
    // module path, and module paths are precisely what differ between machines
    // — keeping one would group by checkout directory.
    .replace(/'([^']*)'/g, (_match, subject: string) => capture(subject))
    .replace(/"([^"]*)"/g, (_match, subject: string) => capture(subject))
    .replace(/`([^`]*)`/g, (_match, subject: string) => capture(subject))
    // Numbers vary between otherwise-identical messages ("expected 2 arguments,
    // but got 3"), and grouping on them would defeat the point.
    .replace(/\b\d+\b/g, '…')
    // Two adjacent blanks are one blank as far as grouping is concerned.
    .replace(/(?:'…'\s*)+'…'/g, "'…'")
    .replace(/\s+/g, ' ')
    .trim();

  return { code, template, subjects };
}

/**
 * An absolute path reduced to the part that identifies it.
 *
 * `/Users/someone/checkout/node_modules/typescript/lib/version` is the same
 * module as `/build/ci/node_modules/typescript/lib/version`, and reporting
 * either in full spends a line of the budget on a directory layout.
 */
function shortenPaths(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return '';
  if (!trimmed.includes('/')) return trimmed;

  const fromModules = /node_modules\/(.+)$/.exec(trimmed);
  if (fromModules) return fromModules[1]!;
  if (trimmed.startsWith('/')) return trimmed.split('/').slice(-2).join('/');
  return trimmed;
}

/**
 * The digest as prompt text.
 *
 * Written for a model rather than a reader: it leads with the count so the
 * model can weigh a group before reading it, and says outright that a large
 * uniform group is usually one cause. An agent given two hundred identical
 * errors and no framing reliably starts fixing them one at a time.
 */
export function renderDigest(
  digest: DiagnosticsDigest,
  context: { label: string; rawTail?: string },
): string {
  if (digest.unparsed) {
    const tail = (context.rawTail ?? '').trim();
    if (!tail) return '';
    return [
      `### \`${context.label}\``,
      '',
      'Drift could not parse this tool\'s output into individual diagnostics, so this is the tail of it verbatim:',
      '',
      '```',
      tail,
      '```',
    ].join('\n');
  }

  const lines: string[] = [
    `### \`${context.label}\``,
    '',
    `${digest.total} diagnostic${digest.total === 1 ? '' : 's'} across ${digest.fileCount} file${
      digest.fileCount === 1 ? '' : 's'
    }, which reduce to ${digest.groups.length + digest.omittedGroups} distinct problem${
      digest.groups.length + digest.omittedGroups === 1 ? '' : 's'
    }.`,
    '',
    'Counts matter here: a problem reported hundreds of times is almost always',
    'one root cause, and fixing it once fixes every occurrence. Work out what is',
    'shared before editing any individual site.',
    '',
  ];

  for (const [index, group] of digest.groups.entries()) {
    const total = group.total;
    const heading = [
      `${index + 1}. `,
      group.code ? `**${group.code}** ` : '',
      group.template,
      ` — ${total} occurrence${total === 1 ? '' : 's'} in ${group.files.length} file${group.files.length === 1 ? '' : 's'}`,
      group.focused ? ' *(on a file this upgrade was proved to affect)*' : '',
    ].join('');
    lines.push(heading);

    if (group.subjects.length > 0) {
      const shown = group.subjects.slice(0, 12).join(', ');
      lines.push(
        `   Affecting: ${shown}${group.subjects.length > 12 ? `, and ${group.subjects.length - 12} more` : ''}`,
      );
    }

    for (const site of group.sites) {
      lines.push(`   ${site.file}:${site.line}`);
    }
    lines.push('');
  }

  if (digest.omittedGroups > 0) {
    lines.push(
      `Plus ${digest.omittedGroups} smaller problem${digest.omittedGroups === 1 ? '' : 's'} (${
        digest.omittedDiagnostics
      } diagnostic${digest.omittedDiagnostics === 1 ? '' : 's'}) not listed. Re-run \`${context.label}\` yourself to see them.`,
      '',
    );
  }

  return lines.join('\n');
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Anchored on the escape character, so bracketed prose like `[1]` survives. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
