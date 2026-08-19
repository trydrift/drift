import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { publicCaseDir } from '../case/load.ts';

/**
 * A content hash of everything a prediction could see.
 *
 * The artifact previously pinned `case.yml` alone, which is metadata. What a
 * prediction actually reads is the consumer source, the `before/` manifest,
 * both frozen upstream trees, the frozen prose evidence, and any lockfile —
 * none of which `case.yml` covers. Editing a consumer file, correcting a
 * `.d.ts`, or adding a changelog therefore changed what Drift was asked to do
 * while leaving every past artifact looking current, and a paid trial could be
 * re-scored against evidence it never saw without anything saying so.
 *
 * So the whole public capsule is hashed. Private material is *structurally*
 * outside it — the capsule is `eval/cases/public/<id>`, and truth lives in
 * `eval/cases/private/<id>` — which keeps two things separate that are
 * genuinely separate concerns: what the predictor saw, and what the reviewers
 * later decided about it. Ground truth is allowed to improve after a
 * prediction was made (that is the entire point of adjudication being
 * append-only and re-runnable), and an evaluator that treated a new
 * adjudication as evidence staleness would make every truth correction
 * discard the trials it was meant to re-score. The adjudication's own revision
 * is recorded separately, beside each result, so a reader can always see which
 * truth a number came from.
 *
 * Properties, all of which have a regression test:
 *
 * - **Deterministic** — sorted paths, no timestamps, no absolute paths.
 * - **Path-sensitive** — moving a file's content to a different name changes
 *   the hash; the path is fed in beside the content.
 * - **Content-sensitive** — one byte anywhere changes it.
 * - **Ordering-independent** — directory read order cannot affect it.
 * - **Platform-independent where it can be** — separators are normalized, and
 *   CRLF is folded to LF for text files so a Windows checkout of the same
 *   corpus agrees with a POSIX one. Binary files (anything containing a NUL)
 *   are hashed byte-for-byte, because folding bytes there could make two
 *   different files agree.
 */

export const CAPSULE_HASH_VERSION = 'drift-bench-capsule-v1';

/**
 * Directories that are never part of the capsule.
 *
 * `.git` and `node_modules` are regenerable; `.drift` and `node_modules/.cache`
 * are run state a materialization or an install may leave behind. None of them
 * is evidence, and including them would make the hash depend on whether
 * someone had run an install in the source tree.
 */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.drift', '.turbo', '.cache']);

/** Files that are run state rather than case material. */
const EXCLUDED_FILES = new Set(['.DS_Store', 'npm-debug.log', '.npmrc-generated']);

export async function hashPublicCapsule(caseId: string, root?: string): Promise<string> {
  return hashCapsuleDir(publicCaseDir(caseId, root));
}

/** The same hash over an explicit directory, so a test can build a capsule without a corpus. */
export async function hashCapsuleDir(dir: string): Promise<string> {
  const files = await listCapsuleFiles(dir);
  const hash = createHash('sha256');
  hash.update(CAPSULE_HASH_VERSION);
  hash.update('\0');

  for (const path of files) {
    const relativePath = relative(dir, path).split(sep).join('/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(canonicalBytes(await readFile(path)));
    hash.update('\0');
  }

  return hash.digest('hex');
}

/** Every capsule file, sorted by repo-relative path so read order cannot matter. */
async function listCapsuleFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) await walk(join(dir, entry.name));
        continue;
      }
      // A symlink is not followed and not hashed as content: its target is
      // outside the capsule by definition, and the isolation audit already
      // refuses a workspace containing one that leaves.
      if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) found.push(join(dir, entry.name));
    }
  };

  await walk(root);
  return found.sort((a, b) => (relative(root, a) < relative(root, b) ? -1 : 1));
}

function canonicalBytes(content: Buffer): Buffer {
  if (content.includes(0)) return content;
  return Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}
