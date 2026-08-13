import type { BreakingChange, ImpactSite } from '../types.js';

/**
 * The one-click "file this" action offered wherever Drift shows a breaking
 * change — content-only. Everything here is pure and side-effect free on
 * purpose: the CLI's interactive prompt and the VS Code extension's report
 * webview each drive their own git/`gh`/Octokit calls (different runtimes,
 * different credentials), but both need the exact same title, body, marker,
 * and branch name for the same finding. Building that text in one place is
 * what keeps an issue filed from the terminal indistinguishable from one
 * filed by clicking a button in the editor.
 */

export type IssueBranchAction = 'issue' | 'branch' | 'both';
export type IssueBranchScope = 'change' | 'package';

/** One or more breaking changes bundled into a single issue/branch. */
export interface IssueBranchTarget {
  dependency: string;
  /**
   * The changes this target files. When `impactSites` was supplied to
   * `groupForAction`, this is only the ones that reach code in this
   * repository — see `groupForAction` for why, and `upstreamOnlyCount` for
   * what was left out.
   */
  changes: readonly BreakingChange[];
  /** Impact sites for `changes`, when known — one issue's worth of "where". */
  impactSites?: readonly ImpactSite[];
  /**
   * Breaking changes in this dependency that `groupForAction` folded out of
   * `changes` because no code in this repository calls the affected API.
   * Zero when every change in the group reaches this repo, or when nothing
   * does and `changes` fell back to the full unfiltered group.
   */
  upstreamOnlyCount?: number;
  /** `https://github.com/<owner>/<repo>/blob/<sha>` — for linking impact-site locations. */
  repoBlobUrl?: string;
}

/**
 * Group breaking changes for the action's scope.
 *
 * `'package'` folds every finding for one dependency into a single target,
 * matching `codeScanning.granularity`'s `'package'` mode. `'change'` gives
 * each finding its own target, one per element of `changes` — used when the
 * action is triggered from an individual row rather than a group header.
 *
 * When `impactSites` is supplied, a `'package'` target only *files* the
 * breaking changes that actually reach code in this repository — the same
 * rule `report/sarif.ts` applies to code-scanning alerts, and for the same
 * reason: a major upgrade can carry hundreds of upstream breaking changes
 * while touching none of this repository's code, and an issue that dumps
 * every one of them is unreadable noise nobody asked for by clicking "file
 * this". The rest are folded into `upstreamOnlyCount` rather than dropped
 * silently. A group with no locally-reaching changes at all falls back to
 * filing everything unfiltered — better an issue that says "upstream only"
 * than a button click that visibly does nothing.
 */
export function groupForAction(
  changes: readonly BreakingChange[],
  scope: IssueBranchScope,
  impactSites: readonly ImpactSite[] = [],
): IssueBranchTarget[] {
  const sitesFor = (id: string) => impactSites.filter((site) => site.breakingChangeId === id);

  if (scope === 'change') {
    return changes.map((change) => ({
      dependency: change.dependency,
      changes: [change],
      impactSites: sitesFor(change.id),
    }));
  }

  const byDependency = new Map<string, BreakingChange[]>();
  for (const change of changes) {
    const list = byDependency.get(change.dependency);
    if (list) list.push(change);
    else byDependency.set(change.dependency, [change]);
  }
  return [...byDependency.entries()].map(([dependency, grouped]) => {
    const affecting = grouped.filter((change) => sitesFor(change.id).length > 0);
    const included = affecting.length > 0 ? affecting : grouped;
    return {
      dependency,
      changes: included,
      impactSites: included.flatMap((change) => sitesFor(change.id)),
      upstreamOnlyCount: affecting.length > 0 ? grouped.length - affecting.length : 0,
    };
  });
}

/**
 * A hidden HTML-comment marker embedded in every issue this feature files,
 * mirroring `codeScanning.createIssuesPerAlert`'s dedup marker
 * (`src/runners/action.ts`). Content-derived from the target's dependency
 * and finding ids, so re-triggering the same action always looks up the
 * same marker and finds the issue it already filed rather than piling up
 * duplicates.
 */
export function issueMarker(target: IssueBranchTarget): string {
  const ids = [...target.changes.map((change) => change.id)].sort().join(',');
  return `drift-issue:${target.dependency}:${ids}`;
}

