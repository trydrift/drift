import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * The repository file a verification diagnostic names, or `null`.
 *
 * A measured impact site is Drift's strongest claim — "this line broke, we ran
 * the checks" — so the path in it has to be a file in the repository, not
 * text that happened to precede `:line` in a tool's output. Parsers are
 * format-driven and will always see new shapes: Node's test runner prints
 * `test at test/files.test.js:1:1`, a stack frame prints
 * `at Object.<anonymous> (/tmp/worktree/src/x.ts:1:2561)`. Rejecting each
 * shape as it is discovered does not converge. This check does: whatever the
 * parser produced, it becomes a site only if it resolves to a regular file
 * inside the checkout.
 *
 * - A relative path is tried under the member directory the check ran in,
 *   then from the repository root (tools differ in which they print).
 * - An absolute path is accepted only when, after resolving symlinks (macOS
 *   temp directories live under `/private/var`), it lies inside the checkout.
 * - Anything that escapes the checkout, lies under `.git/` (where the
 *   verification worktrees are), or does not exist is rejected.
 *
 * Returns the repository-relative, `/`-separated path.
 */
export async function resolveMeasuredPath(workspace: string, dir: string, file: string): Promise<string | null> {
  const raw = file.replace(/\\/g, '/').trim();
  if (!raw || /[\n\r\0]/.test(raw)) return null;

  let root: string;
  try {
    root = await realpath(workspace);
  } catch {
    return null;
  }

  const candidates = isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)
    ? [raw]
    : [...new Set([dir ? join(root, dir, raw) : null, join(root, raw)].filter((c): c is string => c !== null))];

  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
    } catch {
      continue;
    }
    const rel = relative(root, resolved);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    // Verification runs in scratch worktrees under `.git/`; a path into one is
    // inside the checkout on disk but is not a file of the repository.
    if (rel.split(sep).includes('.git')) continue;
    return rel.split(sep).join('/');
  }
  return null;
}
