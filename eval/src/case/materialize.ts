import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditWorkspaceIsolation, type PredictionWorkspace } from './layers.ts';
import { publicCaseDir } from './load.ts';
import { privateCasesRoot } from './private.ts';
import type { PublicCase } from './schema.ts';

/**
 * Builds the disposable workspace a prediction runs against, and proves it
 * isolated before handing it over.
 *
 * The public case directory is laid out so that the workspace *is* the
 * bump-only state — the causal construction BUMP and DepBench both use:
 *
 *   consumer/         the consumer at its base commit with ONLY the dependency
 *                     manifest/lockfile bump applied. Source is untouched, so
 *                     this is exactly the state a developer lands in when a
 *                     Dependabot PR turns red.
 *   before/           the manifest and lockfile as they read at the base
 *                     commit, and nothing else. This is what makes real
 *                     manifest *detection* measurable: the end-to-end adapter
 *                     diffs `before/` against `consumer/` through a
 *                     `RepoProvider`, exactly as production diffs two git
 *                     refs.
 *   upstream/old|new/ the frozen package trees for the two exact versions.
 *   evidence/         frozen upstream prose (changelog, release notes,
 *                     migration guide) as it existed, so an offline run reads
 *                     the same evidence a networked one would.
 *
 * Nothing from `eval/cases/private/` is ever copied, and the audit that proves
 * it runs on every materialization rather than in a test only — the property
 * has to hold for the run that actually spent money, not for a fixture.
 */

export interface MaterializedCase extends PredictionWorkspace {
  /** Manifest/lockfile contents as at the base commit, keyed repo-relative. Served as the `before` ref. */
  beforeDir: string;
  /** Frozen upstream prose directory, or `null` when the case froze none. */
  evidenceDir: string | null;
  /** Removes the whole temp tree. Callers must call this in a `finally`. */
  teardown: () => Promise<void>;
}

export async function materializeCase(publicCase: PublicCase, root?: string): Promise<MaterializedCase> {
  const source = publicCaseDir(publicCase.id, root);
  const temp = await mkdtemp(join(tmpdir(), `drift-capsule-${publicCase.id}-`));
  const teardown = () => rm(temp, { recursive: true, force: true });

  try {
    const workspaceRoot = join(temp, 'consumer');
    const beforeDir = join(temp, 'before');
    const upstreamOldDir = join(temp, 'upstream', 'old');
    const upstreamNewDir = join(temp, 'upstream', 'new');
    const evidenceDir = join(temp, 'evidence');

    // Copied one directory at a time, by name, rather than by copying the case
    // directory and deleting what should not be there. A copy-then-delete
    // would put private material inside the workspace for however long the
    // delete took, and would silently start including any new directory a
    // future case layout adds.
    await cp(join(source, 'consumer'), workspaceRoot, { recursive: true });
    await copyIfPresent(join(source, 'before'), beforeDir);
    await copyIfPresent(join(source, 'upstream', 'old'), upstreamOldDir);
    await copyIfPresent(join(source, 'upstream', 'new'), upstreamNewDir);
    const hasEvidence = await copyIfPresent(join(source, 'evidence'), evidenceDir);

    const auditedPaths = await auditWorkspaceIsolation(workspaceRoot, privateCasesRoot(root));

    return {
      root: workspaceRoot,
      beforeDir,
      upstreamOldDir,
      upstreamNewDir,
      evidenceDir: hasEvidence ? evidenceDir : null,
      auditedPaths,
      teardown,
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}

async function copyIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await readdir(from);
  } catch {
    return false;
  }
  await cp(from, to, { recursive: true });
  return true;
}
