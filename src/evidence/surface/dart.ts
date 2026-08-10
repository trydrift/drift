import { readArchive, type ArchiveEntry } from '../../util/archive.js';
import { diffSurfaces, type SurfaceApi, type SurfaceEntry } from '../type-surface.js';
import { unavailable, type SurfaceOutcome, type SurfaceProvider, type SurfaceRequest } from './types.js';

/**
 * Dart API diffing, from the source pub.dev actually publishes.
 *
 * Drift's capability matrix said "Drift does not compare published Dart APIs"
 * and that was an implementation gap rather than a fact about Dart. A pub
 * package's public surface is defined by a convention the whole ecosystem
 * follows and the analyzer enforces: **everything under `lib/` is public
 * except `lib/src/`**, which is private by agreement, reachable only through
 * an `export` in a public library. So the public API is the declarations in
 * `lib/*.dart` plus whatever those files export out of `lib/src/`.
 *
 * That convention is what makes this readable without the Dart SDK. Drift
 * downloads the published archive, opens it in memory, and reads the
 * declarations — no `pub get`, no analyzer server, no build. A package that
 * fails to follow the convention loses precision here, not correctness: an
 * implementation file nobody exports is simply not compared.
 *
 * Weighted 0.8 rather than 1.0. The `.d.ts` and ECMA-335 diffs read a
 * *description* of the surface that the publisher generated; this reads the
 * source and applies the ecosystem's visibility rule to it. That is one
 * inference more than the others make, and the weight says so.
 */

const TOOL = 'pub source';
const WEIGHT = 0.8;

export const pubSurface: SurfaceProvider = {
  ecosystem: 'pub',
  tool: TOOL,
  weight: WEIGHT,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    const before = await surfaceOf(request, request.from);
    if (!before.ok) return before.failure;
    const after = await surfaceOf(request, request.to);
    if (!after.ok) return after.failure;

    if (before.api.size === 0 && after.api.size === 0) {
      return unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} publishes no public Dart library Drift could read, so this upgrade rests on prose evidence.`,
      );
    }

    return {
      available: true,
      changes: diffSurfaces(before.api, after.api),
      tool: TOOL,
      weight: WEIGHT,
      locator: `${request.name} ${request.from} → ${request.to} (published lib/)`,
    };
  },
};

type Attempt = { ok: true; api: SurfaceApi } | { ok: false; failure: SurfaceOutcome };

async function surfaceOf(request: SurfaceRequest, version: string): Promise<Attempt> {
  const url = `https://pub.dev/api/archives/${encodeURIComponent(request.name)}-${encodeURIComponent(version)}.tar.gz`;

  let entries: ArchiveEntry[];
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(request.timeoutMs) });
    if (!response.ok) {
      return {
        ok: false,
        failure: unavailable(
          TOOL,
          'version-unavailable',
          response.status === 404
            ? `pub.dev has no archive for ${request.name} ${version}. It may be retracted, or published to a private pub server.`
            : `pub.dev returned ${response.status} for ${request.name} ${version}.`,
        ),
      };
    }
    entries = readArchive(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `Could not read ${request.name} ${version} from pub.dev: ${(err as Error).message}`,
      ),
    };
  }

  return { ok: true, api: publicApiOf(entries) };
}

/**
 * The declarations a consumer can reach.
 *
 * Starts at the libraries a consumer may import — `lib/*.dart`, never
 * `lib/src/` — and follows each `export` from there, because the near-universal
 * layout is a one-line library file that exports its implementation. Following
 * stops at the first repeat, so a pair of files exporting each other terminates.
 */
export function publicApiOf(entries: readonly ArchiveEntry[]): SurfaceApi {
  // A pub archive is unpacked *into* the package directory, so `lib/` is at the
  // root. A leading segment is stripped only when nothing sits at the root
  // already — and that condition is load-bearing rather than defensive.
  // Stripping unconditionally turns `example/lib/main.dart` into
  // `lib/main.dart`, and a package's example app is then compared as though it
  // were the package: `provider` reported `MyApp`, `MyHomePage` and `main`
  // among its public API, and would have reported their removal the day
  // somebody rewrote the example.
  const rooted = entries.some((entry) => entry.path.startsWith('lib/'));

  const byPath = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    const path = rooted ? entry.path : entry.path.replace(/^[^/]+\//, '');
    if (path.startsWith('lib/') && path.endsWith('.dart')) byPath.set(path, entry);
  }

  const api: SurfaceApi = new Map();
  const seen = new Set<string>();
  const queue = [...byPath.keys()].filter((path) => !path.startsWith('lib/src/'));

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);

    const entry = byPath.get(path);
    if (!entry) continue;

    let source: string;
    try {
      source = entry.read().toString('utf8');
    } catch {
      continue;
    }

    for (const declaration of declarationsIn(source)) {
      // First declaration wins: a name re-exported through two libraries is
      // one symbol, and the entry point that reaches it first is the one a
      // consumer is likeliest to have imported.
      if (!api.has(declaration.name)) api.set(declaration.name, declaration);
    }

    for (const exported of exportsIn(source)) {
      const resolved = resolveDartPath(path, exported);
      if (resolved && byPath.has(resolved)) queue.push(resolved);
    }
  }

  return api;
}