export interface IssueContent {
  title: string;
  body: string;
  labels: string[];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * GitHub's `createIssue` GraphQL mutation rejects a body over 65536
 * characters outright — no truncation, just a hard failure — and the
 * `gh`-not-available fallback stuffs the same body into an `issues/new`
 * query string, which breaks long before that on URL-length limits. Capped
 * well under both so a package-scope target with dozens of changes degrades
 * to "some changes omitted" instead of failing to file anything at all.
 */
const MAX_BODY_CHARS = 8000;

/**
 * GitHub's real hard cap (see `MAX_BODY_CHARS`'s comment), kept as a ceiling
 * for the collapsed "more changes" section below. That section is
 * `<details>`-hidden by default, so it costs nothing visually — there is no
 * reason to fall back to a bare one-liner per change there just because the
 * visible-by-default budget above was hit. Margin under the real 65536 is
 * for `trailer`, which must survive intact.
 */
const HARD_BODY_CHARS = 60000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * Wraps every backtick-quoted symbol name in `text` with a markdown link to
 * `url`, mirroring the same helper in `report/sarif.ts` — the evidence for a
 * claim about a symbol belongs right next to it, not off in a separate
 * "sources" section nobody clicks through to.
 */
function linkSymbols(text: string, url: string | undefined): string {
  if (!url) return text;
  return text.replace(/`([^`]+)`/g, (_match, symbol: string) => `[\`${symbol}\`](${url})`);
}

/** A link to the exact repo line an impact site was found at — see `report/sarif.ts`'s `mdLink`. */
function mdLink(site: ImpactSite, repoBlobUrl: string | undefined): string {
  const href = repoBlobUrl ? `${repoBlobUrl}/${site.file}#L${site.line}` : `${site.file}#L${site.line}`;
  return `[\`${site.file}:${site.line}\`](${href})`;
}

const MAX_SITES_LISTED = 10;

