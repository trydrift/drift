import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAvailable } from '../../util/exec.js';
import { fetchArchive } from '../../util/http.js';
import { readZip } from '../../util/archive.js';
import type { SurfaceChange } from '../type-surface.js';
import { ensureHelperArtifact } from './helper-artifact.js';
import {
  detectPackageMigrations,
  detectRuntimeFloorRaise,
  parseMemberSignature,
  type MemberSignature,
} from './java-migration.js';
import {
  unavailable,
  type SurfaceProvider,
  type SurfaceRequest,
  type SurfaceOutcome,
} from './types.js';

/**
 * Java binary-compatibility diffing via japicmp.
 *
 * japicmp compares the classfiles of two published jars, which makes it the
 * only source here that reads *what was actually shipped* rather than a
 * reconstruction of it. Jars come from Maven Central by URL — downloading a jar
 * is not running it, and Drift never invokes a build for a third-party artefact.
 */

const TOOL = 'japicmp';
const POM_TOOL = 'Maven POM contract';
const CENTRAL = 'https://repo1.maven.org/maven2';
const MAX_POM_BYTES = 5 * 1024 * 1024;

/**
 * The japicmp version Drift provisions. Pinned, not "latest": a recording is a
 * published artifact and must not diff differently because the tap moved.
 * `japicmp-<v>-jar-with-dependencies.jar` is the self-contained CLI fat JAR.
 */
const JAPICMP_VERSION = '0.23.1';
const JAPICMP_JAR_URL =
  `${CENTRAL}/com/github/siom79/japicmp/japicmp/${JAPICMP_VERSION}` +
  `/japicmp-${JAPICMP_VERSION}-jar-with-dependencies.jar`;
/** SHA-256 of the fat JAR above, verified before Drift ever runs `java -jar` on it. */
const JAPICMP_JAR_SHA256 = 'f2300a8531b68e25b678247874a1eae13a07d6842a4a1236845481fc90c5c6c7';

const JAVA_REMEDY =
  'Install a JDK (11 or newer) and re-run. Drift downloads and runs japicmp itself, but does not install Java.';

