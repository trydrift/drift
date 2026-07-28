import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';

export const rubygemsParser: ManifestParser = {
  ecosystem: 'rubygems',
  name: 'bundler',

  handles(path) {
    const base = basename(path);
    return base === 'gemfile' || base === 'gemfile.lock' || base.endsWith('.gemspec');
  },

  isLockfile(path) {
    return basename(path) === 'gemfile.lock';
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'gemfile.lock') return parseGemfileLock(content);
    if (base.endsWith('.gemspec')) return parseGemspec(content);
    return parseGemfile(content);
  },
};

/**
 * Gemfile `gem "name", "~> 1.2"` declarations.
 *
 * `group :development do ... end` blocks and the `group:` keyword both mark
 * dev dependencies, so we track block nesting to classify correctly.
 */
function parseGemfile(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const groupStack: string[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0]!.trim();
    if (!line) continue;

    const groupBlock = /^group\s+(.+?)\s+do$/.exec(line);
    if (groupBlock) {
      groupStack.push(groupBlock[1]!);
      continue;
    }
    if (line === 'end' && groupStack.length) {
      groupStack.pop();
      continue;
    }

    const gem = /^gem\s+["']([^"']+)["'](.*)$/.exec(line);
    if (!gem) continue;

    const name = gem[1]!;
    const rest = gem[2] ?? '';

    // Version constraints are the positional string args before any `key:`.
    const constraints = [...rest.matchAll(/["']([~><=!]*\s*[\d][^"']*)["']/g)].map((m) => m[1]!.trim());
    const version = constraints.length ? constraints.join(', ') : null;

    const inlineGroup = /\bgroups?:\s*\[?\s*:?([\w,\s:]+)/.exec(rest)?.[1] ?? '';
    const scope = `${groupStack.join(' ')} ${inlineGroup}`;
    const kind: DependencyKind = /development|test/.test(scope) ? 'dev' : 'runtime';

    out.set(name, { version, kind });
  }

  return out;
}

/**
 * Gemfile.lock resolved versions live under `GEM > specs:` at 4-space indent
 * for top-level gems; deeper indents are that gem's own dependencies.
 */
function parseGemfileLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  let inSpecs = false;

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*specs:\s*$/.test(line)) {
      inSpecs = true;
      continue;
    }
    // A non-indented line ends the section (PLATFORMS, DEPENDENCIES, ...).
    if (line.trim() && !/^\s/.test(line)) {
      inSpecs = false;
      continue;
    }
    if (!inSpecs) continue;

    const spec = /^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/.exec(line);
    if (spec) out.set(spec[1]!, { version: spec[2]!, kind: 'transitive' });
  }

  return out;
}

function parseGemspec(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const pattern = /add_(development_|runtime_)?dependency[\s(]+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/g;
  for (const match of content.matchAll(pattern)) {
    out.set(match[2]!, {
      version: match[3] ?? null,
      kind: match[1] === 'development_' ? 'dev' : 'runtime',
    });
  }
  return out;
}
