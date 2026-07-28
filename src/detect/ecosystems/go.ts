import { basename, type DependencyMap, type ManifestParser } from './types.js';

export const goParser: ManifestParser = {
  ecosystem: 'go',
  name: 'go modules',

  handles(path) {
    const base = basename(path);
    return base === 'go.mod' || base === 'go.sum';
  },

  // go.sum carries hashes for every module in the graph, including ones not in
  // the build. go.mod is the source of truth, so go.sum is treated as lock-like.
  isLockfile(path) {
    return basename(path) === 'go.sum';
  },

  parse(content, path) {
    return basename(path) === 'go.sum' ? parseGoSum(content) : parseGoMod(content);
  },
};

/**
 * go.mod `require` directives, both block and single-line forms.
 *
 * `// indirect` marks a transitive dependency, which Drift respects so users
 * aren't drowned in graph churn they didn't cause.
 */
function parseGoMod(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  let inRequireBlock = false;
  // `replace` directives redirect a module elsewhere; we skip those lines so a
  // local replacement isn't reported as a version move.
  let inReplaceBlock = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, (m) => (m.includes('indirect') ? m : '')).trim();
    const original = rawLine.trim();

    if (/^require\s*\($/.test(original)) {
      inRequireBlock = true;
      continue;
    }
    if (/^replace\s*\($/.test(original) || /^exclude\s*\($/.test(original)) {
      inReplaceBlock = true;
      continue;
    }
    if (original === ')') {
      inRequireBlock = false;
      inReplaceBlock = false;
      continue;
    }
    if (inReplaceBlock || original.startsWith('replace ') || original.startsWith('exclude ')) {
      continue;
    }

    const single = /^require\s+(\S+)\s+(\S+)/.exec(original);
    if (single) {
      out.set(single[1]!, { version: single[2]!, kind: 'runtime' });
      continue;
    }

    if (!inRequireBlock) continue;

    const entry = /^(\S+)\s+(v\S+)/.exec(line || original);
    if (!entry) continue;
    const indirect = original.includes('// indirect');
    out.set(entry[1]!, { version: entry[2]!, kind: indirect ? 'transitive' : 'runtime' });
  }

  return out;
}

/** go.sum lines look like `module version[/go.mod] h1:hash`. */
function parseGoSum(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  for (const rawLine of content.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [name, version] = parts as [string, string, ...string[]];
    // Skip the `/go.mod` hash rows; the bare version row already covers it.
    if (version.endsWith('/go.mod')) continue;
    out.set(name, { version, kind: 'transitive' });
  }
  return out;
}
