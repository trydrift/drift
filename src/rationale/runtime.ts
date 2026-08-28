import semver from 'semver';
import { parseDocument, isMap, isScalar, isSeq, type Node } from 'yaml';
import { isRuntimeConfigPath } from '../index/walk.js';
import { memberOf } from '../detect/workspace.js';
import { intersectsInterval, isSubsetInterval, parseSpecifierSet, type VersionInterval } from './pep440.js';
import type { RuntimeCompatibilityState, RuntimeName } from '../types.js';

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

/** Which kind of file a declaration (resolved or not) was read out of. */
export type RuntimeDeclarationSource =
  | 'version-file'
  | 'manifest'
  | 'container'
  | 'ci'
  | 'tool-versions'
  | 'build-config';

/**
 * Everything a scan of this repository found about one runtime: the
 * declarations it could read, and the declaration *positions* it recognized
 * but could not resolve to a version.
 *
 * The two halves are returned together, from one pass, precisely so a caller
 * cannot accidentally look at only the first and read an empty list as
 * "nothing declared". A dynamic `FROM node:${NODE_VERSION}` is not the same
 * fact as a repository with no Dockerfile, and only this shape can say so.
 */
export interface RuntimeDeclarationDiscovery {
  resolved: RuntimeDeclaration[];
  unresolved: UnresolvedRuntimeDeclaration[];
}

export interface RuntimeCompatibility extends RuntimeDeclaration {
  /**
   * `'unknown'` means the declaration was found but could not be compared —
   * an alias (`lts/hydrogen`), a channel name, a range grammar this runtime's
   * ecosystem does not define. Emitted rather than dropped: a declaration
   * silently skipped is indistinguishable from a repository that never made
   * one, and that collapse is exactly what turns "Drift could not tell" into
   * "Drift found nothing wrong".
   */
  verdict: RuntimeCompatibilityState;
}

/**
 * Find declarations for any runtime named by structured upstream evidence.
 *
 * The resolved half of {@link discoverRuntimeDeclarations}. Prefer the
 * discovery form in any new caller that has to reason about compatibility —
 * this one cannot distinguish "nothing declared" from "declared dynamically".
 */
export function findRuntimeDeclarations(
  files: readonly { path: string; content: string }[],
  runtime: RuntimeName,
  member?: string,
  allMembers?: readonly string[],
): RuntimeDeclaration[] {
  return discoverRuntimeDeclarations(files, runtime, member, allMembers).resolved;
}

/**
 * The one pass that reads this repository's runtime declarations.
 *
 * Every declaration surface — version files, manifests, container images,
 * build configs, CI — is walked once, per runtime, after workspace scoping and
 * precedence have already been applied by `scopedTo`. Each surface reports two
 * things and never one: the versions it could read, and the positions it
 * recognized as *this runtime's* declaration but could not resolve to a
 * version.
 *
 * The second half is deliberately narrow. A position only becomes `unresolved`
 * once the parser has already established runtime identity — `FROM
 * node:${NODE_VERSION}` names Node and hides its version, so it is unresolved
 * Node; `FROM $BASE_IMAGE` names nothing at all, so it is not a Node
 * declaration in any state. Attaching every unreadable value in a CI file to
 * whichever runtime happened to be under analysis is what made a single
 * `image: $DEFAULT_CI_IMAGE` read as an unknown Node *and* Ruby *and* Python
 * declaration simultaneously.
 */
export function discoverRuntimeDeclarations(
  files: readonly { path: string; content: string }[],
  runtime: RuntimeName,
  member?: string,
  allMembers?: readonly string[],
): RuntimeDeclarationDiscovery {
  const scoped = scopedTo(files, member, allMembers);
  const found: RuntimeDeclarationDiscovery = { resolved: [], unresolved: [] };

  for (const { path, content } of scoped) {
    if (!isRuntimeConfigPath(path)) continue;
    const base = (path.split('/').pop() ?? '').toLowerCase();

    if (VERSION_FILES[runtime].includes(base)) {
      versionFileDeclarations(path, base, content, runtime, found);
      continue;
    }

    if (base === '.tool-versions') {
      toolVersionDeclarations(path, content, runtime, found);
      continue;
    }

    if (base.startsWith('dockerfile') || base.startsWith('containerfile')) {
      containerDeclarations(path, content, runtime, found);
      continue;
    }

    if (runtime === 'node' && base === 'package.json') {
      packageJsonEngineDeclarations(path, content, found);
      continue;
    }
    if (runtime === 'python' && ['pyproject.toml', 'setup.cfg', 'setup.py'].includes(base)) {
      pythonManifestDeclarations(path, base, content, found);
      continue;
    }
    if (runtime === 'ruby') {
      if (base === 'gemfile') rubyGemfileDeclarations(path, content, found, scoped);
      else if (base.endsWith('.gemspec')) rubyGemspecDeclarations(path, content, found);
    } else if (runtime === 'go' && base === 'go.mod') {
      goModDeclarations(path, content, found);
    } else if (runtime === 'java') {
      if (base === 'pom.xml') mavenJavaDeclarations(path, content, found);
      else if (base === 'build.gradle' || base === 'build.gradle.kts') gradleJavaDeclarations(path, content, found);
    } else if (runtime === 'rust' && base === 'cargo.toml') {
      const found_ = tomlPackageValue(content, 'rust-version');
      if (found_) record(found, runtime, path, found_.line, found_.requirement, 'manifest', found_.requirement);
    }

    if (isCiPath(path)) ciDeclarations(path, content, runtime, found, member, allMembers);
  }

  found.resolved = dedupeDeclarations(found.resolved);
  found.unresolved = dedupeUnresolved(found.unresolved);
  return found;
}

/**
 * Plain "this directory runs on version X" files, per runtime. Node's
 * `.nvmrc` says nothing about Ruby and vice versa, so the mapping is explicit
 * rather than inferred from whichever file happens to be present.
 */
const VERSION_FILES: Record<RuntimeName, readonly string[]> = {
  node: ['.nvmrc', '.node-version'],
  python: ['.python-version', 'runtime.txt'],
  ruby: ['.ruby-version'],
  rust: ['rust-toolchain', 'rust-toolchain.toml'],
  go: [],
  java: [],
};

/**
 * Record one recognized declaration position.
 *
 * `requirement === null` is the whole reason this exists: the position is
 * already known to belong to `runtime`, so failing to read its value is a
 * fact worth carrying (`unresolved`), never an absence.
 */
function record(
  found: RuntimeDeclarationDiscovery,
  runtime: RuntimeName,
  file: string,
  line: number,
  rawText: string,
  source: RuntimeDeclarationSource,
  requirement: string | null,
): void {
  if (requirement) found.resolved.push({ file, line, requirement });
  else found.unresolved.push({ runtime, file, line, rawText, source });
}

