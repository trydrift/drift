import { createHash } from 'node:crypto';
import { describeMember } from '../detect/workspace.js';
import { RECOMMENDATION_LABEL } from '../rationale/assess.js';
import type { UpgradeRationale, Vulnerability } from '../rationale/types.js';
import { compareSeverity } from '../rationale/types.js';
import type {
  BreakingChange,
  BreakingChangeKind,
  Confidence,
  DependencyChange,
  DependencyKind,
  Ecosystem,
  ImpactSite,
  RemediationPlan,
} from '../types.js';
import { upgradeCommandFor, type UpgradeCandidate } from '../upgrade/scan.js';

/**
 * Turning a Drift plan into GitHub code scanning alerts.
 *
 * CodeQL and OpenSSF Scorecard both land their findings here, and a team that
 * has come to trust that dashboard should not have to go somewhere else for
 * Drift's. This module is the seam: everything upstream of it already knows
 * the evidence, the location, and the fix (that's the whole plan/rationale
 * pipeline) — this only reshapes it into SARIF.
 *
 * The unit of an alert is one *package* — a dependency that moved, not each
 * individual breaking change it carries. A package can still carry hundreds
 * of upstream breaking changes — most upgrades touch no code in a given
 * repository at all — so dumping every one of them into a single alert
 * (or, worse, opening one alert per upstream change regardless of whether
 * it reaches this repository) is what turns the Security tab into noise
 * nobody reads. So:
 *
 *   - a breaking change is *listed* in its package's alert only when it has
 *     at least one `ImpactSite` — code in *this* repository that actually
 *     calls the affected symbol. An upstream-only change never reaches
 *     SARIF; it is still visible in the job summary / PR body, where the
 *     full upstream count belongs, and its existence is noted with a count
 *     inside the alert.
 *   - every locally-actionable issue for a package — each breaking change,
 *     plus any security signal — renders as its own block inside that one
 *     alert, one after another and separated by a rule, rather than folded
 *     into a single paragraph. A reader scanning the alert can tell exactly
 *     how many distinct things are wrong and where each one is.
 *   - the alert is anchored to the highest-confidence site among all its
 *     blocks as its primary `location`; every other site any block reaches
 *     rides along as a `relatedLocation` rather than inflating `locations[]`.
 *   - severity is the worst of every block's severity, and each block's own
 *     severity is upstream confidence *and* local confidence together: a
 *     proven upstream change with no confidently-matched local call site is
 *     a warning, not an error.
 *   - `ruleId` is `drift/<ecosystem>/<name>` — stable across runs for the
 *     same package, independent of which breaking changes or advisories it
 *     currently has. That stability is what makes rescanning a *replacement*
 *     rather than an accumulation: GitHub keeps or opens one alert per
 *     `ruleId` from the newest upload and marks a `ruleId` absent from it
 *     fixed, so a package alert updates in place instead of piling up.
 *   - the message carries both a `markdown` and a `text` rendering, since
 *     GitHub's alert body only renders formatting and links (including
 *     jump-to-file links) from `message.markdown` — `message.text` is a
 *     plain-text fallback for tools that don't read it.
 */

export type SarifLevel = 'error' | 'warning' | 'note';

/** What a reader can do right now about one finding. */
export interface SarifFix {
  /** One sentence: what taking the fix means. */
  description: string;
  /** The exact command that applies it, when Drift knows one. */
  command?: string;
  /** A pull request or approval issue Drift already opened for this. */
  url?: string;
}

/** One place a finding was seen. */
export interface SarifLocation {
  file: string;
  /** 1-indexed. */
  line: number;
  excerpt?: string;
}

