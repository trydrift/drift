import { describeMember } from '../detect/workspace.js';
import type {
  BreakingChange,
  Confidence,
  DependencyChange,
  Evidence,
  ImpactSite,
  RemediationPlan,
} from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import { renderRationale } from './rationale.js';
import {
  evidenceStrengthLabel,
  confidenceDisplay,
  renderCheckedSurfaces,
  renderConfidenceTable,
  renderEligibility,
  renderGaps,
  renderTaxonomy,
  repositoryConclusion,
  verdictFor,
  verdictText,
} from './confidence.js';
import { PLAN_SCHEMA_VERSION, planDigest } from '../approval/digest.js';
import { renderApprovalMetadata } from '../approval/metadata.js';
import { DEPENDENCY_KIND_LABELS } from './sarif.js';
import { describeOp } from '../fixplan/document.js';

/**
 * The Drift Report.
 *
 * This is the product surface. Everything upstream exists to make this
 * document trustworthy: a reviewer should be able to read it, click three
 * citations, and know whether to approve — without opening the diff first.
 *
 * Two rules govern what goes in:
 *   1. Every claim carries a link to the evidence behind it.
 *   2. Anything Drift is unsure about is stated as uncertain, in the same
 *      place as the confident findings. Burying caveats at the bottom is how
 *      a tool teaches people to stop reading its output.
 */

const CONFIDENCE_BADGE: Record<Confidence, string> = {
  high: '🟢 high',
  medium: '🟡 medium',
  low: '🟠 low',
};

const RISK_BADGE: Record<string, string> = {
  none: '⚪ none',
  low: '🟢 low',
  medium: '🟡 medium',
  high: '🔴 high',
};

/** Body for the pull request Copilot opens. */
export function renderPullRequestBody(plan: RemediationPlan, config: DriftConfig): string {
  const sections: string[] = [];

  sections.push(renderHeader(plan));
  sections.push(renderSummaryTable(plan));

  if (plan.blockers.length > 0) sections.push(renderBlockers(plan));
  if (plan.warnings.length > 0) sections.push(renderWarnings(plan));

  sections.push(renderBreakingChanges(plan));
  sections.push(renderRationale(plan));
  sections.push(renderCommitPlan(plan));
  sections.push(renderImpactSites(plan));
  sections.push(renderGaps(plan.gaps));
  sections.push(renderCheckedSurfaces(plan));
  sections.push(renderEvidence(plan));
  sections.push(renderReviewChecklist(plan, config));
  sections.push(renderFooter(plan));

  return sections.filter(Boolean).join('\n\n');
}

/** Body for the approval issue posted in `approve` mode. */
export function renderApprovalIssue(plan: RemediationPlan, config: DriftConfig): string {
  const sections: string[] = [];

  sections.push('## Drift found breaking changes that need your call');
  sections.push(
    plan.blockers.length > 0
      ? 'Drift analysed this dependency change and prepared a fix, then stopped. The reasons are listed below.'
      : `Drift analysed this dependency change and prepared a fix. This repository runs in \`approve\` mode, so nothing has been changed yet.`,
  );

  sections.push(renderSummaryTable(plan));
  if (plan.blockers.length > 0) sections.push(renderBlockers(plan));
  if (plan.warnings.length > 0) sections.push(renderWarnings(plan));
  sections.push(renderBreakingChanges(plan));
  sections.push(renderRationale(plan));
  sections.push(renderCommitPlan(plan));
  sections.push(renderGaps(plan.gaps));
  sections.push(renderCheckedSurfaces(plan));
  sections.push(renderEvidence(plan));

  sections.push(
    [
      '## To proceed',
      '',
      'Comment `/drift apply` on this issue and Drift will create the branch and',
      'hand the plan to GitHub Copilot, one commit at a time. You will get a pull',
      'request to review — nothing merges automatically.',
      '',
      'Comment `/drift dismiss` to close this out.',
      '',
      `To stop being asked for changes like this, adjust \`.github/drift.yml\` — see the [configuration reference](https://github.com/trydrift/drift/blob/main/docs/configuration.md).`,
    ].join('\n'),
  );

  sections.push(renderFooter(plan));

  return sections.filter(Boolean).join('\n\n');
}