export const javaSurface: SurfaceProvider = {
  ecosystem: 'maven',
  tool: TOOL,
  weight: 1.0,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    const coordinate = parseCoordinate(request.name);
    if (!coordinate) {
      return unavailable(
        TOOL,
        'unsupported-ecosystem',
        `\`${request.name}\` is not a \`groupId:artifactId\` coordinate, so Drift could not locate it on Maven Central.`,
      );
    }

    // The exact POM declares what kind of artifact this coordinate is. Read it
    // before requiring Java or assuming a jar exists: parent POMs and BOMs are
    // contracts in their own right, not failed classfile libraries.
    // Central plus whatever this project's own POM says. Resolved once and
    // reused for the jars below, so a repository list is read at most once.
    const repositories = [CENTRAL, ...(await declaredRepositories(request))];

    const [beforePom, afterPom] = await Promise.all([
      downloadPom(coordinate, request.from, repositories),
      downloadPom(coordinate, request.to, repositories),
    ]);
    if (!beforePom.ok) return beforePom.failure;
    if (!afterPom.ok) return afterPom.failure;

    const beforeRole = classifyMavenPackaging(beforePom.contract.packaging);
    const afterRole = classifyMavenPackaging(afterPom.contract.packaging);
    if (beforeRole === 'pom' || afterRole === 'pom') {
      return {
        available: true,
        changes: diffPomContracts(beforePom.contract, afterPom.contract),
        tool: POM_TOOL,
        weight: 0.9,
        locator: `${request.name} ${request.from} → ${request.to} (POM contract; ${beforeRole} → ${afterRole})`,
        packageRole: afterRole,
      };
    }

    // A packaging Drift does not diff directly is not the end of the question.
    // Several publish a plain `.jar` beside the primary artifact, and that jar
    // is precisely what a *consumer* compiles against: a Jenkins plugin ships
    // an `hpi`, but a plugin that depends on it resolves the `.jar` onto its
    // compile classpath, and 160 classfiles of real API sit inside it. Probed
    // before declining rather than after, so the role decides how hard Drift
    // looks and never what it is allowed to find.
    let siblingJars: { before: JarAttempt & { ok: true }; after: JarAttempt & { ok: true } } | undefined;
    if (beforeRole !== 'library' || afterRole !== 'library') {
      await mkdir(request.workdir, { recursive: true });
      const [probedBefore, probedAfter] = await Promise.all([
        downloadJar(coordinate, request.from, request.workdir, repositories),
        downloadJar(coordinate, request.to, request.workdir, repositories),
      ]);
      if (!probedBefore.ok || !probedAfter.ok) {
        return {
          ...unavailable(
            POM_TOOL,
            'artifact-type-unsupported',
            `${request.name} is packaged as ${afterPom.contract.packaging}, not as a Java library jar, and publishes no companion jar Drift could compare instead.`,
          ),
          packageRole: afterRole,
        };
      }
      siblingJars = { before: probedBefore, after: probedAfter };
    }

    // Java is an external runtime prerequisite. Drift provisions japicmp on top
    // of it, never the JDK itself.
    if (!(await isAvailable(request.exec, 'java', ['-version']))) {
      return unavailable(
        TOOL,
        'tool-missing',
        `Java is not installed, so ${request.name}'s classfile API could not be compared directly.`,
        JAVA_REMEDY,
      );
    }

    // Download-and-verify the pinned japicmp fat JAR into Drift's own cache.
    const helper = await ensureHelperArtifact({
      id: 'japicmp',
      version: JAPICMP_VERSION,
      url: JAPICMP_JAR_URL,
      sha256: JAPICMP_JAR_SHA256,
    });
    if (!helper.ok) {
      // Every branch here is an evidence gap in the helper Drift manages, not a
      // statement about Java: `java -version` already succeeded above.
      const detail =
        helper.error.kind === 'checksum-failed'
          ? `Drift's pinned japicmp helper failed its SHA-256 check and was not run (${helper.error.detail}).`
          : helper.error.kind === 'cache-failed'
            ? `Drift verified its pinned japicmp helper but could not cache it for use (${helper.error.detail}).`
            : `Drift could not download its pinned japicmp helper (${helper.error.detail}).`;
      return unavailable(TOOL, 'toolchain-failed', detail);
    }
    const japicmpJar = helper.path;

    await mkdir(request.workdir, { recursive: true });
    // The "before" and "after" jars are independent downloads from Maven
    // Central -- there is no reason the second waits on the first to finish.
    // Both are fetched concurrently and only one japicmp comparison runs,
    // once both have landed. Failure precedence is preserved exactly as
    // before: "before" failing is reported ahead of "after" failing, even
    // though "after" may now finish (or fail) first.
    let before: JarAttempt;
    let after: JarAttempt;
    if (siblingJars) {
      // Already fetched while deciding whether a non-library packaging had a
      // comparable artifact at all; re-downloading them would prove nothing.
      before = siblingJars.before;
      after = siblingJars.after;
    } else {
      const beforePromise = downloadJar(coordinate, request.from, request.workdir, repositories);
      const afterPromise = downloadJar(coordinate, request.to, request.workdir, repositories);
      afterPromise.catch(() => undefined);
      before = await beforePromise;
      if (!before.ok) return before.failure;
      after = await afterPromise;
      if (!after.ok) return after.failure;
    }
    if (!before.ok) return before.failure;
    if (!after.ok) return after.failure;

    // A `jar`-packaged coordinate is not necessarily a library: a starter or
    // aggregator (`spring-boot-starter`, BOMs republished as an empty jar for
    // tooling compatibility) declares no `<packaging>pom</packaging>` but
    // ships zero classfiles of its own — its real surface lives in whatever
    // it pulls in. Diffing two empty jars always reports "no differences",
    // which is indistinguishable from a genuinely unchanged library unless
    // this is caught before japicmp ever runs. Caught here rather than by
    // reading `<packaging>` because the packaging tag lies for exactly these
    // artifacts; only the shipped bytes tell the truth.
    const [beforeClasses, afterClasses] = await Promise.all([
      hasClassfiles(before.path),
      hasClassfiles(after.path),
    ]);
    if (!beforeClasses || !afterClasses) {
      return {
        ...unavailable(
          TOOL,
          'artifact-type-unsupported',
          `${request.name} ${request.from} → ${request.to} ships no classfiles of its own (an aggregator, starter, or relocated artifact) — its published API surface is not this jar's contents, so Drift did not claim a classfile comparison for it.`,
        ),
        packageRole: 'jar',
      };
    }

    const result = await request.exec(
      'java',
      [
        '-jar',
        japicmpJar,
        '-o',
        before.path,
        '-n',
        after.path,
        '--only-modified',
        '--ignore-missing-classes',
      ],
      { cwd: request.workdir, timeoutMs: request.timeoutMs },
    );

    // japicmp exits non-zero when it finds incompatibilities under some
    // configurations, so output is what decides, not the exit code.
    if (result.stdout.trim().length === 0) {
      return unavailable(
        TOOL,
        result.code === 0 ? 'no-public-surface' : 'toolchain-failed',
        result.code === 0
          ? `japicmp found no differences it could read between ${request.name} ${request.from} and ${request.to}.`
          : `japicmp execution failed on ${request.name}: ${firstLine(result.stderr)}`,
      );
    }

    // Non-empty output that carries none of japicmp's structural markers is a
    // format this parser cannot read — distinct from japicmp running fine and
    // finding only compatible changes.
    if (!looksLikeJapicmpReport(result.stdout)) {
      return unavailable(
        TOOL,
        'parse-failed',
        `japicmp output for ${request.name} was not in a recognised report format.`,
      );
    }

    const sourceIncompatibleCount = countSourceIncompatibleChanges(result.stdout);
    return {
      available: true,
      changes: parseJapicmp(result.stdout),
      ...(sourceIncompatibleCount > 0 ? { sourceIncompatibleCount } : {}),
      tool: TOOL,
      weight: 1.0,
      locator: `${request.name} ${request.from} → ${request.to} (classfiles)`,
      packageRole: 'jar',
    };
  },
};

