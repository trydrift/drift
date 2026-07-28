/**
 * Minimal glob matcher.
 *
 * Drift only needs `*`, `**` and `?` against `/`-separated paths and package
 * names. Pulling in a full matcher would add a dependency (and a supply-chain
 * surface) for ~30 lines of logic, which would be a poor look for a tool whose
 * entire pitch is dependency risk.
 */
export function matchGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

export function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => matchGlob(p, value));
}

const cache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        // `**/` may match zero segments, so `foo/**/bar` matches `foo/bar`.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        // A single star stops at a path separator.
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';

  const re = new RegExp(out);
  cache.set(pattern, re);
  return re;
}