/**
 * A value that is a reference to a version rather than a version — a shell or
 * CI variable (`$NODE_VERSION`, `${NODE_VERSION}`), a GitHub Actions
 * expression (`${{ matrix.node }}`), a Maven property (`${java.version}`), a
 * Windows-style `%VAR%`, or an interpolated string.
 */
function isDynamicValue(raw: string): boolean {
  return /[$`%]|\{\{|\}\}/.test(raw);
}

function versionFileDeclarations(
  path: string,
  base: string,
  content: string,
  runtime: RuntimeName,
  found: RuntimeDeclarationDiscovery,
): void {
  if (base === 'rust-toolchain.toml') {
    const channel = lineValue(content, /^\s*channel\s*=\s*['"]([^'"]+)['"]/);
    if (!channel) return;
    record(found, runtime, path, channel.line, channel.requirement, 'version-file', dynamicOr(channel.requirement));
    return;
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
        record(found, runtime, path, i + 1, token, 'version-file', dynamicOr(token));
      }
    }
    return;
  }

  const first = content.trim().split('\n')[0]?.trim();
  if (!first) return;
  const stripped = base === 'runtime.txt'
    ? first.replace(/^python-/i, '').trim()
    : first.replace(/^(?:ruby-|go|rust-)?v?/i, '').trim();
  if (!stripped) return;
  record(found, runtime, path, 1, first, 'version-file', dynamicOr(stripped));
}

/** The value itself when it is a literal, `null` when it only points at one. */
function dynamicOr(raw: string): string | null {
  return isDynamicValue(raw) ? null : raw;
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
  const requiredRange = normalizeSemverRange(runtime === 'java' ? javaVersion(requirement) ?? requirement : requirement);
  for (const declaration of declarations) {
    const declaredRange = normalizeSemverRange(runtime === 'java' ? javaVersion(declaration.requirement) ?? declaration.requirement : declaration.requirement);
    if (!declaredRange || !requiredRange) {
      out.push({ ...declaration, verdict: 'unknown' });
      continue;
    }
    let verdict: RuntimeCompatibility['verdict'];
    try {
      if (semver.subset(declaredRange, requiredRange, { loose: true })) verdict = 'compatible';
      else if (!semver.intersects(declaredRange, requiredRange, { loose: true })) verdict = 'incompatible';
      else verdict = 'partial';
    } catch {
      verdict = 'unknown';
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

  const unsupportedRange = normalizeSemverRange(runtime === 'java' ? javaVersion(unsupportedRequirement) ?? unsupportedRequirement : unsupportedRequirement);
  const out: RuntimeCompatibility[] = [];
  for (const declaration of declarations) {
    const declaredRange = normalizeSemverRange(runtime === 'java' ? javaVersion(declaration.requirement) ?? declaration.requirement : declaration.requirement);
    if (!declaredRange || !unsupportedRange) {
      out.push({ ...declaration, verdict: 'unknown' });
      continue;
    }
    let verdict: RuntimeCompatibility['verdict'];
    try {
      if (semver.subset(declaredRange, unsupportedRange, { loose: true })) verdict = 'incompatible';
      else if (!semver.intersects(declaredRange, unsupportedRange, { loose: true })) verdict = 'compatible';
      else verdict = 'partial';
    } catch {
      verdict = 'unknown';
    }
    out.push({ ...declaration, verdict });
  }
  return out;
}

export type ParsedPythonRuntimeRange =
  | { status: 'parsed'; value: VersionInterval }
  | { status: 'unknown'; reason: 'unsupported-grammar' | 'unparseable' };

/**
 * Parse a Python runtime range without asking callers to infer failure from
 * whatever partial bounds the PEP 440 interval parser happened to recover.
 * An imprecise interval is not representable by Drift's model and therefore
 * cannot support any compatibility verdict, regardless of whether the text
 * belonged to the repository or to upstream.
 */
export function parsePythonRuntimeRange(
  requirement: string,
  kind: 'minimum' | 'unsupported' = 'minimum',
): ParsedPythonRuntimeRange {
  const normalized = kind === 'unsupported' ? requirement.replace(/\.x$/i, '.*') : requirement;
  if (/^\s*(?:\^|~(?![=>]))/.test(normalized)) {
    return { status: 'unknown', reason: 'unsupported-grammar' };
  }
  const value = parseSpecifierSet(normalized);
  if (value.imprecise || (value.min === null && value.max === null)) {
    return { status: 'unknown', reason: 'unparseable' };
  }
  return { status: 'parsed', value };
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
  const unsupported = parsePythonRuntimeRange(unsupportedRequirement, 'unsupported');
  const out: RuntimeCompatibility[] = [];
  for (const declaration of declarations) {
    const declared = parsePythonRuntimeRange(declaration.requirement);
    let verdict: RuntimeCompatibility['verdict'];
    if (unsupported.status === 'unknown' || declared.status === 'unknown') verdict = 'unknown';
    else if (isSubsetInterval(declared.value, unsupported.value)) verdict = 'incompatible';
    else if (!intersectsInterval(declared.value, unsupported.value)) verdict = 'compatible';
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
  /**
   * Which runtime this position declares. Present because identity is the
   * precondition for existing at all: a value with no runtime identity —
   * `image: $DEFAULT_CI_IMAGE`, `FROM $BASE_IMAGE` — produces no
   * `UnresolvedRuntimeDeclaration` for any runtime, rather than one for every
   * runtime under analysis.
   */
  runtime: RuntimeName;
  file: string;
  line: number;
  /** The unresolvable value exactly as written, for the report to quote. */
  rawText: string;
  source: RuntimeDeclarationSource;
}

const TOOL_VERSION_KEYS: Record<RuntimeName, readonly string[]> = {
  node: ['node', 'nodejs'],
  python: ['python', 'python3'],
  go: ['go', 'golang'],
  ruby: ['ruby'],
  java: ['java'],
  rust: ['rust'],
};

function toolVersionDeclarations(
  path: string,
  content: string,
  runtime: RuntimeName,
  found: RuntimeDeclarationDiscovery,
): void {
  for (const [i, line] of content.split('\n').entries()) {
    const match = /^\s*([\w-]+)\s+([^\s#]+)/.exec(line);
    // The *key* is what establishes runtime identity here, and it is a
    // structural field of the format — so `nodejs $NODE_VERSION` is a Node
    // declaration whose value could not be read, while `gitleaks 8.24.3` is
    // not a runtime declaration at all.
    if (!match || !TOOL_VERSION_KEYS[runtime].includes(match[1]!.toLowerCase())) continue;
    const values = line.slice(match.index! + match[0].length - match[2]!.length).split('#', 1)[0]!.split(/\s+/).filter(Boolean);
    for (const raw of values) {
      const requirement = isDynamicValue(raw) || /^(?:system|path:|ref:)/i.test(raw)
        ? null
        : runtime === 'java' ? javaVersion(raw) : raw;
      record(found, runtime, path, i + 1, raw, 'tool-versions', requirement);
    }
  }
}

function containerDeclarations(
  path: string,
  content: string,
  runtime: RuntimeName,
  found: RuntimeDeclarationDiscovery,
): void {
  for (const [i, line] of content.split('\n').entries()) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line)?.[1];
    if (!from) continue;
    recordImage(found, runtime, path, i + 1, from, 'container');
  }
}

/**
 * Record a container image reference, if and only if the image *names* this
 * runtime.
 *
 * `node:${NODE_VERSION}` is unmistakably a Node runtime image whose tag Drift
 * cannot resolve — unresolved Node. `$BASE_IMAGE` and `$DEFAULT_CI_IMAGE`
 * name no runtime at all, so nothing is recorded for any runtime: they are
 * not Node declarations that happen to be unreadable, they are simply not
 * Node declarations.
 */
function recordImage(
  found: RuntimeDeclarationDiscovery,
  runtime: RuntimeName,
  path: string,
  line: number,
  image: string,
  source: RuntimeDeclarationSource,
): void {
  const identity = identifyRuntimeImage(image);
  if (!identity || identity.runtime !== runtime) return;
  const version = identity.version;
  record(
    found,
    runtime,
    path,
    line,
    image,
    source,
    version && !isDynamicValue(version) ? numericRuntimeTag(version) : null,
  );
}

/**
 * Runtime identity and version extraction are separate questions. A bare or
 * digest-only `node` image still names Node even though it supplies no tag
 * Drift can compare. Shared by Dockerfiles, GitLab CI and CircleCI so the
 * surfaces cannot diverge.
 */
export interface RuntimeImageIdentity {
  runtime: RuntimeName;
  version?: string;
}

const RUNTIME_IMAGE_NAMES: Readonly<Record<string, RuntimeName>> = {
  node: 'node',
  python: 'python',
  ruby: 'ruby',
  golang: 'go',
  openjdk: 'java',
  'eclipse-temurin': 'java',
  amazoncorretto: 'java',
  rust: 'rust',
};

export function identifyRuntimeImage(raw: string): RuntimeImageIdentity | null {
  const image = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!image || image.startsWith('$')) return null;

  const withoutDigest = image.split('@', 1)[0]!;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  const hasTag = colon > slash;
  const repository = (hasTag ? withoutDigest.slice(0, colon) : withoutDigest).split('/').at(-1)?.toLowerCase();
  if (!repository) return null;
  const runtime = RUNTIME_IMAGE_NAMES[repository];
  if (!runtime) return null;
  const version = hasTag ? withoutDigest.slice(colon + 1) : undefined;
  return version ? { runtime, version } : { runtime };
}

/**
 * `package.json#engines.node`.
 *
 * A dynamic value here (`"node": "${NODE_VERSION}"`, written by a template or
 * a release tool) is a Node declaration Drift cannot read, not the absence of
 * one — the field name already settled runtime identity.
 */
function packageJsonEngineDeclarations(
  path: string,
  content: string,
  found: RuntimeDeclarationDiscovery,
): void {
  const engine = engineFromPackageJson(content);
  if (!engine) return;
  record(found, 'node', path, lineOf(content, /"node"\s*:/), engine.raw, 'manifest', engine.requirement);
}

function pythonManifestDeclarations(
  path: string,
  base: string,
  content: string,
  found: RuntimeDeclarationDiscovery,
): void {
  if (base === 'setup.py') {
    const setup = setupPyPythonRequires(content);
    if (setup) record(found, 'python', path, setup.line, setup.raw, 'manifest', setup.requirement);
    return;
  }
  const located =
    base === 'pyproject.toml'
      ? requiresPythonFromPyproject(content)
      : base === 'setup.cfg'
        ? pythonRequiresFromSetupCfg(content)
        : null;
  if (!located) return;
  record(found, 'python', path, located.line, located.requirement, 'manifest', dynamicOr(located.requirement));
}

function rubyGemfileDeclarations(
  path: string,
  content: string,
  found: RuntimeDeclarationDiscovery,
  files: readonly { path: string; content: string }[],
): void {
  for (const [i, line] of content.split('\n').entries()) {
    const call = /^\s*ruby\s+(.+?)\s*(?:#.*)?$/.exec(line)?.[1]?.trim();
    if (!call) continue;
    const literal = /^(['"])([^'"]+)\1/.exec(call)?.[2];
    const fileRef = /^file\s*:\s*(['"])([^'"]+)\1/.exec(call)?.[2];
    if (fileRef) {
      const referenced = files.find((file) => file.path === fileRef || file.path.endsWith(`/${fileRef}`));
      if (referenced) {
        const value = referenced.content.trim().split(/\s+/)[0];
        if (value && !isDynamicValue(value)) continue;
      }
    }
    record(found, 'ruby', path, i + 1, call, 'manifest', literal ? dynamicOr(literal) : null);
  }
}

function rubyGemspecDeclarations(path: string, content: string, found: RuntimeDeclarationDiscovery): void {
  for (const [i, line] of content.split('\n').entries()) {
    const raw = /\.required_ruby_version\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line)?.[1]?.trim();
    if (!raw) continue;
    const literal = /^(['"])([^'"]+)\1/.exec(raw)?.[2];
    record(found, 'ruby', path, i + 1, raw, 'manifest', literal ? dynamicOr(literal) : null);
  }
}

function goModDeclarations(path: string, content: string, found: RuntimeDeclarationDiscovery): void {
  for (const [i, line] of content.split('\n').entries()) {
    const match = /^\s*(go|toolchain)\s+(?:go)?(\d+(?:\.\d+){0,3})\s*(?:\/\/.*)?$/.exec(line);
    if (match?.[2]) record(found, 'go', path, i + 1, match[2], 'manifest', match[2]);
  }
}

/**
 * Maven's Java version, including the property indirection nearly every real
 * `pom.xml` uses: `<maven.compiler.release>${java.version}</maven.compiler.release>`
 * alongside a `<properties><java.version>17</java.version></properties>`.
 *
 * The property is looked up in the same file first — a one-hop substitution,
 * not a general expression evaluator — because the alternative (calling every
 * such pom unresolved) would report "Drift could not determine compatibility"
 * for the single most common way Java projects state their version. Only when
 * the property genuinely is not declared here does the position become
 * unresolved, which is the honest answer: the value lives in a parent pom or
 * a build profile Drift has not read.
 */
function mavenJavaDeclarations(path: string, content: string, found: RuntimeDeclarationDiscovery): void {
  const positions: { line: number; raw: string }[] = [];
  // Compiler source/target/release settings describe bytecode compatibility,
  // not the JVM that runs the application. Only an explicit java.version
  // property is eligible as a runtime declaration here.
  const pattern = /<java\.version>\s*([^<]+?)\s*<\//g;
  for (const match of content.matchAll(pattern)) {
    positions.push({ line: content.slice(0, match.index).split('\n').length, raw: match[1]! });
  }
  // Compiler `release`/`source`/`target` — even an unresolved `${property}` one
  // — describes emitted bytecode, not the JVM that runs the application. It is
  // deliberately NOT added to `found.unresolved`: that set feeds `stateOf`,
  // where a single unresolved entry forces the whole runtime verdict to
  // `unknown`, and compiler-target uncertainty must never override an
  // authoritative `<java.version>`/toolchain declaration that does resolve.
  //
  // `<java.version>` itself is not automatically that authoritative
  // declaration either — see #137. It is an extremely common Maven
  // convention, but the property alone does not say whether it names the
  // actual build/deploy JDK or is merely the value fed to the compiler's
  // `source`/`target`/`release`. Only a Maven Toolchains plugin block that
  // provisions the build JDK from this same property is a structural signal
  // strong enough to call it authoritative; absent that, it is real evidence
  // — worth surfacing — but never enough by itself to decide
  // `compatible`/`incompatible` for this project's execution runtime.
  const authoritative = mavenJavaVersionIsToolchainProvisioned(content);
  for (const { line, raw } of positions) {
    if (/^\s*\$\{[^}]+\}\s*$/.test(raw) && resolveMavenProperty(content, raw)) continue;
    const resolved = resolveMavenProperty(content, raw);
    const requirement = resolved ? javaVersion(resolved) : null;
    record(found, 'java', path, line, raw, 'manifest', authoritative ? requirement : null);
  }
}

/**
 * Is `<java.version>` tied to the JDK Maven actually provisions to build
 * with, rather than merely a value the compiler plugin happens to read?
 *
 * The Maven Toolchains plugin (`maven-toolchains-plugin`) is the mechanism
 * Maven itself provides for pinning the *build* JDK — as opposed to
 * `maven.compiler.source`/`target`/`release`, which only constrain emitted
 * bytecode and say nothing about which JDK produced it. A `<jdk><version>`
 * inside that plugin's configuration that resolves to this same property is
 * a real, structural declaration of build-JDK intent, not a guess.
 */
function mavenJavaVersionIsToolchainProvisioned(content: string): boolean {
  if (!/<artifactId>\s*maven-toolchains?-plugin\s*<\/artifactId>/i.test(content)) return false;
  return /<jdk>[\s\S]*?<version>\s*\$\{java\.version\}\s*<\/version>[\s\S]*?<\/jdk>/i.test(content);
}

/** One hop of `${property}` substitution against this pom's own `<properties>`. */
function resolveMavenProperty(content: string, raw: string): string | null {
  const property = /^\$\{([^}]+)\}$/.exec(raw.trim())?.[1];
  if (!property) return isDynamicValue(raw) ? null : raw;
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = new RegExp(`<${escaped}>\\s*([^<]+?)\\s*</${escaped}>`).exec(content)?.[1];
  return value && !isDynamicValue(value) ? value : null;
}

/**
 * Gradle's Java toolchain, in both the modern
 * `JavaLanguageVersion.of(21)` form and the older
 * Java toolchain declarations. `sourceCompatibility` and
 * `targetCompatibility` describe emitted bytecode, not the runtime JVM.
 *
 * The argument is captured whatever shape it has, so
 * `JavaLanguageVersion.of(javaVersion)` — a project property resolved at
 * configuration time — is recorded as an unresolved Java declaration rather
 * than vanishing because the regex only ever matched digits.
 */
function gradleJavaDeclarations(path: string, content: string, found: RuntimeDeclarationDiscovery): void {
  const patterns = [
    /JavaLanguageVersion\.of\(\s*([^)]+?)\s*\)/,
  ];
  for (const [i, line] of content.split('\n').entries()) {
    for (const pattern of patterns) {
      const raw = pattern.exec(line)?.[1];
      if (!raw) continue;
      record(found, 'java', path, i + 1, raw, 'build-config', isDynamicValue(raw) ? null : javaVersion(raw));
    }
  }
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

/**
 * The CI fields whose *name* identifies a runtime. `node-version:` is a Node
 * declaration whatever its value is — including `${{ matrix.node }}`, which
 * is a Node declaration Drift cannot resolve.
 */
const CI_RUNTIME_FIELD_NAMES: Record<RuntimeName, string> = {
  node: 'node-version',
  python: 'python-version',
  ruby: 'ruby-version',
  go: 'go-version',
  java: 'java-version',
  rust: 'toolchain',
};

function yamlKeyValue(line: string, key: string): { raw: string } | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*(?:-\\s*)?${escaped}\\s*:\\s*(.*?)\\s*$`, 'i').exec(line);
  if (!match) return null;
  const value = match[1]!.replace(/\\s+#.*$/, '').trim();
  const quoted = /^(['"])(.*?)\1$/.exec(value)?.[2];
  return { raw: quoted ?? value };
}

/**
 * Mark YAML lines that are configuration structure rather than literal text
 * inside a `|`/`>` scalar. An anchored key matcher alone is insufficient for
 * a workflow such as `run: |` followed by `node-version: 16`: that indented
 * text is shell input, not a YAML key.
 */
function yamlStructuralLineMask(lines: readonly string[]): boolean[] {
  const structural = Array.from({ length: lines.length }, () => true);
  let scalarIndent: number | null = null;
  const blockScalar = /(?:^\s*-\s*|:\s*)[>|](?:(?:[+-]?\d)|(?:\d[+-]?))?\s*(?:#.*)?$/;

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    const indent = /^\s*/.exec(line)![0].length;
    if (scalarIndent !== null) {
      if (!trimmed || indent > scalarIndent) {
        structural[i] = false;
        continue;
      }
      scalarIndent = null;
    }
    if (blockScalar.test(line)) scalarIndent = indent;
  }
  return structural;
}

function ciDeclarations(
  path: string,
  content: string,
  runtime: RuntimeName,
  found: RuntimeDeclarationDiscovery,
  member?: string,
  allMembers?: readonly string[],
): void {
  const lines = content.split('\n');
  const structural = yamlStructuralLineMask(lines);
  const { allowed, ambiguous } = ciJobLinesForMember(lines, member, allMembers);
  // GitHub Actions only: a `${{ matrix.<key> }}` runtime value whose job
  // defines that matrix key statically can be resolved to concrete versions.
  const resolveMatrix = /^\.github\/workflows\/.+\.ya?ml$/i.test(path)
    ? buildGithubMatrixResolver(content, lines)
    : null;
  // A CI declaration whose owning job could not be attributed to this
  // specific member is real evidence of *something*, but not evidence this
  // member's compatibility may be decided from — see `ciJobLinesForMember`.
  // Recording it as unresolved (never as a resolved, votable declaration)
  // keeps `stateOf` from folding an unattributed root pin into a definite
  // `incompatible`/`compatible` verdict for a member it may not even govern.
  const recordCi = (line: number, rawText: string, source: RuntimeDeclarationSource, requirement: string | null) => {
    record(found, runtime, path, line, rawText, source, ambiguous[line - 1] ? null : requirement);
  };

  for (const [i, line] of lines.entries()) {
    if (!structural[i]) continue;
    if (!allowed[i]) continue;
    // A `python-version:` key *inside* `strategy.matrix` is a matrix dimension,
    // not a setup-action input — reading it as one records a spurious
    // unresolved declaration that then forces the whole verdict to `unknown`.
    if (resolveMatrix?.insideMatrix(i)) continue;
    const field = yamlKeyValue(line, CI_RUNTIME_FIELD_NAMES[runtime]);
    if (field) {
      const raw = field.raw;
      const matrixKey = resolveMatrix && exactMatrixReference(raw);
      const resolved = resolveMatrix && matrixKey ? resolveMatrix.resolve(i, matrixKey) : null;
      if (resolved?.ok) {
        // The matrix feeding this expression is statically enumerable, so the
        // consumer is not unresolved: it stands for these concrete versions,
        // each cited at the matrix literal that produced it. The raw
        // expression is deliberately not also recorded — a resolved consumer
        // must leave nothing behind in `found.unresolved`.
        for (const resolvedValue of resolved.values) {
          recordCi(resolvedValue.line, resolvedValue.value, 'ci', numericRuntimeTag(resolvedValue.value));
        }
      } else {
        recordCi(i + 1, raw, 'ci', isDynamicValue(raw) ? null : numericRuntimeTag(raw));
      }
    }

    // GitHub Actions job containers are application runtimes; service
    // containers are not. Keep this provider-specific instead of treating
    // every YAML `image:` key as the job runtime.
    if (/^\.github\/workflows\//i.test(path)) {
      const scalar = /^\s*container\s*:\s*['"]?([^'"\s#]+)/i.exec(line)?.[1];
      if (scalar) recordCiImage(found, runtime, path, i + 1, scalar, 'ci', ambiguous);
      if (/^\s*container\s*:\s*$/i.test(line)) {
        const baseIndent = /^\s*/.exec(line)![0].length;
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]!;
          if (!next.trim()) continue;
          const indent = /^\s*/.exec(next)![0].length;
          if (indent <= baseIndent) break;
          const image = /^\s*image\s*:\s*['"]?([^'"\s#]+)/i.exec(next)?.[1];
          if (image) recordCiImage(found, runtime, path, j + 1, image, 'ci', ambiguous);
        }
      }
      continue;
    }

    // GitLab CI and CircleCI put authoritative runtimes in container images
    // rather than setup-action fields. Feed those image values through the
    // same recognizer Dockerfiles use so image semantics have one source of
    // truth across every config surface. Covers both the inline scalar form
    // (`image: node:18`, CircleCI's `- image: cimg/python:3.11`) and, below,
    // GitLab's map form (`image:` followed by an indented `name:`).
    //
    // `recordImage` is what keeps a generic `image: $DEFAULT_CI_IMAGE` out of
    // every runtime's results: the image has to *name* the runtime before its
    // unreadable tag can mean anything about that runtime.
    const image = /^\s*(?:-\s*)?image\s*:\s*['"]?([^'"\s#]+)/i.exec(line)?.[1];
    if (image) {
      recordCiImage(found, runtime, path, i + 1, image, 'ci', ambiguous);
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
        if (!structural[j]) continue;
        const nameValue = /^\s*name\s*:\s*['"]?([^'"\s#]+)/i.exec(next)?.[1];
        if (nameValue) recordCiImage(found, runtime, path, j + 1, nameValue, 'ci', ambiguous);
      }
    }
  }
}

/**
 * `recordImage`, but routed through the same ambiguous-ownership guard as
 * every other CI declaration: an image whose job could not be attributed to
 * this member is recorded unresolved, never as a resolved declaration that
 * could swing `stateOf` to a definite verdict for a member it may not govern.
 */
function recordCiImage(
  found: RuntimeDeclarationDiscovery,
  runtime: RuntimeName,
  path: string,
  line: number,
  image: string,
  source: RuntimeDeclarationSource,
  ambiguous: readonly boolean[],
): void {
  if (!ambiguous[line - 1]) {
    recordImage(found, runtime, path, line, image, source);
    return;
  }
  const identity = identifyRuntimeImage(image);
  if (!identity || identity.runtime !== runtime) return;
  record(found, runtime, path, line, image, source, null);
}

interface GithubJobBlock {
  name: string;
  /** 0-indexed line of the job's key line. */
  start: number;
  /** 0-indexed line one past the job's last line. */
  end: number;
}

/**
 * Slice a GitHub Actions workflow into per-job line ranges.
 *
 * Shared by workspace-ownership scoping ({@link ciJobLinesForMember}) and
 * static matrix resolution ({@link buildGithubMatrixResolver}) so there is a
 * single notion of which job a line belongs to. The parse is intentionally
 * shallow: it finds the `jobs:` key at whatever indentation the file uses,
 * takes the indentation of the first mapping key beneath it as the job level,
 * and slices each job block by that indentation. `null` when the structure is
 * unrecognizable (no `jobs:` key, or nothing nested under it) — GitLab's
 * top-level job keys, a malformed file — which every caller treats the same
 * way it treats a recognized-but-unscoped job.
 */
function githubActionsJobBlocks(lines: readonly string[]): GithubJobBlock[] | null {
  const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
  const isBlank = (line: string) => !line.trim() || /^\s*#/.test(line);

  const jobsLine = lines.findIndex((line) => /^[ \t]*jobs:\s*(#.*)?$/.test(line));
  if (jobsLine === -1) return null;
  const jobsIndent = indentOf(lines[jobsLine]!);

  let jobIndent: number | null = null;
  const starts: number[] = [];
  const names: string[] = [];
  let blockEnd = lines.length;
  for (let i = jobsLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    if (indent <= jobsIndent) {
      blockEnd = i;
      break;
    }
    if (jobIndent === null) jobIndent = indent;
    const key = indent === jobIndent ? /^[ \t]*([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line) : null;
    if (key) {
      starts.push(i);
      names.push(key[1]!);
    }
  }
  if (starts.length === 0) return null;

  return starts.map((start, k) => ({
    name: names[k]!,
    start,
    end: k + 1 < starts.length ? starts[k + 1]! : blockEnd,
  }));
}

/** `${{ matrix.<key> }}` and nothing else — the only expression shape resolved statically. */
const EXACT_MATRIX_REFERENCE = /^\s*\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}\s*$/;

function exactMatrixReference(raw: string): string | null {
  return EXACT_MATRIX_REFERENCE.exec(raw)?.[1] ?? null;
}

interface ResolvedMatrixValue {
  value: string;
  /** 1-indexed line of the matrix literal that produced this value. */
  line: number;
}

/**
 * `{ ok: true }` only when every reachable static job configuration supplies a
 * concrete value for the referenced key. `{ ok: false }` covers "no such
 * matrix", a dynamic dimension (`runtime: ${{ fromJSON(...) }}`), an
 * `include`/`exclude` entry Drift cannot evaluate, and an `include` that can
 * leave the key unset — every case where the consumer must stay unresolved.
 */
type MatrixResolution = { ok: true; values: ResolvedMatrixValue[] } | { ok: false };

/**
 * A resolver for `${{ matrix.<key> }}` runtime values in one GitHub Actions
 * workflow, or `null` when the file will not parse or has no recognizable
 * `jobs:` structure.
 *
 * A matrix reference is job-scoped, so resolution is against the same job the
 * consuming line sits in — the job boundaries come from the shared
 * {@link githubActionsJobBlocks}, never a second guess. Its output is generic
 * `{ value, line }` pairs; runtime-specific normalization stays in
 * {@link ciDeclarations}.
 */
interface GithubMatrixResolver {
  /** Resolve `${{ matrix.<key> }}` for the job containing a 0-indexed line. */
  resolve(lineIndex: number, key: string): MatrixResolution;
  /**
   * Is this 0-indexed line inside a job's `strategy.matrix` block? Such a line
   * is a matrix *dimension definition* — `python-version:` under `matrix:` —
   * not a setup-action input, so the line-oriented field scan must skip it or
   * it records a bogus unresolved declaration (which then forces `unknown`).
   */
  insideMatrix(lineIndex: number): boolean;
}

function buildGithubMatrixResolver(content: string, lines: readonly string[]): GithubMatrixResolver | null {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(content, { prettyErrors: false });
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;

  const blocks = githubActionsJobBlocks(lines);
  if (!blocks) return null;

  // 1-indexed inclusive line spans of every job's `strategy.matrix` value, so
  // the field scan can tell a matrix dimension from a setup-action input.
  const matrixSpans: [number, number][] = [];
  for (const block of blocks) {
    const node = doc.getIn(['jobs', block.name, 'strategy', 'matrix'], true) as Node | null;
    if (!node?.range) continue;
    matrixSpans.push([
      content.slice(0, node.range[0]).split('\n').length,
      content.slice(0, node.range[2]).split('\n').length,
    ]);
  }

  const cache = new Map<string, MatrixResolution>();
  const resolve = (lineIndex: number, key: string): MatrixResolution => {
    const block = blocks.find((b) => lineIndex >= b.start && lineIndex < b.end);
    if (!block) return { ok: false };
    const cacheKey = `${block.name} ${key}`;
    let resolution = cache.get(cacheKey);
    if (!resolution) {
      resolution = resolveJobMatrixKey(doc, content, block.name, key);
      cache.set(cacheKey, resolution);
    }
    return resolution;
  };

  return {
    resolve,
    insideMatrix: (lineIndex) => {
      const line = lineIndex + 1;
      return matrixSpans.some(([from, to]) => line >= from && line <= to);
    },
  };
}

/**
 * Expand one job's static `strategy.matrix` — base dimensions × `exclude` ×
 * `include`, GitHub's own semantics — and project `key` from the reachable
 * configurations.
 */
function resolveJobMatrixKey(
  doc: ReturnType<typeof parseDocument>,
  content: string,
  jobName: string,
  key: string,
): MatrixResolution {
  const matrixNode = doc.getIn(['jobs', jobName, 'strategy', 'matrix'], true);
  if (!isMap(matrixNode)) return { ok: false };

  const lineAt = (node: unknown): number => {
    const range = (node as Node | null)?.range;
    return range ? content.slice(0, range[0]).split('\n').length : 1;
  };
  // A scalar Drift can trust as a literal: a plain string/number/bool, never a
  // `${{ }}` expression.
  const literal = (node: unknown): { value: string; line: number } | null => {
    if (!isScalar(node)) return null;
    const raw = node.value;
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return null;
    const text = String(raw);
    return /\$\{\{/.test(text) ? null : { value: text, line: lineAt(node) };
  };

  const baseKeys: string[] = [];
  const dimensions = new Map<string, { value: string; line: number }[]>();
  for (const pair of matrixNode.items) {
    const k = isScalar(pair.key) ? String(pair.key.value) : null;
    if (k === null || k === 'include' || k === 'exclude') continue;
    baseKeys.push(k);
    if (isScalar(pair.value)) {
      // GitHub treats a scalar dimension as a one-element list.
      const lit = literal(pair.value);
      if (!lit) return { ok: false }; // a dynamic dimension
      dimensions.set(k, [lit]);
      continue;
    }
    if (!isSeq(pair.value)) return { ok: false };
    const values: { value: string; line: number }[] = [];
    for (const item of pair.value.items) {
      const lit = literal(item);
      if (!lit) return { ok: false };
      values.push(lit);
    }
    dimensions.set(k, values);
  }

  // Cartesian product of the base dimensions. No base dimensions is a valid
  // include-only matrix — the product then starts empty, not with one config.
  let configs: Map<string, { value: string; line: number }>[] = baseKeys.length > 0 ? [new Map()] : [];
  for (const k of baseKeys) {
    const next: typeof configs = [];
    for (const config of configs) {
      for (const value of dimensions.get(k) ?? []) {
        const copy = new Map(config);
        copy.set(k, value);
        next.push(copy);
      }
    }
    configs = next;
  }
  const baseKeySet = new Set(baseKeys);

  // `include` / `exclude` may only be skipped when they are genuinely absent.
  // A present-but-dynamic form — `exclude: ${{ fromJSON(...) }}`, a mapping, a
  // bare `include:` — changes the reachable configuration set in a way Drift
  // cannot enumerate statically, so the consumer must stay unresolved rather
  // than resolve against the visible static dimensions alone.
  const excludeNode = matrixNode.get('exclude', true);
  if (matrixNode.has('exclude') && !isSeq(excludeNode)) return { ok: false };
  if (isSeq(excludeNode)) {
    for (const entry of excludeNode.items) {
      if (!isMap(entry)) return { ok: false };
      const pairs: { k: string; value: string }[] = [];
      for (const p of entry.items) {
        const pk = isScalar(p.key) ? String(p.key.value) : null;
        const lit = literal(p.value);
        if (pk === null || !lit) return { ok: false };
        pairs.push({ k: pk, value: lit.value });
      }
      // GitHub removes every base combination matching all of an exclude
      // entry's key/value pairs.
      configs = configs.filter((config) => !pairs.every((p) => config.get(p.k)?.value === p.value));
    }
  }

  const includeNode = matrixNode.get('include', true);
  if (matrixNode.has('include') && !isSeq(includeNode)) return { ok: false };
  if (isSeq(includeNode)) {
    // Only the base Cartesian product is a merge target. An include entry that
    // becomes its own standalone combination is never one — otherwise a second
    // include-only entry would overwrite the first instead of standing beside
    // it. Earlier includes' *augmentations* of an original combination can
    // still be overwritten by a later include, since those combos stay in the
    // list. Mutations here are in place, so the list keeps the changes.
    const originalCombos = configs.slice();
    for (const entry of includeNode.items) {
      if (!isMap(entry)) return { ok: false };
      const pairs: { k: string; value: string; line: number }[] = [];
      for (const p of entry.items) {
        const pk = isScalar(p.key) ? String(p.key.value) : null;
        const lit = literal(p.value);
        if (pk === null || !lit) return { ok: false };
        pairs.push({ k: pk, value: lit.value, line: lit.line });
      }
      let merged = false;
      for (const config of originalCombos) {
        const overwritesOriginal = pairs.some(
          (p) => baseKeySet.has(p.k) && config.has(p.k) && config.get(p.k)!.value !== p.value,
        );
        if (overwritesOriginal) continue;
        for (const p of pairs) config.set(p.k, { value: p.value, line: p.line });
        merged = true;
      }
      if (!merged) configs.push(new Map(pairs.map((p) => [p.k, { value: p.value, line: p.line }])));
    }
  }

  if (configs.length === 0) return { ok: false };

  const values: ResolvedMatrixValue[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    const hit = config.get(key);
    // A reachable configuration with no value for this key — an include-only
    // matrix that does not always set it. The consumer cannot be proven.
    if (!hit) return { ok: false };
    if (seen.has(hit.value)) continue;
    seen.add(hit.value);
    values.push({ value: hit.value, line: hit.line });
  }
  return { ok: true, values };
}

/**
 * Keep runtime declarations inside the job that owns a workspace member.
 *
 * GitHub Actions workflows put each job under `jobs:` as its own mapping, and a
 * monorepo commonly scopes a job to one package with
 * `defaults.run.working-directory:` (or path filters). A `node-version:` inside
 * the `web` job says nothing about the `api` workspace, so a member's
 * compatibility check must not read a sibling job's runtime pin.
 *
 * The parse is intentionally shallow — it does not build a YAML tree. It finds
 * the `jobs:` key at whatever indentation the file uses, takes the indentation
 * of the first mapping key beneath it as the job level, and slices each job
 * block by that indentation. Three outcomes per job, not two:
 *
 * - the job names *this* member (in `working-directory`, path filters — same
 *   line or an indented multiline list beneath `paths:`/`paths-ignore:` — or a
 *   `run` step): `allowed`, not `ambiguous`. Its declarations are resolved
 *   normally and may decide compatibility for this member.
 * - the job carries a workspace selector naming a *different* member: not
 *   `allowed` at all. Its declarations play no part in this member's analysis.
 * - the job carries no workspace selector whatsoever: repository-wide *by
 *   construction* when there is only one workspace member (or none), so it
 *   stays `allowed` and authoritative, matching the tool's original,
 *   single-package behaviour. In a repository with more than one member,
 *   though, an unattributed root job is not proof it governs this particular
 *   member — its declarations are `allowed` (they still count as CI evidence
 *   worth surfacing) but `ambiguous`, so the caller records them unresolved
 *   rather than letting them decide `compatible`/`incompatible` on this
 *   member's behalf. See #123.
 *
 * When the job structure cannot be recognized at all (GitLab's top-level job
 * keys, a malformed file), the same ownership rule applies as an unscoped
 * job: repository-wide and unambiguous for a single-package repository,
 * `allowed`-but-`ambiguous` for every member in a real monorepo.
 */
function ciJobLinesForMember(
  lines: readonly string[],
  member?: string,
  allMembers?: readonly string[],
): { allowed: boolean[]; ambiguous: boolean[] } {
  const allowed = Array.from({ length: lines.length }, () => true);
  const ambiguous = Array.from({ length: lines.length }, () => false);
  if (member === undefined) return { allowed, ambiguous };

  // A single-package repository (or a caller that has not gathered workspace
  // context) has no sibling member a root job's declaration could be
  // misattributed to — an unscoped job is repository-wide because there is
  // nothing else it could mean, exactly as before job-level ownership existed.
  const isMonorepo = (allMembers?.length ?? 0) > 1;
  // Structure Drift could not resolve into per-job blocks — GitLab CI defines
  // jobs as arbitrary top-level keys rather than nesting them under `jobs:`,
  // which this shallow parser does not attempt to distinguish from reserved
  // top-level keys (`stages`, `variables`, `include`, ...). Ownership is
  // exactly as unestablished here as it is for a recognized-but-unscoped
  // job, so the same rule applies: repository-wide when there is only one
  // member, ambiguous rather than silently authoritative when there is not.
  const markUnresolvedStructure = (): { allowed: boolean[]; ambiguous: boolean[] } => {
    if (isMonorepo) ambiguous.fill(true);
    return { allowed, ambiguous };
  };

  const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;

  // The one shallow `jobs:` slice both this ownership pass and static matrix
  // resolution read from, so the two cannot disagree about which job a line
  // belongs to.
  const jobs = githubActionsJobBlocks(lines);
  if (!jobs) return markUnresolvedStructure();

  // Trim leading/trailing separators without `/^\/+|\/+$/` — `member` is
  // uncontrolled and a long internal run of slashes makes that pattern
  // quadratic (CodeQL js/polynomial-redos).
  const slashed = member.replace(/\\/g, '/');
  let lo = 0;
  let hi = slashed.length;
  while (lo < hi && slashed[lo] === '/') lo++;
  while (hi > lo && slashed[hi - 1] === '/') hi--;
  const normalized = slashed.slice(lo, hi);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const memberEntryPattern = normalized ? new RegExp(escaped, 'i') : null;

  // `paths:`/`working-directory:`/`run:` are *inclusion* selectors: naming a
  // member there means the job targets it. `paths-ignore:` is the opposite —
  // naming a member there means the job explicitly skips it — and folding it
  // into the same "mentions the member => scoped to it" test (as the
  // original implementation did) had the polarity backwards: a job that
  // excludes `packages/docs/**` was being read as *scoped to* `docs`.
  const inclusionSelectorPattern = /(?:working-directory\s*:|paths(?!-ignore)\s*:)/i;
  const exclusionSelectorPattern = /paths-ignore\s*:/i;
  const sameLineInclusionPattern = normalized
    ? new RegExp(`(?:working-directory|paths(?!-ignore)|run)\\s*:[^\\n]*${escaped}(?:[/\\s"']|$)`, 'i')
    : null;
  const sameLineExclusionPattern = normalized
    ? new RegExp(`paths-ignore\\s*:[^\\n]*${escaped}(?:[/\\s"']|$)`, 'i')
    : null;
  // Both `paths:` and `paths-ignore:` conventionally introduce a multiline
  // YAML list (`paths:\n  - packages/api/**\n  - shared/**`), and the member
  // path is just as often on one of those indented item lines as on the
  // key's own line. The same-line patterns above alone would read that
  // entire, perfectly ordinary job as unscoped.
  const inclusionListKeyPattern = /^([ \t]*)(?:-\s*)?paths(?!-ignore)\s*:\s*(#.*)?$/i;
  const exclusionListKeyPattern = /^([ \t]*)(?:-\s*)?paths-ignore\s*:\s*(#.*)?$/i;

  const blockNamesMember = (text: string, listKeyPattern: RegExp): boolean => {
    if (!memberEntryPattern) return false;
    const blockLines = text.split('\n');
    for (let i = 0; i < blockLines.length; i++) {
      const key = listKeyPattern.exec(blockLines[i]!);
      if (!key) continue;
      const baseIndent = key[1]!.length;
      for (let j = i + 1; j < blockLines.length; j++) {
        const next = blockLines[j]!;
        if (!next.trim()) continue;
        const indent = indentOf(next);
        if (indent <= baseIndent) break;
        if (memberEntryPattern.test(next)) return true;
      }
    }
    return false;
  };

  const jobIncludesMember = (text: string): boolean =>
    (sameLineInclusionPattern?.test(text) ?? false) || blockNamesMember(text, inclusionListKeyPattern);
  const jobExcludesMember = (text: string): boolean =>
    (sameLineExclusionPattern?.test(text) ?? false) || blockNamesMember(text, exclusionListKeyPattern);

  allowed.fill(false);
  for (const job of jobs) {
    const text = lines.slice(job.start, job.end).join('\n');

    // An exclusion naming this member is affirmative evidence the job skips
    // it, regardless of any inclusion selector also present.
    if (exclusionSelectorPattern.test(text) && jobExcludesMember(text)) continue;

    if (inclusionSelectorPattern.test(text)) {
      if (jobIncludesMember(text)) {
        for (let i = job.start; i < job.end; i++) allowed[i] = true;
      }
      // Scoped to a sibling (or a selector that does not name any member
      // Drift recognizes): stays excluded entirely, not merely ambiguous —
      // Drift has affirmative evidence this job is not this member's.
      continue;
    }

    // No inclusion selector, and not excluded by name either: either the job
    // carries no path/directory scoping at all, or it only carries a
    // `paths-ignore:` that does not mention this member — "runs on
    // everything except these paths" is not the same as "targets this
    // member specifically". Either way ownership is not established:
    // repository-wide evidence when there is nothing else it could mean,
    // ambiguous ownership when there is a sibling it could instead belong to.
    for (let i = job.start; i < job.end; i++) {
      allowed[i] = true;
      if (isMonorepo) ambiguous[i] = true;
    }
  }
  return { allowed, ambiguous };
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

function dedupeUnresolved(
  declarations: readonly UnresolvedRuntimeDeclaration[],
): UnresolvedRuntimeDeclaration[] {
  const seen = new Set<string>();
  return declarations.filter((declaration) => {
    const key = `${declaration.file}:${declaration.line}:${declaration.rawText}`;
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

function scopedTo<T extends { path: string; content: string }>(
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
    //
    // A CI workflow is always kept in the scanned set here, whatever member is
    // being analyzed: `ciDeclarations`/`ciJobLinesForMember` (see #123) do the
    // real attribution at job granularity — which job a declaration lives in,
    // whether that job names this member via a (possibly multiline)
    // `working-directory`/`paths`/`paths-ignore` selector — and fail
    // conservatively (recording an unattributed declaration unresolved rather
    // than dropping it) when ownership cannot be established. A whole-file
    // gate ahead of that can only be coarser and would either drop a
    // genuinely member-owned declaration whose selector spans multiple lines,
    // or admit a sibling's declaration a same-line-only check happened not to
    // rule out — both wrong in ways the job-level pass already gets right.
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

function engineFromPackageJson(content: string): { raw: string; requirement: string | null } | null {
  try {
    const parsed = JSON.parse(content) as { engines?: Record<string, unknown> };
    if (!parsed.engines || !Object.prototype.hasOwnProperty.call(parsed.engines, 'node')) return null;
    const value = parsed.engines.node;
    if (typeof value === 'string') return { raw: value, requirement: dynamicOr(value) };
    return { raw: JSON.stringify(value), requirement: null };
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
    // An alias (`lts/hydrogen`), a channel name, anything semver cannot read
    // as a range. Reported as `unknown` rather than skipped: a declaration
    // dropped here is indistinguishable downstream from a repository that
    // never wrote one, and that collapse is what turns "Drift could not tell"
    // into "Drift found nothing wrong".
    if (!semver.validRange(decl.requirement, { loose: true })) {
      out.push({ ...decl, verdict: 'unknown' });
      continue;
    }

    let verdict: RuntimeCompatibility['verdict'];
    try {
      if (semver.subset(decl.requirement, requirement, { loose: true })) verdict = 'compatible';
      else if (!semver.intersects(decl.requirement, requirement, { loose: true })) verdict = 'incompatible';
      else verdict = 'partial';
    } catch {
      verdict = 'unknown';
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

/** `setup.py`'s literal `python_requires="..."` keyword argument, if it has one. */
function setupPyPythonRequires(content: string): { raw: string; requirement: string | null; line: number } | null {
  const call = extractSetupCall(content);
  if (!call) return null;
  const literal = /\bpython_requires\s*=\s*(['"])([^'"]+)\1/.exec(call)?.[2];
  if (literal) {
    return { raw: literal, requirement: dynamicOr(literal), line: lineOf(content, /python_requires\s*=/) };
  }
  const expression = /\bpython_requires\s*=\s*([^,)\n]+)/.exec(call)?.[1]?.trim();
  return expression
    ? { raw: expression, requirement: null, line: lineOf(content, /python_requires\s*=/) }
    : null;
}

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
  const required = parsePythonRuntimeRange(requirement);
  const out: RuntimeCompatibility[] = [];

  for (const decl of declarations) {
    const declared = parsePythonRuntimeRange(decl.requirement);

    let verdict: RuntimeCompatibility['verdict'];
    if (required.status === 'unknown' || declared.status === 'unknown') verdict = 'unknown';
    else if (isSubsetInterval(declared.value, required.value)) verdict = 'compatible';
    else if (!intersectsInterval(declared.value, required.value)) verdict = 'incompatible';
    else verdict = 'partial';

    out.push({ ...decl, verdict });
  }

  return out;
}
