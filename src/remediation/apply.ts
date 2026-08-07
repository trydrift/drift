import { applyCodemodTransform } from '../codemod/index.js';
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
