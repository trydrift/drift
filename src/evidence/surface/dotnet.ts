import { readArchive } from '../../util/archive.js';
import { createHash } from 'node:crypto';
import { diffSurfaces, type SurfaceApi, type SurfaceChange } from '../type-surface.js';
import { readAssembly, type AssemblyType } from './ecma335.js';
import { fetchArchive } from '../../util/http.js';
import { unavailable, type SurfaceOutcome, type SurfaceProvider, type SurfaceRequest } from './types.js';

/**
 * .NET API diffing, from the assemblies NuGet actually publishes.
 *
 * Drift downloads both versions' `.nupkg`, reads the managed assembly out of
 * the zip in memory, and parses its ECMA-335 metadata (`ecma335.ts`). No SDK,
 * no decompiler, no install — the package is opened, not executed, and NuGet
 * install scripts never run.
 *
 * Weighted 1.0, the same as the TypeScript declaration diff, because it is the
 * same kind of evidence: a direct reading of the published artefact's own
 * description of its public surface. It is not a reconstruction and it does not
 * guess.
 */

const TOOL = 'assembly metadata';
const WEIGHT = 1.0;

export const nugetSurface: SurfaceProvider = {
  ecosystem: 'nuget',
  tool: TOOL,
  weight: WEIGHT,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    const beforePromise = surfaceOf(request, request.from);
    const afterPromise = surfaceOf(request, request.to);
    afterPromise.catch(() => undefined);
    const before = await beforePromise;
    if (!before.ok) return before.failure;
    const after = await afterPromise;
    if (!after.ok) return after.failure;

    if (before.role !== 'managed-library' || after.role !== 'managed-library') {
      return {
        available: true,
        changes: diffNugetContracts(before, after),
        tool: 'NuGet package contract',
        weight: 0.9,
        locator: `${request.name} ${request.from} → ${request.to} (NuGet package roles: ${before.role} → ${after.role})`,
      };
    }

    return {
      available: true,
      changes: diffSurfaces(before.api!, after.api!),
      tool: TOOL,
      weight: WEIGHT,
      locator: `${request.name} ${request.from} → ${request.to} (${before.framework} assembly metadata)`,
    };
  },
};

type Attempt =
  | { ok: true; role: NugetPackageRole; contract: Map<string, string>; api?: SurfaceApi; framework: string }
  | { ok: false; failure: SurfaceOutcome };

export type NugetPackageRole =
  | 'managed-library'
  | 'analyzer'
  | 'msbuild'
  | 'tool'
  | 'meta-package'
  | 'unsupported';

async function surfaceOf(request: SurfaceRequest, version: string): Promise<Attempt> {
  const id = request.name.toLowerCase();
  const normalized = version.toLowerCase();
  const url = `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/${encodeURIComponent(normalized)}/${encodeURIComponent(id)}.${encodeURIComponent(normalized)}.nupkg`;

  let entries;
  try {
    const downloaded = await fetchArchive(url, { timeoutMs: request.timeoutMs });
    // A request that never completed used to throw out of `fetch`; re-thrown so
    // it still lands in this provider's own catch, with the same message.
    if (!downloaded.ok && downloaded.status === 0) throw new Error(downloaded.error ?? 'the request failed');
    if (!downloaded.ok) {
      return {
        ok: false,
        failure: unavailable(
          TOOL,
          downloaded.status === 404 ? 'version-unavailable' : 'artifact-unavailable',
          downloaded.status === 404
            ? `NuGet has no package for ${request.name} ${version}. It may be unlisted, delisted, or published to a private feed.`
            : `NuGet returned ${downloaded.status} for ${request.name} ${version}.`,
        ),
      };
    }
    entries = readArchive(downloaded.bytes);
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `Could not read ${request.name} ${version} from NuGet: ${(err as Error).message}`,
      ),
    };
  }

  const role = classifyNugetPackage(entries);
  if (role !== 'managed-library') {
    if (role === 'unsupported') {
      return {
        ok: false,
        failure: unavailable(
          'NuGet package contract',
          'artifact-type-unsupported',
          `${request.name} ${version} contains no managed library, analyzer, MSBuild, tool, or dependency-only contract Drift can classify.`,
        ),
      };
    }
    return { ok: true, role, contract: nugetRoleContract(entries, role), framework: role };
  }

  const chosen = chooseAssembly(entries.map((entry) => entry.path));
  if (!chosen) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'parse-failed',
        `${request.name} ${version} was classified as a managed library, but no readable assembly could be selected under lib/ or ref/.`,
      ),
    };
  }

  const entry = entries.find((candidate) => candidate.path === chosen.path)!;
  const types = readAssembly(entry.read());
  if (!types) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'parse-failed',
        `${chosen.path} in ${request.name} ${version} is not a managed assembly Drift could read.`,
      ),
    };
  }

  return { ok: true, role, contract: new Map(), api: toSurface(types), framework: chosen.framework };
}

export function classifyNugetPackage(entries: readonly { path: string; read(): Buffer }[]): NugetPackageRole {
  const paths = entries.map((entry) => entry.path.replaceAll('\\', '/').toLowerCase());
  if (chooseAssembly(paths)) return 'managed-library';
  if (paths.some((path) => path.startsWith('analyzers/'))) return 'analyzer';
  if (paths.some((path) => path.startsWith('build/') || path.startsWith('buildtransitive/'))) return 'msbuild';
  if (paths.some((path) => path.startsWith('tools/'))) return 'tool';
  const nuspec = entries.find((entry) => entry.path.toLowerCase().endsWith('.nuspec'));
  if (nuspec && /<(?:dependency|group)\b/i.test(nuspec.read().toString('utf8'))) return 'meta-package';
  return 'unsupported';
}

