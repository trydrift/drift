import type { Ecosystem } from '../types.js';
import { PACKAGE_MANAGERS } from './package-manager.js';
import { IGNORED_DIRECTORIES } from '../index/walk.js';
import type { WorkspaceFs } from './workspace.js';

/**
 * Undeclared nested projects.
 *
 * `detectWorkspaces` only recognises *formal* workspace protocols — an npm
 * `workspaces` field, `pnpm-workspace.yaml`, a Cargo `[workspace]`, and so
 * on. Plenty of repositories are multi-project without ever declaring that:
 * a root package plus a `extension/` or `cli/` subdirectory with its own
 * manifest, tied together by nothing but being checked out together. This
 * module finds those by walking the tree for manifests, rather than reading
 * a declaration.
 *
 * A directory that owns its own `.git` is a different case entirely — a
 * genuinely separate repository (most often a submodule), not a sibling
 * package of this one. It is reported so the caller can offer it as its own
 * scan root, but the walk does not descend into it: whatever is inside
 * belongs to that repository's own discovery pass, not this one's.
 */
export interface NestedProject {
  /** Repo-relative, `/`-separated. Never `''` — the root itself is not nested. */
  dir: string;
  ecosystem: Ecosystem;
  /** Repo-relative path of the manifest that was found. */
  manifestPath: string;
  /** This directory has its own `.git` — a separate repository, not a sub-package. */
  hasOwnGit: boolean;
}

const ALL_MANIFESTS = new Set(PACKAGE_MANAGERS.flatMap((manager) => manager.manifests));

/** First manager to claim a manifest name wins the ecosystem label. */
const MANIFEST_ECOSYSTEM = new Map<string, Ecosystem>();
for (const manager of PACKAGE_MANAGERS) {
  for (const manifest of manager.manifests) {
    if (!MANIFEST_ECOSYSTEM.has(manifest)) MANIFEST_ECOSYSTEM.set(manifest, manager.ecosystem);
  }
}

/**
 * Walk `root` for manifests outside any declared workspace member.
 *
 * `exclude` is the set of directories a formal workspace declaration already
 * covers (pass `memberDirectories(...)` from `detectWorkspaces`'s result) so
 * a declared member is never reported twice, once by name and once by walk.
 *
 * Depth is capped generously as a runaway-symlink guard, not as the real
 * boundary — `IGNORED_DIRECTORIES` and the git-boundary stop below do the
 * actual work of keeping this fast.
 */
export async function discoverNestedProjects(
  root: string,
  fs: WorkspaceFs,
  exclude: readonly string[] = [],
  maxDepth = 8,
): Promise<NestedProject[]> {
  const excluded = new Set(exclude);
  const found: NestedProject[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await fs.readDirectory(join(root, dir));
    if (entries.length === 0) return;

    let hasOwnGit = false;
    if (dir !== '' && !excluded.has(dir)) {
      hasOwnGit = entries.includes('.git');
      const manifest = entries.find((entry) => ALL_MANIFESTS.has(entry));
      if (manifest && (hasOwnGit || !isFixtureOwned(dir))) {
        found.push({
          dir,
          ecosystem: MANIFEST_ECOSYSTEM.get(manifest)!,
          manifestPath: join(dir, manifest),
          hasOwnGit,
        });
      }
    }

    // A separate repository's contents belong to its own discovery pass.
    if (hasOwnGit) return;

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      if (entry.startsWith('.') && entry !== '.github') continue;
      const child = join(dir, entry);
      if (excluded.has(child)) continue;
      if (await fs.isDirectory(join(root, child))) await visit(child, depth + 1);
    }
  };

  await visit('', 0);
  return found;
}

/**
 * Test registries and checked-in fixtures often contain complete package
 * manifests. They are inputs to the repository's tests, not projects the
 * repository owns for dependency scanning. Keep walking the tree so a real
 * sibling project is still found, but do not surface manifests below these
 * explicit fixture roots.
 */
function isFixtureOwned(dir: string): boolean {
  const segments = dir.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  return segments.some((segment, index) => {
    if (segment !== 'test' && segment !== 'tests') return false;
    const next = segments[index + 1];
    return next === 'registry' || next === 'testdata';
  });
}

/** `/`-joined, skipping empty segments — these are all repo-relative paths. */
function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}
