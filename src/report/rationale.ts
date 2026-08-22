import type { RemediationPlan } from '../types.js';
import { RECOMMENDATION_LABEL } from '../rationale/assess.js';
import type {
  LicenseFinding,
  MaintenanceAssessment,
  ReleaseSummary,
  SecurityAssessment,
  Severity,
  UpgradeRationale,
  Vulnerability,
} from '../rationale/types.js';

/**
 * The upgrade rationale, rendered.
 *
 * One block per dependency, and the same shape every time: what it costs, what
 * it buys, who is looking after it, and one sentence saying what Drift thinks
 * and why. The order is deliberate — compatibility first, because that is what
 * the reader came for, and the recommendation at the top, because a reader who
 * stops after the first line should still have got the answer.
 *
 * Every claim carries its citation inline. A benefit without a link is not
 * printed; that rule is enforced upstream, and this module simply never invents
 * a place to put one.
 */

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: '🔴 critical',
  high: '🟠 high',
  medium: '🟡 medium',
  low: '🔵 low',
  unknown: '⚪ severity not stated',
};

const CONFIDENCE_BADGE = { high: '🟢 High', medium: '🟡 Medium', low: '🟠 Low' } as const;

/** Vulnerabilities listed individually before the rest become a count. */
const MAX_LISTED = 8;

export function renderRationale(plan: RemediationPlan): string {
  const rationale = plan.rationale ?? [];
  if (rationale.length === 0) return '';

  const blocks = rationale.map(renderOne).filter(Boolean);
  if (blocks.length === 0) return '';

  return ['## Upgrade assessment', '', blocks.join('\n\n---\n\n')].join('\n');
}

export function renderOne(rationale: UpgradeRationale): string {
  const lines: string[] = [
    `### \`${rationale.dependency}\` ${rationale.from} → ${rationale.to}`,
    '',
    `**Recommendation: ${RECOMMENDATION_LABEL[rationale.assessment.recommendation]}**`,
    '',
  ];

  const security = renderSecurity(rationale.security);
  if (security) lines.push(security, '');

  const maintenance = renderMaintenance(rationale.maintenance);
  if (maintenance) lines.push(maintenance, '');

  if (rationale.improvements.length > 0) {
    lines.push('**Other improvements**', '');
    for (const improvement of rationale.improvements) {
      lines.push(`- ${improvement.statement}${improvement.url ? ` ([source](${improvement.url}))` : ''}`);
    }
    lines.push('');
  }

  const license = renderLicense(rationale.license);
  if (license) lines.push(license, '');

  const summary = renderSummary(rationale.summary);
  if (summary) lines.push(summary, '');

  lines.push(
    `**Evidence confidence:** ${CONFIDENCE_BADGE[rationale.assessment.confidence]} — ${rationale.assessment.confidenceBasis}`,
    '',
  );

  // The reasons come last and in full. They are the argument for everything
  // above, and a reader who disagrees with the recommendation needs to be able
  // to find the specific sentence they disagree with.
  if (rationale.assessment.reasons.length > 0) {
    lines.push('<details><summary>Why Drift concluded this</summary>', '');
    for (const reason of rationale.assessment.reasons) lines.push(`- ${reason}`);
    lines.push('', '</details>');
  }

  return lines.join('\n').trim();
}

function renderSecurity(security: SecurityAssessment): string {
  if (!security.checked) {
    return `**Security**\n\n${
      security.reason ??
      'The OSV advisory database could not be reached, so this upgrade\'s effect on known vulnerabilities is unknown.'
    }`;
  }

  const lines: string[] = ['**Security**', ''];

  if (security.resolved.length > 0) {
    lines.push(`Upgrading resolves ${count(security.resolved.length, 'known vulnerability', 'known vulnerabilities')}:`);
    lines.push(...listVulnerabilities(security.resolved));
    lines.push('');
  }

  if (security.introduced.length > 0) {
    lines.push(
      `The target version is affected by ${count(security.introduced.length, 'advisory', 'advisories')} that ${security.introduced.length === 1 ? 'does' : 'do'} not affect the installed version:`,
    );
    lines.push(...listVulnerabilities(security.introduced));
    lines.push('');
  }

  if (security.carried.length > 0) {
    lines.push(
      `${count(security.carried.length, 'advisory affects', 'advisories affect')} both versions and ${security.carried.length === 1 ? 'is' : 'are'} not addressed by this upgrade:`,
    );
    lines.push(...listVulnerabilities(security.carried));
    lines.push('');
  }

  if (security.target.length === 0) {
    lines.push('No known vulnerabilities were found for the target version.');
  }

  return lines.join('\n').trim();
}

