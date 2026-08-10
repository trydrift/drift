import type { Confidence } from '../types.js';
import type { AuditResult, LatentFinding } from '../audit/types.js';

/**
 * The present-tense section of a Drift report.
 *
 * Kept apart from the plan sections on purpose, and placed above them wherever
 * both appear. Everything else in a Drift report is a proposal about a version
 * that is not installed — a reviewer reads it deciding whether to accept a
 * move. This section is not a proposal. It is a statement that the code in the
 * branch they are looking at is already out of step with the dependency tree
 * they already have, which is true whether or not they take the upgrade, and
 * stays true if they close the pull request.
 *
 * Presenting the two in one undifferentiated list was the thing to avoid: a
 * reviewer who reads "breaking change" and thinks "if I upgrade" will file this
 * under later, and later never comes for a bug that is already shipping.
 */

const CONFIDENCE_BADGE: Record<Confidence, string> = {
  high: '🟢 high',
  medium: '🟡 medium',
  low: '🟠 low',
};

export function renderAudit(audit: AuditResult | undefined): string {
  if (!audit || audit.findings.length === 0) return '';

  const violations = audit.findings.filter((f) => f.kind === 'range-violation');
  const drift = audit.findings.filter((f) => f.kind === 'unreviewed-drift');

  const lines: string[] = ['## Already broken, before any upgrade'];

  const files = new Set(drift.flatMap((f) => f.sites.map((s) => s.file))).size;
  lines.push(
    '',
    `These findings are about the versions **installed right now**. Each one is a place where this ` +
      `repository imports something that, checked directly against the package sitting in ` +
      `\`node_modules\`, is not there. Upgrading will not fix them; they are already true.`,
    '',
  );

  if (drift.length > 0) {
    lines.push(
      `**${drift.length} finding${drift.length === 1 ? '' : 's'}** across ` +
        `${new Set(drift.map((f) => f.dependency)).size} package${new Set(drift.map((f) => f.dependency)).size === 1 ? '' : 's'}` +
        (files > 0 ? `, in ${files} file${files === 1 ? '' : 's'}.` : '.'),
      '',
    );

    for (const finding of drift) lines.push(renderFinding(finding), '');
  }

  if (violations.length > 0) {
    lines.push(
      '### Installed versions that contradict the manifest',
      '',
      'A clean install on another machine would not reproduce this dependency tree, so every other',
      'finding in this report is conditional on whose lockfile produced it.',
      '',
    );
    for (const violation of violations) {
      lines.push(
        `- **${violation.dependency}** — \`${violation.declaredRange}\` declared in ` +
          `\`${violation.manifestPath}\`, \`${violation.installedVersion}\` installed.`,
      );
    }
    lines.push('');
  }

  lines.push(
    `<sub>Audited ${audit.analysed} of ${audit.checked} direct ${audit.checked === 1 ? 'dependency' : 'dependencies'}; ` +
      `the rest were not npm packages, had no on-disk declarations, or this repository imports ` +
      `nothing from them by name.</sub>`,
  );

  return lines.join('\n').trimEnd();
}

function renderFinding(finding: LatentFinding): string {
  const breaking = finding.breakingChange;
  // Same wording as `describeMember`, over the audit's own record rather than
  // a `DependencyChange` — a latent finding never had one.
  const where =
    finding.workspace === undefined
      ? null
      : finding.workspace === ''
        ? 'the repository root'
        : finding.workspace;
  const lines: string[] = [];

  lines.push(
    `### \`${finding.dependency}\` — installed ${finding.installedVersion}${where ? ` (${where})` : ''}`,
    '',
    breaking?.summary ?? finding.summary,
    '',
    `Checked directly against \`${finding.dependency}@${finding.installedVersion}\` as installed in ` +
      `\`node_modules\` — not a version diff, the file this repository's own tooling would resolve.`,
  );

  if (breaking?.remediation) lines.push('', `**Fix:** ${breaking.remediation}`);

  if (finding.sites.length > 0) {
    lines.push('', '| File | Line | Code | Confidence |', '| --- | --- | --- | --- |');
    for (const site of finding.sites.slice(0, 10)) {
      const excerpt = site.excerpt.replace(/\|/g, '\\|').slice(0, 90);
      lines.push(
        `| \`${site.file}\` | ${site.line} | \`${excerpt}\` | ${CONFIDENCE_BADGE[site.confidence]} |`,
      );
    }
    if (finding.sites.length > 10) {
      lines.push('', `<sub>…and ${finding.sites.length - 10} more.</sub>`);
    }
  }

  return lines.join('\n');
}

/** One line for a status bar, a CLI footer, or a check-run title. */
export function auditHeadline(audit: AuditResult | undefined): string | null {
  if (!audit || audit.findings.length === 0) return null;

  const drift = audit.findings.filter((f) => f.kind === 'unreviewed-drift');
  const files = new Set(drift.flatMap((f) => f.sites.map((s) => s.file))).size;

  if (drift.length === 0) {
    return `${audit.findings.length} installed version(s) contradict the manifest`;
  }

  return (
    `${drift.length} place${drift.length === 1 ? '' : 's'} in this repository ` +
    `already ${drift.length === 1 ? 'conflicts' : 'conflict'} with an installed dependency` +
    (files > 0 ? ` (${files} file${files === 1 ? '' : 's'})` : '')
  );
}
