import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execCommand } from '../../../dist/util/exec.js';

/**
 * What a full-pipeline or component-adapter repair actually did, captured
 * from real file edits rather than asserted. Shared by every adapter that
 * applies a deterministic repair so patch generation and scope-escape
 * detection are computed identically everywhere, not reimplemented per
 * adapter.
 */
export interface RepairCapture {
  /** Every file whose content the repair actually changed (post !== pre). */
  changedFiles: string[];
  /**
   * `changedFiles` minus the union of every repairable commit's own
   * `allowedFiles` — files Drift's own plan did not declare it would touch.
   * A hard production-safety signal, distinct from a benchmark disagreement
   * about which allowed file *should* have changed (see `eval/src/score.ts`,
   * which scores that separately against adjudicated `expectedChangedFiles`).
   */
  productionScopeEscapeFiles: string[];
  /** Unified diff of every changed file, before -> after, in `git diff --no-index a b` shape. */
  patch: string;
}

interface RepairEdit {
  path: string;
  content: string;
}

export interface RepairCaptureBuilder {
  /**
   * Records one commit's applied edits. `before` must contain every file the
   * commit was allowed to read (its `commit.allowedFiles`, snapshotted before
   * `edits` were applied) so an edit that leaves content unchanged is not
   * mistaken for a real change.
   */
  recordCommit(allowedFiles: readonly string[], before: ReadonlyMap<string, string>, edits: readonly RepairEdit[]): void;
  finalize(): Promise<RepairCapture>;
}

export function createRepairCaptureBuilder(): RepairCaptureBuilder {
  const allowedUnion = new Set<string>();
  const snapshots = new Map<string, { before: string; after: string }>();

  return {
    recordCommit(allowedFiles, before, edits) {
      for (const file of allowedFiles) allowedUnion.add(file);
      for (const edit of edits) {
        const beforeContent = before.get(edit.path) ?? '';
        if (edit.content === beforeContent) continue;
        snapshots.set(edit.path, { before: beforeContent, after: edit.content });
      }
    },
    async finalize() {
      const changedFiles = [...snapshots.keys()].sort();
      const productionScopeEscapeFiles = changedFiles.filter((file) => !allowedUnion.has(file)).sort();
      const patch = await buildPatch(changedFiles.map((path) => ({ path, ...snapshots.get(path)! })));
      return { changedFiles, productionScopeEscapeFiles, patch };
    },
  };
}

/** An empty, no-repair-attempted capture, so callers never have to special-case "finalize() was never called". */
export const EMPTY_REPAIR_CAPTURE: RepairCapture = { changedFiles: [], productionScopeEscapeFiles: [], patch: '' };

/**
 * Diffs `before`/`after` snapshots by writing them into disposable `a`/`b`
 * staging directories and running a real `git diff --no-index a b` — the
 * same mechanism `unifiedDiffText` (src/evidence/version-diff.ts) uses for
 * production's own upstream-version diff, so this is not a second,
 * independently-drifting diff implementation. Relative `a/`/`b/` staging
 * paths mean the resulting patch text never contains a temp-directory path,
 * so it stays comparable across separate runs' separate `mkdtemp` calls.
 */
async function buildPatch(files: readonly { path: string; before: string; after: string }[]): Promise<string> {
  if (files.length === 0) return '';
  const staging = await mkdtemp(join(tmpdir(), 'drift-eval-repair-patch-'));
  try {
    for (const file of files) {
      const aPath = join(staging, 'a', file.path);
      const bPath = join(staging, 'b', file.path);
      await mkdir(dirname(aPath), { recursive: true });
      await mkdir(dirname(bPath), { recursive: true });
      await writeFile(aPath, file.before, 'utf8');
      await writeFile(bPath, file.after, 'utf8');
    }
    const result = await execCommand('git', ['diff', '--no-index', 'a', 'b'], {
      cwd: staging,
      maxBuffer: 16 * 1024 * 1024,
    });
    // `git diff --no-index` exits 1 when the compared trees differ (the
    // ordinary case here) and only >1 on an actual failure to run the diff.
    return result.code <= 1 ? result.stdout : '';
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Strips noise that is real but irrelevant to whether two patches represent
 * the same edit: blob-hash `index` lines (depend on nothing about the edit's
 * content) and hunk-header line-number ranges (`@@ -1,4 +1,4 @@` -> `@@`,
 * shift with unrelated surrounding context). Never touches `+`/`-`/context
 * lines — the only place a semantic difference could hide.
 */
export function normalizePatch(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? line.replace(/^@@[^@]*@@/, '@@') : line))
    .join('\n')
    .trim();
}

/** Gold-patch exactness comparison, after canonical normalization on both sides. Pure — no filesystem, no adjudication lookup. */
export function goldPatchMatches(actualPatch: string, goldPatch: string): boolean {
  return normalizePatch(actualPatch) === normalizePatch(goldPatch);
}
