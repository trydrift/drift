import { applyCodemodTransform } from '../codemod/index.js';
import { applyFixPlanToContent } from '../fixplan/execute.js';
import { summarizeFixPlan } from '../fixplan/document.js';
import type { CommitUnit } from '../types.js';

export interface AppliedCodemodEdit {
  path: string;
  content: string;
}

export interface ApplyCodemodResult {
  status: 'applied' | 'no-changes';
  edits: AppliedCodemodEdit[];
  message: string;
}

/**
 * Apply a commit's built-in deterministic codemod to file contents in hand.
 *
 * Framework-free counterpart to the VS Code extension's `applyCommitCodemod`
 * (`extension/src/fix.ts`) — same re-apply-against-live-content approach via
 * the shared `applyCodemodTransform`, for callers (CLI, Action) that read
 * files from a worktree or an API response instead of the editor's document
 * model. Returns `no-changes` rather than an error when nothing moved, e.g.
 * because an earlier commit in the same run already applied it.
 */
export function applyBuiltinCodemod(
  commit: CommitUnit,
  files: ReadonlyMap<string, string>,
): ApplyCodemodResult {
  const byPath = new Map(files);

  for (const transform of commit.codemod ?? []) {
    for (const file of transform.files) {
      const content = byPath.get(file);
      if (content === undefined) continue;
      byPath.set(file, applyCodemodTransform(content, transform, file));
    }
  }

  const edits: AppliedCodemodEdit[] = [];
  for (const [path, original] of files) {
    const updated = byPath.get(path);
    if (updated !== undefined && updated !== original) edits.push({ path, content: updated });
  }

  if (edits.length === 0) {
    return {
      status: 'no-changes',
      edits: [],
      message: 'The deterministic fix produced no changes here — likely already applied by an earlier commit.',
    };
  }

  const fileCount = new Set(edits.map((edit) => edit.path)).size;
  const ruleCount = commit.codemod?.length ?? 0;
  return {
    status: 'applied',
    edits,
    message: `Applied ${ruleCount} deterministic rename${ruleCount === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'} — no agent call was made.`,
  };
}

/**
 * Apply a commit's validated fix plan to file contents in hand.
 *
 * The counterpart to `applyBuiltinCodemod` for the tier above it, and
 * deliberately the same shape: re-derive the edit from the rule and its
 * anchors against whatever the file actually holds now, rather than writing
 * back a snapshot taken at analysis time. A plan can be applied long after it
 * was validated, and after earlier commit units in the same run have already
 * shifted lines above these.
 *
 * This never consults `dispositionFor` — deciding *whether* to apply a plan
 * is the caller's job and happens once per surface, before this is reached.
 * Mixing the two would put the policy in a function that three surfaces call
 * from four places, which is how the policy stops being one policy.
 */
export function applyCommitFixPlan(
  commit: CommitUnit,
  files: ReadonlyMap<string, string>,
): ApplyCodemodResult {
  const fixPlan = commit.fixPlan;
  if (!fixPlan) {
    return { status: 'no-changes', edits: [], message: 'This commit has no fix plan.' };
  }

  const byPath = new Map(files);
  for (const file of fixPlan.files) {
    const content = byPath.get(file);
    if (content === undefined) continue;
    byPath.set(file, applyFixPlanToContent(content, fixPlan.plan.ops, fixPlan.anchors, file));
  }

  const edits: AppliedCodemodEdit[] = [];
  for (const [path, original] of files) {
    const updated = byPath.get(path);
    if (updated !== undefined && updated !== original) edits.push({ path, content: updated });
  }

  if (edits.length === 0) {
    return {
      status: 'no-changes',
      edits: [],
      message: 'The fix plan produced no changes here — likely already applied by an earlier commit.',
    };
  }

  const fileCount = new Set(edits.map((edit) => edit.path)).size;
  const summary = summarizeFixPlan({
    plan: fixPlan.plan,
    verdict: fixPlan.residual === 0 ? 'accepted' : 'partial',
    assurance: fixPlan.assurance,
    sites: [],
    covered: fixPlan.covered,
    residual: fixPlan.residual,
    rejections: [],
    anchors: fixPlan.anchors,
  });

  return {
    status: 'applied',
    edits,
    message:
      `Applied fix plan \`${fixPlan.plan.id}\` — ${summary} — across ${fileCount} file${fileCount === 1 ? '' : 's'}.` +
      (fixPlan.residual > 0
        ? ` ${fixPlan.residual} call site${fixPlan.residual === 1 ? '' : 's'} remain${fixPlan.residual === 1 ? 's' : ''} for an agent.`
        : ' No agent call was made.'),
  };
}
