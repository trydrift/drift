import { readdirSync, readFileSync, statSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { DependencyChange, Ecosystem } from '../types.js';
import { tryJson } from './ecosystems/types.js';
import { scanTomlTables, parseTomlArray } from './ecosystems/toml.js';

/**
 * Workspace layouts.
 *
 * A monorepo is not one project with many manifests; it is many projects that
 * happen to share a checkout. Analysing them together is what produced Drift's
 * oldest known wrong answer — a bump in `packages/api` surfacing impact sites
 * in `packages/web`, which shares the dependency but was never touched.
 *
 * Detection is a function over a filesystem seam rather than over `node:fs`, so
 * the extension can supply VS Code's filesystem and the tests can supply a
 * literal tree.
 */

export interface WorkspaceFs {
  /** File content, or `null` when it does not exist or cannot be read. */
  readFile(path: string): Promise<string | null>;
  /** Entry names in a directory. Empty when the directory is unreadable. */
  readDirectory(path: string): Promise<string[]>;
  /** Is this path a directory? */
  isDirectory(path: string): Promise<boolean>;
}

export type WorkspaceKind =
  | 'npm-workspaces'
  | 'pnpm-workspace'
  | 'cargo-workspace'
  | 'go-work'
  | 'maven-modules'
  | 'gradle-settings'
  /** A sibling manifest found by walking the tree, not declared by any workspace protocol. */
  | 'undeclared-nested';

export interface WorkspaceMember {
  /** Directory relative to the repository root. `''` is the root itself. */
  dir: string;
  /** The package's own name, when its manifest declares one. */
  name: string | null;
  ecosystem: Ecosystem;
}

export interface WorkspaceLayout {
  kind: WorkspaceKind;
  ecosystem: Ecosystem;
  /** The file that declared the workspace, repo-relative. */
  declaredIn: string;
  members: WorkspaceMember[];
}

/** The seam backed by the real filesystem, for the CLI and the Action. */
export function nodeWorkspaceFs(): WorkspaceFs {
  return {
    async readFile(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    async readDirectory(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    async isDirectory(path) {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

/**
 * Every workspace declared at the repository root.
 *
 * A repository can hold more than one — a Cargo workspace and an npm workspace
 * in the same checkout is common in tools that ship a native core and a JS
 * wrapper — so this returns a list rather than picking a winner.
 */
export async function detectWorkspaces(root: string, fs: WorkspaceFs): Promise<WorkspaceLayout[]> {
  const layouts = await Promise.all([
    npmWorkspace(root, fs),
    pnpmWorkspace(root, fs),
    cargoWorkspace(root, fs),
    goWorkspace(root, fs),
    mavenWorkspace(root, fs),
    gradleWorkspace(root, fs),
  ]);

  // pnpm-workspace.yaml and a `workspaces` field can both exist; the pnpm file
  // is the one pnpm reads, so it wins for the npm ecosystem.
  const found = layouts.filter((l): l is WorkspaceLayout => l !== null);
  const pnpm = found.find((l) => l.kind === 'pnpm-workspace');
  return pnpm ? found.filter((l) => l.kind !== 'npm-workspaces') : found;
}

/**
 * The directories to analyse, in order.
 *
 * Falls back to the root alone, which is what a single-package repository is —
 * so callers need no special case for the ordinary project.
 */
export function memberDirectories(layouts: readonly WorkspaceLayout[]): string[] {
  const dirs = new Set<string>();
  for (const layout of layouts) for (const member of layout.members) dirs.add(member.dir);
  return dirs.size === 0 ? [''] : [...dirs].sort();
}

/**
 * Which member owns a file.
 *
 * Longest prefix wins, so a nested member inside another member's directory is
 * attributed to the nearer one. `null` means the file belongs to the repository
 * rather than to any package — a root config file, typically.
 */
export function memberOf(path: string, members: readonly string[]): string | null {
  let best: string | null = null;
  for (const dir of members) {
    if (dir === '') {
      if (best === null) best = '';
      continue;
    }
    if (path === dir || path.startsWith(`${dir}/`)) {
      if (best === null || dir.length > best.length) best = dir;
    }
  }
  return best;
}

/** Is this file inside the given member's directory? */
export function withinMember(path: string, member: string): boolean {
  return member === '' || path === member || path.startsWith(`${member}/`);
}

/**
 * Attribute each dependency change to the member whose manifest declared it.
 *
 * Returns the changes unchanged when there is no workspace, so a single-package
 * repository carries no labels it does not need — an empty label rendered next
 * to every finding is noise, and noise is what teaches people to stop reading.
 */
export function labelWorkspaces<T extends DependencyChange>(
  changes: readonly T[],
  layouts: readonly WorkspaceLayout[],
): T[] {
  if (layouts.length === 0) return [...changes];

  const dirs = memberDirectories(layouts);
  const names = new Map<string, string>();
  for (const layout of layouts) {
    for (const member of layout.members) if (member.name) names.set(member.dir, member.name);
  }

  return changes.map((change) => {
    const dir = memberOf(change.manifestPath, dirs);
    if (dir === null) return change;
    const name = names.get(dir);
    return { ...change, workspace: dir, ...(name ? { workspaceName: name } : {}) };
  });
}

/** How a member is named in output: its package name, else its directory. */
export function describeMember(change: DependencyChange): string | null {
  if (change.workspace === undefined) return null;
  return change.workspaceName ?? (change.workspace === '' ? 'the repository root' : change.workspace);
}

/* ------------------------------------------------------------------ */
/* Per-ecosystem declarations                                          */
/* ------------------------------------------------------------------ */

async function npmWorkspace(root: string, fs: WorkspaceFs): Promise<WorkspaceLayout | null> {
  const content = await fs.readFile(join(root, 'package.json'));
  if (!content) return null;

  const pkg = tryJson<{ workspaces?: string[] | { packages?: string[] }; name?: string }>(content);
  const patterns = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (!patterns || patterns.length === 0) return null;

  return {
    kind: 'npm-workspaces',
    ecosystem: 'npm',
    declaredIn: 'package.json',
    members: await resolveMembers(root, fs, patterns, 'npm', 'package.json', pkg?.name ?? null),
  };
}

async function pnpmWorkspace(root: string, fs: WorkspaceFs): Promise<WorkspaceLayout | null> {
  const content = await fs.readFile(join(root, 'pnpm-workspace.yaml'));
  if (!content) return null;

  let patterns: string[] = [];
  try {
    const doc = parseYaml(content) as { packages?: unknown } | null;
    if (Array.isArray(doc?.packages)) patterns = doc.packages.filter((p): p is string => typeof p === 'string');
  } catch {
    return null;
  }
  if (patterns.length === 0) return null;

  const rootName = tryJson<{ name?: string }>((await fs.readFile(join(root, 'package.json'))) ?? '')?.name ?? null;

  return {
    kind: 'pnpm-workspace',
    ecosystem: 'npm',
    declaredIn: 'pnpm-workspace.yaml',
    members: await resolveMembers(root, fs, patterns, 'npm', 'package.json', rootName),
  };
}

async function cargoWorkspace(root: string, fs: WorkspaceFs): Promise<WorkspaceLayout | null> {
  const content = await fs.readFile(join(root, 'Cargo.toml'));
  if (!content) return null;

  const tables = scanTomlTables(content);
  const workspace = tables.find((t) => t.header === 'workspace');
  if (!workspace) return null;

  const patterns = parseTomlArray(workspace.entries.get('members') ?? '');
  // A virtual manifest declares members and no package of its own.
  const rootIsPackage = tables.some((t) => t.header === 'package');
  const rootName = rootIsPackage
    ? stripQuotes(tables.find((t) => t.header === 'package')?.entries.get('name') ?? '')
    : null;

  return {
    kind: 'cargo-workspace',
    ecosystem: 'cargo',
    declaredIn: 'Cargo.toml',
    members: await resolveMembers(
      root,
      fs,
      patterns,
      'cargo',
      'Cargo.toml',
      rootName,
      !rootIsPackage,
    ),
  };
}

async function goWorkspace(root: string, fs: WorkspaceFs): Promise<WorkspaceLayout | null> {
  const content = await fs.readFile(join(root, 'go.work'));
  if (!content) return null;

  const patterns: string[] = [];
  let inBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.split('//')[0]!.trim();
    if (!line) continue;
    if (/^use\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const single = /^use\s+(\S+)$/.exec(line);
    if (single) patterns.push(single[1]!);
    else if (inBlock) patterns.push(line);
  }

  return {
    kind: 'go-work',
    ecosystem: 'go',
    declaredIn: 'go.work',
    members: await resolveMembers(root, fs, patterns, 'go', 'go.mod', null, true),
  };
}

async function mavenWorkspace(root: string, fs: WorkspaceFs): Promise<WorkspaceLayout | null> {
  const content = await fs.readFile(join(root, 'pom.xml'));
  if (!content) return null;

  const block = /<modules>([\s\S]*?)<\/modules>/.exec(content);
  if (!block) return null;

  const patterns = [...block[1]!.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]!);
  if (patterns.length === 0) return null;

  const rootName = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(content)?.[1] ?? null;

  return {
    kind: 'maven-modules',
    ecosystem: 'maven',
    declaredIn: 'pom.xml',
    members: await resolveMembers(root, fs, patterns, 'maven', 'pom.xml', rootName),
  };
}

async function gradleWorkspace(root: string, fs: WorkspaceFs): Promise<WorkspaceLayout | null> {
  const path = (await fs.readFile(join(root, 'settings.gradle.kts')))
    ? 'settings.gradle.kts'
    : (await fs.readFile(join(root, 'settings.gradle')))
      ? 'settings.gradle'
      : null;
  if (!path) return null;

  const content = (await fs.readFile(join(root, path))) ?? '';
  // `include(":app", ":core:data")` — a Gradle project path, colon-separated.
  const patterns = [...content.matchAll(/include\s*\(?\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g)]
    .flatMap((match) => [...match[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!))
    .map((project) => project.replace(/^:/, '').replace(/:/g, '/'));

  if (patterns.length === 0) return null;

  return {
    kind: 'gradle-settings',
    ecosystem: 'maven',
    declaredIn: path,
    members: await resolveMembers(root, fs, patterns, 'maven', 'build.gradle', null, true),
  };
}

/* ------------------------------------------------------------------ */
/* Pattern resolution                                                  */
/* ------------------------------------------------------------------ */

async function resolveMembers(
  root: string,
  fs: WorkspaceFs,
  patterns: readonly string[],
  ecosystem: Ecosystem,
  manifest: string,
  rootName: string | null,
  rootIsVirtual = false,
): Promise<WorkspaceMember[]> {
  const dirs = new Set<string>();
  const excluded = new Set<string>();
  for (const pattern of patterns) {
    const clean = pattern.trim();
    // Negative patterns exclude, regardless of where in the list they appear
    // — the same semantics npm/pnpm/yarn workspace globs use. Expanding the
    // pattern with its `!` stripped finds what it names; expanding it with
    // the `!` intact (via `expandPattern` itself) would just yield nothing.
    if (clean.startsWith('!')) {
      for (const dir of await expandPattern(root, fs, clean.slice(1), manifest)) excluded.add(dir);
    } else {
      for (const dir of await expandPattern(root, fs, clean, manifest)) dirs.add(dir);
    }
  }
  for (const dir of excluded) dirs.delete(dir);

  const members: WorkspaceMember[] = [];

  // A workspace root that is also a package is a member of its own workspace.
  // A virtual manifest — Cargo's word for a root that only lists members — is
  // not, and analysing it would attribute every member's file to the root.
  if (!rootIsVirtual) {
    members.push({ dir: '', name: rootName, ecosystem });
  }

  for (const dir of [...dirs].sort()) {
    if (dir === '') continue;
    members.push({ dir, name: await memberName(root, fs, dir, manifest, ecosystem), ecosystem });
  }

  return members;
}

/**
 * Expand one workspace pattern into directories that hold a manifest.
 *
 * Supports the two forms workspace declarations actually use: a literal path
 * and a trailing `*` or `**`. Anything more elaborate is rare enough that
 * guessing at it would be more likely to produce a wrong member list than a
 * missing one — and a missing member is visible, while a wrong one is not.
 *
 * When `manifest` is given, a directory matched by a `*`/`**` segment is only
 * included if it actually contains that manifest file — a glob like
 * `packages/*` otherwise sweeps up every directory under `packages/`,
 * including ones that are not packages at all (fixtures, docs, a stray
 * `node_modules`-adjacent folder). The literal-path form is left unfiltered:
 * a workspace declaration that names a directory outright is trusted the way
 * npm/yarn/pnpm trust it.
 */
export async function expandPattern(
  root: string,
  fs: WorkspaceFs,
  pattern: string,
  manifest?: string,
): Promise<string[]> {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (clean.startsWith('!')) return [];
  if (!clean.includes('*')) return [clean];

  const segments = clean.split('/');
  const wildcard = segments.findIndex((s) => s.includes('*'));
  const prefix = segments.slice(0, wildcard).join('/');
  const deep = segments[wildcard] === '**';
  const suffix = segments.slice(wildcard + 1).join('/');

  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const entry of await fs.readDirectory(join(root, dir))) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'target') continue;
      const child = dir ? `${dir}/${entry}` : entry;
      if (!(await fs.isDirectory(join(root, child)))) continue;

      const candidate = suffix ? `${child}/${suffix}` : child;
      if (!manifest || (await fs.readFile(join(root, candidate, manifest))) !== null) {
        found.push(candidate);
      }
      if (deep) await visit(child, depth + 1);
    }
  };

  await visit(prefix, 0);
  return found;
}

/**
 * The name a package declares for itself, or `null` if it declares none.
 *
 * Exported because a formal workspace declaration is not the only thing that
 * produces more than one package in a checkout — an undeclared sibling
 * directory does too, and so does the root package sitting above one. Those
 * have names in their manifests exactly like a declared member does; they were
 * simply never asked, which left the scan labelling some rows and not others.
 */
export async function memberName(
  root: string,
  fs: WorkspaceFs,
  dir: string,
  manifest: string,
  ecosystem: Ecosystem,
): Promise<string | null> {
  const content = await fs.readFile(join(root, dir, manifest));
  if (!content) return null;

  switch (ecosystem) {
    case 'npm':
      return tryJson<{ name?: string }>(content)?.name ?? null;
    case 'cargo': {
      const table = scanTomlTables(content).find((t) => t.header === 'package');
      return stripQuotes(table?.entries.get('name') ?? '') || null;
    }
    case 'go':
      return /^\s*module\s+(\S+)/m.exec(content)?.[1] ?? null;
    case 'maven':
      return /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(content)?.[1] ?? null;
    default:
      return null;
  }
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

/** `/`-joined, skipping empty segments — these are all repo-relative paths. */
function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}