/** One alert: one locally actionable finding. */
export interface SarifFinding {
  /**
   * `drift/<ecosystem>/<name>` — stable across runs for the same package,
   * independent of which breaking changes or advisories it currently has.
   * That stability is what lets GitHub's own SARIF reconciliation replace
   * this alert in place on every rescan instead of accumulating duplicates.
   */
  ruleId: string;
  /** Human-readable rule name, shown in GitHub's rule/alert-type listing. */
  ruleName: string;
  dependency: string;
  ecosystem: Ecosystem;
  /** `dependencies`, `devDependencies`, `optionalDependencies`, ... — which manifest section this was declared in. */
  dependencyKind: DependencyKind;
  from: string | null;
  to: string | null;
  manifestPath: string;
  /** Workspace member directory this was found in, e.g. a monorepo subfolder. Absent in a single-package repo. */
  workspace?: string;
  workspaceLabel?: string | null;
  level: SarifLevel;
  /**
   * Markdown source for `result.message.markdown` (GitHub renders this in
   * the alert body — bold, links, code spans) and, stripped, for
   * `result.message.text` (the plain-text fallback SARIF requires). GitHub
   * treats the first sentence as the alert's title when space is
   * constrained — there is no separate title field in SARIF — so the
   * concise statement of what's wrong comes first and the supporting detail
   * follows it.
   */
  message: string;
  /** The location GitHub anchors the alert to. */
  primaryLocation: SarifLocation;
  /** Every other place the same finding reaches. */
  relatedLocations: SarifLocation[];
  fix?: SarifFix;
  helpUri?: string;
}

const TOOL_NAME = 'Drift';
const TOOL_URI = 'https://github.com/trydrift/drift';

/** How many extra locations ride along as `relatedLocations`, per finding. */
const MAX_RELATED_LOCATIONS = 9;

/**
 * Render a set of findings as a SARIF 2.1.0 log, ready to gzip and upload.
 *
 * `category` becomes `runAutomationDetails.id`. It must be distinct between
 * the push-triggered diff scan and the scheduled outdated-dependency scan:
 * without it, GitHub has no way to tell that an upload from one mode is not
 * meant to replace the other's result set, and the two would fight over
 * which findings are "current" on every run.
 */
export function buildSarifLog(findings: readonly SarifFinding[], category?: string): Record<string, unknown> {
  const rules = new Map<string, { id: string; name: string; helpUri?: string }>();
  for (const finding of findings) {
    if (!rules.has(finding.ruleId)) {
      rules.set(finding.ruleId, {
        id: finding.ruleId,
        name: finding.ruleName,
        ...(finding.helpUri ? { helpUri: finding.helpUri } : {}),
      });
    }
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            informationUri: TOOL_URI,
            rules: [...rules.values()].map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: rule.name },
              fullDescription: {
                text: `A Drift finding: what changed, where it's used, and the fix — see the alert body.`,
              },
              helpUri: rule.helpUri ?? TOOL_URI,
              defaultConfiguration: { level: 'warning' },
              properties: { tags: ['dependencies', 'drift'] },
            })),
          },
        },
        ...(category ? { automationDetails: { id: category } } : {}),
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.level,
          message: { text: stripMarkdown(finding.message), markdown: finding.message },
          locations: [toSarifPhysicalLocation(finding.primaryLocation)],
          ...(finding.relatedLocations.length > 0
            ? {
                relatedLocations: finding.relatedLocations.map((loc, i) => ({
                  id: i + 1,
                  ...toSarifPhysicalLocation(loc),
                })),
              }
            : {}),
          partialFingerprints: {
            primaryLocationLineHash: lineHash(finding),
          },
        })),
      },
    ],
  };
}

/**
 * `result.message.markdown` is what GitHub actually renders in the alert
 * body — `result.message.text` is a required plain-text fallback for tools
 * that don't read markdown. Rather than maintain two parallel renderings of
 * every finding, everything above builds one markdown string and this
 * derives the fallback from it: strip the syntax, keep the words.
 */
function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1');
}

/** A markdown link from a `file:line` reference to that line in the repo. */
function mdLink(file: string, line: number): string {
  return `[\`${file}:${line}\`](${file}#L${line})`;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  scala: 'scala',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
};

function languageForFile(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase();
  return (ext && LANGUAGE_BY_EXTENSION[ext]) ?? '';
}