/** Drops any "Before: ..." / "After: ..." lines — see `changeSection`'s `hasDiff` branch. */
function stripLabelledBeforeAfter(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(before|after):/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One change's worth of issue body, in the same voice as a code-scanning
 * alert (`report/sarif.ts`'s `buildBreakingBlock`): a linked summary,
 * inline-code before/after rather than a fenced block, and remediation
 * capped at a sentence or two — not the full diff and rationale verbatim,
 * which is what let a handful of changes blow past GitHub's body limit.
 *
 * `sites` are this change's own impact sites, listed underneath it — the
 * actual answer to "where does this break in my code", which used to be
 * nowhere in the issue at all.
 */
function changeSection(change: BreakingChange, sites: readonly ImpactSite[], repoBlobUrl: string | undefined): string {
  const lines = [`**${linkSymbols(change.summary, change.sourceUrl)}**`];

  const hasDiff = Boolean(change.before && change.after && change.before !== change.after);
  if (change.before && change.after && change.before !== change.after) {
    lines.push(
      '',
      `- \`${truncate(change.before, 300)}\``,
      `+ \`${truncate(change.after, 300)}\``,
    );
  }

  // The AI's own remediation prose often restates the same before/after as a
  // "Before: ...\nAfter: ..." pair, unformatted, right below the diff two
  // lines up — a second, worse-rendered copy of what's already shown. Strip
  // it rather than show the same fact twice in two different voices.
  const remediation = hasDiff ? stripLabelledBeforeAfter(change.remediation) : change.remediation;
  lines.push('', truncate(remediation, 400));

  if (sites.length > 0) {
    const shown = sites.slice(0, MAX_SITES_LISTED);
    const rest = sites.slice(shown.length);
    // GitHub issue bodies render `<details>`, so the rest of the sites are
    // one click away instead of a dead-end count with nowhere to go.
    const tail =
      rest.length > 0
        ? `<details><summary>and ${rest.length} more ${plural(rest.length, 'place', 'places')}</summary>\n\n${rest
            .map((site) => `- ${mdLink(site, repoBlobUrl)}`)
            .join('\n')}\n\n</details>`
        : '';
    lines.push('', `Used at: ${shown.map((site) => mdLink(site, repoBlobUrl)).join(', ')}${tail ? `\n${tail}` : ''}`);
  }

  if (change.sourceUrl) lines.push('', `Source: ${change.sourceUrl}`);

  return lines.join('\n');
}

/** Deterministic branch name for a target, safe as a git ref component. */
export function branchNameFor(target: IssueBranchTarget): string {
  if (target.changes.length === 1) {
    return `drift/${slugify(target.dependency)}/${slugify(target.changes[0]!.id)}`;
  }
  return `drift/${slugify(target.dependency)}`;
}

/**
 * The issue's title and body for a target, optionally linking to a branch
 * already created for the same finding(s) — the `'both'` action's contract.
 */
export function buildIssueContent(target: IssueBranchTarget, linkedBranch?: string): IssueContent {
  const title =
    target.changes.length === 1
      ? `Drift: ${target.dependency} — ${target.changes[0]!.summary}`
      : `Drift: ${target.dependency} — ${target.changes.length} breaking changes`;

  const impactSites = target.impactSites ?? [];
  const files = new Set(impactSites.map((site) => site.file)).size;
  const upstreamOnlyCount = target.upstreamOnlyCount ?? 0;

  // The headline states where this actually bites, not how many upstream
  // changes exist — a target that made it through `groupForAction`'s filter
  // is here because it reaches this repository's code, and that's the fact
  // worth leading with. The all-upstream fallback (no impact sites at all,
  // `groupForAction` filed everything unfiltered) gets its own honest
  // framing instead of claiming an impact that was never found.
  const intro =
    impactSites.length > 0
      ? `Upgrading **${target.dependency}** will affect your code in ${impactSites.length} ${plural(impactSites.length, 'place', 'places')} across ${files} ${plural(files, 'file', 'files')}.`
      : `Drift flagged ${target.changes.length === 1 ? 'a breaking change' : `${target.changes.length} breaking changes`} in **${target.dependency}**, upstream — none of them matched code in this repository, but they're listed here in case the analysis missed something.`;

  const trailer = [
    upstreamOnlyCount > 0
      ? `${upstreamOnlyCount} additional upstream breaking ${plural(upstreamOnlyCount, 'change does', 'changes do')} not reach code in this repository and ${plural(upstreamOnlyCount, 'is', 'are')} omitted here.`
      : undefined,
    linkedBranch ? `Tracking branch: \`${linkedBranch}\`` : undefined,
    `<!-- ${issueMarker(target)} -->`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n\n');

  // Fold in sections until the next one would breach the budget, then note
  // how many were left out rather than let the whole issue fail to file —
  // reserving room for `trailer`, which must survive (it carries the dedup
  // marker every future run depends on) even when every change doesn't.
  const budget = MAX_BODY_CHARS - intro.length - trailer.length - 20;
  const included: string[] = [];
  const omitted: BreakingChange[] = [];
  let used = 0;
  for (const change of target.changes) {
    const sites = impactSites.filter((site) => site.breakingChangeId === change.id);
    const section = changeSection(change, sites, target.repoBlobUrl);
    const cost = section.length + 4;
    if (used + cost > budget && included.length > 0) {
      omitted.push(change);
      continue;
    }
    included.push(section);
    used += cost;
  }

  const bodyParts = [intro, ...included];
  if (omitted.length > 0) {
    // Collapsed, not diminished: the same before/after, remediation, and
    // impact sites as the sections above — just tucked behind a click so the
    // visible body stays short. Only the truly excessive case (bumping the
    // real GitHub body cap even collapsed) falls back to a one-liner.
    const detailBudget = HARD_BODY_CHARS - bodyParts.join('\n\n').length - trailer.length - 200;
    const detailSections: string[] = [];
    let detailUsed = 0;
    let cutoff = omitted.length;
    for (let i = 0; i < omitted.length; i++) {
      const change = omitted[i]!;
      const sites = impactSites.filter((site) => site.breakingChangeId === change.id);
      const section = changeSection(change, sites, target.repoBlobUrl);
      const cost = section.length + 8;
      if (detailUsed + cost > detailBudget) {
        cutoff = i;
        break;
      }
      detailSections.push(section);
      detailUsed += cost;
    }
    const remainder = omitted.slice(cutoff);
    const remainderNote =
      remainder.length > 0
        ? `\n\n${remainder.length} additional ${plural(remainder.length, 'change', 'changes')} not shown, even collapsed, to stay under GitHub's body limit:\n${remainder
            .map((change) => `- ${linkSymbols(change.summary, change.sourceUrl)}`)
            .join('\n')}`
        : '';
    bodyParts.push(
      `<details><summary>${omitted.length} more ${plural(omitted.length, 'change', 'changes')} not shown above</summary>\n\n${detailSections.join('\n\n---\n\n')}${remainderNote}\n\n</details>`,
    );
  }
  bodyParts.push(trailer);

  return {
    title,
    body: bodyParts.join('\n\n'),
    labels: ['drift', `drift:${target.dependency}`],
  };
}

/**
 * What the action did, in terms a caller can act on without inspecting an
 * error object. Mirrors `GhPullRequestOutcome`'s discriminated-union shape
 * (`extension/src/gh.ts`): every reason the action could not run is named,
 * so the CLI and the extension can both fail soft — a log line or a
 * dismissable toast, never a thrown error.
 */
export type IssueBranchOutcome =
  | { kind: 'issue'; status: 'created' | 'existing'; number: number; url: string }
  | { kind: 'branch'; status: 'created' | 'existing'; name: string }
  | {
      kind: 'unavailable';
      reason: 'no-git-repo' | 'no-remote' | 'gh-not-installed' | 'gh-not-authenticated' | 'no-token';
    }
  | { kind: 'failed'; message: string };