function listVulnerabilities(vulnerabilities: readonly Vulnerability[]): string[] {
  const shown = vulnerabilities.slice(0, MAX_LISTED);
  const lines = shown.map((vuln) => {
    // The CVE is what most readers search for, so it is named alongside the
    // OSV id rather than hidden behind the link.
    const cve = vuln.aliases.find((alias) => alias.startsWith('CVE-'));
    const identifier = cve && cve !== vuln.id ? `${vuln.id} (${cve})` : vuln.id;
    const fix = vuln.fixedIn ? ` — first fixed in ${vuln.fixedIn}` : ' — no fixed version published';
    return `- [${identifier}](${vuln.url}) — ${SEVERITY_BADGE[vuln.severity]}${fix}. ${vuln.summary}`;
  });

  if (vulnerabilities.length > shown.length) {
    lines.push(`- …and ${vulnerabilities.length - shown.length} more.`);
  }
  return lines;
}

function renderMaintenance(maintenance: MaintenanceAssessment): string {
  if (maintenance.facts.length === 0) return '';

  // Concerning facts first. Everything here is a statement with a source, and
  // there is deliberately no score: a package can be stable without being busy.
  const ordered = [...maintenance.facts].sort(
    (a, b) => Number(b.concerning ?? false) - Number(a.concerning ?? false),
  );

  return [
    '**Maintenance**',
    '',
    ...ordered.map((fact) => `- ${fact.statement}${fact.url ? ` ([source](${fact.url}))` : ''}`),
  ].join('\n');
}

function renderLicense(license: LicenseFinding): string {
  // Silence for 'ok' (nothing changed) and 'changed' (changed but still
  // within policy) alike: an upgrade report that flags every benign license
  // note is one people stop reading. 'unknown' and 'policy-violation' are
  // kept — a license that stopped being readable, or one that conflicts with
  // policy, is worth a reader's attention even when nothing else is wrong.
  if (license.verdict === 'ok' || license.verdict === 'changed') return '';

  const heading = license.verdict === 'policy-violation' ? '**License review required**' : '**License**';
  const lines = [heading, '', license.statement];

  const introduced = license.introduced.filter((dep) => !dep.allowed);
  if (introduced.length > 0) {
    lines.push('', 'Newly introduced dependencies of this package:');
    for (const dep of introduced) {
      lines.push(`- \`${dep.name}\` — ${dep.license ?? 'no declared license'}`);
    }
    lines.push(
      '',
      'This covers the dependencies this package itself declares. Drift does not resolve the full transitive graph during analysis.',
    );
  }

  lines.push('', '_Drift reports what the metadata says and how it compares to your configured policy. It does not give legal advice._');

  return lines.join('\n');
}

function renderSummary(summary: ReleaseSummary): string {
  if (summary.changes.length === 0) return '';

  const groups: [string, typeof summary.changes][] = [
    ['Breaking changes', summary.changes.filter((c) => c.category === 'breaking')],
    ['Security', summary.changes.filter((c) => c.category === 'security')],
    ['Improvements', summary.changes.filter((c) => c.category === 'performance' || c.category === 'improvement')],
    ['Fixes', summary.changes.filter((c) => c.category === 'fix')],
  ];

  const lines: string[] = ['<details><summary>What changed upstream</summary>', ''];

  for (const [heading, changes] of groups) {
    if (changes.length === 0) continue;
    lines.push(`**${heading}**`, '');
    for (const change of changes) {
      const impact =
        change.affectedSites !== undefined
          ? ` Drift found ${count(change.affectedSites, 'affected call', 'affected calls')} in this repository.`
          : '';
      lines.push(`- ${change.text}${impact}${change.url ? ` ([source](${change.url}))` : ''}`);
    }
    lines.push('');
  }

  if (summary.unrelated > 0) {
    lines.push(
      `**Unrelated changes**`,
      '',
      `- ${count(summary.unrelated, 'further change', 'further changes')} were read and judged not to concern this repository.`,
      '',
    );
  }

  lines.push('</details>');
  return lines.join('\n');
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