/**
 * One occurrence, rendered as its own fenced code snippet rather than a bare
 * link — GitHub only turns a `relatedLocations` reference into an inline
 * snippet for the alert's single primary location; every other site a link
 * jumps you to is just a hyperlink with nothing shown in the alert body
 * itself. Embedding the excerpt directly in the markdown is the only way to
 * show what's actually at each occurrence without leaving the alert.
 */
function siteSnippet(loc: SarifLocation, linkId: number | undefined): string {
  const label = linkId !== undefined ? `[\`${loc.file}:${loc.line}\`](${linkId})` : mdLink(loc.file, loc.line);
  if (!loc.excerpt) return label;
  return `${label}\n\`\`\`${languageForFile(loc.file)}\n${loc.excerpt}\n\`\`\``;
}

function toSarifPhysicalLocation(loc: SarifLocation): Record<string, unknown> {
  return {
    physicalLocation: {
      artifactLocation: { uri: loc.file },
      region: {
        startLine: Math.max(1, loc.line),
        ...(loc.excerpt ? { snippet: { text: loc.excerpt } } : {}),
      },
    },
  };
}

/**
 * A content-based fingerprint, so the same finding reconciles across runs
 * even when unrelated edits shift its line number by a line or two.
 *
 * GitHub only reads `primaryLocationLineHash` out of `partialFingerprints`
 * for result tracking — a `ruleId`-only fingerprint (the previous approach
 * here) is silently ignored. Uploading through the REST API directly, rather
 * than through `github/codeql-action/upload-sarif`, means Drift does not get
 * one generated for it automatically either.
 */
