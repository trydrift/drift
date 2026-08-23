import { readArchive } from '../../util/archive.js';
import { diffSurfaces, type SurfaceApi } from '../type-surface.js';
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
    const [before, after] = await Promise.all([surfaceOf(request, request.from), surfaceOf(request, request.to)]);
    if (!before.ok) return before.failure;
    if (!after.ok) return after.failure;

    return {
      available: true,
      changes: diffSurfaces(before.api, after.api),
      tool: TOOL,
      weight: WEIGHT,
      locator: `${request.name} ${request.from} → ${request.to} (${before.framework} assembly metadata)`,
    };
  },
};

type Attempt =
  | { ok: true; api: SurfaceApi; framework: string }
  | { ok: false; failure: SurfaceOutcome };

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
          'version-unavailable',
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

  const chosen = chooseAssembly(entries.map((entry) => entry.path));
  if (!chosen) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ${version} publishes no managed assembly under lib/ or ref/. Meta-packages, analyzers, and native-only packages have no API surface to compare.`,
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

  return { ok: true, api: toSurface(types), framework: chosen.framework };
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