/** `export 'src/impl.dart';` — package: URIs point outside this package. */
function exportsIn(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/^\s*export\s+['"]([^'"]+)['"]/gm)) {
    const target = match[1]!;
    if (target.startsWith('package:') || target.startsWith('dart:')) continue;
    out.push(target);
  }
  return out;
}

function resolveDartPath(from: string, specifier: string): string | undefined {
  const segments = [...from.split('/').slice(0, -1), ...specifier.split('/')];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Top-level public declarations in one Dart source.
 *
 * A leading underscore is Dart's privacy marker and is the whole visibility
 * rule at declaration level — `_Foo` is library-private however it is exported
 * — so it is the one filter that matters. Class members are collected too,
 * because a removed method is as breaking as a removed class and `diffSurfaces`
 * already knows how to report one.
 */
export function declarationsIn(source: string): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];
  const lines = stripComments(source).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Only top-level declarations: anything indented is a member, and members
    // are collected against the type that encloses them.
    if (/^\s/.test(line)) continue;

    const type =
      /^(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+|mixin\s+)*(class|mixin|enum|extension|extension\s+type)\s+([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (type?.[2]) {
      const name = type[2];
      if (name.startsWith('_')) continue;
      // `extension on XMLHttpRequest` is an *unnamed* extension: `on` is the
      // keyword, not the name, and the extension has no public identity for a
      // consumer to depend on. Recording it produced a symbol called `on` in
      // the surface of `http`.
      if (name === 'on') continue;
      entries.push({
        name,
        kind: 'class',
        signature: collapse(line),
        members: membersOf(lines, i),
        requiredMembers: [],
      });
      continue;
    }

    const typedef = /^typedef\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (typedef?.[1] && !typedef[1].startsWith('_')) {
      entries.push({
        name: typedef[1],
        kind: 'type',
        signature: collapse(line),
        members: [],
        requiredMembers: [],
      });
      continue;
    }

    // A top-level function or getter: a return type, a name, an argument list.
    const fn =
      /^(?:external\s+)?(?:[\w$<>,\s?[\]]+\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:async\s*\*?|sync\s*\*)?\s*[{=;]/.exec(
        line,
      );
    if (fn?.[1] && !fn[1].startsWith('_') && !DART_KEYWORDS.has(fn[1])) {
      entries.push({
        name: fn[1],
        kind: 'function',
        signature: collapse(line),
        members: [],
        requiredMembers: [],
      });
      continue;
    }

    const variable = /^(?:const|final|var|late\s+final|late\s+var)\s+(?:[\w$<>,\s?[\]]+\s+)?([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (variable?.[1] && !variable[1].startsWith('_')) {
      entries.push({
        name: variable[1],
        kind: 'variable',
        signature: collapse(line),
        members: [],
        requiredMembers: [],
      });
    }
  }

  return entries;
}

/**
 * Public member names declared inside the block that opens at `start`.
 *
 * Only lines at the block's own indentation count. Without that, a local
 * variable inside a method body is read as a member of the class — `http`'s
 * `BrowserClient` was credited with `splitIdx`, `key` and `value`, and renaming
 * any of them in a patch release would have been reported as a removed member
 * of a public type. Dart's formatter makes indentation reliable enough to be
 * the rule here.
 */
function membersOf(lines: readonly string[], start: number): string[] {
  const members: string[] = [];
  let memberIndent: number | undefined;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // A top-level declaration ends the type. A blank line does not.
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    if (line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    memberIndent ??= indent;
    if (indent !== memberIndent) continue;

    const member =
      /^\s+(?:static\s+|final\s+|const\s+|late\s+|external\s+|covariant\s+)*(?:[\w$<>,\s?[\]]+\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*[({=;]/.exec(
        line,
      );
    if (member?.[1] && !member[1].startsWith('_') && !DART_KEYWORDS.has(member[1])) {
      members.push(member[1]);
    }
  }

  return [...new Set(members)];
}

/**
 * Words that look like an identifier in the position a declaration's name
 * occupies, and are not one.
 */
const DART_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'assert', 'super', 'this',
  'new', 'await', 'yield', 'throw', 'else', 'do', 'try', 'case', 'with', 'is',
  'as', 'in', 'on', 'of', 'when', 'get', 'set', 'factory', 'operator', 'part', 'import', 'export',
  'library', 'typedef', 'class', 'enum', 'mixin', 'extension', 'const', 'final',
  'var', 'void', 'late', 'required', 'covariant', 'abstract', 'static', 'external',
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s*[{=;]\s*$/, '').trim();
}