function lineHash(finding: SarifFinding): string {
  const basis = `${finding.ruleId}|${finding.primaryLocation.file}|${(finding.primaryLocation.excerpt ?? '').trim()}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

/**
 * Findings from a push-triggered `RemediationPlan`: one alert per package,
 * folding every locally-actionable breaking change and every security
 * signal found for it into that one alert as its own block.
 *
 * Each run uploads the *complete* current set of findings for the ref it
 * analysed (see `uploadCodeScanning` in `runners/action.ts`) rather than an
 * incremental diff. GitHub's code scanning API is built around exactly that
 * shape: for a given `(ref, category, tool)`, the newest upload is the
 * authoritative state — a `ruleId` present in it keeps (or opens) one alert,
 * updated to the latest commit; a `ruleId` that was open before and is
 * absent from the new upload is automatically marked fixed. Because
 * `ruleId` here is `drift/<ecosystem>/<name>` — stable across runs, not
 * derived from a specific breaking change — rescanning a package naturally
 * replaces its one alert in place rather than accumulating a new one
 * alongside the old.
 */
export function findingsFromPlan(
  plan: RemediationPlan,
  opts: { includeInformational?: boolean; fixOf?: (change: DependencyChange) => SarifFix | undefined } = {},
): SarifFinding[] {
  const includeInformational = opts.includeInformational ?? false;
  const findings: SarifFinding[] = [];

  for (const change of plan.changes) {
    const allBreaking = plan.breakingChanges.filter(
      (b) => b.dependency === change.name && (b.workspace ?? '') === (change.workspace ?? ''),
    );
    // `UpgradeRationale` isn't workspace-qualified — see its definition — so
    // in the rare monorepo case of the same package at two versions across
    // members, this matches the first. Every other consumer of rationale has
    // the same limitation.
    const rationale = plan.rationale?.find((r) => r.dependency === change.name);

    const blocks: FindingBlock[] = [];
    let upstreamOnlyCount = 0;

    const sortedBreaking = [...allBreaking].sort((a, b) => rank(b.confidence) - rank(a.confidence));
    for (const b of sortedBreaking) {
      const sites = plan.impactSites.filter((site) => site.breakingChangeId === b.id);
      if (sites.length === 0) {
        upstreamOnlyCount++; // upstream-only: no code here to point at.
        continue;
      }
      blocks.push(buildBreakingBlock(b, sites, plan.evidence));
    }

    if (hasSecuritySignal(rationale)) blocks.push(buildSecurityBlock(rationale!));

    if (blocks.length === 0) {
      if (!includeInformational || !rationale) continue;
      blocks.push(buildOutdatedBlock(change, rationale));
    }

    const commit = plan.commits.find((c) => allBreaking.some((b) => c.breakingChangeIds.includes(b.id)));
    findings.push(
      buildPackageFinding({
        change,
        blocks,
        upstreamOnlyCount,
        fix: opts.fixOf?.(change) ?? fixFromCommit(commit, plan),
      }),
    );
  }

  return findings;
}

function hasSecuritySignal(rationale: UpgradeRationale | undefined): boolean {
  if (!rationale) return false;
  const s = rationale.security;
  return s.checked && (s.resolved.length > 0 || s.introduced.length > 0 || s.current.length > 0);
}

/**
 * One dependency's worth of findings from a proactive outdated-dependency
 * scan (see `upgrade/scan.ts`, shared with `drift outdated`) — the check
 * that runs on a schedule rather than a push, over every currently installed
 * version rather than only the ones that just moved.
 *
 * Each candidate already carries its own single-dependency `RemediationPlan`
 * (`scanUpgrades` builds one per package it can reach a verdict on), so this
 * is `findingsFromPlan` run once per candidate — with one addition: a
 * candidate with no breaking changes has no commits, and therefore no fix
 * `findingsFromPlan` would describe on its own. The exact upgrade command
 * fills that gap, so "safe to upgrade" alerts still say what to run.
 */
export function findingsFromCandidates(
  candidates: readonly UpgradeCandidate[],
  opts: { includeInformational?: boolean } = {},
): SarifFinding[] {
  const findings: SarifFinding[] = [];

  for (const candidate of candidates) {
    if (!candidate.plan) continue;

    const fixOf = (): SarifFix | undefined => {
      if (candidate.plan!.commits.length > 0) return undefined;
      const command = upgradeCommandFor(candidate);
      if (!command) return undefined;
      return {
        description:
          candidate.breakingCount > 0
            ? 'The upstream API changed, but no code in this repository was found to use the affected parts. Review before upgrading.'
            : 'Safe to upgrade — no breaking changes found.',
        command,
      };
    };

    findings.push(...findingsFromPlan(candidate.plan, { ...opts, fixOf }));
  }

  return findings;
}

const RULE_NAMES: Record<BreakingChangeKind, string> = {
  'removed-export': 'Removed export used in this repository',
  'renamed-export': 'Renamed export used in this repository',
  'moved-export': 'Export moved to a different module',
  'signature-change': 'Call signature changed',
  'type-change': 'Type changed in a breaking way',
  'behaviour-change': 'Runtime behaviour changed',
  'removed-endpoint': 'API endpoint removed',
  'changed-endpoint': 'API endpoint changed',
  'required-field-added': 'New required field',
  'default-change': 'Default value changed',
  'config-change': 'Configuration shape changed',
  'runtime-requirement': 'Runtime requirement changed',
  unknown: 'Unclassified breaking change',
};

function ruleNameForBreaking(kind: BreakingChangeKind): string {
  return RULE_NAMES[kind] ?? 'Breaking change';
}

export const DEPENDENCY_KIND_LABELS: Record<DependencyKind, string> = {
  runtime: 'dependency',
  dev: 'devDependency',
  peer: 'peerDependency',
  optional: 'optionalDependency',
  transitive: 'transitive dependency',
};

function dependencyKindLabel(kind: DependencyKind): string {
  return DEPENDENCY_KIND_LABELS[kind] ?? kind;
}

/**
 * One locally-actionable issue's worth of alert content: a package's alert
 * is the concatenation of these, each rendered on its own and separated by
 * a rule, so a reader sees every distinct issue in turn rather than one
 * paragraph with everything folded together.
 */
interface FindingBlock {
  level: SarifLevel;
  /** Markdown lines for this block alone; joined with `\n` by the caller. */
  lines: string[];
  /** The location this block would anchor an alert to, if it were its own. */
  primaryCandidate?: SarifLocation;
  relatedCandidates: SarifLocation[];
  helpUri?: string;
}

const LEVEL_RANK: Record<SarifLevel, number> = { error: 2, warning: 1, note: 0 };

function worstLevel(levels: readonly SarifLevel[]): SarifLevel {
  return levels.reduce<SarifLevel>((worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst), 'note');
}

function buildBreakingBlock(breaking: BreakingChange, sites: ImpactSite[], evidence: RemediationPlan['evidence']): FindingBlock {
  const sorted = [...sites].sort(
    (a, b) => rank(b.confidence) - rank(a.confidence) || a.file.localeCompare(b.file) || a.line - b.line,
  );
  const primary = sorted[0]!;
  const related = sorted.slice(1, 1 + MAX_RELATED_LOCATIONS);
  const localConfidence = primary.confidence;
  const files = new Set(sites.map((s) => s.file));
  const helpUri = evidenceUrlForBreaking(breaking, evidence);

  const lines: string[] = [
    `**${ruleNameForBreaking(breaking.kind)}:** ${linkSymbols(breaking.summary, helpUri)}`,
    '',
    `Upstream confidence: ${breaking.confidence}. Local confidence: ${localConfidence}` +
      (sites.length > 1 ? ` (best of ${sites.length} matches across ${files.size} file(s)).` : '.'),
  ];
  // The declaration itself, before and after — the actual evidence for the
  // claim above. `helpUri` alone used to stand in for this and pointed at the
  // *current* published declaration file, which shows nothing about what
  // changed; a reader had to diff two CDN files by hand to see it.
  if (breaking.before && breaking.after && breaking.before !== breaking.after) {
    lines.push('', '```diff', `- ${truncate(breaking.before, 300)}`, `+ ${truncate(breaking.after, 300)}`, '```');
  }
  if (helpUri) lines.push('', `Declaration source: ${helpUri}`);

  return {
    level: levelForBreaking(breaking.confidence, localConfidence),
    lines,
    primaryCandidate: { file: primary.file, line: primary.line, excerpt: primary.excerpt },
    relatedCandidates: related.map((s) => ({ file: s.file, line: s.line, excerpt: s.excerpt })),
    helpUri,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Wraps every backtick-quoted symbol name in `text` with a markdown link to
 * `url`, when one is known — the upstream commit, changelog, or diff that is
 * the actual evidence for the claim being made about that symbol. Without
 * this, the only place the evidence link appeared was `helpUri` metadata,
 * which GitHub surfaces as a separate "show more" affordance rather than
 * inline next to the symbol it's evidence for.
 */
function linkSymbols(text: string, url: string | undefined): string {
  if (!url) return text;
  return text.replace(/`([^`]+)`/g, (_match, symbol: string) => `[\`${symbol}\`](${url})`);
}

/**
 * Upstream confidence and local confidence together, not upstream alone.
 *
 * A proven upstream change (Drift computed the diff itself) that only
 * loosely matches a call site in this repository is worth a warning, not an
 * error — the error level is reserved for the case both dimensions agree.
 */
function levelForBreaking(upstream: Confidence, local: Confidence): SarifLevel {
  if (upstream === 'high' && local === 'high') return 'error';
  if (upstream === 'high' || local === 'high') return 'warning';
  if (upstream === 'medium' && local === 'medium') return 'warning';
  return 'note';
}

function rank(confidence: Confidence): number {
  return confidence === 'high' ? 2 : confidence === 'medium' ? 1 : 0;
}

function buildSecurityBlock(rationale: UpgradeRationale): FindingBlock {
  const sec = rationale.security;

  let title: string;
  let level: SarifLevel;
  const sections: string[] = [];

  if (sec.current.length > 0) {
    title = `Currently affected by ${sec.current.length} known ${plural(sec.current.length, 'advisory', 'advisories')}`;
    const worst = worstOf(sec.current);
    level = worst === 'critical' || worst === 'high' ? 'error' : 'warning';
    sections.push(['**Currently affected:**', ...sec.current.map((v) => `- ${vulnerabilityLine(v)}`)].join('\n'));
  } else if (sec.introduced.length > 0) {
    title = `Upgrading would introduce ${sec.introduced.length} new known ${plural(sec.introduced.length, 'advisory', 'advisories')}`;
    const worst = worstOf(sec.introduced);
    level = worst === 'critical' || worst === 'high' ? 'error' : 'warning';
  } else {
    title = `Resolves ${sec.resolved.length} known ${plural(sec.resolved.length, 'advisory', 'advisories')}`;
    level = 'note';
  }

  if (sec.introduced.length > 0) {
    sections.push(['**Would introduce:**', ...sec.introduced.map((v) => `- ${vulnerabilityLine(v)}`)].join('\n'));
  }
  if (sec.resolved.length > 0) {
    sections.push(['**Resolves:**', ...sec.resolved.map((v) => `- ${vulnerabilityLine(v)}`)].join('\n'));
  }

  const lines: string[] = [`**${title}**`];
  for (const section of sections) lines.push('', section);
  lines.push('', `Drift's assessment: **${RECOMMENDATION_LABEL[rationale.assessment.recommendation]}**.`);
  for (const reason of rationale.assessment.reasons) lines.push(`- ${reason}`);

  return {
    level,
    lines,
    relatedCandidates: [],
    helpUri: sec.current[0]?.url ?? sec.introduced[0]?.url ?? sec.resolved[0]?.url,
  };
}

function buildOutdatedBlock(change: DependencyChange, rationale: UpgradeRationale): FindingBlock {
  const versionMove = change.to ? `${change.from ?? 'none'} → ${change.to}` : 'removed';
  void rationale;
  return {
    level: 'note',
    lines: [`**Update available** (${versionMove}), with no breaking changes or advisories found.`],
    relatedCandidates: [],
  };
}

/**
 * Fold every locally-actionable block found for one package into the single
 * alert GitHub sees for it: the worst level and every location among them,
 * with each block's own markdown appended in turn.
 */
function buildPackageFinding(args: {
  change: DependencyChange;
  blocks: FindingBlock[];
  upstreamOnlyCount: number;
  fix?: SarifFix;
}): SarifFinding {
  const { change, blocks, upstreamOnlyCount, fix } = args;
  const memberLabel = describeMember(change);
  const versionMove = change.to ? `${change.from ?? 'none'} → ${change.to}` : 'removed';
  const hasBreaking = blocks.some((b) => b.primaryCandidate);

  const kindLabel = dependencyKindLabel(change.kind);
  const header: string[] = [
    memberLabel
      ? `**${change.name}** (${change.ecosystem} ${kindLabel}) ${versionMove} — ${memberLabel}`
      : `**${change.name}** (${change.ecosystem} ${kindLabel}) ${versionMove}`,
  ];
  if (upstreamOnlyCount > 0) {
    header.push(
      '',
      `${upstreamOnlyCount} additional upstream breaking ${plural(upstreamOnlyCount, 'change does', 'changes do')} not reach code in this repository and ${plural(upstreamOnlyCount, 'is', 'are')} omitted here.`,
    );
  }

  const primary = blocks.find((b) => b.primaryCandidate)?.primaryCandidate ?? { file: change.manifestPath, line: 1 };
  const relatedSeen = new Set([`${primary.file}:${primary.line}`]);
  const related: SarifLocation[] = [];
  for (const block of blocks) {
    const candidates = block.primaryCandidate ? [block.primaryCandidate, ...block.relatedCandidates] : block.relatedCandidates;
    for (const loc of candidates) {
      const key = `${loc.file}:${loc.line}`;
      if (relatedSeen.has(key)) continue;
      relatedSeen.add(key);
      related.push(loc);
      if (related.length >= MAX_RELATED_LOCATIONS) break;
    }
    if (related.length >= MAX_RELATED_LOCATIONS) break;
  }

  // `related`'s array order is exactly the order `buildSarifLog` assigns
  // `relatedLocations[].id` in (1-indexed) — this map lets every occurrence's
  // label still deep-link to that id (GitHub's jump-to-file affordance) while
  // the fenced snippet below it, built from the site's own excerpt, is what
  // actually shows the code inline instead of making a reader click through.
  const relatedIds = new Map(related.map((loc, i) => [`${loc.file}:${loc.line}`, i + 1]));
  const linkIdFor = (loc: SarifLocation): number | undefined => relatedIds.get(`${loc.file}:${loc.line}`);

  const body = [
    header.join('\n'),
    ...blocks.map((b) => {
      if (!b.primaryCandidate) return b.lines.join('\n');
      const seenAt = [
        'Seen at:',
        siteSnippet(b.primaryCandidate, linkIdFor(b.primaryCandidate)),
        ...b.relatedCandidates.map((loc) => siteSnippet(loc, linkIdFor(loc))),
      ];
      return [...b.lines, '', seenAt.join('\n\n')].join('\n');
    }),
    fixLine(fix, hasBreaking),
  ].join('\n\n---\n\n');

  return {
    ruleId: `drift/${change.ecosystem}/${change.name}`,
    ruleName: `${change.name}: dependency finding`,
    dependency: change.name,
    ecosystem: change.ecosystem,
    dependencyKind: change.kind,
    from: change.from,
    to: change.to,
    manifestPath: change.manifestPath,
    workspace: change.workspace,
    workspaceLabel: memberLabel,
    level: worstLevel(blocks.map((b) => b.level)),
    message: body,
    primaryLocation: primary,
    relatedLocations: related,
    fix,
    helpUri: blocks.find((b) => b.helpUri)?.helpUri,
  };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function worstOf(vs: Vulnerability[]): Vulnerability['severity'] {
  return vs.reduce<Vulnerability['severity']>(
    (worst, v) => (compareSeverity(v.severity, worst) < 0 ? v.severity : worst),
    'unknown',
  );
}

function vulnerabilityLine(v: Vulnerability): string {
  const fixed = v.fixedIn ? `, fixed in ${v.fixedIn}` : '';
  return `[${v.id}](${v.url}) (${v.severity}${fixed}): ${v.summary}`;
}

function evidenceUrlForBreaking(breaking: BreakingChange, evidence: RemediationPlan['evidence']): string | undefined {
  for (const citationId of breaking.citations) {
    const url = evidence.find((e) => e.id === citationId)?.url;
    if (url) return url;
  }
  return undefined;
}

function fixFromCommit(
  commit: RemediationPlan['commits'][number] | undefined,
  plan: RemediationPlan,
): SarifFix | undefined {
  if (!commit) return undefined;
  const deterministic = (commit.codemod?.length ?? 0) > 0;
  const recipe = (commit.recipe?.length ?? 0) > 0;
  if (deterministic) {
    return {
      description: `Deterministic fix available: "${commit.message}". Drift can commit this itself once approved.`,
    };
  }
  if (recipe) {
    return {
      description: `A pinned community recipe resolves this: "${commit.message}". Enable \`remediation.communityRecipes\` in drift.yml to let Drift apply it.`,
    };
  }
  return {
    description:
      plan.risk === 'none'
        ? `No deterministic fix; comment \`/drift apply\` on Drift's approval issue for this plan to dispatch GitHub Copilot.`
        : `No deterministic fix, and this plan carries risk: \`${plan.risk}\`. Review the plan Drift filed, then comment \`/drift apply\` to dispatch a fix.`,
  };
}

/** Human-readable line describing the fix, appended to every alert body. */
function fixLine(fix: SarifFix | undefined, hasBreaking: boolean): string {
  if (fix?.url) return `**Fix:** ${fix.description} → ${fix.url}`;
  if (fix?.command) return `**Fix:** ${fix.description} Run: \`${fix.command}\``;
  if (fix) return `**Fix:** ${fix.description}`;
  return hasBreaking
    ? '**Fix:** Drift did not produce a plan for this finding — see the workflow run for why.'
    : '**Fix:** No action required; this is informational.';
}
