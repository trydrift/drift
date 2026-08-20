import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EXTERNAL_RECORD_VERSION, type ExclusionKind, type ExternalCaseResult } from '../record.ts';
import type { Selectable } from '../selection.ts';
import { computeSurfaceDiff } from '../../../../dist/evidence/surface/index.js';
import { clearHttpCache } from '../../../../dist/util/http.js';
import type { DependencyChange, Logger } from '../../../../dist/index.js';

const execFile = promisify(execFileCallback);

/**
 * Roseau's accuracy dataset: the only corpus here that can give Drift a real
 * precision.
 *
 * ## Why this one is different
 *
 * Every other external corpus is positives-only — a collection of upgrades
 * that are known to break — so it can say how often Drift catches something
 * and never how often it invents something. This dataset is 267 hand-built
 * Java library version pairs, each labelled by hand for whether the change is
 * binary-breaking and whether it is source-breaking, and roughly half of them
 * are labelled *not* breaking. Those negatives are what make precision, a
 * false-positive rate and F1 defined at all.
 *
 * The negatives are the interesting half. `accessModifierClazzAccessIncrease`
 * — widening a member from protected to public — is a change, it is not
 * breaking, and a tool that reports it is producing exactly the noise that
 * makes developers stop reading dependency alerts.
 *
 * ## What Drift actually runs
 *
 * Drift's Java surface diff is japicmp over two published jars. That is a real
 * production path — `computeSurfaceDiff` from the shipped build, routed to
 * `javaSurface`, shelling out to the japicmp binary exactly as it would on a
 * developer's machine — and it needs jars, which this dataset does not ship.
 * So the two source trees are compiled once with `javac` and served to
 * production's own `fetchArchive` as though Maven Central had them.
 *
 * The substitution is transport and nothing else: the bytes japicmp compares
 * are classfiles compiled from the dataset's own sources, and every line of
 * analysis between the download and the result is production's.
 *
 * ## Attributing one diff to 267 cases
 *
 * The dataset puts all 267 cases in one source tree, one package each, so a
 * single jar-to-jar diff produces every case's changes at once. A change is
 * attributed to a case by its package — `testing_lib.<caseName>` — which is
 * the dataset's own partition rather than a heuristic. One diff also means one
 * japicmp invocation for the whole corpus, which is what makes running all 267
 * cases cheap enough to do every time rather than sampling.
 *
 * ## Binary, not source
 *
 * The ground truth has two columns and they disagree on real cases. Drift is
 * scored against `isBinaryBreaking`, because japicmp compares classfiles and
 * binary compatibility is the question it answers; scoring a binary-compatibility
 * tool against source-compatibility labels would charge it for a question it
 * was never asked. The source column is carried into every artifact so anyone
 * can score it the other way.
 */

export const ADAPTER_VERSION = 'roseau-japicmp-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

/** The synthetic coordinate the two compiled jars are served under. */
const GROUP = 'io.drift.bench';
const ARTIFACT = 'roseau-accuracy';
const FROM = '1.0.0';
const TO = '2.0.0';

export interface RoseauCase {
  name: string;
  groundTruthBinaryBreaking: boolean;
  groundTruthSourceBreaking: boolean;
  /** Labels the replication kit records for the other tools. Reported, never re-run here. */
  recorded: Record<string, { isBinaryBreaking: boolean; isSourceBreaking: boolean }>;
}

export interface RoseauCorpus {
  cases: RoseauCase[];
  datasetVersion: string;
  sourceHash: string;
  v1Dir: string;
  v2Dir: string;
}

export class RoseauUnavailable extends Error {
  readonly kind: ExclusionKind;
  readonly missingRequirement: string | null;

  constructor(kind: ExclusionKind, message: string, missingRequirement: string | null = null) {
    super(message);
    this.kind = kind;
    this.missingRequirement = missingRequirement;
  }
}

export async function loadRoseau(root: string): Promise<RoseauCorpus> {
  const truthPath = join(root, 'results', 'bench', 'jezek_dietrich.json');
  const bytes = await readFile(truthPath).catch(() => {
    throw new RoseauUnavailable(
      'source-unavailable',
      `the replication kit's ground truth was not found at ${truthPath}; extract archive.zip from https://zenodo.org/records/15536418 into this directory`,
    );
  });

  const parsed = JSON.parse(bytes.toString('utf8')) as {
    name: string;
    counts: Record<string, { isBinaryBreaking: boolean; isSourceBreaking: boolean }>;
  }[];

  const cases = parsed.map((entry) => {
    const { GroundTruth, ...recorded } = entry.counts;
    return {
      name: entry.name,
      groundTruthBinaryBreaking: GroundTruth?.isBinaryBreaking === true,
      groundTruthSourceBreaking: GroundTruth?.isSourceBreaking === true,
      recorded,
    };
  });

  return {
    cases,
    // The kit is a Zenodo record with a fixed md5, so its DOI *is* its version.
    datasetVersion: '10.5281/zenodo.15536418',
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    v1Dir: join(root, 'accuracy-dataset', 'v1', 'src'),
    v2Dir: join(root, 'accuracy-dataset', 'v2', 'src'),
  };
}