interface Coordinate {
  groupId: string;
  artifactId: string;
}

/**
 * How many declared repositories Drift will try before giving up.
 *
 * A POM may list a dozen mirrors; each miss is a round trip, and the artifact
 * is in the first one or two in every real case. A bound rather than a
 * judgement about which are worth trying.
 */
const MAX_DECLARED_REPOSITORIES = 4;

/**
 * Where this project says its dependencies are published.
 *
 * Maven Central is the default and the overwhelming majority, but it is not
 * the only place Java is published, and an artifact that is not on it is not
 * an artifact that does not exist. Jenkins is the concrete case: every
 * `org.jenkins-ci.*` plugin lives at `repo.jenkins-ci.org`, and looking only at
 * Central reported 41 of BUMP's Java cases — a tenth of the corpus — as
 * `version-unavailable`, which reads as "that version was unpublished or
 * yanked" when the truth is that Drift looked in one place.
 *
 * Read from the POM that declared the dependency, which is where Maven itself
 * reads them, so nothing here knows what Jenkins is. Only `https` is accepted:
 * these URLs come from the repository under analysis, and while fetching an
 * artifact is not running one, a plaintext mirror is not a source Drift should
 * be talked into by a file it is analysing.
 */
async function declaredRepositories(request: SurfaceRequest): Promise<string[]> {
  const read = request.readRepoFile;
  if (!read) return [];

  // The declaring member's POM first: in a monorepo the repositories are on
  // the module that has the dependency, not on the aggregator above it.
  const candidates = [...new Set([request.manifestPath, 'pom.xml'].filter((path): path is string => Boolean(path)))];
  const urls: string[] = [];

  for (const path of candidates) {
    const content = await read(path).catch(() => null);
    if (!content) continue;
    for (const section of content.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<repositories>([\s\S]*?)<\/repositories>/g)) {
      for (const entry of section[1]!.matchAll(/<repository(?:\s[^>]*)?>([\s\S]*?)<\/repository>/g)) {
        const url = tag(entry[1]!, 'url');
        if (url && /^https:\/\//i.test(url)) urls.push(url.replace(/\/+$/, ''));
      }
    }
    if (urls.length > 0) break;
  }

  return [...new Set(urls)].slice(0, MAX_DECLARED_REPOSITORIES);
}

