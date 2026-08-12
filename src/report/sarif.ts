import { describeMember } from '../detect/workspace.js';
import { RECOMMENDATION_LABEL } from '../rationale/assess.js';
import type { UpgradeRationale, Vulnerability } from '../rationale/types.js';
import { compareSeverity } from '../rationale/types.js';
import type { BreakingChange, DependencyChange, Ecosystem, ImpactSite, RemediationPlan } from '../types.js';
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
 * One alert per package, not per breaking change and not per occurrence: a
 * package with three breaking changes and two resolved advisories is one
 * alert with all five, listing every location any of its breaking changes
 * reach, not five. The earlier per-breaking-change design produced 347
 * alerts for a single outdated dependency in this very repository (zod 3 ->
 * 4 is a large rewrite; nearly all of those changes touched no code here) —
 * a flood, not a report. `ruleId` is `drift/<ecosystem>/<name>`: stable
 * across runs for the same package, which is what makes rescanning a
 * *replacement* rather than an accumulation — see the note on
 * `findingsFromPlan` below.
 *
 * `SarifFinding` is the intermediate: dependency-shaped and framework-free, so
 * it can be built from a push-triggered `RemediationPlan` (`findingsFromPlan`)
 * or from a scheduled outdated-dependency scan (`findingsFromCandidates`) and
 * rendered by the same `buildSarifLog`.
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

/** One alert: everything Drift found about a single package. */
export interface SarifFinding {
  /**
   * `drift/<ecosystem>/<name>` — stable across runs for the same package,
   * independent of which breaking changes or advisories it currently has.
   * That stability is what lets GitHub's own SARIF reconciliation do the
   * work: uploading a fresh SARIF log for the same `ref` updates this rule's
   * alert to the latest commit and finding set, and drops it entirely (marks
   * it "fixed") the run it stops appearing — no bookkeeping of Drift's own
   * needed to avoid piling up duplicate alerts across rescans.
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
  /** Shown as the alert's title in GitHub's UI. */
  title: string;
  /** The full alert body: what changed, every location it reaches, the evidence, and the fix. */
  message: string;
  /** At least one entry. `[0]` is the primary location GitHub anchors the alert to. */
  locations: SarifLocation[];
  fix?: SarifFix;
  helpUri?: string;
}

const TOOL_NAME = 'Drift';
const TOOL_URI = 'https://github.com/trydrift/drift';

/** How many locations actually ride along in the SARIF payload, per finding. */
const MAX_LOCATIONS_UPLOADED = 10;

/** Render a set of findings as a SARIF 2.1.0 log, ready to gzip and upload. */
export function buildSarifLog(findings: readonly SarifFinding[]): Record<string, unknown> {
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
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.level,
          message: { text: finding.message },
          locations: finding.locations.map((loc) => ({
            physicalLocation: {
              artifactLocation: { uri: loc.file },
              region: {
                startLine: Math.max(1, loc.line),
                ...(loc.excerpt ? { snippet: { text: loc.excerpt } } : {}),
              },
            },
          })),
          partialFingerprints: {
            driftFinding: finding.ruleId,
          },
        })),
      },
    ],
  };
}

/**
 * Findings from a push-triggered `RemediationPlan`: one alert per package
 * that moved, folding together every breaking change and every security fact
 * the rationale stage found for it.
 *
 * Each run uploads the *complete* current set of findings for the ref it
 * analysed (see `uploadCodeScanning` in `runners/action.ts`) rather than an
 * incremental diff. GitHub's code scanning API is built around exactly that
 * shape: for a given `(ref, category, tool)`, the newest upload is the
 * authoritative state — a `ruleId` present in it keeps (or opens) one alert,
 * updated to the latest commit; a `ruleId` that was open before and is
 * absent from the new upload is automatically marked fixed. Because `ruleId`
 * here is `drift/<ecosystem>/<name>` — stable across runs, not derived from
 * a specific breaking change — rescanning a package naturally replaces its
 * one alert rather than accumulating a new one alongside the old.
 */