function nugetRoleContract(
  entries: readonly { path: string; read(): Buffer }[],
  role: Exclude<NugetPackageRole, 'managed-library' | 'unsupported'>,
): Map<string, string> {
  const contract = new Map<string, string>();
  if (role === 'meta-package') {
    const nuspec = entries.find((entry) => entry.path.toLowerCase().endsWith('.nuspec'));
    if (!nuspec) return contract;
    const xml = nuspec.read().toString('utf8');
    for (const match of xml.matchAll(/<dependency\b([^>]*)\/?\s*>/gi)) {
      const attrs = Object.fromEntries([...match[1]!.matchAll(/([\w.-]+)\s*=\s*["']([^"']*)["']/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]));
      if (attrs.id) contract.set(`dependency:${attrs.id}`, [attrs.version, attrs.include, attrs.exclude].filter(Boolean).join('|'));
    }
    return contract;
  }

  const prefixes = role === 'analyzer'
    ? ['analyzers/']
    : role === 'msbuild'
      ? ['build/', 'buildtransitive/']
      : ['tools/'];
  for (const entry of entries) {
    const normalized = entry.path.replaceAll('\\', '/').toLowerCase();
    if (!prefixes.some((prefix) => normalized.startsWith(prefix))) continue;
    contract.set(normalized, createHash('sha256').update(entry.read()).digest('hex'));
  }
  return contract;
}

function diffNugetContracts(before: Extract<Attempt, { ok: true }>, after: Extract<Attempt, { ok: true }>): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  if (before.role !== after.role) {
    changes.push({
      kind: 'signature-changed',
      symbol: 'nuget:package-role',
      detail: `The NuGet package role changed from ${before.role} to ${after.role}.`,
      before: before.role,
      after: after.role,
    });
  }
  for (const [name, oldValue] of before.contract) {
    const symbol = `nuget:${before.role}:${name}`;
    if (!after.contract.has(name)) {
      changes.push({
        kind: 'export-removed',
        symbol,
        detail: `The ${before.role} contract entry ${name} was removed from the NuGet package.`,
        before: oldValue,
      });
    } else if (after.contract.get(name) !== oldValue) {
      changes.push({
        kind: 'signature-changed',
        symbol,
        detail: `The ${before.role} contract entry ${name} changed in the NuGet package.`,
        before: oldValue,
        after: after.contract.get(name),
      });
    }
  }
  return changes;
}

/**
 * Turn assembly types into the entries `diffSurfaces` compares.
 *
 * Signatures land in `members` alongside the bare names on purpose. A member
 * whose parameter list changed keeps its name, so a name-only comparison would
 * report nothing at all — and a changed signature is the most common .NET
 * breaking change after a removal, not a rare one.
 */
function toSurface(types: readonly AssemblyType[]): SurfaceApi {
  const api: SurfaceApi = new Map();

  for (const type of types) {
    api.set(type.fullName, {
      name: type.fullName,
      kind: type.kind === 'struct' || type.kind === 'delegate' ? 'type' : type.kind,
      signature: `${type.kind} ${type.fullName}`,
      members: [...type.members, ...type.signatures],
      requiredMembers: [],
    });
  }

  return api;
}

/**
 * Which assembly in the package to read.
 *
 * A NuGet package ships the same library compiled for several target
 * frameworks, and their public surfaces differ — a `net48` build can expose
 * APIs a `netstandard2.0` build does not. Comparing across two *different*
 * frameworks would report those differences as breaking changes, so the choice
 * has to be deterministic and the same for both versions.
 *
 * `ref/` wins over `lib/` where a package publishes both, because a reference
 * assembly is by definition the public surface with the implementation
 * stripped — exactly what is being compared. Then `netstandard2.0`, the widest
 * common target and the one most likely to exist in both an old version and a
 * new one, then the highest `net` version, then whatever else there is.
 */
export function chooseAssembly(paths: readonly string[]): { path: string; framework: string } | null {
  const candidates = paths
    .map((path) => {
      const match = /^(lib|ref)\/([^/]+)\/([^/]+\.dll)$/i.exec(path);
      if (!match) return null;
      const name = match[3]!;
      // Resource assemblies carry localised strings, never API.
      if (/\.resources\.dll$/i.test(name)) return null;
      return { path, area: match[1]!.toLowerCase(), framework: match[2]!.toLowerCase(), name };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) => {
    if (a.area !== b.area) return a.area === 'ref' ? -1 : 1;
    const score = frameworkScore(b.framework) - frameworkScore(a.framework);
    if (score !== 0) return score;
    // Within one framework a package may ship several assemblies; the shortest
    // name is the primary one, and the rest are its satellites.
    return a.name.length - b.name.length || a.name.localeCompare(b.name);
  });

  const best = ranked[0]!;
  return { path: best.path, framework: best.framework };
}

function frameworkScore(framework: string): number {
  if (framework.startsWith('netstandard2.0')) return 1000;
  if (framework.startsWith('netstandard')) return 900;

  // `net8.0` and friends. `net48` is the old .NET Framework spelling and sorts
  // below every .NET Core-era target, which is the order of preference too.
  const modern = /^net(\d+)\.(\d+)/.exec(framework);
  if (modern) return 500 + Number(modern[1]) * 10 + Number(modern[2]);

  const legacy = /^net(\d+)$/.exec(framework);
  if (legacy) return 100 + Number(legacy[1]);

  return 0;
}

export { readAssembly as readAssemblySurface };
