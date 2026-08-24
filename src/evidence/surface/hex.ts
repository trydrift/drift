import { readArchive, type ArchiveEntry } from '../../util/archive.js';
import { diffSurfaces, type SurfaceApi } from '../type-surface.js';
import { fetchArchive } from '../../util/http.js';
import { unavailable, type SurfaceOutcome, type SurfaceProvider, type SurfaceRequest } from './types.js';

/**
 * Elixir and Erlang API diffing, from the release tarball.
 *
 * The old capability note — "Hex publishes no machine-comparable API artefact"
 * — was true about *compiled* artefacts and misleading about the ecosystem. A
 * Hex release ships its sources, and in Elixir the public API is spelled out in
 * them with no ambiguity at all: `def` is public and `defp` is private, and the
 * distinction is a keyword rather than a convention. Erlang says the same thing
 * with `-export([f/1, g/2])`, which is an explicit list.
 *
 * So the comparison is between two module lists whose public functions are
 * named and counted by arity. A module that disappears, a function that
 * disappears, and a function whose arity changed are the three ways a Hex
 * upgrade breaks a caller, and all three fall out of `diffSurfaces` once each
 * module is an entry and its `name/arity` pairs are its members.
 *
 * Weighted 0.8: the source is what was published, but "public" is being read
 * from the definition keyword rather than from a compiled export table. A macro
 * that generates functions at compile time is invisible here, which is the same
 * class of limit the C header diff has with the preprocessor.
 */

const TOOL = 'hex sources';
const WEIGHT = 0.8;

export const hexSurface: SurfaceProvider = {
  ecosystem: 'hex',
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

    if (before.api.size === 0 && after.api.size === 0) {
      return unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ships no Elixir or Erlang source Drift could read, so this upgrade rests on prose evidence.`,
      );
    }

    return {
      available: true,
      changes: diffSurfaces(before.api, after.api),
      tool: TOOL,
      weight: WEIGHT,
      locator: `${request.name} ${request.from} → ${request.to} (published sources)`,
    };
  },
};

type Attempt = { ok: true; api: SurfaceApi } | { ok: false; failure: SurfaceOutcome };

async function surfaceOf(request: SurfaceRequest, version: string): Promise<Attempt> {
  const url = `https://repo.hex.pm/tarballs/${encodeURIComponent(request.name)}-${encodeURIComponent(version)}.tar`;

  let outer: ArchiveEntry[];
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
            ? `Hex has no release for ${request.name} ${version}. It may have been retired, or published to a private repository.`
            : `Hex returned ${downloaded.status} for ${request.name} ${version}.`,
        ),
      };
    }
    outer = readArchive(downloaded.bytes);
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `Could not read ${request.name} ${version} from Hex: ${(err as Error).message}`,
      ),
    };
  }

  // A Hex tarball is a tar whose payload is another, gzipped tar.
  const contents = outer.find((e) => e.path === 'contents.tar.gz' || e.path.endsWith('/contents.tar.gz'));
  if (!contents) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'parse-failed',
        `${request.name} ${version} is not in the layout Hex tarballs use, so Drift could not read its sources.`,
      ),
    };
  }

  try {
    return { ok: true, api: publicApiOf(readArchive(contents.read())) };
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'parse-failed',
        `Could not unpack ${request.name} ${version}: ${(err as Error).message}`,
      ),
    };
  }
}

