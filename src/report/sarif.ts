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
 * The unit of an alert is one *locally actionable* finding, not one package.
 * A package can carry hundreds of upstream breaking changes — most upgrades
 * touch no code in a given repository at all — and dumping every one of them
 * into a single alert (or, worse, opening one alert per upstream change
 * regardless of whether it reaches this repository) is what turns the
 * Security tab into noise nobody reads. So:
 *
 *   - a breaking change becomes an alert only when it has at least one
 *     `ImpactSite` — code in *this* repository that actually calls the
 *     affected symbol. An upstream-only change never reaches SARIF; it is
 *     still visible in the job summary / PR body, where the full upstream
 *     count belongs.
 *   - each such alert is anchored to the highest-confidence site as its
 *     primary `location`; every other site the same change reaches rides
 *     along as a `relatedLocation` rather than inflating `locations[]`.
 *   - severity is upstream confidence *and* local confidence together: a
 *     proven upstream change with no confidently-matched local call site is
 *     a warning, not an error.
 *   - `ruleId` names the *kind* of finding (`drift/removed-export`,
 *     `drift/vulnerability`, ...), because that is what GitHub's rule
 *     descriptors are for — a category that changes rarely — not the
 *     package name, which would mint a new "rule" per dependency.
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
   * `drift/<finding-kind>` — the category of finding (a removed export, a
   * signature change, a vulnerability, an outdated dependency...), not the
   * package it was found in. Stable across every package that produces the
   * same kind of finding, which is what a SARIF rule descriptor is for.
   */
  ruleId: string;
  /** Human-readable rule name, shown in GitHub's rule/alert-type listing. */
  ruleName: string;
  dependency: string;
  ecosystem: Ecosystem;
  from: string | null;
  to: string | null;
  manifestPath: string;
  /** Workspace member directory this was found in, e.g. a monorepo subfolder. Absent in a single-package repo. */
  workspace?: string;
  workspaceLabel?: string | null;
  level: SarifLevel;
  /**
   * `result.message.text`. GitHub treats this as both the alert's title (its
   * first sentence, when space is constrained) and its full body — there is
   * no separate title field in SARIF, so the concise statement of what's
   * wrong comes first and the supporting detail follows it.
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
          message: { text: finding.message },
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
 * Findings from a push-triggered `RemediationPlan`.
 *
 * Each run uploads the *complete* current set of findings for the ref it
 * analysed (see `uploadCodeScanning` in `runners/action.ts`) rather than an
 * incremental diff. GitHub's code scanning API is built around exactly that
 * shape: for a given `(ref, category, tool)`, the newest upload is the
 * authoritative state — a finding present in it keeps (or opens) one alert,
 * updated to the latest commit; one that was open before and is absent from
 * the new upload is automatically marked fixed.
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

    let emittedAnything = false;

    for (const b of allBreaking) {
      const sites = plan.impactSites.filter((site) => site.breakingChangeId === b.id);
      if (sites.length === 0) continue; // upstream-only: no code here to point at.

      emittedAnything = true;
      const commit = plan.commits.find((c) => c.breakingChangeIds.includes(b.id));
      findings.push(
        buildBreakingFinding({
          change,
          breaking: b,
          upstreamCount: allBreaking.length,
          sites,
          evidence: plan.evidence,
          fix: opts.fixOf?.(change) ?? fixFromCommit(commit, plan),
        }),
      );
    }

    if (hasSecuritySignal(rationale)) {
      emittedAnything = true;
      findings.push(buildSecurityFinding({ change, rationale: rationale! }));
    }

    if (!emittedAnything && includeInformational && rationale) {
      findings.push(buildOutdatedFinding({ change, rationale, fix: opts.fixOf?.(change) }));
    }
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

/** `drift/<breaking-change-kind>` — the rule for one kind of upstream change. */
function ruleIdForBreaking(kind: BreakingChangeKind): string {
  return `drift/${kind}`;
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

function buildBreakingFinding(args: {
  change: DependencyChange;
  breaking: BreakingChange;
  upstreamCount: number;
  sites: ImpactSite[];
  evidence: RemediationPlan['evidence'];
  fix?: SarifFix;
}): SarifFinding {
  const { change, breaking, upstreamCount, sites, evidence, fix } = args;
  const memberLabel = describeMember(change);
  const versionMove = change.to ? `${change.from ?? 'none'} → ${change.to}` : 'removed';

  const sorted = [...sites].sort(
    (a, b) => rank(b.confidence) - rank(a.confidence) || a.file.localeCompare(b.file) || a.line - b.line,
  );
  const primary = sorted[0]!;
  const related = sorted.slice(1, 1 + MAX_RELATED_LOCATIONS);
  const localConfidence = primary.confidence;
  const files = new Set(sites.map((s) => s.file));

  const lines: string[] = [breaking.summary];
  lines.push(
    '',
    memberLabel
      ? `**${change.name}** (${change.ecosystem}) ${versionMove} — ${memberLabel}`
      : `**${change.name}** (${change.ecosystem}) ${versionMove}`,
  );
  lines.push(
    `Upstream confidence: ${breaking.confidence}. Local confidence: ${localConfidence}` +
      (sites.length > 1 ? ` (best of ${sites.length} matches across ${files.size} file(s)).` : '.'),
  );
  if (upstreamCount > 1) {
    lines.push('', `1 of ${upstreamCount} upstream breaking changes in ${change.name} that reach code here.`);
  }
  if (related.length > 0) {
    lines.push('', `**Also seen at:**`);
    for (const site of related) lines.push(`- \`${site.file}:${site.line}\``);
  }
  lines.push('', fixLine(fix, true));

  return {
    ruleId: ruleIdForBreaking(breaking.kind),
    ruleName: ruleNameForBreaking(breaking.kind),
    dependency: change.name,
    ecosystem: change.ecosystem,
    from: change.from,
    to: change.to,
    manifestPath: change.manifestPath,
    workspace: change.workspace,
    workspaceLabel: memberLabel,
    level: levelForBreaking(breaking.confidence, localConfidence),
    message: lines.join('\n'),
    primaryLocation: { file: primary.file, line: primary.line, excerpt: primary.excerpt },
    relatedLocations: related.map((s) => ({ file: s.file, line: s.line, excerpt: s.excerpt })),
    fix,
    helpUri: evidenceUrlForBreaking(breaking, evidence),
  };
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

function buildSecurityFinding(args: { change: DependencyChange; rationale: UpgradeRationale }): SarifFinding {
  const { change, rationale } = args;
  const sec = rationale.security;
  const memberLabel = describeMember(change);
  const versionMove = change.to ? `${change.from ?? 'none'} → ${change.to}` : 'removed';

  let title: string;
  let level: SarifLevel;
  const sections: string[] = [];

  if (sec.current.length > 0) {
    title = `${change.name} is currently affected by ${sec.current.length} known ${plural(sec.current.length, 'advisory', 'advisories')}`;
    const worst = worstOf(sec.current);
    level = worst === 'critical' || worst === 'high' ? 'error' : 'warning';
    sections.push(['**Currently affected:**', ...sec.current.map((v) => `- ${vulnerabilityLine(v)}`)].join('\n'));
  } else if (sec.introduced.length > 0) {
    title = `Upgrading ${change.name} to ${change.to} would introduce ${sec.introduced.length} new known ${plural(sec.introduced.length, 'advisory', 'advisories')}`;
    const worst = worstOf(sec.introduced);
    level = worst === 'critical' || worst === 'high' ? 'error' : 'warning';
  } else {
    title = `${change.name} ${change.to} resolves ${sec.resolved.length} known ${plural(sec.resolved.length, 'advisory', 'advisories')}`;
    level = 'note';
  }

  if (sec.introduced.length > 0) {
    sections.push(['**Would introduce:**', ...sec.introduced.map((v) => `- ${vulnerabilityLine(v)}`)].join('\n'));
  }
  if (sec.resolved.length > 0) {
    sections.push(['**Resolves:**', ...sec.resolved.map((v) => `- ${vulnerabilityLine(v)}`)].join('\n'));
  }

  const lines: string[] = [title];
  for (const section of sections) lines.push('', section);
  lines.push('', memberLabel ? `**${change.name}** (${change.ecosystem}) ${versionMove} — ${memberLabel}` : `**${change.name}** (${change.ecosystem}) ${versionMove}`);
  lines.push('', `Drift's assessment: **${RECOMMENDATION_LABEL[rationale.assessment.recommendation]}**.`);
  for (const reason of rationale.assessment.reasons) lines.push(`- ${reason}`);

  return {
    ruleId: 'drift/vulnerability',
    ruleName: 'Dependency vulnerability',
    dependency: change.name,
    ecosystem: change.ecosystem,
    from: change.from,
    to: change.to,
    manifestPath: change.manifestPath,
    workspace: change.workspace,
    workspaceLabel: memberLabel,
    level,
    message: lines.join('\n'),
    primaryLocation: { file: change.manifestPath, line: 1 },
    relatedLocations: [],
    helpUri: sec.current[0]?.url ?? sec.introduced[0]?.url ?? sec.resolved[0]?.url,
  };
}

function buildOutdatedFinding(args: {
  change: DependencyChange;
  rationale: UpgradeRationale;
  fix?: SarifFix;
}): SarifFinding {
  const { change, rationale, fix } = args;
  const memberLabel = describeMember(change);
  const versionMove = change.to ? `${change.from ?? 'none'} → ${change.to}` : 'removed';

  const lines: string[] = [
    `${change.name} has an update available (${versionMove}), with no breaking changes or advisories found.`,
    '',
    memberLabel
      ? `**${change.name}** (${change.ecosystem}) — ${memberLabel}`
      : `**${change.name}** (${change.ecosystem})`,
    '',
    fixLine(fix, false),
  ];

  return {
    ruleId: 'drift/outdated',
    ruleName: 'Outdated dependency',
    dependency: change.name,
    ecosystem: change.ecosystem,
    from: change.from,
    to: change.to,
    manifestPath: change.manifestPath,
    workspace: change.workspace,
    workspaceLabel: memberLabel,
    level: 'note',
    message: lines.join('\n'),
    primaryLocation: { file: change.manifestPath, line: 1 },
    relatedLocations: [],
    fix,
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
