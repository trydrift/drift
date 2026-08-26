import semver from 'semver';
import { isRuntimeConfigPath } from '../index/walk.js';
import { memberOf } from '../detect/workspace.js';
import { intersectsInterval, isSubsetInterval, parseSpecifierSet } from './pep440.js';
import type { RuntimeName } from '../types.js';

/**
 * Where this repository itself declares a runtime version.
 */
export interface RuntimeDeclaration {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** The version or range exactly as declared, e.g. ">=22.6.0", "22", "22.6.0". */
  requirement: string;
}

export interface RuntimeCompatibility extends RuntimeDeclaration {
  verdict: 'compatible' | 'incompatible' | 'partial';
}

/** Find declarations for any runtime named by structured upstream evidence. */
export function findRuntimeDeclarations(
  files: readonly { path: string; content: string }[],
  runtime: RuntimeName,
  member?: string,
  allMembers?: readonly string[],
): RuntimeDeclaration[] {
  const scoped = scopedTo(files, member, allMembers);
  if (runtime === 'node') return findNodeDeclarationsIn(scoped);
  if (runtime === 'python') return findPythonDeclarationsIn(scoped);
  const out: RuntimeDeclaration[] = [];
  for (const { path, content } of scoped) {
    if (!isRuntimeConfigPath(path)) continue;
    const base = (path.split('/').pop() ?? '').toLowerCase();

    const versionFile = runtime === 'ruby'
      ? base === '.ruby-version'
      : runtime === 'rust'
        ? ['rust-toolchain', 'rust-toolchain.toml'].includes(base)
        : false;
    if (versionFile) {
      if (base === 'rust-toolchain.toml') {
        const found = lineValue(content, /^\s*channel\s*=\s*['"]([^'"]+)['"]/);
        if (found) out.push({ file: path, ...found });
      } else {
        const requirement = content.trim().split('\n')[0]?.replace(/^(?:ruby-|go|rust-)?v?/i, '').trim();
        if (requirement) out.push({ file: path, line: 1, requirement });
      }
      continue;
    }

    if (base === '.tool-versions') {
      out.push(...toolVersionDeclarations(path, content, runtime));
      continue;
    }

    if (base.startsWith('dockerfile') || base.startsWith('containerfile')) {
      out.push(...containerDeclarations(path, content, runtime));
      continue;
    }

    if (runtime === 'ruby') {
      if (base === 'gemfile') out.push(...rubyGemfileDeclarations(path, content));
      else if (base.endsWith('.gemspec')) out.push(...rubyGemspecDeclarations(path, content));
    } else if (runtime === 'go' && base === 'go.mod') {
      out.push(...goModDeclarations(path, content));
    } else if (runtime === 'java') {
      if (base === 'pom.xml') out.push(...mavenJavaDeclarations(path, content));
      else if (base === 'build.gradle' || base === 'build.gradle.kts') out.push(...gradleJavaDeclarations(path, content));
    } else if (runtime === 'rust' && base === 'cargo.toml') {
      const found = tomlPackageValue(content, 'rust-version');
      if (found) out.push({ file: path, ...found });
    }

    if (isCiPath(path)) {
      out.push(...ciDeclarations(path, content, runtime));
    }
  }
  return out;
}

/** Compare declarations for runtimes without a language-specific grammar. */
export function checkRuntimeCompatibility(
  runtime: RuntimeName,
  declarations: readonly RuntimeDeclaration[],
  requirement: string,
): RuntimeCompatibility[] {
  if (runtime === 'node') return checkNodeCompatibility(declarations, requirement);
  if (runtime === 'python') return checkPythonCompatibility(declarations, requirement);
  const out: RuntimeCompatibility[] = [];
  for (const declaration of declarations) {
    const declaredRange = normalizeSemverRange(declaration.requirement);
    const requiredRange = normalizeSemverRange(requirement);
    if (!declaredRange || !requiredRange) continue;
    let verdict: RuntimeCompatibility['verdict'];
    try {
      if (semver.subset(declaredRange, requiredRange, { loose: true })) verdict = 'compatible';
      else if (!semver.intersects(declaredRange, requiredRange, { loose: true })) verdict = 'incompatible';
      else verdict = 'partial';
    } catch {
      continue;
    }
    out.push({ ...declaration, verdict });
  }
  return out;
}

