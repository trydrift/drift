import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Is this module the file Node was actually asked to run?
 *
 * Every script here doubles as an importable module so its logic can be
 * tested, which means each needs to know whether it is the entry point. The
 * obvious comparison — `resolve(process.argv[1])` against
 * `fileURLToPath(import.meta.url)` — compares two paths that can name the same
 * file and still differ as strings:
 *
 *   - macOS puts temporary directories under `/var`, which is a symlink to
 *     `/private/var`. Node resolves a module's URL through the real path while
 *     `argv[1]` keeps whatever the caller typed, so the two sides disagree and
 *     the script silently does nothing.
 *   - npm installs binaries as symlinks in `node_modules/.bin`, with the same
 *     result.
 *
 * Both sides are therefore canonicalised the same way, through the filesystem
 * rather than through string rules. This is not a `/private/var` special case:
 * it is the general question "are these the same file", asked properly.
 *
 * A path that cannot be resolved (deleted mid-run, a virtual entry point)
 * falls back to its absolute form, which is what the comparison did before.
 */
export function isDirectExecution(moduleUrl, invoked = process.argv[1]) {
  if (!invoked) return false;
  return canonicalPath(invoked) === canonicalPath(fileURLToPath(moduleUrl));
}

export function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