function renderHeader(plan: RemediationPlan): string {
  // In a monorepo, *which package* moved is the first thing a reviewer needs;
  // in a single-package repository it is a label with no information in it.
  const members = new Set(plan.changes.map((c) => c.workspace).filter((w) => w !== undefined));
  const changes = plan.changes
    .map((c) => {
      const where = members.size > 1 ? describeMember(c) : null;
      // Runtime is the common case and clutters every line if labelled; the
      // sections a reviewer doesn't expect (dev, optional, peer, transitive)
      // are the ones worth calling out.
      const kind = c.kind === 'runtime' ? null : DEPENDENCY_KIND_LABELS[c.kind];
      // The ecosystem is always named, unlike the workspace member: one run
      // can cover several registries at once, and a package name alone does
      // not say which of them a line belongs to.
      const tags = [c.ecosystem, kind].filter(Boolean).join(', ');
      return `\`${c.name}\` _(${tags})_ ${c.from ?? '—'} → **${c.to ?? '—'}**${where ? ` _(in ${where})_` : ''}`;
    })
    .join(', ');

  return [
    `## Drift: dependency compatibility fix`,
    '',
    `${changes}`,
    '',
    plan.commits.length > 0
      ? `Drift found **${plan.breakingChanges.length} breaking change(s)** affecting **${new Set(plan.impactSites.map((s) => s.file)).size} file(s)** in this repository, and planned **${plan.commits.length} commit(s)** to fix them.`
      : repositoryConclusion(plan),
  ].join('\n');
}

function renderSummaryTable(plan: RemediationPlan): string {
  const files = new Set(plan.impactSites.map((s) => s.file)).size;

  return [
    '| | |',
    '|---|---|',
    `| **Risk** | ${RISK_BADGE[plan.risk] ?? plan.risk} |`,
    `| **Breaking changes** | ${plan.upstreamBreakingCount ?? plan.breakingChanges.length} |`,
    `| **Impact sites** | ${plan.impactSites.length} across ${files} file(s) |`,
    `| **Planned commits** | ${plan.commits.length} |`,
    `| **Evidence sources** | ${describeSources(plan.evidence)} |`,
    `| **Base branch** | \`${plan.baseBranch}\` |`,
  ].join('\n');
}

function describeSources(evidence: readonly Evidence[]): string {
  const counts = new Map<string, number>();
  for (const record of evidence) {
    counts.set(record.source, (counts.get(record.source) ?? 0) + 1);
  }
  if (counts.size === 0) return 'none';
  return [...counts.entries()].map(([source, count]) => `${source} (${count})`).join(', ');
}

function renderBlockers(plan: RemediationPlan): string {
  return [
    '## ⛔ Why Drift stopped',
    '',
    'Drift did not dispatch this automatically. Each reason below is a guardrail',
    'from `.github/drift.yml`:',
    '',
    ...plan.blockers.map((b) => `- ${b}`),
  ].join('\n');
}

function renderWarnings(plan: RemediationPlan): string {
  return ['## ⚠️ Worth checking', '', ...plan.warnings.map((w) => `- ${w}`)].join('\n');
}

