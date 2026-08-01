import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../../util/exec.js';
import type { Logger } from '../../util/logger.js';
import { GO_APIDUMP_SOURCE } from './go-apidump.js';
import { diffGoApi, parseGoApiDump, type GoApi } from './go-api.js';
import {
  goPlatforms,
  goRemedy,
  inGitHubActions,
  probeGoToolchain,
  requiredGoVersion,
  type GoVersionRequirement,
} from './go-toolchain.js';
import { unavailable, type SurfaceProvider, type SurfaceRequest, type SurfaceOutcome } from './types.js';

/**
 * Go exported-API diffing.
 *
 * The question is `golang.org/x/exp/cmd/apidiff`'s — what did this module stop
 * offering? — answered through Go's own module cache and parser rather than
 * through prose.
 *
 * Two decisions shape everything here:
 *
 * **`go mod download` rather than `go get`.** The module is fetched into the
 * shared module cache by path and version, with no build list, without
 * resolving its own dependencies, and without touching the user's `go.mod`.
 * That makes the fetch idempotent — the second look at a version Go already
 * has is a cache hit and no network at all — and it means a module whose own
 * dependencies no longer resolve is still analysable, because Drift reads its
 * source rather than building it.
 *
 * **Parsing rather than type-checking.** The previous implementation ran
 * `go doc -all` against the module root, which reports nothing for the very
 * common case of a module whose API lives entirely in subpackages — the shape
 * of `golang.org/x/sys`, and a large part of why nearly every Go dependency
 * came back unverified. The extractor walks every importable package instead,
 * at every platform, which is where the API actually is.
 */

const TOOL = 'go (go/build + go/parser)';

export const goSurface: SurfaceProvider = {
  ecosystem: 'go',
  tool: TOOL,
  weight: 1.0,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    const requirement = await requiredGoVersion(request.readRepoFile);
    const toolchain = await probeGoToolchain(request.exec, request.env);

    if (!toolchain.available) {
      return unavailable(
        TOOL,
        'tool-missing',
        `The Go toolchain is not installed, so ${request.name}'s exported API could not be compared.`,
        goRemedy(requirement, inGitHubActions()),
      );
    }

    const workdir = await scratchModule(request.exec, request.logger, request.env);
    if (!workdir) {
      return unavailable(
        TOOL,
        'toolchain-failed',
        `Drift could not prepare a scratch Go module to run its API extractor in, so ${request.name} could not be compared.`,
      );
    }

    const platforms = goPlatforms();

    const before = await apiOf(request, workdir, request.from, platforms, requirement);
    if ('failure' in before) return before.failure;
    const after = await apiOf(request, workdir, request.to, platforms, requirement);
    if ('failure' in after) return after.failure;

    const { changes, additions, omitted } = diffGoApi(before.api, after.api);

    // A package Go could not parse is recorded, never swallowed — but it never
    // costs the developer the comparison of every package that did parse.
    const unreadable = new Set([...before.api.failures, ...after.api.failures].map((f) => f.pkg));
    if (unreadable.size > 0) {
      request.logger.debug(
        `${request.name}: ${unreadable.size} package(s) could not be parsed and were skipped`,
      );
    }

    return {
      available: true,
      changes,
      tool: TOOL,
      weight: 1.0,
      locator: describeComparison(request, before.api, after.api, platforms, unreadable.size, omitted),
      additions,
    };
  },
};

function describeComparison(
  request: SurfaceRequest,
  before: GoApi,
  after: GoApi,
  platforms: readonly string[],
  unreadable: number,
  omitted: number,
): string {
  const parts = [
    `${request.name} ${request.from} → ${request.to}`,
    `${after.packages.length} package(s), ${after.symbols.size} exported symbol(s)`,
    `platforms: ${platforms.join(', ')}`,
  ];
  if (before.packages.length !== after.packages.length) {
    parts.push(`${before.packages.length} package(s) before`);
  }
  if (unreadable > 0) parts.push(`${unreadable} package(s) unparseable and skipped`);
  if (omitted > 0) parts.push(`${omitted} further finding(s) not listed`);
  return parts.join(' · ');
}

type ApiAttempt = { api: GoApi } | { failure: SurfaceOutcome };

/**
 * The exported API of one module version.
 *
 * Memoised for the lifetime of the process: a scan of a repository that reaches
 * the same version twice, or a re-check of one package after a fix, must not
 * re-parse twenty thousand declarations to arrive at the same answer.
 */
const apiCache = new Map<string, GoApi>();

