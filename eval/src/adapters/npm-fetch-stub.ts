import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Serves a fixture's `upstream/old` and `upstream/new` trees to production
 * code as though they were jsDelivr's npm CDN and file-listing APIs.
 *
 * This is one of two real seams production code already has for substituting
 * fixture-local data for the network (the other is `localPackageEnvironment`,
 * used for behavioural verification): `src/evidence/type-surface.ts` reads
 * `data.jsdelivr.com`'s flat file listing and `cdn.jsdelivr.net`'s raw file
 * content, and nothing else. Stubbing exactly those two endpoints drives the
 * real `fetchTypeSurface`/`extractExports`/`diffSurfaces` code path — the
 * declaration files are genuinely parsed and diffed, only the transport is
 * fixture-local.
 *
 * Per fixture.yml's `network: disabled` policy: any host other than the two
 * jsDelivr hosts throws, so a fixture cannot silently reach the real network
 * and this adapter cannot silently under-report what it actually consulted.
 */

const JSDELIVR_DATA_HOST = 'data.jsdelivr.com';
const JSDELIVR_CDN_HOST = 'cdn.jsdelivr.net';

export interface NpmFetchStubPackage {
  name: string;
  version: string;
  dir: string;
}

export function installNpmFetchStub(packages: readonly NpmFetchStubPackage[]): () => void {
  const original = globalThis.fetch;
  const byKey = new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));

  // Typed from `fetch` itself rather than from the DOM lib: this package
  // compiles with `lib: ES2022` and no DOM, so `RequestInfo` does not exist
  // here even though the runtime value does.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.hostname === JSDELIVR_DATA_HOST) return handleDataApi(url, byKey);
    if (url.hostname === JSDELIVR_CDN_HOST) return handleCdn(url, byKey);
    throw new Error(
      `eval full-pipeline adapter: unexpected network request to ${url.hostname} (fixture declares network: disabled). ` +
        `Only ${JSDELIVR_DATA_HOST} and ${JSDELIVR_CDN_HOST} are stubbed; every other host is refused rather than silently reached.`,
    );
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
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