function renderBreakingChanges(plan: RemediationPlan): string {
  if (plan.breakingChanges.length === 0) {
    return ['## Breaking changes', '', 'None identified from the available evidence.'].join('\n');
  }

  const evidenceById = new Map(plan.evidence.map((e) => [e.id, e]));
  const lines: string[] = ['## Breaking changes', ''];

  for (const change of plan.breakingChanges) {
    const siteCount = plan.impactSites.filter((s) => s.breakingChangeId === change.id).length;
    const verdict = verdictFor(change);

    lines.push(`### ${confidenceDisplay(change).text} · \`${change.dependency}\` · ${change.kind}`);
    lines.push('');
    lines.push(change.summary);
    lines.push('');

    // The declaration itself, before and after — the actual evidence for the
    // summary above, not just a link to where it can be found.
    if (change.before && change.after && change.before !== change.after) {
      lines.push('```diff', `- ${truncate(change.before, 300)}`, `+ ${truncate(change.after, 300)}`, '```', '');
    }

    // The verdict leads, because it is the sentence a reader acts on — and
    // because it is the one place the difference between "checked and clean"
    // and "not checked" is stated in words rather than implied by a count.
    // Hedged against the assessment: a `low`/`medium` local-impact match reads
    // "may be affected", not "is affected" — the same certainty a reader would
    // otherwise wrongly assign to a single textual hit.
    lines.push(`**Verdict:** ${verdictText(verdict, change.assessment)}.`);
    lines.push('');

    lines.push(renderTaxonomy(change));
    lines.push('');

    if (change.assessment) {
      // The one number a non-expert reads first, ahead of the three-dimension
      // breakdown that follows for anyone who wants to see the working.
      lines.push(renderConfidenceTable(change.assessment));
      lines.push('');
      lines.push(renderEligibility(change.assessment));
      lines.push('');
    }

    if (change.symbols.length > 0) {
      lines.push(`**Symbols:** ${change.symbols.map((s) => `\`${s}\``).join(', ')}`);
      lines.push('');
    }

    lines.push(
      siteCount > 0
        ? `**Found in this repo:** ${siteCount} location(s)`
        : change.assessment?.localImpact.penalties.some((p) => p.code === 'localization-unavailable')
          ? '**Found in this repo:** not searched — no checkout was available. This is not evidence the change is unused.'
          : '**Found in this repo:** no usages found in the files that import this dependency — no fix planned',
    );
    lines.push('');

    lines.push(...renderFix(change.remediation));
    lines.push('');

    const citations = change.citations
      .map((id) => evidenceById.get(id))
      .filter((e): e is Evidence => e !== undefined);

    if (citations.length > 0) {
      lines.push('**Evidence:**');
      for (const citation of citations) {
        lines.push(`- ${linkTo(citation)}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function renderFix(remediation: string): string[] {
  const rendered = renderCodeAwareMarkdown(remediation);
  if (rendered.length === 1) return [`**Fix:** ${rendered[0]}`];
  return ['**Fix:**', '', ...rendered];
}

function renderCodeAwareMarkdown(text: string): string[] {
  const out: string[] = [];
  const paragraph: string[] = [];

  const flushParagraph = () => {
    const value = paragraph.join(' ').trim();
    paragraph.length = 0;
    if (value) out.push(value);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const labelledCode = /^(before|after):(.*)$/i.exec(line);
    if (labelledCode) {
      flushParagraph();
      out.push(`**${capitalize(labelledCode[1]!)}:**`, '', fencedCode(labelledCode[2]!.trimStart()), '');
      continue;
    }

    if (!line) {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return out.filter((line, index, lines) => line || (lines[index - 1] && lines[index + 1]));
}

function fencedCode(code: string): string {
  const ticks = code.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 2) ?? 2;
  const fence = '`'.repeat(ticks + 1);
  return [fence, code, fence].join('\n');
}

function capitalize(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1).toLowerCase()}` : text;
}

function renderCommitPlan(plan: RemediationPlan): string {
  if (plan.commits.length === 0) {
    return ['## Commit plan', '', `No commits planned. ${repositoryConclusion(plan)}`].join('\n');
  }

  const lines: string[] = [
    '## Commit plan',
    '',
    'Each commit addresses one concern. The graph below records only necessary',
    'dependencies; commits in the same execution layer have disjoint file scope and',
    'may run in parallel.',
    '',
  ];

  for (const commit of plan.commits) {
    lines.push(`**${commit.order}. \`${commit.message}\`**`);
    lines.push('');
    lines.push(`Unit: \`${commit.id}\``);
    lines.push(`Layer: ${commit.executionLayer}`);
    if (commit.dependsOn.length > 0) {
      lines.push(`Depends on: ${commit.dependsOn.map((id) => `\`${id}\``).join(', ')}`);
      lines.push(
        `Why: ${commit.dependencyReasons
          .map((edge) => `${edge.reason}${edge.evidence.length ? ` (${edge.evidence.slice(0, 3).join('; ')})` : ''}`)
          .join('; ')}`,
      );
    }
    lines.push(`Files: ${commit.allowedFiles.map((f) => `\`${f}\``).join(', ')}`);
    if ((commit.allowedSymbols ?? []).length > 0) {
      lines.push(`Symbols: ${commit.allowedSymbols!.map((s) => `\`${s}\``).join(', ')}`);
    }
    if (commit.expectedChecks.length > 0) {
      lines.push(`Expected checks: ${commit.expectedChecks.map((check) => check.kind).join(', ')}`);
    }
    if (commit.codemod?.length) {
      const renames = commit.codemod.map((t) => `\`${t.from}\` → \`${t.to}\``).join(', ');
      lines.push(
        `**Resolved deterministically** by Drift's codemod engine (${renames}) — no model call was needed for this commit.`,
      );
    } else if (commit.fixPlan) {
      const { plan: fixPlan, covered, residual, assurance } = commit.fixPlan;
      const total = covered + residual;
      lines.push(
        `**Deterministic fix plan** \`${fixPlan.id}\` — ${fixPlan.migration} ` +
          `${fixPlan.ops.length} rule${fixPlan.ops.length === 1 ? '' : 's'}, ${covered}/${total} call site${total === 1 ? '' : 's'} covered, assurance \`${assurance}\`.`,
      );
      for (const op of fixPlan.ops) lines.push(`  - ${describeOp(op)}`);
      if (residual > 0) {
        lines.push(
          `  - ${residual} call site${residual === 1 ? '' : 's'} not covered by the plan; an agent handles ${residual === 1 ? 'it' : 'them'} individually.`,
        );
      }
      if (commit.recipe?.length) {
        const recipes = [...new Map(commit.recipe.map((r) => [`${r.provider}:${r.name}@${r.version}`, r])).values()];
        lines.push(
          `  - Consulted: ${recipes.map((r) => `[\`${r.name}@${r.version}\`](${r.source}) from ${r.publisher}`).join(', ')}`,
        );
      }
    } else if (commit.recipe?.length) {
      const recipes = [...new Map(commit.recipe.map((r) => [`${r.provider}:${r.name}@${r.version}`, r])).values()];
      const list = recipes
        .map((r) => `[\`${r.name}@${r.version}\`](${r.source}) from ${r.publisher} (${r.provider})`)
        .join(', ');
      // Metadata only: a matched recipe whose edits Drift could not re-derive
      // as its own operations is reported as consulted, never as available to
      // run. What it proposed was not something Drift can describe in advance.
      lines.push(
        `**Community recipe consulted**: ${list} — ${recipes[0]!.migration} Drift could not re-derive its edits as deterministic operations, so this commit goes to an agent.`,
      );
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function renderImpactSites(plan: RemediationPlan): string {
  if (plan.impactSites.length === 0) return '';

  const byFile = new Map<string, ImpactSite[]>();
  for (const site of plan.impactSites) {
    const bucket = byFile.get(site.file);
    if (bucket) bucket.push(site);
    else byFile.set(site.file, [site]);
  }

  const lines: string[] = [
    '<details>',
    `<summary><b>All ${plan.impactSites.length} impact site(s)</b></summary>`,
    '',
  ];

  for (const [file, sites] of [...byFile.entries()].sort()) {
    lines.push(`**\`${file}\`**`);
    lines.push('');
    for (const site of sites.slice(0, 25)) {
      const where = site.enclosingSymbol ? ` (in \`${site.enclosingSymbol}\`)` : '';
      lines.push(`- L${site.line}${where} — \`${site.excerpt}\` · ${CONFIDENCE_BADGE[site.confidence]}`);
    }
    if (sites.length > 25) lines.push(`- …and ${sites.length - 25} more in this file`);
    lines.push('');
  }

  lines.push('</details>');
  return lines.join('\n');
}

function renderEvidence(plan: RemediationPlan): string {
  if (plan.evidence.length === 0) return '';

  const lines: string[] = [
    '<details>',
    `<summary><b>Evidence Drift used (${plan.evidence.length} source(s))</b></summary>`,
    '',
    'Every finding above traces back to one of these. Open them to check the work.',
    '',
  ];

  for (const record of plan.evidence) {
    lines.push(`#### ${linkTo(record)}`);
    lines.push('');
    lines.push(`\`${record.source}\` · ${evidenceStrengthLabel(record.weight)} (weight ${record.weight.toFixed(2)})`);
    lines.push('');
    lines.push('```');
    lines.push(truncate(record.content, 2000));
    lines.push('```');
    lines.push('');
  }

  lines.push('</details>');
  return lines.join('\n');
}

function renderReviewChecklist(plan: RemediationPlan, config: DriftConfig): string {
  const items: string[] = [
    'Every edit corresponds to a breaking change listed above — no unrelated refactoring crept in',
    'The fixes match what the cited evidence actually says',
    'CI passes on this branch',
  ];

  if (plan.impactSites.some((s) => s.file.includes('test'))) {
    items.push('Test changes update assertions to the new API rather than weakening them');
  }

  if (plan.breakingChanges.some((c) => c.kind === 'behaviour-change' || c.kind === 'default-change')) {
    items.push(
      'Behaviour changes were handled deliberately — these compile either way, so the type checker will not catch a wrong choice',
    );
  }

  if (plan.breakingChanges.some((c) => c.confidence === 'low')) {
    items.push('Low-confidence findings were verified against the upstream source before accepting');
  }

  return ['## Review checklist', '', ...items.map((i) => `- [ ] ${i}`)].join('\n');
}

function renderFooter(plan: RemediationPlan): string {
  return [
    '---',
    '',
    // Load-bearing, not decoration: the approval flow reproduces the plan from
    // these values rather than storing it anywhere, and refuses to act if what
    // it recomputes does not match the digest recorded here. See
    // `approval/digest.ts` for why the digest is not simply the plan id.
    renderApprovalMetadata({
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: plan.id,
      planDigest: planDigest(plan),
      headSha: plan.headSha,
      baseBranch: plan.baseBranch,
    }),
    '',
    `<sub>Generated by [Drift](https://github.com/trydrift/drift) · plan \`${plan.id}\` · ${plan.createdAt}<br>`,
    'Drift reads dependency changes, proves which ones break your code, and drives',
    'GitHub Copilot to fix them. It never merges anything.</sub>',
  ].join('\n');
}

function linkTo(evidence: Evidence): string {
  const label = evidence.title;
  if (evidence.url) return `[${label}](${evidence.url})`;
  if (evidence.locator) return `${label} (\`${evidence.locator}\`)`;
  return label;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

/** Compact single-line summary for check-run titles and log output. */
export function renderSummaryLine(plan: RemediationPlan): string {
  if (plan.commits.length === 0) {
    return `${repositoryConclusion(plan)} (${plan.changes.length} dependency change(s) checked)`;
  }
  const files = new Set(plan.impactSites.map((s) => s.file)).size;
  return `${plan.breakingChanges.length} breaking change(s), ${files} file(s) affected, ${plan.commits.length} commit(s) planned (risk: ${plan.risk})`;
}

export { CONFIDENCE_BADGE, RISK_BADGE };
export type { BreakingChange, DependencyChange };