export function findingsFromPlan(
  plan: RemediationPlan,
  opts: { includeInformational?: boolean; fixOf?: (change: DependencyChange) => SarifFix | undefined } = {},
): SarifFinding[] {
  const includeInformational = opts.includeInformational ?? true;
  const findings: SarifFinding[] = [];

  for (const change of plan.changes) {
    const breaking = plan.breakingChanges.filter(
      (b) => b.dependency === change.name && (b.workspace ?? '') === (change.workspace ?? ''),
    );
    // `UpgradeRationale` isn't workspace-qualified — see its definition — so
    // in the rare monorepo case of the same package at two versions across
    // members, this matches the first. Every other consumer of rationale has
    // the same limitation.
    const rationale = plan.rationale?.find((r) => r.dependency === change.name);

    if (breaking.length === 0 && !hasSecuritySignal(rationale) && !includeInformational) continue;
    if (breaking.length === 0 && !rationale) continue;

    const sites = plan.impactSites.filter((site) => breaking.some((b) => b.id === site.breakingChangeId));
    const commit = plan.commits.find((c) => breaking.some((b) => c.breakingChangeIds.includes(b.id)));

    findings.push(
      buildFinding({
        change,
        breaking,
        rationale,
        sites,
        evidence: plan.evidence,
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
 * One finding per dependency from a proactive outdated-dependency scan (see
 * `upgrade/scan.ts`, shared with `drift outdated`) — the check that runs on a
 * schedule rather than a push, over every currently installed version rather
 * than only the ones that just moved.
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

function buildFinding(args: {
  change: DependencyChange;
  breaking: BreakingChange[];
  rationale: UpgradeRationale | undefined;
  sites: ImpactSite[];
  evidence: RemediationPlan['evidence'];
  fix?: SarifFix;
}): SarifFinding {
  const { change, breaking, rationale, sites, evidence, fix } = args;
  const memberLabel = describeMember(change);
  const versionMove = change.to ? `${change.from ?? 'none'} → ${change.to}` : 'removed';

  const lines: string[] = [];
  lines.push(`**${change.name}** (${change.ecosystem}) — ${versionMove}`);
  lines.push(
    memberLabel ? `Found in: \`${change.manifestPath}\` (${memberLabel})` : `Found in: \`${change.manifestPath}\``,
  );

  if (breaking.length > 0) {
    lines.push('', `**Breaking changes (${breaking.length}):**`);
    for (const b of breaking) lines.push(`- ${b.summary} — confidence: ${b.confidence}`);

    if (sites.length > 0) {
      const shown = sites.slice(0, MAX_LOCATIONS_UPLOADED);
      const files = new Set(sites.map((s) => s.file));
      lines.push('', `**Appears in ${sites.length} location(s) across ${files.size} file(s):**`);
      for (const s of shown) lines.push(`- \`${s.file}:${s.line}\` — \`${s.excerpt.trim()}\``);
      if (sites.length > shown.length) lines.push(`- …and ${sites.length - shown.length} more.`);
    } else {
      lines.push('', 'No local usage was found to be affected by these changes.');
    }
  }

  if (rationale) {
    const sec = rationale.security;
    if (sec.checked) {
      if (sec.resolved.length > 0) {
        lines.push('', `**Resolves ${sec.resolved.length} advisory/advisories if upgraded:**`);
        for (const v of sec.resolved) lines.push(`- ${vulnerabilityLine(v)}`);
      }
      if (sec.introduced.length > 0) {
        lines.push('', `**Would introduce ${sec.introduced.length} new advisory/advisories:**`);
        for (const v of sec.introduced) lines.push(`- ${vulnerabilityLine(v)}`);
      }
      if (sec.current.length > 0) {
        lines.push('', `**Currently affected by ${sec.current.length} advisory/advisory(ies) at the installed version:**`);
        for (const v of sec.current) lines.push(`- ${vulnerabilityLine(v)}`);
      }
    }
    lines.push('', `Drift's assessment: **${RECOMMENDATION_LABEL[rationale.assessment.recommendation]}**.`);
    for (const reason of rationale.assessment.reasons) lines.push(`- ${reason}`);
  }

  lines.push('', fixLine(fix, breaking.length > 0));

  const locations: SarifLocation[] =
    sites.length > 0
      ? sites.slice(0, MAX_LOCATIONS_UPLOADED).map((s) => ({ file: s.file, line: s.line, excerpt: s.excerpt }))
      : [{ file: change.manifestPath, line: 1 }];

  return {
    ruleId: `drift/${change.ecosystem}/${change.name}`,
    ruleName: `${change.name}: dependency finding`,
    dependency: change.name,
    ecosystem: change.ecosystem,
    from: change.from,
    to: change.to,
    manifestPath: change.manifestPath,
    workspace: change.workspace,
    workspaceLabel: memberLabel,
    level: levelFor(breaking, rationale),
    title: `${change.name}: ${titleFor(breaking, rationale)}`,
    message: lines.join('\n'),
    locations,
    fix,
    helpUri: evidenceUrl(breaking, rationale, evidence),
  };
}

function titleFor(breaking: BreakingChange[], rationale: UpgradeRationale | undefined): string {
  if (breaking.length > 0) {
    return breaking.length === 1 ? breaking[0]!.summary : `${breaking.length} breaking changes found`;
  }
  const sec = rationale?.security;
  if (sec?.checked && sec.introduced.length > 0) return 'upgrade would introduce a known vulnerability';
  if (sec?.checked && sec.resolved.length > 0) return 'safe upgrade available, resolves a known vulnerability';
  if (sec?.checked && sec.current.length > 0) return 'currently affected by a known vulnerability';
  return 'dependency update available';
}

function levelFor(breaking: BreakingChange[], rationale: UpgradeRationale | undefined): SarifLevel {
  if (breaking.some((b) => b.confidence === 'high')) return 'error';

  const sec = rationale?.security;
  if (sec?.checked) {
    const worstCurrent = sec.current.length > 0 ? worstOf(sec.current) : undefined;
    const worstIntroduced = sec.introduced.length > 0 ? worstOf(sec.introduced) : undefined;
    if (worstCurrent === 'critical' || worstCurrent === 'high') return 'error';
    if (worstIntroduced === 'critical' || worstIntroduced === 'high') return 'error';
    if (worstCurrent || worstIntroduced) return 'warning';
  }

  if (breaking.some((b) => b.confidence === 'medium')) return 'warning';
  if (breaking.length > 0) return 'note';

  // Rationale-only: a resolvable advisory or a plain update is informational —
  // it costs nothing to leave open, unlike an unresolved one above.
  return 'note';
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

function evidenceUrl(
  breaking: BreakingChange[],
  rationale: UpgradeRationale | undefined,
  evidence: RemediationPlan['evidence'],
): string | undefined {
  const sec = rationale?.security;
  if (sec?.resolved[0]?.url) return sec.resolved[0].url;
  if (sec?.introduced[0]?.url) return sec.introduced[0].url;
  if (sec?.current[0]?.url) return sec.current[0].url;

  for (const change of breaking) {
    for (const citationId of change.citations) {
      const url = evidence.find((e) => e.id === citationId)?.url;
      if (url) return url;
    }
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