export function parseCoordinate(name: string): Coordinate | null {
  const [groupId, artifactId] = name.split(':');
  if (!groupId || !artifactId) return null;
  return { groupId, artifactId };
}

/** A Maven repository's layout is entirely derivable, so no search API is needed. */
export function jarUrl(coordinate: Coordinate, version: string, base: string = CENTRAL): string {
  const path = coordinate.groupId.replace(/\./g, '/');
  return `${base}/${path}/${coordinate.artifactId}/${version}/${coordinate.artifactId}-${version}.jar`;
}

export function pomUrl(coordinate: Coordinate, version: string, base: string = CENTRAL): string {
  const path = coordinate.groupId.replace(/\./g, '/');
  return `${base}/${path}/${coordinate.artifactId}/${version}/${coordinate.artifactId}-${version}.pom`;
}

export type MavenArtifactRole = 'library' | 'pom' | 'maven-plugin' | 'unsupported';

export function classifyMavenPackaging(packaging: string | undefined): MavenArtifactRole {
  const normalized = (packaging ?? 'jar').trim().toLowerCase();
  if (normalized === 'jar' || normalized === 'bundle') return 'library';
  if (normalized === 'pom') return 'pom';
  if (normalized === 'maven-plugin') return 'maven-plugin';
  return 'unsupported';
}

export interface PomContract {
  packaging: string;
  parent: string | null;
  properties: Map<string, string>;
  dependencyManagement: Map<string, string>;
  pluginManagement: Map<string, string>;
}

type PomAttempt = { ok: true; contract: PomContract } | { ok: false; failure: SurfaceOutcome };

async function downloadPom(
  coordinate: Coordinate,
  version: string,
  bases: readonly string[] = [CENTRAL],
): Promise<PomAttempt> {
  let url = pomUrl(coordinate, version, bases[0] ?? CENTRAL);
  let downloaded = await fetchArchive(url, { timeoutMs: 60_000, maxBytes: MAX_POM_BYTES });
  // Central answers for almost everything, so it is tried first and the rest
  // are only paid for when it does not have the artifact.
  for (const base of bases.slice(1)) {
    if (downloaded.ok) break;
    url = pomUrl(coordinate, version, base);
    downloaded = await fetchArchive(url, { timeoutMs: 60_000, maxBytes: MAX_POM_BYTES });
  }
  if (!downloaded.ok) {
    return {
      ok: false,
      failure: unavailable(
        POM_TOOL,
        downloaded.status === 404 ? 'version-unavailable' : 'artifact-unavailable',
        downloaded.status === 404
          ? `No POM for ${coordinate.groupId}:${coordinate.artifactId}:${version} in ${describeRepositories(bases)}.`
          : `The exact Maven POM at ${url} could not be downloaded (HTTP ${downloaded.status || 'unavailable'}).`,
      ),
    };
  }
  try {
    return { ok: true, contract: parsePomContract(downloaded.bytes.toString('utf8')) };
  } catch (error) {
    return {
      ok: false,
      failure: unavailable(POM_TOOL, 'parse-failed', `The exact Maven POM at ${url} could not be parsed: ${(error as Error).message}`),
    };
  }
}

export function parsePomContract(xml: string): PomContract {
  if (!/<project(?:\s|>)/i.test(xml)) throw new Error('missing project element');
  const clean = xml.replace(/<!--[\s\S]*?-->/g, '');
  const packaging = tag(clean, 'packaging') ?? 'jar';
  const parentBlock = block(clean, 'parent');
  const parent = parentBlock
    ? [tag(parentBlock, 'groupId'), tag(parentBlock, 'artifactId'), tag(parentBlock, 'version')]
        .map((value) => value ?? '')
        .join(':')
    : null;
  return {
    packaging,
    parent,
    properties: childValues(block(clean, 'properties')),
    dependencyManagement: dependencyContracts(block(clean, 'dependencyManagement')),
    pluginManagement: pluginContracts(block(clean, 'pluginManagement')),
  };
}

