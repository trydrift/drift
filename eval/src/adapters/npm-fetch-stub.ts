import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Serves a case's frozen upstream material to production code as though it
 * were the real npm registry, jsDelivr and raw.githubusercontent.
 *
 * These are the seams production code already has for substituting local data
 * for the network (the other is `localPackageEnvironment`, used for
 * behavioural verification). Stubbing exactly the endpoints production reads
 * drives the real code path: `fetchTypeSurface`/`extractExports`/`diffSurfaces`
 * genuinely parse and diff the declaration files, and
 * `fetchChangelogDocuments`/`fetchMigrationGuides` genuinely parse, section and
 * excerpt the frozen prose. Only the transport is case-local.
 *
 * The prose half is what makes a case's `evidence/` directory real rather than
 * decorative. Production reaches upstream prose through a chain — npm registry
 * metadata names a GitHub repository, and the changelog and migration guide are
 * probed on `raw.githubusercontent.com` — so serving the tail of that chain
 * without the head serves nothing. Both ends are stubbed here, from the case's
 * own frozen files, which is what lets an offline run read the same evidence a
 * networked one would.
 *
 * Per the case's `networkPolicy: disabled`: every other host throws, so a case
 * cannot silently reach the real network and this adapter cannot silently
 * under-report what it actually consulted.
 */

const JSDELIVR_DATA_HOST = 'data.jsdelivr.com';
const JSDELIVR_CDN_HOST = 'cdn.jsdelivr.net';
const NPM_REGISTRY_HOST = 'registry.npmjs.org';
const RAW_GITHUB_HOST = 'raw.githubusercontent.com';

export interface NpmFetchStubPackage {
  name: string;
  version: string;
  dir: string;
}

export interface NpmFetchStubOptions {
  /**
   * The case's frozen prose directory, served as the upstream repository's
   * default branch. Omitted when the case froze none, in which case the
   * changelog probe answers 404 exactly as it does for a package without one.
   */
  evidenceDir?: string | null;
  /**
   * `owner/repo` the registry metadata should name. Taken from the upstream
   * package's own `repository` field where it declares one, so the case data
   * stays the single source of the fact rather than the adapter inventing it.
   */
  githubRepo?: string | null;
}

export function installNpmFetchStub(
  packages: readonly NpmFetchStubPackage[],
  options: NpmFetchStubOptions = {},
): () => void {
  const original = globalThis.fetch;
  const byKey = new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  // Typed from `fetch` itself rather than from the DOM lib: this package
  // compiles with `lib: ES2022` and no DOM, so `RequestInfo` does not exist
  // here even though the runtime value does.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.hostname === JSDELIVR_DATA_HOST) return handleDataApi(url, byKey);
    if (url.hostname === JSDELIVR_CDN_HOST) return handleCdn(url, byKey);
    if (url.hostname === NPM_REGISTRY_HOST) return handleRegistry(url, byName, packages, options.githubRepo ?? null);
    if (url.hostname === RAW_GITHUB_HOST) return handleRawGitHub(url, options);
    throw new Error(
      `eval end-to-end adapter: unexpected network request to ${url.hostname} (the case declares networkPolicy: disabled). ` +
        `Only ${JSDELIVR_DATA_HOST}, ${JSDELIVR_CDN_HOST}, ${NPM_REGISTRY_HOST} and ${RAW_GITHUB_HOST} are stubbed; ` +
        'every other host is refused rather than silently reached.',
    );
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/**
 * A minimal npm packument, built from the case's own frozen package trees.
 *
 * Only the fields production actually reads are present — the version list,
 * each version's manifest, and the repository URL — because a stub that
 * invented richer metadata would be supplying evidence the case never froze.
 */
async function handleRegistry(
  url: URL,
  byName: Map<string, NpmFetchStubPackage>,
  packages: readonly NpmFetchStubPackage[],
  githubRepo: string | null,
): Promise<Response> {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!byName.has(name)) return notFound();

  const versions: Record<string, unknown> = {};
  for (const pkg of packages.filter((entry) => entry.name === name)) {
    const manifest = await readFile(join(pkg.dir, 'package.json'), 'utf8')
      .then((body) => JSON.parse(body) as Record<string, unknown>)
      .catch(() => ({}) as Record<string, unknown>);
    versions[pkg.version] = manifest;
  }

  return jsonResponse({
    name,
    versions,
    ...(githubRepo ? { repository: { type: 'git', url: `https://github.com/${githubRepo}` } } : {}),
  });
}

/** The case's frozen prose, served as files on the upstream repository's default branch. */
async function handleRawGitHub(url: URL, options: NpmFetchStubOptions): Promise<Response> {
  if (!options.evidenceDir || !options.githubRepo) return notFound();

  // /<owner>/<repo>/<branch>/<path...>
  const match = new RegExp(`^/${options.githubRepo}/[^/]+/(.+)$`).exec(url.pathname);
  if (!match) return notFound();

  try {
    const content = await readFile(join(options.evidenceDir, ...match[1]!.split('/')), 'utf8');
    return textResponse(content);
  } catch {
    return notFound();
  }
}

async function handleDataApi(url: URL, byKey: Map<string, NpmFetchStubPackage>): Promise<Response> {
  // https://data.jsdelivr.com/v1/packages/npm/<name>@<version>?structure=flat
  const match = url.pathname.match(/^\/v1\/packages\/npm\/(.+)$/);
  if (!match) return notFound();
  const spec = decodeURIComponent(match[1]!);
  const pkg = resolvePackage(spec, byKey);
  if (!pkg) return notFound();

  const files = await listFiles(pkg.dir);
  return jsonResponse({ files: files.map((name) => ({ name: `/${name}` })) });
}

async function handleCdn(url: URL, byKey: Map<string, NpmFetchStubPackage>): Promise<Response> {
  // https://cdn.jsdelivr.net/npm/<name>@<version>/<path...>
  const match = url.pathname.match(/^\/npm\/(.+)$/);
  if (!match) return notFound();
  const decoded = decodeURIComponent(match[1]!);
  const separator = decoded.indexOf('/');
  if (separator < 0) return notFound();
  const spec = decoded.slice(0, separator);
  const filePath = decoded.slice(separator + 1);
  const pkg = resolvePackage(spec, byKey);
  if (!pkg) return notFound();

  try {
    const content = await readFile(join(pkg.dir, ...filePath.split('/')), 'utf8');
    return textResponse(content);
  } catch {
    return notFound();
  }
}

function resolvePackage(spec: string, byKey: Map<string, NpmFetchStubPackage>): NpmFetchStubPackage | undefined {
  return byKey.get(spec);
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return out;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

function notFound(): Response {
  return new Response('', { status: 404 });
}
