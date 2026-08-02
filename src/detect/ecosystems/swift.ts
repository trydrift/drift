import { basename, tryJson, type DependencyMap, type ManifestParser } from './types.js';

/**
 * Swift Package Manager — `Package.swift` and `Package.resolved`.
 *
 * Two things make Swift different from every other ecosystem here.
 *
 * First, `Package.swift` is a *program*, not a data file: SwiftPM compiles and
 * runs it to produce a manifest. Drift reads the literal `.package(...)` calls,
 * which is what essentially every real manifest contains, and reports nothing
 * for versions a manifest computes at evaluation time. That limit is stated in
 * the capability matrix rather than hidden — a computed version silently read
 * as absent would be a wrong answer, and absent is at least an honest one.
 *
 * Second, SwiftPM has no central registry: a package *is* a git URL. So the
 * name carried forward is the URL's `owner/repo`, which is both what a human
 * calls the package and exactly what the evidence stage needs to find releases
 * and changelogs. `packageIdentity` is the whole reason Swift gets real
 * evidence coverage despite having no registry to query.
 */
export const swiftParser: ManifestParser = {
  ecosystem: 'swift',
  name: 'Swift Package Manager',

  handles(path) {
    const base = basename(path);
    // Swift tools-version-pinned manifests: `Package@swift-5.9.swift`.
    return base === 'package.resolved' || /^package(@swift-[\d.]+)?\.swift$/.test(base);
  },

  isLockfile(path) {
    return basename(path) === 'package.resolved';
  },

  parse(content, path) {
    return basename(path) === 'package.resolved'
      ? parseResolved(content)
      : parsePackageSwift(content);
  },
};

/**
 * `.package(url: "...", from: "1.2.3")` and its many siblings.
 *
 * SwiftPM accepts a spread of requirement forms — `from:`, `exact:`,
 * `branch:`, `revision:`, `.upToNextMajor(from:)`, and a bare range operator.
 * The version-shaped ones are normalised to the range they mean; `branch:` and
 * `revision:` yield `null`, because a branch is not a version and pretending
 * otherwise would manufacture upgrades.
 */
function parsePackageSwift(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  for (const match of content.matchAll(/\.package\s*\(([\s\S]*?)\)\s*[,\]]/g)) {
    const args = match[1] ?? '';

    const url = /\burl\s*:\s*"([^"]+)"/.exec(args)?.[1];
    const local = /\bpath\s*:\s*"([^"]+)"/.exec(args)?.[1];
    // A `path:` dependency is a sibling checkout with no version at all.
    if (!url && local) continue;

    // A registry-style `id:` package ("apple.swift-argument-parser").
    const id = /\bid\s*:\s*"([^"]+)"/.exec(args)?.[1];
    const name = url ? packageIdentity(url) : id;
    if (!name) continue;

    out.set(name, { version: requirementOf(args), kind: 'runtime' });
  }

  return out;
}

/**
 * The version constraint a `.package(...)` argument list expresses.
 *
 * Rendered with the operator the rest of Drift already understands rather than
 * with SwiftPM's own spelling. `from: "1.2.3"` means "1.2.3 up to the next
 * major", which is `^1.2.3` — and writing it as `from: 1.2.3` would leave
 * `normalizeVersion` holding the word "from" and reporting no version at all.
 */
function requirementOf(args: string): string | null {
  const exact = /\bexact\s*:\s*"([^"]+)"/.exec(args)?.[1];
  if (exact) return exact;

  const from = /\bfrom\s*:\s*"([^"]+)"/.exec(args)?.[1];
  if (from) return `^${from}`;

  const upToNextMajor = /\.upToNextMajor\s*\(\s*from\s*:\s*"([^"]+)"/.exec(args)?.[1];
  if (upToNextMajor) return `^${upToNextMajor}`;

  const upToNextMinor = /\.upToNextMinor\s*\(\s*from\s*:\s*"([^"]+)"/.exec(args)?.[1];
  if (upToNextMinor) return `~${upToNextMinor}`;

  // `"1.0.0"..<"2.0.0"` and `"1.0.0"..."1.5.0"` — the lower bound is what the
  // manifest was authored against, which is the convention everywhere else.
  const range = /"([^"]+)"\s*\.\.[.<]\s*"([^"]+)"/.exec(args);
  if (range) return `>=${range[1]} <${range[2]}`;

  // A branch or revision pin is not a version; say nothing rather than guess.
  return null;
}

interface ResolvedPin {
  identity?: string;
  location?: string;
  /** v1 manifests spell it `repositoryURL`. */
  repositoryURL?: string;
  package?: string;
  state?: { version?: string; revision?: string; branch?: string };
}

/**
 * `Package.resolved`, in both formats SwiftPM has shipped.
 *
 * v1 nests the pins under `object.pins` and names the URL `repositoryURL`; v2
 * and v3 put `pins` at the root and call it `location`. Reading only one of
 * them would silently skip every project that has not migrated.
 */
function parseResolved(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const doc = tryJson<{ pins?: ResolvedPin[]; object?: { pins?: ResolvedPin[] } }>(content);
  if (!doc) return out;

  for (const pin of doc.pins ?? doc.object?.pins ?? []) {
    const url = pin.location ?? pin.repositoryURL;
    const name = url ? packageIdentity(url) : (pin.identity ?? pin.package);
    if (!name) continue;

    // A pin resolved to a branch or a bare revision has no version to compare.
    const version = pin.state?.version ?? null;
    out.set(name, { version, kind: 'transitive' });
  }

  return out;
}

/**
 * The name a human gives a Swift package, from its git URL.
 *
 * `https://github.com/apple/swift-nio.git` becomes `apple/swift-nio`, which is
 * both what the README calls it and exactly the shape the evidence stage needs
 * to fetch releases. Non-GitHub hosts keep their last path segment, since there
 * is nothing better to say about them.
 */
export function packageIdentity(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!trimmed) return null;

  const github = /github\.com[/:]([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (github) return `${github[1]}/${github[2]}`;

  return trimmed.split('/').pop() || null;
}