export function diffPomContracts(before: PomContract, after: PomContract): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  if (before.packaging !== after.packaging) {
    changes.push({
      kind: 'signature-changed',
      symbol: 'pom:packaging',
      detail: `The Maven artifact role changed from ${before.packaging} to ${after.packaging}.`,
      before: before.packaging,
      after: after.packaging,
    });
  }
  if (before.parent !== after.parent) {
    changes.push({
      kind: 'signature-changed',
      symbol: 'pom:parent',
      detail: 'The inherited Maven parent coordinates changed.',
      before: before.parent ?? '(none)',
      after: after.parent ?? '(none)',
    });
  }
  comparePomMap('property', before.properties, after.properties, changes);
  comparePomMap('dependencyManagement', before.dependencyManagement, after.dependencyManagement, changes);
  comparePomMap('pluginManagement', before.pluginManagement, after.pluginManagement, changes);
  return changes;
}

function comparePomMap(
  section: string,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  changes: SurfaceChange[],
): void {
  for (const [name, oldValue] of before) {
    const symbol = `pom:${section}:${name}`;
    if (!after.has(name)) {
      changes.push({
        kind: 'export-removed',
        symbol,
        detail: `The ${section} entry ${name} was removed from the published POM contract.`,
        before: oldValue,
      });
    } else if (after.get(name) !== oldValue) {
      changes.push({
        kind: 'signature-changed',
        symbol,
        detail: `The ${section} entry ${name} changed in the published POM contract.`,
        before: oldValue,
        after: after.get(name),
      });
    }
  }
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml);
  return match?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;
}

function block(xml: string | null, name: string): string | null {
  if (!xml) return null;
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml)?.[1] ?? null;
}

function childValues(xml: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml) return out;
  const pattern = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  for (const match of xml.matchAll(pattern)) {
    const value = match[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (value) out.set(match[1]!, value);
  }
  return out;
}

function dependencyContracts(xml: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml) return out;
  for (const match of xml.matchAll(/<dependency(?:\s[^>]*)?>([\s\S]*?)<\/dependency>/g)) {
    const body = match[1]!;
    const key = `${tag(body, 'groupId') ?? ''}:${tag(body, 'artifactId') ?? ''}`;
    if (key === ':') continue;
    const exclusions = [...body.matchAll(/<exclusion(?:\s[^>]*)?>([\s\S]*?)<\/exclusion>/g)]
      .map((entry) => `${tag(entry[1]!, 'groupId') ?? ''}:${tag(entry[1]!, 'artifactId') ?? ''}`)
      .sort();
    out.set(key, [tag(body, 'version'), tag(body, 'type'), tag(body, 'scope'), tag(body, 'classifier'), ...exclusions]
      .filter(Boolean).join('|'));
  }
  return out;
}

function pluginContracts(xml: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml) return out;
  for (const match of xml.matchAll(/<plugin(?:\s[^>]*)?>([\s\S]*?)<\/plugin>/g)) {
    const body = match[1]!;
    const key = `${tag(body, 'groupId') ?? 'org.apache.maven.plugins'}:${tag(body, 'artifactId') ?? ''}`;
    if (key.endsWith(':')) continue;
    out.set(key, [tag(body, 'version'), block(body, 'configuration')?.replace(/\s+/g, ' ').trim()]
      .filter(Boolean).join('|'));
  }
  return out;
}

/** Does this jar carry at least one `.class` entry — real compiled surface, not just resources/metadata? */
async function hasClassfiles(jarPath: string): Promise<boolean> {
  const bytes = await readFile(jarPath);
  return readZip(bytes).some((entry) => entry.path.endsWith('.class'));
}

