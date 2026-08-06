import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fetchJson, fetchText } from '../util/http.js';
import type { BehaviouralEnvironment } from './behavioural.js';

/**
 * Resolving where a behavioural probe's code actually lives — for a version
 * already on disk, or for one that must be fetched.
 *
 * The old version of a dependency is, by definition, no longer in
 * `node_modules` once an upgrade has landed, which is the same problem
 * `evidence/type-surface.ts` solves for declarations. This does the equivalent
 * for executable code: read the entry file jsDelivr serves for a pinned
 * version, rather than requiring an install.
 */

interface NpmManifest {
  main?: string;
  module?: string;
  exports?: unknown;
}

/** The file a package's default import resolves to, from its own manifest. */
export function resolveJsEntry(pkg: NpmManifest): string {
  return jsFromExports(pkg.exports) ?? pkg.module ?? pkg.main ?? 'index.js';
}

function jsFromExports(exportsField: unknown): string | null {
  if (typeof exportsField === 'string') return exportsField;
  if (!exportsField || typeof exportsField !== 'object') return null;

  const record = exportsField as Record<string, unknown>;
  const root = '.' in record ? record['.'] : record;

  const visit = (node: unknown, depth: number): string | null => {
    if (depth > 6 || node == null) return null;
    if (typeof node === 'string') return node;
    if (typeof node !== 'object') return null;

    const rec = node as Record<string, unknown>;
    for (const key of ['import', 'require', 'default', 'node']) {
      if (!(key in rec)) continue;
      const found = visit(rec[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(root, 0);
}

/** A package already on disk — the common case for the version currently installed. */
export async function localPackageEnvironment(
  label: BehaviouralEnvironment['label'],
  packageRoot: string,
): Promise<BehaviouralEnvironment | null> {
  try {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as NpmManifest;
    const root = resolve(packageRoot);
    return { label, packageRoot: root, modulePath: resolve(root, resolveJsEntry(pkg)) };
  } catch {
    return null;
  }
}

const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/npm';

/**
 * Fetch one published npm version's entry module into a fresh temp directory.
 *
 * Bounded to the resolved entry file only: a package whose entry imports
 * sibling files still probes, but the worker reports `worker-failed` for the
 * unresolved import rather than crashing — the same degrade every dependency
 * this probe cannot fully read already gets. Fetching only what is needed
 * keeps this from turning into a package installer.
 */
export async function fetchedPackageEnvironment(
  label: BehaviouralEnvironment['label'],
  name: string,
  version: string,
): Promise<BehaviouralEnvironment | null> {
  const manifest = await fetchJson<NpmManifest>(`${JSDELIVR_CDN}/${name}@${version}/package.json`);
  if (!manifest) return null;

  const entry = resolveJsEntry(manifest).replace(/^\.\//, '');
  const content = await fetchText(`${JSDELIVR_CDN}/${name}@${version}/${entry}`);
  if (content === null) return null;

  const dir = await mkdtemp(join(tmpdir(), 'drift-behavioural-env-'));
  const entryPath = join(dir, entry);
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, content);
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));

  return { label, packageRoot: await realpath(dir), modulePath: await realpath(entryPath) };
}
