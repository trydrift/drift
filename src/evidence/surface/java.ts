import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAvailable } from '../../util/exec.js';
import type { SurfaceChange } from '../type-surface.js';
import { unavailable, type SurfaceProvider, type SurfaceRequest, type SurfaceOutcome } from './types.js';

/**
 * Java binary-compatibility diffing via japicmp.
 *
 * japicmp compares the classfiles of two published jars, which makes it the
 * only source here that reads *what was actually shipped* rather than a
 * reconstruction of it. Jars come from Maven Central by URL — downloading a jar
 * is not running it, and Drift never invokes a build for a third-party artefact.
 */

const TOOL = 'japicmp';
const INSTALL = {
  id: 'japicmp',
  label: 'Install japicmp',
  command: 'brew',
  args: ['install', 'japicmp'],
} as const;
const REMEDY = 'Drift can install the missing `japicmp` helper for you after approval.';
const CENTRAL = 'https://repo1.maven.org/maven2';

export const javaSurface: SurfaceProvider = {
  ecosystem: 'maven',
  tool: TOOL,
  weight: 1.0,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    const coordinate = parseCoordinate(request.name);
    if (!coordinate) {
      return unavailable(
        TOOL,
        'unsupported-ecosystem',
        `\`${request.name}\` is not a \`groupId:artifactId\` coordinate, so Drift could not locate it on Maven Central.`,
      );
    }

    if (!(await isAvailable(request.exec, 'japicmp', ['--help']))) {
      return unavailable(
        TOOL,
        'tool-missing',
        `Drift's Java API helper is missing, so ${request.name}'s classfile API could not be compared directly.`,
        REMEDY,
        INSTALL,
      );
    }

    await mkdir(request.workdir, { recursive: true });
    const before = await downloadJar(coordinate, request.from, request.workdir);
    if (!before.ok) return before.failure;
    const after = await downloadJar(coordinate, request.to, request.workdir);
    if (!after.ok) return after.failure;

    const result = await request.exec(
      'japicmp',
      ['-o', before.path, '-n', after.path, '--only-modified', '--ignore-missing-classes'],
      { cwd: request.workdir, timeoutMs: request.timeoutMs },
    );

    // japicmp exits non-zero when it finds incompatibilities under some
    // configurations, so output is what decides, not the exit code.
    if (result.stdout.trim().length === 0) {
      return unavailable(
        TOOL,
        result.code === 0 ? 'no-public-surface' : 'toolchain-failed',
        result.code === 0
          ? `japicmp found no differences it could read between ${request.name} ${request.from} and ${request.to}.`
          : `japicmp failed on ${request.name}: ${firstLine(result.stderr)}`,
      );
    }

    return {
      available: true,
      changes: parseJapicmp(result.stdout),
      tool: TOOL,
      weight: 1.0,
      locator: `${request.name} ${request.from} → ${request.to} (classfiles)`,
    };
  },
};

interface Coordinate {
  groupId: string;
  artifactId: string;
}

export function parseCoordinate(name: string): Coordinate | null {
  const [groupId, artifactId] = name.split(':');
  if (!groupId || !artifactId) return null;
  return { groupId, artifactId };
}

/** Maven Central's layout is entirely derivable, so no search API is needed. */
export function jarUrl(coordinate: Coordinate, version: string): string {
  const path = coordinate.groupId.replace(/\./g, '/');
  return `${CENTRAL}/${path}/${coordinate.artifactId}/${version}/${coordinate.artifactId}-${version}.jar`;
}

type JarAttempt = { ok: true; path: string } | { ok: false; failure: SurfaceOutcome };

async function downloadJar(
  coordinate: Coordinate,
  version: string,
  workdir: string,
): Promise<JarAttempt> {
  const url = jarUrl(coordinate, version);
  const path = join(workdir, `${coordinate.artifactId}-${version}.jar`);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      return {
        ok: false,
        failure: unavailable(
          TOOL,
          response.status === 404 ? 'version-unavailable' : 'toolchain-failed',
          response.status === 404
            ? `Maven Central has no jar for ${coordinate.groupId}:${coordinate.artifactId}:${version}. It may be an internal artefact, or published only as a POM or a BOM.`
            : `Maven Central returned ${response.status} for ${url}.`,
        ),
      };
    }
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(TOOL, 'toolchain-failed', `Could not download ${url}: ${(err as Error).message}`),
    };
  }
}

/**
 * Parse japicmp's default report.
 *
 * The format is a marker, a change word, a kind, and a name, with members
 * indented under their class:
 *
 * ```
 * ---! REMOVED CLASS: PUBLIC com.example.Legacy
 * ***! MODIFIED CLASS: PUBLIC com.example.Client
 *      ---! REMOVED METHOD: PUBLIC void close()
 * ```
 *
 * Only removals and modifications are reported onwards, matching every other
 * evidence source: an addition cannot break a caller, and reporting one costs a
 * reviewer attention they will need elsewhere.
 */
export function parseJapicmp(output: string): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  let currentClass: string | null = null;

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const match = /^(\*\*\*!|---!|\+\+\+)\s*(\w+)\s+(CLASS|METHOD|FIELD|CONSTRUCTOR|INTERFACE|ANNOTATION|SUPERCLASS):\s*(.+)$/.exec(
      line,
    );
    if (!match) continue;

    const [, , verb, kind, rest] = match;
    const isClass = kind === 'CLASS' || kind === 'INTERFACE' || kind === 'ANNOTATION';
    const name = symbolName(rest!);
    if (!name) continue;

    if (isClass) currentClass = name;

    if (verb === 'NEW') continue;

    const symbol = isClass || !currentClass ? name : `${currentClass}.${name}`;

    if (verb === 'REMOVED') {
      changes.push({
        kind: isClass ? 'export-removed' : 'member-removed',
        symbol,
        detail: isClass
          ? `\`${symbol}\` is no longer published (was a ${kind.toLowerCase()}).`
          : `\`${symbol}\` was removed.`,
      });
    } else if (verb === 'MODIFIED' && !isClass) {
      changes.push({
        kind: 'signature-changed',
        symbol,
        detail: `The signature of \`${symbol}\` changed.`,
        after: rest!.trim(),
      });
    }
  }

  return changes;
}

/**
 * `PUBLIC void close()` -> `close`, `PUBLIC com.example.Client` -> the class.
 *
 * japicmp prefixes modifiers and, for members, a return type. The identifier is
 * the last thing before the parameter list.
 */
function symbolName(rest: string): string | null {
  const identifier = (rest.split('(')[0]!.trim().split(/\s+/).pop() ?? '').trim();
  return /^[\w.$]+$/.test(identifier) ? identifier : null;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}
