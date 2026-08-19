import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { walkPaths } from '../util/walk.ts';

/**
 * A `RepoProvider` over a materialized case, so the end-to-end adapter can
 * drive the *real* `analyzeRepository()` instead of hand-building a
 * `DependencyChange`.
 *
 * This is the correction that makes an end-to-end claim honest. Production
 * starts by collecting manifest snapshots at two refs, diffing them
 * (`detectChanges`), labelling workspace members, and triaging against
 * `drift.yml`. An adapter that skips to `gatherEvidence` with a
 * `DependencyChange` it constructed itself has silently marked all of that
 * correct, and monorepos, nested projects, multiple package managers, and
 * config exclusions are exactly where it is not.
 *
 * `RepoProvider` is a genuine production seam — `LocalGitProvider` implements
 * the same three methods against a git checkout — so nothing here is a
 * benchmark-only reimplementation of pipeline behaviour. The two refs are the
 * case's frozen `before/` manifests and its bump-only `consumer/` tree.
 */

export const CASE_BEFORE_REF = 'case-before';
export const CASE_AFTER_REF = 'case-after';

export interface CaseRepoProviderOptions {
  /** The bump-only consumer tree. Served as `CASE_AFTER_REF`. */
  workspaceRoot: string;
  /** Manifests and lockfiles as at the base commit. Served as `CASE_BEFORE_REF`. */
  beforeDir: string;
}

export class CaseRepoProvider {
  private readonly workspaceRoot: string;
  private readonly beforeDir: string;

  constructor(options: CaseRepoProviderOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.beforeDir = options.beforeDir;
  }

  /**
   * Every manifest/lockfile the case froze a `before` copy of.
   *
   * Deliberately derived from `before/` rather than from a hard-coded manifest
   * name list: a case that froze `packages/api/package.json` is telling us that
   * is where its change lives, and a name list would have to be kept in sync
   * with `src/detect/manifest-globs.ts` forever. Production's own
   * `isManifestPath` filter still runs downstream, so a stray file here is
   * ignored rather than misinterpreted.
   */
  async changedFiles(): Promise<string[]> {
    const paths = await walkPaths(this.beforeDir);
    const changed: string[] = [];
    for (const path of paths) {
      const rel = relative(this.beforeDir, path).split(sep).join('/');
      const before = await this.readFile(rel, CASE_BEFORE_REF);
      const after = await this.readFile(rel, CASE_AFTER_REF);
      if (before !== after) changed.push(rel);
    }
    return changed.sort();
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    const base = ref === CASE_BEFORE_REF ? this.beforeDir : this.workspaceRoot;
    try {
      return await readFile(join(base, path), 'utf8');
    } catch {
      // `null` is meaningful: production reads it as "this file does not exist
      // at that ref", which is how a newly added manifest is detected.
      return null;
    }
  }

  /**
   * Only the after-ref can be listed, because only it is a whole tree.
   *
   * Returning `[]` for the before-ref would be a lie production acts on —
   * `listFiles` documents that `null` means "unknown" and `[]` means "this
   * repository genuinely has no files", and a config glob expanded against a
   * false `[]` would report a clean result for files nobody looked at.
   */
  async listFiles(ref: string): Promise<string[] | null> {
    if (ref !== CASE_AFTER_REF) return null;
    const paths = await walkPaths(this.workspaceRoot);
    return paths.map((path) => relative(this.workspaceRoot, path).split(sep).join('/')).sort();
  }
}