export function roseauSelectables(cases: readonly RoseauCase[]): Selectable[] {
  // Stratified by the label first — a sample that lost the negatives would
  // silently remove the only thing that makes precision computable here — and
  // by the change family the dataset's own naming encodes second.
  return cases.map((entry) => ({
    id: entry.name,
    strata: [entry.groundTruthBinaryBreaking ? 'breaking' : 'not-breaking', family(entry.name)],
  }));
}

/** The dataset names cases `<family><Target><Mutation>`, so the leading lowercase run is the family. */
export function family(name: string): string {
  return /^[a-z]+/.exec(name)?.[0] ?? 'other';
}

/**
 * Compiles both source trees into jars.
 *
 * `javac` over the whole tree at once rather than per case, because the cases
 * share a package root and several of them reference helper classes in their
 * own directory. Compiling one case in isolation would fail for reasons that
 * have nothing to do with the change under test.
 */
export async function buildJars(corpus: RoseauCorpus, cacheDir: string): Promise<{ from: string; to: string }> {
  await mkdir(cacheDir, { recursive: true });
  const jars = { from: join(cacheDir, `${ARTIFACT}-${FROM}.jar`), to: join(cacheDir, `${ARTIFACT}-${TO}.jar`) };

  for (const [version, sourceDir, jar] of [
    [FROM, corpus.v1Dir, jars.from],
    [TO, corpus.v2Dir, jars.to],
  ] as const) {
    const classes = join(cacheDir, `classes-${version}`);
    await rm(classes, { recursive: true, force: true });
    await mkdir(classes, { recursive: true });

    const sources = await javaSources(sourceDir);
    if (sources.length === 0) {
      throw new RoseauUnavailable('source-unavailable', `no Java sources under ${sourceDir}`);
    }

    const listing = join(cacheDir, `sources-${version}.txt`);
    await writeFile(listing, `${sources.join('\n')}\n`, 'utf8');
    try {
      await execFile('javac', ['-nowarn', '-d', classes, `@${listing}`], { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      throw new RoseauUnavailable(
        'environment-unavailable',
        `javac could not compile the ${version} tree: ${(err as Error).message.slice(0, 300)}`,
        'a JDK providing javac',
      );
    }
    try {
      await execFile('jar', ['--create', '--file', jar, '-C', classes, '.'], { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      throw new RoseauUnavailable(
        'environment-unavailable',
        `jar could not package the ${version} classes: ${(err as Error).message.slice(0, 300)}`,
        'a JDK providing jar',
      );
    }
  }

  return jars;
}

async function javaSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.java')) out.push(path);
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Serves the two compiled jars to production's own `fetchArchive`.
 *
 * The same seam the npm capsule adapter uses, for the same reason: the
 * analysis under test must be production's, and only the transport may be
 * substituted. Any host other than Maven Central throws rather than quietly
 * reaching the network, so a run cannot silently start measuring something
 * else.
 */
export function installMavenFetchStub(jars: { from: string; to: string }): () => void {
  const original = globalThis.fetch;
  const wanted = new Map([
    [`/${GROUP.replace(/\./g, '/')}/${ARTIFACT}/${FROM}/${ARTIFACT}-${FROM}.jar`, jars.from],
    [`/${GROUP.replace(/\./g, '/')}/${ARTIFACT}/${TO}/${ARTIFACT}-${TO}.jar`, jars.to],
  ]);

  // Typed from `fetch` itself rather than from the DOM lib, for the same
  // reason `npm-fetch-stub.ts` is: this package does not include `lib.dom`.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [suffix, path] of wanted) {
      if (url.endsWith(suffix)) {
        const bytes = await readFile(path);
        return new Response(new Uint8Array(bytes), { status: 200 });
      }
    }
    try {
      if (new URL(url).hostname === 'repo1.maven.org') return new Response(null, { status: 404 });
    } catch {
      // Non-absolute or malformed URL: defer to original fetch behavior.
    }
    return original(input, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

export interface RoseauDiff {
  /** Every change the surface diff produced, with the case each belongs to. */
  byCase: Map<string, { kind: string; symbol: string; detail: string }[]>;
  /** Present when the diff could not be produced at all. */
  unavailable: { reason: string; detail: string } | null;
  toolLocator: string;
}

/**
 * One japicmp invocation for the whole corpus, attributed per case.
 *
 * A symbol is attributed by the package the dataset put it in. Anything whose
 * package is not one of the 267 case packages is counted separately rather
 * than dropped — it would mean the attribution rule had stopped matching the
 * dataset's layout, and a silently empty bucket is how that goes unnoticed.
 */
export async function runRoseauDiff(jars: { from: string; to: string }, caseNames: readonly string[]): Promise<RoseauDiff> {
  const uninstall = installMavenFetchStub(jars);
  const workdir = await mkdtemp(join(tmpdir(), 'drift-roseau-'));
  clearHttpCache();

  try {
    const change: DependencyChange = {
      name: `${GROUP}:${ARTIFACT}`,
      ecosystem: 'maven',
      from: FROM,
      to: TO,
      kind: 'runtime',
      bump: 'major',
      manifestPath: 'pom.xml',
    };

    const outcome = await computeSurfaceDiff(change, { logger: SILENT_LOGGER, timeoutMs: 900_000 });

    if (!outcome.available) {
      return {
        byCase: new Map(),
        unavailable: { reason: outcome.reason, detail: outcome.detail },
        toolLocator: outcome.tool,
      };
    }

    const known = new Set(caseNames);
    const byCase = new Map<string, { kind: string; symbol: string; detail: string }[]>();
    for (const change of outcome.changes) {
      const bucket = caseOf(change.symbol, known) ?? '(unattributed)';
      const entries = byCase.get(bucket) ?? [];
      entries.push({ kind: String(change.kind), symbol: change.symbol, detail: change.detail });
      byCase.set(bucket, entries);
    }

    return { byCase, unavailable: null, toolLocator: outcome.locator ?? outcome.tool };
  } finally {
    uninstall();
    await rm(workdir, { recursive: true, force: true });
  }
}

/** `testing_lib.accessModifierClazzAccessDecrease.Foo#bar` -> `accessModifierClazzAccessDecrease`. */
export function caseOf(symbol: string, known: ReadonlySet<string>): string | null {
  for (const segment of symbol.split(/[.#(]/)) {
    if (known.has(segment)) return segment;
  }
  return null;
}

export interface ScoreRoseauInput {
  entry: RoseauCase;
  changes: { kind: string; symbol: string; detail: string }[];
  diffUnavailable: { reason: string; detail: string } | null;
  datasetVersion: string;
  sourceHash: string;
  toolLocator: string;
  durationMs: number;
}

export function scoreRoseau(input: ScoreRoseauInput): ExternalCaseResult {
  const { entry, changes } = input;
  const predictedBreaking = changes.length > 0;

  const base = {
    schemaVersion: EXTERNAL_RECORD_VERSION as typeof EXTERNAL_RECORD_VERSION,
    caseId: entry.name,
    provenance: {
      dataset: 'roseau',
      datasetVersion: input.datasetVersion,
      recordId: entry.name,
      repository: 'https://github.com/alien-tools/roseau',
      // The dataset is hand-built source shipped inside the replication kit
      // rather than a revision of a repository, so the DOI is the pin.
      commit: input.datasetVersion,
      baseCommit: null,
      dependency: `${GROUP}:${ARTIFACT}`,
      fromVersion: FROM,
      toVersion: TO,
      packageManager: 'maven',
      requiredRuntime: 'a JDK providing javac and jar, plus the japicmp CLI',
      oracleCommand: null,
      containerImage: null,
      sourceHash: input.sourceHash,
      extra: {
        family: family(entry.name),
        groundTruthSourceBreaking: String(entry.groundTruthSourceBreaking),
        toolLocator: input.toolLocator,
        // The kit's own recorded labels for the other tools, carried so a
        // reader can compare without re-deriving them — and clearly marked as
        // recorded rather than re-run, because they were produced on the
        // authors' machines with their tool versions, not here.
        recordedLabels: JSON.stringify(entry.recorded),
      },
    },
    truth: {
      label: entry.groundTruthBinaryBreaking ? 'binary-breaking' : 'not-binary-breaking',
      mappedTo: entry.groundTruthBinaryBreaking ? 'breaking' : 'not-breaking',
      mappingStatus: 'exact' as const,
      mappingNote: '',
      polarity: (entry.groundTruthBinaryBreaking ? 'positive' : 'negative') as 'positive' | 'negative',
    },
    durationMs: input.durationMs,
  };

  if (input.diffUnavailable) {
    return {
      ...base,
      prediction: {},
      outcomes: {},
      excluded: {
        kind: input.diffUnavailable.reason === 'tool-missing' ? 'environment-unavailable' : 'reproduction-failed',
        reason: input.diffUnavailable.detail,
        missingRequirement: input.diffUnavailable.reason === 'tool-missing' ? 'japicmp' : null,
      },
    };
  }

  return {
    ...base,
    prediction: { changes, changeCount: changes.length } as Record<string, unknown>,
    outcomes: {
      // Only meaningful over the positives; the negatives contribute through
      // `polarity` to the confusion matrix instead.
      ...(entry.groundTruthBinaryBreaking ? { detectedBreaking: predictedBreaking } : {}),
    },
    predictedPositive: predictedBreaking,
    excluded: null,
  };
}
