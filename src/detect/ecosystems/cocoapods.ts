import { basename, type DependencyMap, type ManifestParser } from './types.js';

/**
 * CocoaPods — `Podfile`, `Podfile.lock`, and `.podspec`.
 *
 * This is the half of a React Native or native-iOS project that npm cannot see.
 * A React Native upgrade routinely moves native pods underneath the JavaScript
 * package, and a tool that reads only `package.json` reports that half of the
 * change as though it were the whole of it.
 *
 * A Podfile is Ruby, so this is scanned the way the Gemfile parser scans its
 * own: line-oriented, comment-stripped, tracking `target ... do` nesting to
 * tell test-target pods from shipping ones.
 */
export const cocoapodsParser: ManifestParser = {
  ecosystem: 'cocoapods',
  name: 'CocoaPods',

  handles(path) {
    const base = basename(path);
    return base === 'podfile' || base === 'podfile.lock' || base.endsWith('.podspec');
  },

  isLockfile(path) {
    return basename(path) === 'podfile.lock';
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'podfile.lock') return parsePodfileLock(content);
    if (base.endsWith('.podspec')) return parsePodspec(content);
    return parsePodfile(content);
  },
};

/**
 * `pod 'Name', '~> 1.2'` declarations.
 *
 * A pod sourced from `:path`, `:git`, or `:podspec` has no version to compare,
 * so it is recorded with a `null` version rather than dropped — the dependency
 * is genuinely there, and claiming it does not exist is a different error from
 * admitting its version is unknown.
 */
function parsePodfile(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const targetStack: string[] = [];

  for (const raw of content.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    const target = /^(?:target|abstract_target)\s+["']([^"']+)["']\s+do\b/.exec(line);
    if (target) {
      targetStack.push(target[1]!);
      continue;
    }
    // `do` blocks that are not targets still have to be balanced, or the first
    // `end` would pop a target that had not closed.
    if (/\bdo\b\s*(\|[^|]*\|)?\s*$/.test(line)) {
      targetStack.push('');
      continue;
    }
    if (line === 'end') {
      targetStack.pop();
      continue;
    }

    const pod = /^pod\s+["']([^"']+)["'](.*)$/.exec(line);
    if (!pod) continue;

    const name = pod[1]!;
    const rest = pod[2] ?? '';

    // Positional version strings only — `:git => '...'` values are not versions.
    const constraints = [...rest.matchAll(/["']([~><=!]*\s*\d[^"']*)["']/g)]
      .map((m) => m[1]!.trim())
      .filter((v) => !/^https?:/.test(v));

    const external = /:(path|git|podspec|svn|hg)\s*(?:=>|:)/.test(rest);
    const version = external || constraints.length === 0 ? null : constraints.join(', ');

    const kind = targetStack.some((t) => /test|spec|uitest/i.test(t)) ? 'dev' : 'runtime';
    out.set(name, { version, kind });
  }

  return out;
}

/**
 * `Podfile.lock` resolved versions, from the `PODS:` section.
 *
 * Entries look like `  - Alamofire (5.8.1)` for a pod, with its own
 * dependencies nested one level deeper as `    - AFNetworking/Core`. Only the
 * top level carries a version, which is the only level worth recording.
 */
function parsePodfileLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  let inPods = false;

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;

    if (/^[A-Z][A-Z ]*:\s*$/.test(line.trim()) && !/^\s/.test(line)) {
      inPods = line.trim() === 'PODS:';
      continue;
    }
    if (!inPods) continue;

    // `  - Name (1.2.3)` — exactly two spaces, or the nested deps come too.
    const pod = /^ {2}- "?([\w.+/-]+)"? \(([^)]+)\)/.exec(line);
    if (pod) out.set(pod[1]!, { version: pod[2]!, kind: 'transitive' });
  }

  return out;
}

/** `s.dependency 'Name', '~> 1.2'` inside a podspec. */
function parsePodspec(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const pattern = /\.dependency\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/g;

  for (const match of content.matchAll(pattern)) {
    out.set(match[1]!, { version: match[2] ?? null, kind: 'runtime' });
  }

  return out;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}