type JarAttempt = { ok: true; path: string } | { ok: false; failure: SurfaceOutcome };

async function downloadJar(
  coordinate: Coordinate,
  version: string,
  workdir: string,
  bases: readonly string[] = [CENTRAL],
): Promise<JarAttempt> {
  let url = jarUrl(coordinate, version, bases[0] ?? CENTRAL);
  const path = join(workdir, `${coordinate.artifactId}-${version}.jar`);

  try {
    let downloaded = await fetchArchive(url, { timeoutMs: 60_000 });
    for (const base of bases.slice(1)) {
      if (downloaded.ok) break;
      url = jarUrl(coordinate, version, base);
      downloaded = await fetchArchive(url, { timeoutMs: 60_000 });
    }
    // A request that never completed used to throw out of `fetch`; re-thrown so
    // it still lands in this provider's own catch, with the same message.
    if (!downloaded.ok && downloaded.status === 0) throw new Error(downloaded.error ?? 'the request failed');
    if (!downloaded.ok) {
      return {
        ok: false,
        failure: unavailable(
          TOOL,
          downloaded.status === 404 ? 'version-unavailable' : 'toolchain-failed',
          downloaded.status === 404
            ? `No jar for ${coordinate.groupId}:${coordinate.artifactId}:${version} in ${describeRepositories(bases)}. It may be an internal artefact, or published only as a POM or a BOM.`
            : `${url} returned ${downloaded.status}.`,
        ),
      };
    }
    await writeFile(path, downloaded.bytes);
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(TOOL, 'toolchain-failed', `Could not download ${url}: ${(err as Error).message}`),
    };
  }
}

/**
 * Parse japicmp's default report.
 *
 * The format is a four-character marker, a change word, a kind, and a name,
 * with members indented under their class:
 *
 * ```
 * ---! REMOVED CLASS: PUBLIC com.example.Legacy
 * ***! MODIFIED CLASS: PUBLIC com.example.Client
 *      ---! REMOVED METHOD: PUBLIC void close()
 * ```
 *
 * Only *binary-incompatible* removals and modifications are reported onwards.
 * The marker's first three characters repeat the verb's own symbol (`-` / `*`
 * / `+`) and carry no extra information; the fourth is what actually says
 * whether the change is compatible, and it decides everything here rather
 * than being treated as decoration. Confirmed against real japicmp output —
 * compiling two versions of a scratch jar and, separately, running this
 * exact binary against `benchmarks/roseau`'s own fixtures (see
 * `test/surface.test.ts`) — the fourth character is:
 *
 *   `!`      binary-incompatible — an existing *compiled* caller can fail to
 *            link or throw at runtime (a class made `abstract` or `final`, a
 *            visibility reduction, a member removed with nothing left for
 *            inheritance to resolve it to). Reported.
 *   `*`      source-incompatible only — existing compiled callers keep
 *            working; only code *recompiled* against the new version might
 *            not (a newly checked exception, a new abstract method, a new
 *            required annotation member). Not reported: this differ reads
 *            classfiles, and what it can say reliably is binary compatibility
 *            — the same reason `japicmp` is scored against
 *            `isBinaryBreaking`, never `isSourceBreaking`, in this
 *            benchmark. Drift's behavioural verification is what catches an
 *            actual failed recompile, from the one source that can: trying it.
 *   absent   fully compatible (an interface gaining a default method, a
 *            method moving to a superclass a caller still reaches it
 *            through, an access *widening*). Never reported, matching the
 *            rule an addition already gets.
 *
 * Reporting `*` here was tried and measured, not assumed away: on
 * `benchmarks/roseau`'s 267 cases it moved recall from 92/100 to 97/100 but
 * precision from 91.1% to 70.3% (also gating the member-level branch on the
 * same flag — an intermediate version of this fix left it unconditional and
 * regressed the same way for the same reason). The corpus's negative
 * controls are disproportionately source-incompatible-but-binary-compatible
 * changes by construction — exactly what the fourth marker character exists
 * to distinguish. Restricting to `!` lands at 96/100 recall and 90.6%
 * precision (96 tp / 10 fp), an F1 of 0.93 against the pre-fix baseline's
 * 0.92 recall / 0.91 precision / 0.92 F1 — every remaining false positive and
 * false negative checked individually against real japicmp output rather
 * than tuned against the corpus's labels.
 */
