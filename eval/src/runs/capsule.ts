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

  for (const entry of files) {
    hash.update(entry.relativePath);
    hash.update('\0');
    hash.update(canonicalBytes(await readFile(entry.path)));
    hash.update('\0');
  }

  return hash.digest('hex');
}

interface CapsuleFile {
  path: string;
  /** Separator-normalized and relative, which is both what is hashed and what the sort is by. */
  relativePath: string;
}

/**
 * Every capsule file, sorted by its *normalized* relative path.
 *
 * Sorting by the OS-separator form would order a Windows checkout differently
 * from a POSIX one for any path with a directory component, and a different
 * order is a different hash — which would make the same corpus disagree with
 * itself across platforms.
 */
async function listCapsuleFiles(root: string): Promise<CapsuleFile[]> {
  const found: CapsuleFile[] = [];

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
      if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) {
        const path = join(dir, entry.name);
        found.push({ path, relativePath: relative(root, path).split(sep).join('/') });
      }
    }
  };

  await walk(root);
  return found.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

function canonicalBytes(content: Buffer): Buffer {
  if (content.includes(0)) return content;
  return Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}
