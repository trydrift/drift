import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';

/**
 * Elixir and Erlang — `mix.exs` and `mix.lock`.
 *
 * `mix.exs` is Elixir source, and its `deps` list is a literal list of tuples
 * that essentially every project writes out longhand. Drift reads those tuples
 * and reports nothing for deps a project builds programmatically — stated in
 * the capability matrix rather than silently returned as "no change".
 */
export const hexParser: ManifestParser = {
  ecosystem: 'hex',
  name: 'Mix',

  handles(path) {
    const base = basename(path);
    return base === 'mix.exs' || base === 'mix.lock' || base === 'rebar.config';
  },

  isLockfile(path) {
    return basename(path) === 'mix.lock';
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'mix.lock') return parseMixLock(content);
    if (base === 'rebar.config') return parseRebarConfig(content);
    return parseMixExs(content);
  },
};

/**
 * `{:phoenix, "~> 1.7"}` tuples from the `deps` list.
 *
 * The options tail carries the classification: `only: :dev` / `only: :test`
 * makes it a dev dependency, and `path:`, `git:`, or `github:` means there is
 * no Hex version to compare at all.
 */
function parseMixExs(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  // `{:name, ...}` up to the matching close. Nested braces are rare in a dep
  // tuple, and the non-greedy match stops at the first `}` which is where the
  // options end in every conventional formatting.
  for (const match of content.matchAll(/\{\s*:([a-z_][a-zA-Z0-9_]*)\s*(,[^}]*)?\}/g)) {
    const name = match[1]!;
    const rest = match[2] ?? '';

    // A requirement is the first bare string argument. `only:`/`env:` values
    // are atoms, and `path:`/`git:` values are strings — so a string that
    // follows a `key:` is not a version.
    const requirement = /^,\s*"([^"]+)"/.exec(rest)?.[1] ?? null;

    const external = /\b(path|git|github|hg|svn):\s*/.test(rest);
    // `override: true` on a git dep still has no comparable version.
    const version = external ? null : requirement;

    // Only tuples that look like dependencies. A bare `{:ok, value}` in
    // unrelated code has neither a requirement nor a dependency-ish option.
    if (!requirement && !external && !/\b(only|runtime|optional|app|manager):/.test(rest)) continue;

    const only = /\bonly:\s*(\[[^\]]*\]|:[a-z_]+)/.exec(rest)?.[1] ?? '';
    const kind: DependencyKind = /:(dev|test)\b/.test(only) ? 'dev' : 'runtime';

    out.set(name, { version, kind });
  }

  return out;
}

/**
 * `mix.lock` — `"name": {:hex, :name, "1.2.3", "hash", ...},`.
 *
 * The third element is the resolved version. A `:git` entry has a ref there
 * instead, which is not a version, so only `:hex` entries are recorded.
 */
function parseMixLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const pattern = /"([a-z_][a-zA-Z0-9_]*)"\s*:\s*\{\s*:hex\s*,\s*:[a-zA-Z0-9_]+\s*,\s*"([^"]+)"/g;

  for (const match of content.matchAll(pattern)) {
    out.set(match[1]!, { version: match[2]!, kind: 'transitive' });
  }

  return out;
}

/**
 * Erlang's `rebar.config`: `{deps, [{name, "1.2.3"}, ...]}`.
 *
 * Scoped to the `deps` tuple specifically, because a rebar config is full of
 * other tuples — `erl_opts`, `profiles`, `relx` — whose contents look
 * structurally identical and are not dependencies.
 */
function parseRebarConfig(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  const start = /\{\s*deps\s*,\s*\[/.exec(content);
  if (!start) return out;

  let depth = 1;
  let i = start.index + start[0].length;
  for (; i < content.length && depth > 0; i++) {
    if (content[i] === '[') depth += 1;
    else if (content[i] === ']') depth -= 1;
  }
  const body = content.slice(start.index + start[0].length, i - 1);

  for (const match of body.matchAll(/\{\s*([a-z_][a-zA-Z0-9_]*)\s*,\s*"([^"]+)"/g)) {
    out.set(match[1]!, { version: match[2]!, kind: 'runtime' });
  }
  // A bare atom dependency — `{deps, [cowboy, ranch]}` — pins nothing.
  for (const match of body.matchAll(/(?:^|[[,])\s*([a-z_][a-zA-Z0-9_]*)\s*(?=[,\]]|$)/g)) {
    if (!out.has(match[1]!)) out.set(match[1]!, { version: null, kind: 'runtime' });
  }

  return out;
}