export function parseJapicmp(output: string): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  let currentClass: string | null = null;
  // Collected for `detectPackageMigrations`, which needs the added members too
  // — the only place in this parser where a `NEW` line carries information.
  const removedMembers: MemberSignature[] = [];
  const addedMembers: MemberSignature[] = [];

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    // `([-+*])\1\1` requires the three marker characters to be identical,
    // which they always are for a given verb; the compatibility flag is then
    // whatever immediately follows, with no `\s*` between them to swallow it.
    //
    // `(?:\s*\(<-\s*\w+\))?\s*` before the colon is japicmp's type-transition
    // delta: a class turned into an interface (or the reverse) is reported as
    // `***! MODIFIED INTERFACE (<- CLASS) : …`, with the old kind and an extra
    // space wedged between the kind word and the colon. Without this the line
    // did not match at all, and a `class` becoming an `interface` — which
    // breaks every `new`, `extends` and `implements` against it — was read as
    // no change. (Roseau's `otherClazzToIfaze` / `otherIfazeToClass`.)
    const match =
      /^([-+*])\1\1([!*])?\s+(\w+)\s+(CLASS|METHOD|FIELD|CONSTRUCTOR|INTERFACE|ANNOTATION|SUPERCLASS)(?:\s*\(<-\s*\w+\))?\s*:\s*(.+)$/.exec(
        line,
      );
    if (!match) continue;

    const [, , flag, verb, kind, rest] = match;
    const isClass = kind === 'CLASS' || kind === 'INTERFACE' || kind === 'ANNOTATION';
    const name = symbolName(rest!);
    if (!name) continue;

    if (isClass) currentClass = name;

    // Signature collection happens before the `!`-only gate below, because a
    // migration is witnessed by a *pair* and the added half is never flagged.
    // `detectPackageMigrations` re-imposes the gate itself, requiring at least
    // one binary-incompatible removal behind every migration it reports.
    if (!isClass && currentClass && (kind === 'METHOD' || kind === 'CONSTRUCTOR')) {
      const signature = parseMemberSignature(rest!, currentClass, flag === '!');
      if (signature) {
        if (verb === 'REMOVED') removedMembers.push(signature);
        else if (verb === 'NEW') addedMembers.push(signature);
      }
    }

    if (verb === 'NEW' || flag !== '!') continue;

    const symbol = isClass || !currentClass ? name : `${currentClass}.${name}`;

    if (verb === 'REMOVED') {
      changes.push({
        kind: isClass ? 'export-removed' : 'member-removed',
        symbol,
        detail: isClass
          ? `\`${symbol}\` is no longer published (was a ${kind.toLowerCase()}).`
          : `\`${symbol}\` was removed.`,
      });
    } else if (verb === 'MODIFIED') {
      changes.push({
        kind: 'signature-changed',
        symbol,
        detail: isClass
          ? `The declaration of \`${symbol}\` changed in a way an existing compiled caller may not be binary-compatible with.`
          : `The signature of \`${symbol}\` changed.`,
        after: rest!.trim(),
      });
    }
  }

  // A raised bytecode floor affects every consumer or none, depending on one
  // fact about their toolchain — so it is one finding, never one per class.
  const floor = detectRuntimeFloorRaise(output);
  if (floor) {
    changes.push({
      kind: 'runtime-requirement-raised',
      symbol: 'Java',
      detail:
        `This version is compiled for Java ${floor.to}; the previous one was Java ${floor.from}. ` +
        `A project building or running on Java ${floor.from} cannot use it — javac rejects it at build time ` +
        `and the JVM raises \`UnsupportedClassVersionError\` at runtime.`,
      before: String(floor.from),
      after: String(floor.to),
    });
  }

  for (const migration of detectPackageMigrations(removedMembers, addedMembers)) {
    for (const type of migration.types) {
      changes.push({
        kind: 'export-removed',
        // The *old* fully-qualified name, because that is what a consumer
        // wrote and what has to be found in its source. `javaImportRootsFromSymbols`
        // turns it into both the `import javax.servlet.http.HttpServletRequest;`
        // and the `import javax.servlet.http.*;` form.
        symbol: type.from,
        detail:
          `\`${type.from}\` is no longer part of this library's API: ` +
          `\`${migration.fromPackage}\` moved to \`${migration.toPackage}\`. ` +
          `Code that imports \`${type.from}\` no longer compiles against this version — ` +
          `import \`${type.to}\` instead.`,
        before: type.from,
        after: type.to,
      });
    }
  }

  return changes;
}

