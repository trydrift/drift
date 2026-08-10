import { join } from 'node:path';
import type { WorkspaceFs } from '../detect/workspace.js';
import {
  conventionalTypeEntries,
  expandTypesEntry,
  extractExports,
  relativeReExports,
  resolveRelative,
  typesFromExports,
  type ExportAlias,
  type SurfaceApi,
} from '../evidence/type-surface.js';

/**
 * The other half of `evidence/type-surface.ts`: the same declaration-surface
 * extraction, pointed at `node_modules` instead of a registry.
 *
 * `type-surface.ts` fetches two *published* versions because a version diff
 * needs both ends and the old one is never on disk once an upgrade lands. The
 * audit has no such problem — it asks one question about one version, the one
 * actually installed — so there is nothing to fetch. The package is already
 * sitting in the checkout, and reading it from there is strictly more honest
 * than asking a CDN what it thinks got published: this is the literal file
 * Node or `tsc` resolves right now, not a mirror's copy of it.
 *
 * Reading only `.d.ts` text off disk, never executing package code, keeps the
 * same guarantee `type-surface.ts` documents for its own fetches.
 */

export type InstalledSurfaceResult =
  | { status: 'found'; api: SurfaceApi; entryPath: string }
  | { status: 'not-installed' }
  | { status: 'no-declarations' };

interface Manifest {
  types?: string;
  typings?: string;
  exports?: unknown;
  main?: string;
}

/**
 * Read the currently-installed package's real, on-disk declaration surface.
 *
 * Looks in the workspace member's own `node_modules` first, then the
 * repository root's — the same order a Node resolver would walk, and enough
 * to cover both a per-member install and the ordinary hoisted-to-root case
 * every major package manager defaults to.
 */
export async function readInstalledSurface(
  root: string,
  member: string | undefined,
  packageName: string,
  fs: WorkspaceFs,
): Promise<InstalledSurfaceResult> {
  const packageDir = await resolvePackageDir(root, member, packageName, fs);
  if (!packageDir) return { status: 'not-installed' };

  const raw = await fs.readFile(join(packageDir, 'package.json'));
  const manifest: Manifest | null = raw ? parseJson<Manifest>(raw) : null;

  const entryPath = await resolveInstalledTypesEntry(packageDir, packageName, manifest, fs);
  if (entryPath) {
    const sources = await collectInstalledDeclarationSources(packageDir, entryPath, fs);
    const surface = sources.length > 0 ? buildSurface(sources) : null;
    if (surface) return { status: 'found', api: surface, entryPath };
  }

  // The package ships no declarations of its own; a separately installed
  // `@types/*` package, resolved the same way, still answers the question.
  const dtName = packageName.startsWith('@')
    ? `@types/${packageName.slice(1).replace('/', '__')}`
    : `@types/${packageName}`;
  const dtDir = await resolvePackageDir(root, member, dtName, fs);
  const dtContent = dtDir ? await fs.readFile(join(dtDir, 'index.d.ts')) : null;
  if (dtContent === null) return { status: 'no-declarations' };

  const surface = buildSurface([{ path: 'index.d.ts', content: dtContent }]);
  return surface ? { status: 'found', api: surface, entryPath: `${dtName}/index.d.ts` } : { status: 'no-declarations' };
}

function buildSurface(sources: readonly { path: string; content: string }[]): SurfaceApi | null {
  const api: SurfaceApi = new Map();
  const aliases: ExportAlias[] = [];
  for (const source of sources) extractExports(source.content, source.path, api, aliases);
  resolveAliasesInto(api, aliases);
  return api.size > 0 ? api : null;
}

async function resolvePackageDir(
  root: string,
  member: string | undefined,
  packageName: string,
  fs: WorkspaceFs,
): Promise<string | null> {
  const bases = member ? [join(root, member), root] : [root];
  for (const base of bases) {
    const candidate = join(base, 'node_modules', ...packageName.split('/'));
    if (await fs.isDirectory(candidate)) return candidate;
  }
  return null;
}

/**
 * Same resolution order as `resolveTypesEntry` in `type-surface.ts`, minus the
 * DefinitelyTyped fallback — that one needs a registry fetch by construction,
 * which is exactly the round trip this module exists to avoid. A package with
 * `@types/*` types installed alongside it is still covered: that package is
 * looked up on disk the same way, under its own name.
 */
async function resolveInstalledTypesEntry(
  packageDir: string,
  packageName: string,
  manifest: Manifest | null,
  fs: WorkspaceFs,
): Promise<string | null> {
  if (manifest) {
    const declared = manifest.types ?? manifest.typings ?? typesFromExports(manifest.exports);
    if (declared) {
      for (const candidate of expandTypesEntry(normalizePath(declared))) {
        if (await fs.readFile(join(packageDir, candidate))) return candidate;
      }
    }

    if (manifest.main) {
      const sibling = normalizePath(manifest.main).replace(/\.(c|m)?js$/, '.d.ts');
      if (await fs.readFile(join(packageDir, sibling))) return sibling;
    }
  }

  for (const candidate of conventionalTypeEntries(packageName)) {
    if (await fs.readFile(join(packageDir, candidate))) return candidate;
  }

  return null;
}

/** Disk analogue of `collectDeclarationSources`: same barrel-following, no network. */
async function collectInstalledDeclarationSources(
  packageDir: string,
  entryPath: string,
  fs: WorkspaceFs,
): Promise<Array<{ path: string; content: string }>> {
  const MAX_FILES = 25;
  const sources: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  const queue: string[][] = [[entryPath]];

  while (queue.length > 0 && sources.length < MAX_FILES) {
    const candidates = queue.shift()!.filter((path) => !seen.has(path));
    if (candidates.length === 0) continue;

    let resolved: { path: string; content: string } | null = null;
    for (const path of candidates) {
      seen.add(path);
      const content = await fs.readFile(join(packageDir, path));
      if (content !== null) {
        resolved = { path, content };
        break;
      }
    }
    if (!resolved) continue;

    sources.push(resolved);
    for (const specifier of relativeReExports(resolved.content)) {
      queue.push(resolveRelative(resolved.path, specifier));
    }
  }

  return sources;
}

function resolveAliasesInto(api: SurfaceApi, aliases: readonly ExportAlias[]): void {
  for (const alias of aliases) {
    if (api.has(alias.exported)) continue;
    const entry = api.get(alias.local);
    if (entry) api.set(alias.exported, { ...entry, name: alias.exported });
  }
}

function normalizePath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