/** Every public module in the release, with its public functions as members. */
export function publicApiOf(entries: readonly ArchiveEntry[]): SurfaceApi {
  const api: SurfaceApi = new Map();

  for (const entry of entries) {
    // `lib/` is Elixir's source root and `src/` is Erlang's. Anything else in
    // the tarball — priv, mix.exs, docs — declares no callable API.
    if (!/^(lib|src)\//.test(entry.path)) continue;

    let source: string;
    try {
      source = entry.read().toString('utf8');
    } catch {
      continue;
    }

    if (/\.ex$/.test(entry.path)) {
      for (const [module, functions] of elixirModules(source)) {
        merge(api, module, functions, `defmodule ${module}`);
      }
      continue;
    }

    if (/\.erl$/.test(entry.path)) {
      const module = /^\s*-module\(\s*'?([a-z][\w]*)'?\s*\)/m.exec(source)?.[1];
      if (module) merge(api, module, erlangExports(source), `-module(${module})`);
    }
  }

  return api;
}

function merge(api: SurfaceApi, module: string, members: string[], signature: string): void {
  const existing = api.get(module);
  if (existing) {
    existing.members = [...new Set([...existing.members, ...members])];
    return;
  }
  api.set(module, { name: module, kind: 'class', signature, members, requiredMembers: [] });
}

/**
 * Elixir modules and the functions they make public.
 *
 * Nesting and heredocs are handled for the same reasons they are in
 * `src/localize/modules.ts`: a `defmodule` inside another one is not a
 * top-level module, and a `defmodule` inside an `@moduledoc` is an example in
 * a string. Getting either wrong invents a public module that does not exist,
 * and inventing one here means reporting its removal in the next release.
 *
 * Functions are recorded as `name/arity`, which is how Elixir itself names
 * them and the only spelling under which adding a required argument reads as a
 * removal rather than as nothing at all.
 */
export function elixirModules(source: string): Map<string, string[]> {
  const modules = new Map<string, string[]>();
  const stack: { indent: number; name: string | null }[] = [];
  const lines = source.split('\n');
  let inHeredoc = false;

  const enter = (indent: number, name: string | null): void => {
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ indent, name });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fences = (line.match(/"""/g) ?? []).length;
    if (inHeredoc) {
      if (fences % 2 === 1) inHeredoc = false;
      continue;
    }
    if (fences % 2 === 1) {
      inHeredoc = true;
      continue;
    }

    const declaration = /^(\s*)(?:defmodule|defprotocol)\s+([A-Z][\w.]*)/.exec(line);
    if (declaration) {
      const indent = declaration[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const parent = stack[stack.length - 1]?.name;
      const name = parent ? `${parent}.${declaration[2]!}` : declaration[2]!;
      enter(indent, name);
      if (!modules.has(name)) modules.set(name, []);
      continue;
    }

    // `defimpl Collectable, for: Conn` defines functions on the *protocol*'s
    // implementation module, not on the module the block sits inside. Entering
    // a nameless scope is what stops `Plug.Conn` being credited with an
    // `into/1` that belongs to `Collectable.Plug.Conn` — a phantom removal the
    // moment the implementation moves to another file.
    const impl = /^(\s*)defimpl\s+/.exec(line);
    if (impl) {
      enter(impl[1]!.length, null);
      continue;
    }

    // `defp` is private and `def` is public; the `p` is the whole ACL.
    const fn = /^(\s*)(?:def|defmacro|defguard|defdelegate)\s+([a-z_][\w]*[!?]?)\s*(\(|,|\s+when\b|\s+do\b|\s*$)/.exec(line);
    if (!fn) continue;

    const indent = fn[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const owner = stack[stack.length - 1]?.name;
    if (!owner) continue;

    for (const arity of aritiesOf(lines, i, fn[3] === '(')) {
      modules.get(owner)?.push(`${fn[2]}/${arity}`);
    }
  }

  for (const [name, functions] of modules) modules.set(name, [...new Set(functions)]);
  return modules;
}

/**
 * Every arity one `def` defines.
 *
 * Plural, because Elixir's default arguments define more than one function:
 * `def get_session(conn, key, default \\ nil)` defines `get_session/2` *and*
 * `get_session/3`. Reading only the total was how a version that merely added
 * a default argument — a change so backward-compatible it is the recommended
 * way to extend a function — was reported as having removed the old arity.
 *
 * The parameter list is gathered across lines until its parentheses balance,
 * because a long signature wraps and a list truncated at the newline counts
 * the wrong number of arguments.
 */
function aritiesOf(lines: readonly string[], start: number, hasParens: boolean): number[] {
  if (!hasParens) return [0];

  const open = lines[start]!.indexOf('(');
  let text = '';
  let depth = 0;
  let closed = false;

  outer: for (let i = start; i < lines.length && i < start + 12; i++) {
    const line = lines[i]!;
    for (let j = i === start ? open : 0; j < line.length; j++) {
      const ch = line[j]!;
      if (ch === '(') {
        depth += 1;
        if (depth === 1) continue;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          break outer;
        }
      }
      if (depth >= 1) text += ch;
    }
    text += ' ';
  }

  if (!closed) return [0];

  const parameters = splitTopLevel(text);
  if (parameters.length === 0) return [0];

  const required = parameters.filter((parameter) => !parameter.includes('\\\\')).length;
  const total = parameters.length;
  return Array.from({ length: total - required + 1 }, (_, index) => required + index);
}

/** Split a parameter list on the commas that separate arguments. */
function splitTopLevel(list: string): string[] {
  const trimmed = list.trim();
  if (trimmed === '') return [];

  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of trimmed) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** `-export([start/0, stop/1]).`, including the several forms it comes in. */
export function erlangExports(source: string): string[] {
  const exported: string[] = [];
  for (const match of source.matchAll(/-export\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const entry of match[1]!.split(',')) {
      const fn = /([a-z_][\w]*)\s*\/\s*(\d+)/.exec(entry);
      if (fn) exported.push(`${fn[1]}/${fn[2]}`);
    }
  }
  return [...new Set(exported)];
}