/**
 * Changes japicmp flagged `*` — source-incompatible, binary-compatible.
 *
 * These are deliberately not reported as breaking changes: this differ reads
 * classfiles, and emitting them collapsed precision on `benchmarks/roseau`
 * from 91.1% to 70.3%, because that corpus's negatives are disproportionately
 * exactly this class of change. See the note on {@link parseJapicmp}.
 *
 * But "not confident enough to report" is not "did not happen", and the two
 * were being conflated into a *safety* claim. `commons-io 2.7 -> 2.11.0` has
 * zero binary-incompatible changes and eighteen source-incompatible ones;
 * Drift found nothing, and said "no incompatible change in the checked
 * surfaces" — a sentence about a surface it never checked. Counting them lets
 * the verdict say so instead.
 */
export function countSourceIncompatibleChanges(output: string): number {
  let count = 0;
  for (const raw of output.split('\n')) {
    if (/^([-+*])\1\1\*\s+\w+\s+(CLASS|METHOD|FIELD|CONSTRUCTOR|INTERFACE|ANNOTATION|SUPERCLASS)/.test(raw.trim())) {
      count += 1;
    }
  }
  return count;
}

/**
 * `PUBLIC void close()` -> `close`, `PUBLIC com.example.Client` -> the class.
 *
 * japicmp prefixes modifiers and, for changed modifiers, inline deltas such as
 * `PUBLIC(-)` or `PACKAGE_PROTECTED (<- PUBLIC)`. Those deltas are metadata,
 * not identifiers. Strip them before taking the last token before the member
 * parameter list.
 */
function symbolName(rest: string): string | null {
  const cleaned = rest
    .replace(/\s*\(<-\s*[^)]+\)/g, '')
    .replace(/\([+-]\)/g, '')
    .replace(/\s+\(not serializable\)\s*$/, '')
    .trim();
  const identifier = (cleaned.split('(')[0]!.trim().split(/\s+/).pop() ?? '').trim();
  return /^[\w.$]+$/.test(identifier) ? identifier : null;
}

/**
 * Does this text look like japicmp's own report at all?
 *
 * Its default report opens with a `Comparing … compatibility of …` banner and
 * lists changes as marker-prefixed rows (`***`, `+++`, `---`) or bare verb
 * lines (`MODIFIED CLASS: …`). Output with none of those is a wrapper error,
 * a stack trace, or a format change — none of which this parser should mine
 * for findings.
 */
export function looksLikeJapicmpReport(output: string): boolean {
  return (
    /Comparing (?:binary|source) compatibility/i.test(output) ||
    /^[*+-]{3}/m.test(output) ||
    /^(?:UNCHANGED|MODIFIED|REMOVED|NEW)\s+(?:CLASS|METHOD|FIELD|CONSTRUCTOR|INTERFACE|ANNOTATION|SUPERCLASS)/m.test(
      output,
    )
  );
}

/** "Maven Central" alone, or Central and the repositories the project declared. */
function describeRepositories(bases: readonly string[]): string {
  const extra = bases.filter((base) => base !== CENTRAL);
  if (extra.length === 0) return 'Maven Central';
  return `Maven Central or ${extra.join(', ')} (declared by this project)`;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}