/**
 * Does a repository declaration fall inside a range upstream explicitly
 * stopped supporting?
 *
 * The mirror image of `checkRuntimeCompatibility`'s minimum-floor check, and
 * deliberately reuses the same subset/intersects primitives: a declaration
 * that is a *subset* of the unsupported range is `incompatible` here (every
 * version this repository could run is one upstream dropped), where the same
 * subset relationship against a stated minimum would mean `compatible`. No
 * intersection at all means the declaration is untouched by the drop.
 */
export function checkUnsupportedRuntimeRange(
  runtime: RuntimeName,
  declarations: readonly RuntimeDeclaration[],
  unsupportedRequirement: string,
): RuntimeCompatibility[] {
  if (runtime === 'python') return checkUnsupportedPythonRange(declarations, unsupportedRequirement);

  const unsupportedRange = normalizeSemverRange(unsupportedRequirement);
  if (!unsupportedRange) return [];
  const out: RuntimeCompatibility[] = [];
  for (const declaration of declarations) {
    const declaredRange = normalizeSemverRange(declaration.requirement);
    if (!declaredRange) continue;
    let verdict: RuntimeCompatibility['verdict'];
    try {
      if (semver.subset(declaredRange, unsupportedRange, { loose: true })) verdict = 'incompatible';
      else if (!semver.intersects(declaredRange, unsupportedRange, { loose: true })) verdict = 'compatible';
      else verdict = 'partial';
    } catch {
      continue;
    }
    out.push({ ...declaration, verdict });
  }
  return out;
}

function checkUnsupportedPythonRange(
  declarations: readonly RuntimeDeclaration[],
  unsupportedRequirement: string,
): RuntimeCompatibility[] {
  // `parseRuntimeRequirement` formats a bare dropped-support line with the
  // semver X-range convention shared across every runtime ("3.7.x"). PEP 440's
  // own wildcard is "*", not "x" ("3.7.*") -- left untranslated, `analyzeToken`
  // cannot parse the trailing ".x" at all, the whole specifier set comes back
  // `imprecise`, and every declaration then falls through to the same
  // uninformative "partial" verdict regardless of its actual version.
  const unsupported = parseSpecifierSet(unsupportedRequirement.replace(/\.x$/i, '.*'));
  const out: RuntimeCompatibility[] = [];
  for (const declaration of declarations) {
    const declared = parseSpecifierSet(declaration.requirement);
    let verdict: RuntimeCompatibility['verdict'];
    if (isSubsetInterval(declared, unsupported)) verdict = 'incompatible';
    else if (!intersectsInterval(declared, unsupported)) verdict = 'compatible';
    else verdict = 'partial';
    out.push({ ...declaration, verdict });
  }
  return out;
}

/**
 * A runtime declaration Drift found but could not resolve to a literal
 * version — a GitHub Actions matrix expression (`${{ matrix.node }}`), an
 * unexpanded shell/CI variable (`$NODE_VERSION`) — so compatibility against a
 * dependency's requirement is genuinely unknown rather than absent.
 *
 * Kept distinct from `RuntimeDeclaration`/`RuntimeCompatibility` because
 * "Drift could not tell" and "the repository has no such declaration" must
 * never collapse into the same empty result: the first is a reason to ask a
 * developer to check by hand, the second is a reason to say nothing at all.
 */
export interface UnresolvedRuntimeDeclaration {
  file: string;
  line: number;
  rawText: string;
}

