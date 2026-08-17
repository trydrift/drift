import type { FixOp, FixPlan, FixPlanAssessment, FixPlanSiteOutcome, OpAssurance } from './schema.js';

/**
 * The fix plan, written down.
 *
 * This is the artefact the whole tier exists to produce. A git diff records
 * what changed; it does not record why those lines and not others, what rule
 * produced them, what evidence attested it, or which sites the rule declined
 * to touch and for what reason. Six months later that difference is the
 * whole difference between an auditable change and an archaeological dig.
 *
 * So the document is written *before* anything is applied and is the same
 * text in every surface: the CLI prints it, the extension renders it, the
 * Action puts it in the pull request body and the approval issue. One
 * renderer, because a reviewer who approves a plan in the editor and an
 * auditor who reads it in a PR a year later must be looking at the same
 * document — a per-surface summary would let them differ, and the one that
 * differed would be the one nobody checked.
 */

export interface DocumentOptions {
  /** Include the per-site table. Off for a compact summary line. */
  sites?: boolean;
  /** Heading level to start at. Defaults to `###`, which nests inside a report. */
  headingLevel?: number;
}

/** One sentence naming what a rule does, in the language a reviewer thinks in. */
export function describeOp(op: FixOp): string {
  switch (op.kind) {
    case 'rename-identifier':
      return `Rename the identifier \`${op.from}\` to \`${op.to}\` (bare uses only — never \`something.${op.from}\`).`;
    case 'rename-member':
      return `Rename the member \`.${op.from}\` to \`.${op.to}\` (member access only — never a bare \`${op.from}\`).`;
    case 'replace-import-path':
      return `Change the import path \`${op.from}\` to \`${op.to}\`, on lines that actually import.`;
    case 'insert-argument':
      return `Insert \`${op.text}\` as argument ${op.index + 1} of every \`${op.callee}(…)\` call that closes on its own line.`;
    case 'wrap-call':
      return `Prefix every \`${op.callee}(…)\` call with \`${op.wrapper}\`, where it is not already prefixed.`;
  }
}

/** How the assurance level should be stated to someone deciding whether to apply. */
export function describeAssurance(assurance: OpAssurance): string {
  return assurance === 'proven'
    ? 'Every operation swaps one token or string for another of the same kind, so applying this cannot change whether the file parses.'
    : 'At least one operation changes the structure of an expression. Drift knows exactly what it will write, but cannot promise the result compiles — so this plan is only applied automatically once the project’s own checks have actually passed.';
}

function provenanceLine(plan: FixPlan): string {
  const { provenance } = plan;
  switch (provenance.author) {
    case 'model':
      return `Authored by \`${provenance.model ?? 'a model'}\` from the cited evidence, then validated by Drift.`;
    case 'builtin':
      return 'Derived by Drift’s own codemod engine from a computed API diff. No model was involved.';
    case 'recipe':
      return provenance.recipe
        ? `Inferred from what \`${provenance.recipe.name}@${provenance.recipe.version}\` (${provenance.recipe.publisher}) did in a throwaway worktree, then re-derived and validated by Drift. The recipe’s own output was not used — see ${provenance.recipe.source}.`
        : 'Inferred from a community recipe, then re-derived and validated by Drift.';
    case 'cache':
      return `Restored from a previously validated plan for this same migration (\`${provenance.sourceId ?? plan.id}\`), then re-validated against this repository’s own call sites.`;
    case 'user':
      return 'Supplied by a human. Validated by Drift exactly as an authored plan would be.';
  }
}

/**
 * Render the full document.
 *
 * Deliberately readable as plain text as well as markdown, because it is
 * printed to a terminal as often as it is rendered in a browser.
 */