async function apiOf(
  request: SurfaceRequest,
  workdir: string,
  version: string,
  platforms: readonly string[],
  requirement: GoVersionRequirement,
): Promise<ApiAttempt> {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const cacheKey = `${request.name}@${tag}|${platforms.join(',')}`;

  const cached = apiCache.get(cacheKey);
  if (cached) return { api: cached };

  const downloaded = await request.exec(
    'go',
    ['mod', 'download', '-json', `${request.name}@${tag}`],
    { cwd: workdir, timeoutMs: request.timeoutMs, env: goEnv(request.env) },
  );

  const dir = moduleDirectory(downloaded.stdout);
  if (!dir) {
    const output = `${downloaded.stderr}\n${downloaded.stdout}`;
    const missing =
      /unknown revision|invalid version|no matching versions|404 Not Found|does not contain package/i.test(
        output,
      );
    return {
      failure: unavailable(
        TOOL,
        missing ? 'version-unavailable' : 'toolchain-failed',
        missing
          ? `The Go module proxy has no ${request.name} ${tag}, so there was nothing to compare against. It may be retracted, or the module may be private.`
          : `\`go mod download ${request.name}@${tag}\` failed: ${firstLine(output)}`,
      ),
    };
  }

  const extracted = await request.exec(
    'go',
    ['run', 'apidump.go', '-dir', dir, '-module', request.name, '-platforms', platforms.join(',')],
    { cwd: workdir, timeoutMs: request.timeoutMs, env: goEnv(request.env) },
  );

  if (extracted.code !== 0) {
    return {
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `Drift's API extractor could not run under the installed Go toolchain (${requirement.source} asks for Go ${requirement.version}): ${firstLine(extracted.stderr)}`,
      ),
    };
  }

  const api = parseGoApiDump(extracted.stdout);
  if (!api) {
    return {
      failure: unavailable(
        TOOL,
        'parse-failed',
        `Drift could not read its own API extractor's output for ${request.name} ${tag}.`,
      ),
    };
  }

  if (api.symbols.size === 0) {
    return {
      failure: unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ${tag} exports nothing from any importable package on ${platforms.join(', ')}, so there is no API to compare.`,
      ),
    };
  }

  apiCache.set(cacheKey, api);
  return { api };
}

/**
 * `go mod download -json` prints one JSON object per module.
 *
 * Read leniently: some configurations prepend progress output to stdout, and a
 * `Dir` that is present is the answer regardless of what preceded it.
 */
export function moduleDirectory(stdout: string): string | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, stdout.lastIndexOf('}') + 1)) as {
      Dir?: string;
      Error?: string;
    };
    return parsed.Dir && !parsed.Error ? parsed.Dir : null;
  } catch {
    // More than one module, or trailing output. The first `Dir` is still the
    // answer to the only question asked here.
    return /"Dir":\s*"((?:[^"\\]|\\.)*)"/.exec(stdout)?.[1]?.replace(/\\(.)/g, '$1') ?? null;
  }
}

/**
 * The scratch module the extractor runs in.
 *
 * One per process rather than one per dependency: `go run` compiles the
 * extractor, and a fresh directory each time would recompile it once for every
 * package in the scan. The module declares no requirements, so preparing it
 * needs no network.
 */
const scratch = new Map<string, Promise<string | null>>();

function scratchModule(exec: Exec, logger: Logger, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const key = env?.PATH ?? process.env.PATH ?? '';
  let pending = scratch.get(key);
  pending ??= (async () => {
    try {
      const dir = await mkdtemp(join(tmpdir(), 'drift-go-apidump-'));
      await mkdir(dir, { recursive: true });
      // A low `go` directive so the extractor builds under any supported
      // toolchain; it uses nothing newer.
      await writeFile(join(dir, 'go.mod'), 'module driftapidump\n\ngo 1.21\n', 'utf8');
      await writeFile(join(dir, 'apidump.go'), GO_APIDUMP_SOURCE, 'utf8');

      // Compiled once, up front, so a broken extractor is one stated failure
      // rather than the same compile error repeated for forty dependencies.
      const built = await exec('go', ['build', '-o', join(dir, 'apidump-check'), '.'], {
        cwd: dir,
        timeoutMs: 120_000,
        env: goEnv(env),
      });
      if (built.code !== 0) {
        logger.debug(`Drift's Go API extractor failed to build: ${firstLine(built.stderr)}`);
        return null;
      }
      return dir;
    } catch (err) {
      logger.debug(`Could not create the Go scratch module: ${(err as Error).message}`);
      return null;
    }
  })();

  scratch.set(key, pending);
  return pending;
}

/**
 * Environment for every `go` invocation.
 *
 * `GOFLAGS=-mod=mod` keeps `go mod download` from objecting to the scratch
 * module's empty requirement list. `GOTOOLCHAIN` is deliberately left alone, so
 * a repository that pins a newer toolchain still gets one.
 */
function goEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GOFLAGS: '-mod=mod' };
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}

/** Test seam: forget the memoised module APIs and the scratch module. */
export function resetGoSurfaceCache(): void {
  apiCache.clear();
  scratch.clear();
}
