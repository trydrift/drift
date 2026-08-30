import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAvailable } from '../../util/exec.js';
import { fetchArchive, fetchText } from '../../util/http.js';
import type { SurfaceChange } from '../type-surface.js';
import { ensureHelperArtifact } from './helper-artifact.js';
import { diffPomContracts, parsePomContract, type PomContract } from './maven-pom.js';
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
const CENTRAL = 'https://repo1.maven.org/maven2';

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

    // What kind of artifact this coordinate publishes, before deciding what
    // public surface it ought to have. A parent POM or a BOM has no JAR by
    // design, and reporting the missing JAR would say Drift looked for the
    // wrong thing rather than that the package cannot be inspected.
    // Only the target's POM is read up front — one small request that decides
    // which comparison applies. The previous version's POM is fetched only in
    // the branch that needs it, so an ordinary JAR upgrade pays nothing extra
    // beyond this one lookup.
    const afterPom = await fetchPomContract(coordinate, request.to);
    if (afterPom?.role === 'pom') {
      const beforePom = await fetchPomContract(coordinate, request.from);
      if (!beforePom || beforePom.role !== 'pom') {
        return unavailable(
          TOOL,
          'artifact-role-unsupported',
          `${request.name} ${request.to} is packaged as a POM while ${request.from} was not, so there is no comparable artifact between them.`,
        );
      }
      return {
        available: true,
        changes: diffPomContracts(beforePom, afterPom),
        tool: POM_TOOL,
        // A POM contract is a real, published, machine-readable artifact, but
        // it says nothing about class-level compatibility, so it does not carry
        // a classfile diff's weight.
        weight: 0.85,
        locator: `${request.name} ${request.from} → ${request.to} (POM dependency and plugin management)`,
      };
    }
    if (afterPom && afterPom.role === 'other') {
      return unavailable(
        TOOL,
        'artifact-role-unsupported',
        `${request.name} is published with \`<packaging>${afterPom.packaging}</packaging>\`, which Drift has no API comparison for. This is the artifact's role, not a missing JAR.`,
      );
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
    const beforePromise = downloadJar(coordinate, request.from, request.workdir);
    const afterPromise = downloadJar(coordinate, request.to, request.workdir);
    afterPromise.catch(() => undefined);
    const before = await beforePromise;
    if (!before.ok) return before.failure;
    const after = await afterPromise;
    if (!after.ok) return after.failure;

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

    return {
      available: true,
      changes: parseJapicmp(result.stdout),
      tool: TOOL,
      weight: 1.0,
      locator: `${request.name} ${request.from} → ${request.to} (classfiles)`,
    };
  },
};

interface Coordinate {
  groupId: string;
  artifactId: string;
}

export function parseCoordinate(name: string): Coordinate | null {
  const [groupId, artifactId] = name.split(':');
  if (!groupId || !artifactId) return null;
  return { groupId, artifactId };
}

const POM_TOOL = 'maven pom contract';

/**
 * The POM for one exact version, or null when Maven Central would not serve it.
 *
 * A POM that cannot be fetched leaves the role unknown, which falls through to
 * the ordinary JAR path — the behaviour before roles existed.
 */
async function fetchPomContract(coordinate: Coordinate, version: string): Promise<PomContract | null> {
  const path = coordinate.groupId.replace(/\./g, '/');
  const url = `${CENTRAL}/${path}/${coordinate.artifactId}/${version}/${coordinate.artifactId}-${version}.pom`;
  const xml = await fetchText(url, { retries: 0 });
  return xml && xml.trim() ? parsePomContract(xml) : null;
}

/** Maven Central's layout is entirely derivable, so no search API is needed. */
export function jarUrl(coordinate: Coordinate, version: string): string {
  const path = coordinate.groupId.replace(/\./g, '/');
  return `${CENTRAL}/${path}/${coordinate.artifactId}/${version}/${coordinate.artifactId}-${version}.jar`;
}

type JarAttempt = { ok: true; path: string } | { ok: false; failure: SurfaceOutcome };

async function downloadJar(
  coordinate: Coordinate,
  version: string,
  workdir: string,
): Promise<JarAttempt> {
  const url = jarUrl(coordinate, version);
  const path = join(workdir, `${coordinate.artifactId}-${version}.jar`);

  try {
    const downloaded = await fetchArchive(url, { timeoutMs: 60_000 });
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
            ? `Maven Central has no jar for ${coordinate.groupId}:${coordinate.artifactId}:${version}. It may be an internal artefact, or published only as a POM or a BOM.`
            : `Maven Central returned ${downloaded.status} for ${url}.`,
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

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    // `([-+*])\1\1` requires the three marker characters to be identical,
    // which they always are for a given verb; the compatibility flag is then
    // whatever immediately follows, with no `\s*` between them to swallow it.
    const match =
      /^([-+*])\1\1([!*])?\s+(\w+)\s+(CLASS|METHOD|FIELD|CONSTRUCTOR|INTERFACE|ANNOTATION|SUPERCLASS):\s*(.+)$/.exec(
        line,
      );
    if (!match) continue;

    const [, , flag, verb, kind, rest] = match;
    const isClass = kind === 'CLASS' || kind === 'INTERFACE' || kind === 'ANNOTATION';
    const name = symbolName(rest!);
    if (!name) continue;

    if (isClass) currentClass = name;

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

  return changes;
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

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}