const CI_RUNTIME_FIELDS: Record<RuntimeName, RegExp> = {
  node: /\bnode-version\s*:\s*['"]?([^\s'"#]+)/i,
  python: /\bpython-version\s*:\s*['"]?([^\s'"#]+)/i,
  ruby: /\bruby-version\s*:\s*['"]?([^\s'"#]+)/i,
  go: /\bgo-version\s*:\s*['"]?([^\s'"#]+)/i,
  java: /\bjava-version\s*:\s*['"]?([^\s'"#]+)/i,
  rust: /\btoolchain\s*:\s*['"]?([^\s'"#]+)/i,
};

/**
 * Find CI runtime declarations that could not be resolved to a literal
 * version, so a dynamic matrix build cannot silently read as "no runtime
 * declared" and turn an unverified compatibility question into an implicit
 * "safe". Only CI is covered here: it is the source where dynamic
 * expressions (`${{ matrix.node }}`, `$NODE_VERSION`) are idiomatic and
 * common; other declaration surfaces (`.nvmrc`, `engines.node`) are
 * ordinarily literal, and a value Drift cannot parse there is left as an
 * absence rather than guessed to be "dynamic".
 */
export function findUnresolvedRuntimeDeclarations(
  files: readonly { path: string; content: string }[],
  runtime: RuntimeName,
  member?: string,
  allMembers?: readonly string[],
): UnresolvedRuntimeDeclaration[] {
  const scoped = scopedTo(files, member, allMembers);
  const out: UnresolvedRuntimeDeclaration[] = [];
  for (const { path, content } of scoped) {
    if (!isCiPath(path)) continue;
    for (const [i, line] of content.split('\n').entries()) {
      const raw = CI_RUNTIME_FIELDS[runtime].exec(line)?.[1];
      if (raw && /[${}]/.test(raw)) out.push({ file: path, line: i + 1, rawText: raw });

      const image = /^\s*(?:-\s*)?image\s*:\s*['"]?([^'"\s#]+)/i.exec(line)?.[1];
      if (image && /[${}]/.test(image)) out.push({ file: path, line: i + 1, rawText: image });
    }
  }
  return out;
}

const TOOL_VERSION_KEYS: Record<RuntimeName, readonly string[]> = {
  node: ['node', 'nodejs'],
  python: ['python', 'python3'],
  go: ['go', 'golang'],
  ruby: ['ruby'],
  java: ['java'],
  rust: ['rust'],
};

function toolVersionDeclarations(path: string, content: string, runtime: RuntimeName): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    const match = /^\s*([\w-]+)\s+([^\s#]+)/.exec(line);
    if (!match || !TOOL_VERSION_KEYS[runtime].includes(match[1]!.toLowerCase())) continue;
    const requirement = runtime === 'java' ? numericRuntimeTag(match[2]!) : match[2]!;
    if (requirement) out.push({ file: path, line: i + 1, requirement });
  }
  return out;
}

function containerDeclarations(path: string, content: string, runtime: RuntimeName): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line)?.[1];
    if (!from) continue;
    const requirement = containerImageRequirement(from, runtime);
    if (requirement) out.push({ file: path, line: i + 1, requirement });
  }
  return out;
}

/** Read a runtime tag from a container image wherever that image is declared. */
function containerImageRequirement(image: string, runtime: RuntimeName): string | null {
  const images: Record<RuntimeName, RegExp> = {
    node: /(?:^|\/)node:([^\s@'"#]+)/i,
    python: /(?:^|\/)python:([^\s@'"#]+)/i,
    ruby: /(?:^|\/)ruby:([^\s@'"#]+)/i,
    go: /(?:^|\/)golang:([^\s@'"#]+)/i,
    java: /(?:^|\/)(?:openjdk|eclipse-temurin|amazoncorretto):([^\s@'"#]+)/i,
    rust: /(?:^|\/)rust:([^\s@'"#]+)/i,
  };
  const tag = images[runtime].exec(image)?.[1];
  return tag ? numericRuntimeTag(tag) : null;
}

function rubyGemfileDeclarations(path: string, content: string): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    const match = /^\s*ruby\s+(['"])([^'"]+)\1/.exec(line);
    if (match?.[2]) out.push({ file: path, line: i + 1, requirement: match[2] });
  }
  return out;
}

function rubyGemspecDeclarations(path: string, content: string): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    const match = /\.required_ruby_version\s*=\s*(['"])([^'"]+)\1/.exec(line);
    if (match?.[2]) out.push({ file: path, line: i + 1, requirement: match[2] });
  }
  return out;
}

function goModDeclarations(path: string, content: string): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    const match = /^\s*(go|toolchain)\s+(?:go)?(\d+(?:\.\d+){0,3})\s*(?:\/\/.*)?$/.exec(line);
    if (match?.[2]) out.push({ file: path, line: i + 1, requirement: match[2] });
  }
  return out;
}

function mavenJavaDeclarations(path: string, content: string): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];
  const pattern = /<(?:maven\.compiler\.(?:release|source|target)|java\.version)>\s*([^<${}]+?)\s*<\//g;
  for (const match of content.matchAll(pattern)) {
    const requirement = javaVersion(match[1]!);
    if (!requirement) continue;
    out.push({ file: path, line: content.slice(0, match.index).split('\n').length, requirement });
  }
  const compilerBlocks = content.match(/<plugin>[\s\S]*?<artifactId>maven-compiler-plugin<\/artifactId>[\s\S]*?<\/plugin>/g) ?? [];
  for (const block of compilerBlocks) {
    for (const match of block.matchAll(/<(?:release|source|target)>\s*([^<${}]+?)\s*<\//g)) {
      const requirement = javaVersion(match[1]!);
      if (!requirement) continue;
      const blockStart = content.indexOf(block);
      out.push({ file: path, line: content.slice(0, blockStart + match.index).split('\n').length, requirement });
    }
  }
  return dedupeDeclarations(out);
}

function gradleJavaDeclarations(path: string, content: string): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];
  const patterns = [
    /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/,
    /(?:sourceCompatibility|targetCompatibility)\s*=\s*(?:JavaVersion\.VERSION_)?['"]?(\d+(?:\.\d+)*)/,
  ];
  for (const [i, line] of content.split('\n').entries()) {
    for (const pattern of patterns) {
      const requirement = javaVersion(pattern.exec(line)?.[1] ?? '');
      if (requirement) out.push({ file: path, line: i + 1, requirement });
    }
  }
  return dedupeDeclarations(out);
}

function javaVersion(raw: string): string | null {
  const numeric = numericRuntimeTag(raw.replace(/_/g, '.'));
  return numeric?.startsWith('1.') ? numeric.slice(2) : numeric;
}

function tomlPackageValue(content: string, key: string): { line: number; requirement: string } | null {
  let inPackage = false;
  for (const [i, line] of content.split('\n').entries()) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (table) {
      inPackage = table[1] === 'package';
      continue;
    }
    if (!inPackage) continue;
    const match = new RegExp(`^\\s*${key.replace('-', '\\-')}\\s*=\\s*['"]([^'"]+)['"]`).exec(line);
    if (match?.[1]) return { line: i + 1, requirement: match[1] };
  }
  return null;
}

function isCiPath(path: string): boolean {
  return /^\.github\/workflows\/.+\.ya?ml$/i.test(path) || /^\.(?:gitlab-ci|circleci)(?:\/|\.|$)/i.test(path);
}

function ciDeclarations(path: string, content: string, runtime: RuntimeName): RuntimeDeclaration[] {
  const fields: Record<RuntimeName, RegExp> = {
    node: /\bnode-version\s*:\s*['"]?([^\s'"#]+)/i,
    python: /\bpython-version\s*:\s*['"]?([^\s'"#]+)/i,
    ruby: /\bruby-version\s*:\s*['"]?([^\s'"#]+)/i,
    go: /\bgo-version\s*:\s*['"]?([^\s'"#]+)/i,
    java: /\bjava-version\s*:\s*['"]?([^\s'"#]+)/i,
    rust: /\btoolchain\s*:\s*['"]?([^\s'"#]+)/i,
  };
  const out: RuntimeDeclaration[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    const raw = fields[runtime].exec(line)?.[1];
    if (raw && !/[${}]/.test(raw)) {
      const requirement = numericRuntimeTag(raw);
      if (requirement) out.push({ file: path, line: i + 1, requirement });
    }

    // GitLab CI and CircleCI put authoritative runtimes in container images
    // rather than setup-action fields. Feed those image values through the
    // same recognizer Dockerfiles use so image semantics have one source of
    // truth across every config surface. Covers both the inline scalar form
    // (`image: node:18`, CircleCI's `- image: cimg/python:3.11`) and, below,
    // GitLab's map form (`image:` followed by an indented `name:`).
    const image = /^\s*(?:-\s*)?image\s*:\s*['"]?([^'"\s#]+)/i.exec(line)?.[1];
    if (image && !/[${}]/.test(image)) {
      const requirement = containerImageRequirement(image, runtime);
      if (requirement) out.push({ file: path, line: i + 1, requirement });
      continue;
    }

    // A bare `image:` with nothing after the colon starts a map — GitLab
    // accepts `image: { name: ..., entrypoint: [...] }` written as a block.
    // Only `name:` lines strictly inside *this* block count, so a sibling
    // `services:` block's own `name:`/`image:` entries (auxiliary service
    // containers, not the job's runtime) are never reached from here — they
    // are outside this loop's indentation range entirely.
    const bareImage = /^(\s*)(?:-\s*)?image\s*:\s*$/i.exec(line);
    if (bareImage) {
      const baseIndent = bareImage[1]!.length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (!next.trim()) continue;
        const indent = /^\s*/.exec(next)![0].length;
        if (indent <= baseIndent) break;
        const nameValue = /^\s*name\s*:\s*['"]?([^'"\s#]+)/i.exec(next)?.[1];
        if (nameValue && !/[${}]/.test(nameValue)) {
          const requirement = containerImageRequirement(nameValue, runtime);
          if (requirement) out.push({ file: path, line: j + 1, requirement });
        }
      }
    }
  }
  return dedupeDeclarations(out);
}

function lineValue(content: string, pattern: RegExp): { line: number; requirement: string } | null {
  for (const [i, line] of content.split('\n').entries()) {
    const requirement = pattern.exec(line)?.[1];
    if (requirement) return { line: i + 1, requirement };
  }
  return null;
}

function numericRuntimeTag(raw: string): string | null {
  const match = /(?:^|[-_])v?(\d+(?:[._]\d+){0,3})/.exec(raw.trim());
  return match?.[1]?.replace(/_/g, '.') ?? null;
}

function normalizeSemverRange(raw: string): string | null {
  const normalized = raw
    .trim()
    .replace(/^~>\s*/, '~')
    .replace(/^(?:ruby-|go|rust-)?v(?=\d)/i, '')
    .replace(/^(?:temurin|corretto|openjdk)[-_](?=\d)/i, '')
    .replace(/_/g, '.');
  return semver.validRange(normalized, { loose: true });
}

function dedupeDeclarations(declarations: readonly RuntimeDeclaration[]): RuntimeDeclaration[] {
  const seen = new Set<string>();
  return declarations.filter((declaration) => {
    const key = `${declaration.file}:${declaration.line}:${declaration.requirement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Find every place this repository declares its own Node.js version.
 *
 * Reuses whatever file contents the caller already read into memory -- no
 * extra I/O -- and only trusts the config surfaces `isRuntimeConfigPath`
 * already knows to check: `package.json#engines`, `.nvmrc`/`.node-version`,
 * Dockerfiles, and GitHub Actions workflow `node-version:` lines. A value
 * this cannot resolve to a literal version -- a matrix expression like
 * `${{ matrix.node }}` -- is left out rather than guessed at.
 */
export function findNodeDeclarations(
  files: readonly { path: string; content: string }[],
  member?: string,
  allMembers?: readonly string[],
): RuntimeDeclaration[] {
  return findRuntimeDeclarations(files, 'node', member, allMembers);
}

function findNodeDeclarationsIn(
  files: readonly { path: string; content: string }[],
): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];

  for (const { path, content } of files) {
    if (!isRuntimeConfigPath(path)) continue;
    const base = (path.split('/').pop() ?? '').toLowerCase();

    if (base === 'package.json') {
      const requirement = engineFromPackageJson(content);
      if (requirement) out.push({ file: path, line: lineOf(content, /"node"\s*:/), requirement });
      continue;
    }

    if (base === '.nvmrc' || base === '.node-version') {
      const requirement = content.trim().split('\n')[0]?.replace(/^v/i, '').trim();
      if (requirement) out.push({ file: path, line: 1, requirement });
      continue;
    }

    if (base.startsWith('dockerfile') || base.startsWith('containerfile')) {
      out.push(...containerDeclarations(path, content, 'node'));
      continue;
    }

    if (base === '.tool-versions') {
      for (const [i, line] of content.split('\n').entries()) {
        const match = /^\s*(node|nodejs)\s+([^\s#]+)/i.exec(line);
        if (match?.[2]) out.push({ file: path, line: i + 1, requirement: match[2] });
      }
      continue;
    }

    if (isCiPath(path)) {
      out.push(...ciDeclarations(path, content, 'node'));
    }
  }

  return out;
}

/**
 * Narrow a repository's files to the ones a runtime declaration for `member`
 * should actually be read from: that workspace's own directory, plus
 * anything that is not any workspace's business in particular — a root
 * config file in a repository where the root itself is not a package, or a
 * CI workflow, which conventionally governs the whole build regardless of
 * which member happens to own its directory.
 *
 * Without this, a runtime finder handed the whole repository's file list can
 * resolve a monorepo's Python service's `.python-version` against a sibling
 * Node package's dependency upgrade, because both files simply appear in the
 * same flat list.
 *
 * `member === undefined` means no workspace context is known at all (a
 * single-package repository, or a caller that has not gathered one) — every
 * file is kept, matching the tool's original behavior before workspace
 * scoping existed. `member === ''` is a real, meaningful case: the *root*
 * workspace of a multi-package repository, which must not inherit a sibling
 * member's declarations just because `''` is falsy.
 *
 * Ownership is resolved with `memberOf`, the same helper that already
 * attributes a dependency's own manifest to a workspace elsewhere in Drift,
 * rather than a second, independent guess at path prefixes.
 */
/**
 * Root-owned files that declare *a package's own* runtime, not the whole
 * repository's. When the root directory is itself a workspace member,
 * `memberOf` attributes these to `''` the same way it would attribute
 * `packages/api/package.json` to `'packages/api'` — that is correct for
 * finding the root package's own declaration, but wrong to then treat as
 * repository-global the way a root `.nvmrc` or CI workflow is.
 */
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
  'gemfile',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'cargo.toml',
]);

/**
 * Plain version-pin files: no build tool treats these as *this directory's*
 * declaration exclusively the way it does a manifest, nor as governing the
 * whole build regardless of directory the way CI/Dockerfiles do. Real
 * toolchains (nvm, rbenv, pyenv, asdf, rustup) walk from a directory upward
 * and stop at the first one they find — a nested `.nvmrc` overrides a root
 * one for that subtree, it does not merely add to it. `.tool-versions` is
 * included: asdf resolves it exactly the same way.
 */
const HIERARCHICAL_VERSION_FILES = new Set([
  '.nvmrc',
  '.node-version',
  '.ruby-version',
  '.python-version',
  'runtime.txt',
  '.tool-versions',
  'rust-toolchain',
  'rust-toolchain.toml',
]);

function scopedTo<T extends { path: string }>(
  files: readonly T[],
  member: string | undefined,
  allMembers: readonly string[] | undefined,
): readonly T[] {
  if (member === undefined) return files;
  const members = allMembers ?? [];
  const basenameOf = (path: string) => (path.split('/').pop() ?? '').toLowerCase();

  // If the member being analyzed has its own copy of a hierarchical version
  // file, that copy shadows an ancestor's (most commonly the root's) file of
  // the same name — the way `nvm`/`asdf` actually resolve one, and not the
  // way a repository-global CI workflow or an unrelated manifest works.
  const shadowedBasenames = new Set(
    files
      .filter((f) => HIERARCHICAL_VERSION_FILES.has(basenameOf(f.path)) && memberOf(f.path, members) === member)
      .map((f) => basenameOf(f.path)),
  );

  return files.filter((f) => {
    const owner = memberOf(f.path, members);
    if (owner === member) return true;

    const base = basenameOf(f.path);
    if (shadowedBasenames.has(base)) return false;

    // No member directory claims this file at all — genuinely repository-
    // global by construction (or the root is not itself a registered member).
    if (owner === null) return true;
    if (owner === '') {
      // The root workspace's own files. A CI workflow, `.nvmrc`, or Dockerfile
      // at the root conventionally governs the whole build regardless of
      // which member happens to own the root directory — but a root package
      // manifest is that package's own declared runtime, and must not leak
      // into a sibling member's compatibility check just because the root
      // happens to also be a workspace member.
      return !MANIFEST_BASENAMES.has(base) && !base.endsWith('.gemspec');
    }
    return false;
  });
}

function engineFromPackageJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { engines?: { node?: string } };
    return parsed.engines?.node ?? null;
  } catch {
    return null;
  }
}

function lineOf(content: string, pattern: RegExp): number {
  const idx = content.split('\n').findIndex((line) => pattern.test(line));
  return idx >= 0 ? idx + 1 : 1;
}

/**
 * Does everything this repository declares as its Node.js floor also satisfy
 * a dependency's newly raised requirement?
 *
 * Declarations are compared as ranges, not single versions -- ">=22.6.0" and
 * a bare CI major like "22" both denote a set of versions, not one -- so
 * `semver.subset` answers the question that actually matters: does every
 * version this repository could run on also satisfy the new floor. That is
 * stronger than `semver.intersects`, which would call ">=20.0.0" compatible
 * with "^22.13.0" just because the two overlap starting at 22.13.
 */
export function checkNodeCompatibility(
  declarations: readonly RuntimeDeclaration[],
  requirement: string,
): RuntimeCompatibility[] {
  const out: RuntimeCompatibility[] = [];

  for (const decl of declarations) {
    if (!semver.validRange(decl.requirement, { loose: true })) continue;

    let verdict: RuntimeCompatibility['verdict'];
    try {
      if (semver.subset(decl.requirement, requirement, { loose: true })) verdict = 'compatible';
      else if (!semver.intersects(decl.requirement, requirement, { loose: true })) verdict = 'incompatible';
      else verdict = 'partial';
    } catch {
      continue;
    }

    out.push({ ...decl, verdict });
  }

  return out;
}

/**
 * Find every place this repository declares its own Python version.
 *
 * `pyproject.toml`'s `[project] requires-python` is read with a table-scoped
 * line reader rather than a whole-file regex, so a `requires-python`-looking
 * string inside `[tool.poetry.dependencies]` or a comment is never mistaken
 * for the declaration. `setup.py` is different in kind: it is executable
 * Python, not data, so only a literal `python_requires="..."` keyword
 * argument is trusted — anything computed is left out rather than evaluated.
 */
export function findPythonDeclarations(
  files: readonly { path: string; content: string }[],
  member?: string,
  allMembers?: readonly string[],
): RuntimeDeclaration[] {
  return findRuntimeDeclarations(files, 'python', member, allMembers);
}

function findPythonDeclarationsIn(
  files: readonly { path: string; content: string }[],
): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];

  for (const { path, content } of files) {
    if (!isRuntimeConfigPath(path)) continue;
    const base = (path.split('/').pop() ?? '').toLowerCase();

    if (base === 'pyproject.toml') {
      const found = requiresPythonFromPyproject(content);
      if (found) out.push({ file: path, line: found.line, requirement: found.requirement });
      continue;
    }

    if (base === 'setup.cfg') {
      const found = pythonRequiresFromSetupCfg(content);
      if (found) out.push({ file: path, line: found.line, requirement: found.requirement });
      continue;
    }

    if (base === 'setup.py') {
      const call = extractSetupCall(content);
      const match = call ? /\bpython_requires\s*=\s*(['"])([^'"]+)\1/.exec(call) : null;
      if (match?.[2]) out.push({ file: path, line: lineOf(content, /python_requires\s*=/), requirement: match[2] });
      continue;
    }

    if (base === '.python-version') {
      // Pyenv allows more than one version in this file — one per line, or
      // several whitespace-separated on one line — and treats a `#` line as a
      // comment. Reading only the first line can miss an older version this
      // repository also builds and runs on, which is exactly the version a
      // compatibility verdict needs to fail against.
      for (const [i, line] of content.split('\n').entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        for (const token of trimmed.split(/\s+/)) {
          out.push({ file: path, line: i + 1, requirement: token });
        }
      }
      continue;
    }

    if (base === 'runtime.txt') {
      const requirement = content.trim().split('\n')[0]?.replace(/^python-/i, '').trim();
      if (requirement) out.push({ file: path, line: 1, requirement });
      continue;
    }

    if (base === '.tool-versions') {
      for (const [i, line] of content.split('\n').entries()) {
        const match = /^\s*(python|python3)\s+([^\s#]+)/i.exec(line);
        if (match?.[2]) out.push({ file: path, line: i + 1, requirement: match[2] });
      }
      continue;
    }

    if (base.startsWith('dockerfile') || base.startsWith('containerfile')) {
      out.push(...containerDeclarations(path, content, 'python'));
      continue;
    }

    if (isCiPath(path)) out.push(...ciDeclarations(path, content, 'python'));
  }

  return out;
}

/**
 * Read `requires-python` out of `pyproject.toml`'s `[project]` table only.
 *
 * Tracks the current table header line by line rather than searching the
 * whole file, so the same key spelled inside `[tool.*]` — a common place for
 * a build backend to also read a Python constraint — is not read as the
 * package's own declaration.
 */
function requiresPythonFromPyproject(content: string): { requirement: string; line: number } | null {
  const lines = content.split('\n');
  let inProjectTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inProjectTable = header[1]!.trim() === 'project';
      continue;
    }
    if (!inProjectTable) continue;

    const match = /^\s*requires-python\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;

    const requirement = parseTomlString(match[1]!);
    if (requirement) return { requirement, line: i + 1 };
  }

  return null;
}

/**
 * Isolate the `setup(...)` invocation's argument list, so a `python_requires`
 * mentioned in a comment, an unrelated assignment, or someone else's `setup`
 * method is never read as the package's declaration.
 *
 * Comment lines are blanked out first (a `#`-prefixed line only — a `#`
 * appearing after code on the same line is left alone, since a bare regex
 * cannot tell that apart from a `#` inside a string literal). Only a bare
 * `setup(` or a `setuptools.setup(` call counts as the invocation —
 * `helper.setup(...)`, a call on some unrelated object that merely shares the
 * method name, is excluded by requiring the call not be preceded by a `.` or
 * another identifier character (see `CALL_PATTERN`). The last matching call in
 * the file is taken, since that is conventionally the actual invocation;
 * anything named `def setup(...)` is excluded so a helper function of the
 * same name is not mistaken for it.
 *
 * The argument list itself is then isolated with a string-aware scan for the
 * matching close paren, rather than a bare character count — a `)` inside a
 * string argument (`long_description="See docs (v2)."`) must not be read as
 * ending the call early, which would silently drop every keyword argument
 * after it, `python_requires` very much included.
 */
const CALL_PATTERN = /(?<!def\s+)(?:(?<![.\w])setup|(?<!\w)setuptools\.setup)\s*\(/g;

function extractSetupCall(content: string): string | null {
  const withoutCommentLines = content
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');

  const calls = [...withoutCommentLines.matchAll(CALL_PATTERN)];
  const last = calls.at(-1);
  if (!last) return null;

  const openIndex = last.index + last[0].length - 1;
  const closeIndex = matchingParenIndex(withoutCommentLines, openIndex);
  return closeIndex === null ? null : withoutCommentLines.slice(openIndex, closeIndex + 1);
}

/**
 * The index of the `)` that closes the `(` at `openIndex`, skipping over the
 * contents of any string literal along the way — single- or double-quoted,
 * plain or triple-quoted, with escapes honoured in the non-triple forms.
 *
 * Returns `null` on anything this cannot confidently resolve (an unterminated
 * string, no matching close paren before the file ends), which is the safe
 * failure here: `extractSetupCall` then reports no call at all, and the
 * caller reports no declaration rather than one sliced at the wrong place.
 */
function matchingParenIndex(text: string, openIndex: number): number | null {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "'" || ch === '"') {
      const triple = text.slice(i, i + 3) === ch.repeat(3);
      const closer = triple ? ch.repeat(3) : ch;
      let j = i + closer.length;
      let terminated = false;
      while (j < text.length) {
        if (!triple && text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text.startsWith(closer, j)) {
          j += closer.length;
          terminated = true;
          break;
        }
        j += 1;
      }
      if (!terminated) return null;
      i = j;
      continue;
    }

    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

/** A TOML basic or literal string, with a trailing `# comment` stripped when unquoted. */
function parseTomlString(raw: string): string | null {
  const quoted = /^(['"])(.*)\1/.exec(raw);
  if (quoted) return quoted[2]!;
  return raw.split('#')[0]?.trim() || null;
}

/** Read `python_requires` out of `setup.cfg`'s `[options]` section only. */
function pythonRequiresFromSetupCfg(content: string): { requirement: string; line: number } | null {
  const lines = content.split('\n');
  let inOptionsSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inOptionsSection = header[1]!.trim() === 'options';
      continue;
    }
    if (!inOptionsSection) continue;

    const match = /^\s*python_requires\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;

    const requirement = match[1]!.split(';')[0]?.trim();
    if (requirement) return { requirement, line: i + 1 };
  }

  return null;
}

/**
 * Does everything this repository declares as its Python floor also satisfy
 * a dependency's newly raised `requires-python`?
 *
 * Same question `checkNodeCompatibility` answers for Node, over PEP 440
 * intervals instead of semver ranges — see `pep440.ts` for what "interval"
 * means here and where it cannot be exact.
 */
export function checkPythonCompatibility(
  declarations: readonly RuntimeDeclaration[],
  requirement: string,
): RuntimeCompatibility[] {
  const required = parseSpecifierSet(requirement);
  const out: RuntimeCompatibility[] = [];

  for (const decl of declarations) {
    const declared = parseSpecifierSet(decl.requirement);

    let verdict: RuntimeCompatibility['verdict'];
    if (isSubsetInterval(declared, required)) verdict = 'compatible';
    else if (!intersectsInterval(declared, required)) verdict = 'incompatible';
    else verdict = 'partial';

    out.push({ ...decl, verdict });
  }

  return out;
}
