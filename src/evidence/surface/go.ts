import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAvailable } from '../../util/exec.js';
import { diffSurfaces, type SurfaceApi, type SurfaceKind } from '../type-surface.js';
import { unavailable, type SurfaceProvider, type SurfaceRequest, type SurfaceOutcome } from './types.js';

/**
 * Go exported-API diffing.
 *
 * This is `golang.org/x/exp/cmd/apidiff`'s approach — load the exported symbols
 * of two module versions and compare them — done through the toolchain Go
 * already ships. `go doc -all` prints exactly the exported surface of a
 * package, resolved by the real type checker, which is the fact apidiff also
 * works from.
 *
 * Each version is fetched into its own throwaway module: `go get` in the user's
 * own module would rewrite their `go.mod`, and Drift does not edit a repository
 * to look at it.
 */

const TOOL = 'go doc';
const REMEDY = 'Install the Go toolchain and make `go` available on PATH.';

export const goSurface: SurfaceProvider = {
  ecosystem: 'go',
  tool: TOOL,
  weight: 1.0,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    if (!(await isAvailable(request.exec, 'go', ['version']))) {
      return unavailable(
        TOOL,
        'tool-missing',
        `The Go toolchain is not installed, so ${request.name}'s exported API could not be compared directly.`,
        REMEDY,
      );
    }

    const before = await surfaceOf(request, request.from);
    if (!before.ok) return before.failure;
    const after = await surfaceOf(request, request.to);
    if (!after.ok) return after.failure;

    return {
      available: true,
      changes: diffSurfaces(before.api, after.api),
      tool: TOOL,
      weight: 1.0,
      locator: `${request.name} ${request.from} → ${request.to} (exported symbols)`,
    };
  },
};

type SurfaceAttempt = { ok: true; api: SurfaceApi } | { ok: false; failure: SurfaceOutcome };

async function surfaceOf(request: SurfaceRequest, version: string): Promise<SurfaceAttempt> {
  const dir = join(request.workdir, `probe-${version.replace(/[^\w.-]/g, '_')}`);
  const tag = version.startsWith('v') ? version : `v${version}`;

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'go.mod'), 'module driftsurfaceprobe\n\ngo 1.21\n', 'utf8');
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(TOOL, 'toolchain-failed', `Could not prepare a scratch module: ${(err as Error).message}`),
    };
  }

  const fetched = await request.exec('go', ['get', `${request.name}@${tag}`], {
    cwd: dir,
    timeoutMs: request.timeoutMs,
    env: { ...process.env, GOFLAGS: '-mod=mod' },
  });

  if (fetched.code !== 0) {
    const missing = /unknown revision|invalid version|no matching versions|404 Not Found/i.test(fetched.stderr);
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        missing ? 'version-unavailable' : 'toolchain-failed',
        missing
          ? `The module proxy has no ${request.name} ${tag}; it may be retracted, or the module may be private.`
          : `\`go get ${request.name}@${tag}\` failed: ${firstLine(fetched.stderr)}`,
      ),
    };
  }

  const documented = await request.exec('go', ['doc', '-all', request.name], {
    cwd: dir,
    timeoutMs: request.timeoutMs,
  });

  if (documented.code !== 0) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `\`go doc -all ${request.name}\` failed: ${firstLine(documented.stderr)}`,
      ),
    };
  }

  const api = parseGoDoc(documented.stdout);
  if (api.size === 0) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ${tag} exports nothing at its module root — the API may live in subpackages Drift did not read.`,
      ),
    };
  }

  return { ok: true, api };
}

const KINDS: Record<string, SurfaceKind> = {
  func: 'function',
  type: 'interface',
  var: 'variable',
  const: 'variable',
};

/**
 * Parse `go doc -all` into the shared surface shape.
 *
 * Declarations start at column zero; methods of a type are indented beneath it
 * and are recorded as members, so a removed method reads as a member removal
 * rather than as an unrelated missing export. Doc prose is indented too, which
 * is why only lines that parse as a declaration are kept.
 */
export function parseGoDoc(output: string, into: SurfaceApi = new Map()): SurfaceApi {
  /** The type whose `{ ... }` body we are currently inside. */
  let openType: string | null = null;

  const addMember = (owner: string | null, member: string): void => {
    const entry = owner ? into.get(owner) : undefined;
    if (entry && !entry.members.includes(member)) entry.members.push(member);
  };

  for (const raw of output.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    if (/^\s/.test(line)) {
      // Inside a type body: struct fields and interface methods are members,
      // and only the exported ones can break a consumer. Doc prose lives here
      // too, so a member has to look like a declaration.
      const member = /^\s+([A-Z]\w*)(\s+\S|\()/.exec(line)?.[1];
      if (openType && member) addMember(openType, member);
      continue;
    }

    if (line.startsWith('}')) {
      openType = null;
      continue;
    }

    const declaration = /^(func|type|var|const)\s+(.+)$/.exec(line);
    if (!declaration) {
      openType = null;
      continue;
    }

    const keyword = declaration[1]!;
    const rest = declaration[2]!;
    openType = null;

    // `func (v Value) String() string` — a method, belonging to its receiver.
    const receiver = /^\(\s*\w+\s+\*?(\w+)\s*\)\s*(\w+)/.exec(rest);
    if (keyword === 'func' && receiver) {
      addMember(receiver[1]!, receiver[2]!);
      continue;
    }

    const name = /^([A-Za-z_]\w*)/.exec(rest)?.[1];
    // Go exports exactly what starts with an upper-case letter. Everything else
    // in this output is unexported context and cannot break a consumer.
    if (!name || !/^[A-Z]/.test(name)) continue;

    const signature = collapse(`${keyword} ${rest}`);
    const existing = into.get(name);
    if (existing) {
      existing.signature = `${existing.signature} | ${signature}`;
    } else {
      into.set(name, {
        name,
        kind: KINDS[keyword] ?? 'variable',
        signature,
        members: [],
        requiredMembers: [],
      });
    }

    if (keyword === 'type' && rest.trimEnd().endsWith('{')) openType = name;
  }

  return into;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s*\{$/, '').trim();
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}