export function renderFixPlanDocument(assessment: FixPlanAssessment, options: DocumentOptions = {}): string {
  const { plan } = assessment;
  const level = options.headingLevel ?? 3;
  const h = (depth: number) => '#'.repeat(Math.min(6, level + depth));
  const out: string[] = [];

  out.push(`${h(0)} Fix plan: ${plan.migration}`);
  out.push('');
  out.push(`\`${plan.id}\` · **${plan.dependency}** ${plan.fromVersion ?? '?'} → ${plan.toVersion ?? '?'} · ${plan.changeKind}`);
  out.push('');

  if (assessment.verdict === 'rejected') {
    out.push('**Drift rejected this plan.** It was not applied, and the finding falls through to the tier below.');
    out.push('');
    for (const reason of assessment.rejections) out.push(`- ${reason}`);
    out.push('');
    out.push(provenanceLine(plan));
    return out.join('\n');
  }

  out.push(`${h(1)} What it does`);
  out.push('');
  for (const op of plan.ops) out.push(`1. ${describeOp(op)}`);
  out.push('');

  if (plan.rationale) {
    out.push(`${h(1)} Why`);
    out.push('');
    out.push(plan.rationale);
    out.push('');
  }

  out.push(`${h(1)} What Drift checked`);
  out.push('');
  out.push(`- **Grounding.** Every operation acts on a symbol this finding names.`);
  out.push(
    `- **Attestation.** Every name introduced (${plan.ops.flatMap(introduced).map((token) => `\`${token}\``).join(', ') || 'none'}) appears in the cited evidence${plan.citations.length ? ` (${plan.citations.map((id) => `\`${id}\``).join(', ')})` : ''}.`,
  );
  out.push('- **Convergence.** Applying the plan twice was tested, and gives the same result as applying it once.');
  out.push('- **Line preservation.** No operation splits or joins a line.');
  out.push(`- **Assurance.** ${describeAssurance(assessment.assurance)}`);
  out.push('');

  out.push(`${h(1)} Coverage`);
  out.push('');
  out.push(
    assessment.residual === 0
      ? `All ${assessment.covered} call site${assessment.covered === 1 ? '' : 's'} are resolved deterministically. No agent is asked about this finding.`
      : `${assessment.covered} of ${assessment.covered + assessment.residual} call sites are resolved deterministically. The remaining ${assessment.residual} ${assessment.residual === 1 ? 'is' : 'are'} listed below and ${assessment.residual === 1 ? 'is' : 'are'} handed to an agent individually — the plan is not abandoned because of them.`,
  );
  out.push('');

  if (options.sites !== false && assessment.sites.length > 0) {
    out.push(renderSites(assessment.sites));
    out.push('');
  }

  out.push(provenanceLine(plan));
  return out.join('\n');
}

/** A one-line summary, for a report table or a status bar. */
export function summarizeFixPlan(assessment: FixPlanAssessment): string {
  if (assessment.verdict === 'rejected') {
    return `Fix plan rejected: ${assessment.rejections[0] ?? 'it did not pass validation'}`;
  }
  const rules = assessment.plan.ops.length;
  const total = assessment.covered + assessment.residual;
  return `${rules} deterministic rule${rules === 1 ? '' : 's'} covering ${assessment.covered}/${total} call site${total === 1 ? '' : 's'} (${assessment.assurance})`;
}

function renderSites(sites: readonly FixPlanSiteOutcome[]): string {
  const rows: string[] = ['| Site | Change |', '| --- | --- |'];

  for (const site of sites) {
    const where = `\`${site.file}:${site.line}\``;
    if (site.status === 'covered') {
      rows.push(`| ${where} | \`${trim(site.before)}\` → \`${trim(site.after ?? '')}\` |`);
    } else {
      rows.push(`| ${where} | _Not covered_ — ${site.reason ?? 'no rule matched.'} |`);
    }
  }

  return rows.join('\n');
}

function introduced(op: FixOp): string[] {
  switch (op.kind) {
    case 'rename-identifier':
    case 'rename-member':
    case 'replace-import-path':
      return [op.to];
    default:
      return [];
  }
}

function trim(line: string): string {
  const collapsed = line.trim();
  return collapsed.length <= 90 ? collapsed : `${collapsed.slice(0, 87)}…`;
}
