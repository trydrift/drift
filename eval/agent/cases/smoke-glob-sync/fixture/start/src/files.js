import { statSync } from 'node:fs';
import { join } from 'node:path';
import glob from 'glob';

/**
 * Every file under `root` matching `pattern`, as root-relative paths in
 * sorted order. Directories are never returned.
 */
export function findAll(pattern, root) {
  return glob.sync(pattern, { cwd: root, nodir: true }).sort();
}

/** The same listing, restricted to files modified after `since` (a Date). */
export function findModifiedSince(pattern, root, since) {
  const matches = glob.sync(pattern, { cwd: root, nodir: true, dot: true });
  return matches.filter((path) => statSync(join(root, path)).mtime > since).sort();
}
