import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EXTERNAL_RECORD_VERSION, type ExclusionKind, type ExternalCaseResult } from '../record.ts';
import { cleanupTemporaryDirectory } from '../cleanup.ts';
import type { Selectable } from '../selection.ts';
import {
  DriftConfigSchema,
  LocalGitProvider,
  analyzeRepository,
  resolvePlanVerdict,
  type Logger,
  type RemediationPlan,
  type RepoContext,
} from '../../../../dist/index.js';
// Not part of the public package surface — see the note in
// `eval/src/adapters/end-to-end.ts`.
import { deepVerify } from '../../../../dist/analysis.js';
import { buildImpactFunnel, deriveImpactDiagnostics, type ImpactFunnel } from '../impact-funnel.ts';
// Not part of the public package surface — the same non-public reach as `deepVerify` above.
import { pythonParser } from '../../../../dist/detect/ecosystems/python.js';
import { resolveVersionAsOfDate } from './pypi-history.ts';

const execFile = promisify(execFileCallback);

/**
 * TimeMachine-bench: real Python repositories whose historical dependency
 * state no longer works.
 *
 * ## What this run can and cannot do
 *
 * TimeMachine's own reproduction is a container per task, built on a
 * date-filtered PyPI index served at `localhost:5000`, which is what preserves
 * the historical resolution the task depends on. There is no container runtime
 * on the machine these runs happen on, so the oracle is not run and the repair
 * questions are not asked — they are absent from every case record rather than
 * recorded as failures, because Drift was never asked and did not fail.
 *
 * Detection needs neither. The dataset supplies a repository at an exact
 * historical commit and, separately, the dependency versions that resolve at
 * the migration target date — so a before/after manifest pair can be built
 * from two facts the dataset states, and Drift's real `analyzeRepository()` can
 * run over it through production's own `LocalGitProvider`.
 *
 * ## Where the after-state comes from, and where it deliberately does not
 *
 * The after-state is built from `dependency_versions`, the resolved
 * environment at the migration date. It is **not** built from `patch` or
 * `gold_patch`, which are the developer's migration — those are ground truth
 * and they never touch a prediction. The distinction matters because both
 * fields contain manifest edits: reading the upgrade out of the fix would hand
 * Drift the answer and call the result detection.
 *
 * Only requirements the repository itself declares are repinned. The rest of
 * `dependency_versions` is the transitive closure, and writing all of it into
 * a manifest would be inventing declarations the project never made.
 *
 * ## The construction is stated, not hidden
 *
 * This is a manifest pair the harness assembles, unlike BUMP where the pair is
 * two real consecutive commits. It is the weaker of the two constructions and
 * every artifact says so, because a reader comparing the two ecosystems is
 * entitled to know that one of them is reading history and the other is
 * reading a state derived from it.
 *
 * ## Why the before-commit is also rewritten (issue #213)
 *
 * The repository's own historical manifest routinely declares a *range*
 * (`django>=3.2`) or nothing at all (`pyyaml`), never the exact version that
 * was actually installed. Committing only the after-state on top of that
 * leaves Drift with exactly the ambiguity a range represents — it has no
 * lockfile at that commit to resolve `from` against, and correctly refuses to
 * claim one (the same discipline `resolveManifestRanges` applies to npm). The
 * dependency change is then triaged out (`previous manifest range has no
 * exact resolved registry version`), which is Drift behaving correctly against
 * a badly-constructed input, not a detection miss.
 *
 * So before the after-state is written, every requirement this run could pin
 * an exact before-version for — from a committed lockfile
 * (`resolveHistoricalPins`) or, failing that, from what PyPI had published by
 * `reproduction_target_date` (`pypi-history.ts`) — is rewritten into the
 * *before* commit as an explicit `==`. Only then is the after-state committed
 * on top. A requirement neither source can pin stays exactly as the
 * repository wrote it, in both commits, and its entry stays `unresolved`.
 * `provenance.extra.beforeVersionSources` records where each pin came from.
 */

export const ADAPTER_VERSION = 'timemachine-detect-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

export interface TimemachineTask {
  repo_name: string;
  repo_url: string;
  commit_hash: string;
  reproduction_target_date: string;
  reproduction_target_version: string;
  migration_target_date: string;
  migration_target_version: string;
  dependency_versions: string;
  script_source: string;
  version_source: string;
  test_type: string;
  difficulty: string;
  license: string;
}

export type TimemachineSubset = 'verified' | 'random' | 'full';

export async function loadTimemachine(
  root: string,
  subset: TimemachineSubset,
): Promise<{ tasks: TimemachineTask[]; datasetVersion: string; sourceHash: string }> {
  const path = join(root, 'benchmark', 'data', 'v1', `timemachine-bench-${subset}.jsonl`);
  const bytes = await readFile(path);
  const tasks = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TimemachineTask);

  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { tasks, datasetVersion: stdout.trim(), sourceHash: createHash('sha256').update(bytes).digest('hex') };
}

export function timemachineSelectables(tasks: readonly TimemachineTask[]): Selectable[] {
  // Difficulty is the dataset's own stratification and the one that matters:
  // a sample that lost the Hard cases would report an easier corpus than the
  // one it names.
  return tasks.map((task) => ({ id: `${task.repo_name}@${task.commit_hash.slice(0, 12)}`, strata: [task.difficulty, task.script_source] }));
}

export class TimemachineUnavailable extends Error {
  readonly kind: ExclusionKind;
  readonly missingRequirement: string | null;

  constructor(kind: ExclusionKind, message: string, missingRequirement: string | null = null) {
    super(message);
    this.kind = kind;
    this.missingRequirement = missingRequirement;
  }
}

/**
 * `alabaster==1.0.0\nbabel==2.17.0\n…` -> a lookup of resolved versions.
 *
 * Names are normalised the way PyPI normalises them, so `Sphinx` in a
 * requirements file matches `sphinx` in the resolved set. Without that, half
 * the repins would silently not happen and the run would report Drift missing
 * updates that were never written.
 */
export function resolvedVersions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9._-]+)==([^\s;#]+)/.exec(line.trim());
    if (match) out.set(normalizeName(match[1]!), match[2]!);
  }
  return out;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * The exact version a package resolved to, and which committed file said so.
 *
 * TimeMachine states the historical requirement, which for most direct
 * dependencies is a range (`django>=3.2`) — so the authoritative *before*
 * version of a migration is not in the dataset. It is in the repository, in
 * whichever lockfile the project committed alongside that requirement. Reading
 * it there is the difference between adjudicating a case and recording it as
 * `exact-version-unresolved` (issue #213): on the current corpus that is ~38
 * of 55 affected-repository misses.
 */
export interface HistoricalPin {
  version: string;
  /** The committed file the version came from, e.g. `poetry.lock`. */
  source: string;
}

/**
 * Committed Python lockfiles, most authoritative first.
 *
 * `uv.lock`, `poetry.lock` and `pdm.lock` are all TOML with `[[package]]`
 * `name`/`version` tables — the engine's own `pythonParser` reads all three.
 * `Pipfile.lock` is JSON. `*.txt` compiled lockfiles (`pip-compile` output)
 * are exact-pinned requirements and are read by the same parser.
 */
const HISTORICAL_LOCKFILES = [
  'uv.lock',
  'poetry.lock',
  'pdm.lock',
  'Pipfile.lock',
  'requirements.lock',
  'requirements/base.lock',
];

/** Parse `Pipfile.lock` (JSON) into name -> exact version. */
function parsePipfileLock(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const section of ['default', 'develop']) {
    const group = (parsed as Record<string, unknown>)[section];
    if (!group || typeof group !== 'object') continue;
    for (const [name, spec] of Object.entries(group as Record<string, unknown>)) {
      const version = spec && typeof spec === 'object' ? (spec as Record<string, unknown>)['version'] : undefined;
      if (typeof version === 'string') {
        const exact = version.replace(/^==/, '').trim();
        if (exact) out.set(normalizeName(name), exact);
      }
    }
  }
  return out;
}

/**
 * The exact historical version of every package the repository pinned, read
 * from the first committed lockfile that names it.
 *
 * Never guesses: a range with no lockfile entry stays unresolved, and the
 * case stays unadjudicated with that reason recorded — measuring against a
 * fabricated before-version would be worse than not measuring.
 */
export async function resolveHistoricalPins(repoDir: string): Promise<Map<string, HistoricalPin>> {
  const pins = new Map<string, HistoricalPin>();
  for (const candidate of HISTORICAL_LOCKFILES) {
    const content = await readFile(join(repoDir, candidate), 'utf8').catch(() => null);
    if (content === null) continue;
    const base = candidate.split('/').pop()!;
    if (base === 'Pipfile.lock') {
      for (const [name, version] of parsePipfileLock(content)) {
        if (!pins.has(name)) pins.set(name, { version, source: base });
      }
      continue;
    }
    // uv.lock / poetry.lock / pdm.lock are all `[[package]]` TOML — the engine
    // parses that shape under the `poetry.lock` name. `requirements.lock` (a
    // `pip-compile` output) is exact-pinned requirements and parses as itself.
    const asName = base.includes('requirements') ? 'requirements.lock' : 'poetry.lock';
    for (const [name, entry] of pythonParser.parse(content, asName)) {
      const version = typeof entry === 'string' ? entry : entry.version;
      // Only an exact version is authoritative; a range that survived into the
      // lockfile (a `requirements.lock` that was never actually compiled) is not.
      if (version && /^\d/.test(version) && !pins.has(normalizeName(name))) {
        pins.set(normalizeName(name), { version, source: base });
      }
    }
  }
  return pins;
}

/**
 * Rewrites a requirements file's declared pins to their resolved versions.
 *
 * Returns the new text and the packages that actually moved, so the case can
 * record what upgrade Drift was shown rather than what the dataset listed.
 *
 * A requirement written as a range (`django>=3.2`) has no exact *before*
 * version in the text. `historicalPins` — read from a committed lockfile —
 * supplies it, and the entry then moves to `changed` with `fromSource`
 * recording where the version came from. Only a range with no lockfile entry
 * stays `unresolved`.
 */
/** The specifier text of a matched requirement (`"django>=3.2,<4.0"`, name `"django"`) -> `">=3.2,<4.0"`; `null` for a bare name. */
export function specifierOf(requirementText: string, name: string): string | null {
  const rest = requirementText.slice(name.length).replace(/^\s*(?:\[[^\]]*\])?\s*/, '').trim();
  return rest.length > 0 ? rest : null;
}

export function repinRequirements(
  text: string,
  resolved: ReadonlyMap<string, string>,
  historicalPins: ReadonlyMap<string, HistoricalPin> = new Map(),
): {
  text: string;
  changed: { name: string; from: string; to: string; fromSource: string }[];
  unresolved: { name: string; requirement: string; to: string }[];
} {
  const changed: { name: string; from: string; to: string; fromSource: string }[] = [];
  const unresolved: { name: string; requirement: string; to: string }[] = [];
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('-')) return line;

    const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:([=<>!~]=?)\s*([^\s;#]+))?/.exec(trimmed);
    if (!match) return line;

    const name = match[1]!;
    const target = resolved.get(normalizeName(name));
    if (!target) return line;

    const declaredExact = match[2] === '==' ? (match[3] ?? null) : null;
    const from = declaredExact ?? historicalPins.get(normalizeName(name))?.version ?? null;
    const fromSource = declaredExact ? 'requirement-pin' : (historicalPins.get(normalizeName(name))?.source ?? null);
    if (!from || !fromSource) {
      unresolved.push({ name, requirement: match[0]!, to: target });
      return line;
    }
    if (from === target) return line;
    changed.push({ name, from, to: target, fromSource });
    return `${name}==${target}`;
  });

  return { text: lines.join('\n'), changed, unresolved };
}

/**
 * Rewrite a requirement's declared range or bare name into an explicit `==`
 * at the version `pins` supplies — without changing anything about entries
 * `pins` has no answer for, and without touching an entry already pinned to
 * exactly that version.
 *
 * This is what makes the *before* commit resolvable at all (see the module
 * docstring, "Why the before-commit is also rewritten"): `repinRequirements`
 * alone only ever wrote the after-state, leaving Drift to resolve the
 * before-version itself from a lockfile that does not exist at that commit —
 * which it correctly refuses to do, and the case was skipped by triage before
 * it ever reached the assessment this benchmark measures.
 */
export function pinBeforeVersions(
  text: string,
  pins: ReadonlyMap<string, HistoricalPin>,
): { text: string; pinned: { name: string; version: string; source: string }[] } {
  const pinned: { name: string; version: string; source: string }[] = [];
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('-')) return line;

    const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:([=<>!~]=?)\s*([^\s;#]+))?/.exec(trimmed);
    if (!match) return line;

    const name = match[1]!;
    const declaredExact = match[2] === '==' ? (match[3] ?? null) : null;
    const pin = pins.get(normalizeName(name));
    if (!pin || declaredExact === pin.version) return line;

    pinned.push({ name, version: pin.version, source: pin.source });
    return `${name}==${pin.version}`;
  });
  return { text: lines.join('\n'), pinned };
}

export interface TimemachinePrediction {
  dependencyChanges: { name: string; from: string | null; to: string | null }[];
  breakingChanges: { kind: string; symbols: string[] }[];
  impactSites: { file: string; line: number; matchedSymbol: string; siteKind?: 'manifest' | 'runtime-declaration' }[];
  verdict: string;
  summary: string;
  /** What the harness actually repinned, so the constructed upgrade is inspectable. `fromSource` records where the before-version came from (`requirement-pin`, `poetry.lock`, …). */
  repinned: { name: string; from: string; to: string; fromSource: string }[];
  unresolved: { name: string; requirement: string; to: string }[];
  manifestPath: string;
  /** Which pipeline stage a miss was lost at, plus secondary diagnostics. See `impact-funnel.ts`. */
  impactFunnel: ImpactFunnel;
}

const SAFE_EQUIVALENT = new Set(['no-incompatible-change-in-checked-surfaces', 'clean']); // detected-not-locally-reachable is not a safety claim; see src/report/confidence.ts

const REQUIREMENTS_CANDIDATES = [
  'requirements.txt',
  'requirements/base.txt',
  'requirements/requirements.txt',
  'requirements_dev.txt',
  'requirements-dev.txt',
];

export async function predictTimemachine(task: TimemachineTask): Promise<TimemachinePrediction> {
  const work = await mkdtemp(join(tmpdir(), 'drift-timemachine-'));
  const repo = join(work, 'repo');

  try {
    await mkdir(repo, { recursive: true });
    await execFile('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
    await execFile('git', ['remote', 'add', 'origin', `${task.repo_url}.git`], { cwd: repo });
    try {
      await execFile('git', ['fetch', '--quiet', '--depth', '1', 'origin', task.commit_hash], {
        cwd: repo,
        timeout: 600_000,
      });
    } catch (err) {
      throw new TimemachineUnavailable(
        'source-unavailable',
        `commit ${task.commit_hash} could not be fetched from ${task.repo_url}: ${(err as Error).message.slice(0, 300)}`,
      );
    }
    await execFile('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: repo });
    await execFile('git', ['config', 'user.email', 'bench@drift.invalid'], { cwd: repo });
    await execFile('git', ['config', 'user.name', 'Drift Benchmark'], { cwd: repo });

    const resolved = resolvedVersions(task.dependency_versions);
    // The exact historical before-version of every pinned package, read from a
    // committed lockfile — the fix for issue #213. A range with no lockfile
    // entry still falls through to `unresolved`.
    const historicalPins = await resolveHistoricalPins(repo);
    let manifestPath: string | null = null;
    let manifestText: string | null = null;
    let unresolved: { name: string; requirement: string; to: string }[] = [];

    for (const candidate of REQUIREMENTS_CANDIDATES) {
      const existing = await readFile(join(repo, candidate), 'utf8').catch(() => null);
      if (existing === null) continue;
      const rewritten = repinRequirements(existing, resolved, historicalPins);
      if (rewritten.changed.length === 0 && rewritten.unresolved.length === 0) continue;
      manifestPath = candidate;
      manifestText = existing;
      unresolved = rewritten.unresolved;
      break;
    }

    // Second pass: no lockfile pinned it, so ask PyPI what was actually
    // publishable as of the historical date this reproduction targets. Only
    // for names the first pass could not place, and only when the answer
    // satisfies the repository's own declared specifier — see
    // `pypi-history.ts`. A name PyPI cannot answer for stays unresolved.
    const allPins = new Map(historicalPins);
    if (manifestPath && unresolved.length > 0) {
      for (const entry of unresolved) {
        const specifier = specifierOf(entry.requirement, entry.name);
        const pin = await resolveVersionAsOfDate(entry.name, task.reproduction_target_date, specifier, fetch);
        if (pin) allPins.set(normalizeName(entry.name), pin);
      }
    }

    // The before-commit: `task.commit_hash` as fetched, with every requirement
    // this run could pin an exact before-version for rewritten to state it
    // explicitly. See "Why the before-commit is also rewritten" above — without
    // this, `beforeSha` declares a range Drift cannot resolve from a lockfile
    // that does not exist at this commit, and the change never survives triage.
    let repinned: { name: string; from: string; to: string; fromSource: string }[] = [];
    let finalText: string | null = null;
    if (manifestPath && manifestText) {
      // Only pin packages this migration actually moves — `historicalPins`
      // knows every package the lockfile names, most of which have nothing to
      // do with this upgrade, and pinning them into the before-commit would
      // hand Drift dependency changes unrelated to the one under test.
      const relevantPins = new Map([...allPins].filter(([name]) => resolved.has(name)));
      const beforePin = pinBeforeVersions(manifestText, relevantPins);
      if (beforePin.pinned.length > 0) {
        await writeFile(join(repo, manifestPath), beforePin.text, 'utf8');
        await execFile('git', ['add', '-A'], { cwd: repo });
        await execFile('git', ['commit', '--quiet', '-m', 'pin the recovered historical before-version'], { cwd: repo });
      }
      const rewritten = repinRequirements(beforePin.text, resolved, allPins);
      unresolved = rewritten.unresolved;
      finalText = rewritten.text;
      // `repinRequirements` reads `declaredExact` off the now-pinned text, so
      // every entry `pinBeforeVersions` touched reports `fromSource:
      // 'requirement-pin'` — correct about the *text* it just read, but it
      // loses where that pin actually came from. `allPins` still knows.
      repinned = rewritten.changed.map((entry) => ({
        ...entry,
        fromSource: allPins.get(normalizeName(entry.name))?.source ?? entry.fromSource,
      }));
    }

    const beforeSha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    if (manifestPath && finalText && repinned.length > 0) {
      await writeFile(join(repo, manifestPath), finalText, 'utf8');
    }

    if (!manifestPath) {
      // No declared requirement moved, so there is no upgrade to show Drift.
      // A case with nothing to detect cannot measure detection, and scoring it
      // as a miss would charge Drift for an empty input.
      throw new TimemachineUnavailable(
        'no-dependency-update',
        `no requirements file at ${task.commit_hash} declares a package whose resolved version differs, so no dependency update could be constructed for this task`,
      );
    }

    if (repinned.length === 0) {
      return {
        dependencyChanges: [],
        breakingChanges: [],
        impactSites: [],
        verdict: 'insufficient-evidence',
        summary: 'No exact historical dependency version was available to construct an upgrade.',
        repinned,
        unresolved,
        manifestPath,
        impactFunnel: {
          missReason: 'exact-version-unresolved',
          diagnostics: deriveImpactDiagnostics({
            plan: undefined,
            isTargetDependency: () => false,
            updateDetected: false,
            exactVersionResolved: false,
          }),
        },
      };
    }

    await execFile('git', ['add', '-A'], { cwd: repo });
    await execFile('git', ['commit', '--quiet', '-m', `repin declared requirements to ${task.migration_target_date}`], {
      cwd: repo,
    });
    const afterSha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const config = DriftConfigSchema.parse({});
    const context: RepoContext = {
      owner: task.repo_name.split('/')[0] ?? 'unknown',
      repo: task.repo_name.split('/')[1] ?? task.repo_name,
      baseBranch: 'main',
      beforeSha,
      afterSha,
      workspace: repo,
    };

    const analysisOptions = {
      repo: context,
      config,
      logger: SILENT_LOGGER,
      provider: new LocalGitProvider(repo, { before: beforeSha, after: afterSha }),
      workspace: repo,
    };

    // Deep Verification: install the change and run the project's own
    // checks, exactly as `runPipeline` does when a caller asks for it —
    // always, here, matching what this harness measured before PR #69 split
    // Quick Scan from Deep Verification into two calls.
    const result = await deepVerify(await analyzeRepository(analysisOptions), analysisOptions);

    const plan = result.plan;
    const repinnedNames = new Set(repinned.map((entry) => normalizeName(entry.name)));
    const isTargetDependency = (name: string): boolean => repinnedNames.has(normalizeName(name));
    const verdict = verdictFromPlan(plan);
    const impactFunnel = buildImpactFunnel({
      plan,
      localizationDiagnostics: result.localizationDiagnostics,
      isTargetDependency,
      updateDetected: (plan?.changes ?? []).some((change) => isTargetDependency(change.name)),
      // A direct transition left as an unresolved range means the constructed
      // migration is partial — the same fact that keeps the case unadjudicated.
      exactVersionResolved: unresolved.length === 0,
      identifiedAffected: verdict === 'locally-affected',
    });
    return {
      dependencyChanges: (plan?.changes ?? []).map((change) => ({ name: change.name, from: change.from, to: change.to })),
      breakingChanges: (plan?.breakingChanges ?? []).map((change) => ({ kind: String(change.kind), symbols: change.symbols ?? [] })),
      impactSites: (plan?.impactSites ?? []).map((site) => ({
        file: site.file,
        line: site.line,
        matchedSymbol: site.matchedSymbol,
        ...(site.siteKind ? { siteKind: site.siteKind } : {}),
      })),
      verdict,
      summary: result.summary,
      repinned,
      unresolved,
      manifestPath,
      impactFunnel,
    };
  } finally {
    await cleanupTemporaryDirectory(work);
  }
}

/** Production's own reduction — see the note in `bump.ts` about why this is not reimplemented. */
function verdictFromPlan(plan: RemediationPlan | null | undefined): string {
  return plan ? resolvePlanVerdict(plan) : 'insufficient-evidence';
}

export interface ScoreTimemachineInput {
  task: TimemachineTask;
  subset: TimemachineSubset;
  prediction: TimemachinePrediction | null;
  excluded: { kind: ExclusionKind; reason: string; missingRequirement: string | null } | null;
  datasetVersion: string;
  sourceHash: string;
  durationMs: number;
}

export function scoreTimemachine(input: ScoreTimemachineInput): ExternalCaseResult {
  const { task, prediction } = input;

  const base = {
    schemaVersion: EXTERNAL_RECORD_VERSION as typeof EXTERNAL_RECORD_VERSION,
    caseId: `${task.repo_name}@${task.commit_hash.slice(0, 12)}`,
    provenance: {
      dataset: 'timemachine',
      datasetVersion: input.datasetVersion,
      recordId: `${task.repo_name}@${task.commit_hash}`,
      repository: task.repo_url,
      commit: task.commit_hash,
      baseCommit: null,
      dependency: prediction?.repinned.map((entry) => entry.name).join(', ') ?? null,
      fromVersion: task.reproduction_target_date,
      toVersion: task.migration_target_date,
      packageManager: 'pip',
      requiredRuntime: `python ${task.reproduction_target_version} -> ${task.migration_target_version}`,
      oracleCommand: `${task.test_type} (inside the published container, against a PyPI index filtered to ${task.migration_target_date})`,
      containerImage: 'built per task by the dataset; not pulled here',
      sourceHash: input.sourceHash,
      extra: {
        subset: input.subset,
        difficulty: task.difficulty,
        scriptSource: task.script_source,
        licence: task.license,
        // Stated on every case: this pair is assembled by the harness from two
        // dataset facts, not read from two consecutive commits.
        manifestPairConstruction: 'harness-repinned-declared-requirements',
        manifestPath: prediction?.manifestPath ?? 'unavailable',
        repinnedCount: String(prediction?.repinned.length ?? 0),
        unresolvedRangeCount: String(prediction?.unresolved.length ?? 0),
        // Where each before-version came from — `requirement-pin` for a `==` in
        // the manifest, a lockfile name otherwise (issue #213). A reader can
        // see at a glance whether a case was adjudicated on a declared pin or a
        // recovered one.
        beforeVersionSources:
          prediction && prediction.repinned.length > 0
            ? [...new Set(prediction.repinned.map((entry) => entry.fromSource))].sort().join(', ')
            : 'none',
      },
    },
    truth: {
      label: `migration-failure-${task.difficulty.toLowerCase()}`,
      mappedTo: 'locally-affected',
      mappingStatus: 'compatible' as const,
      mappingNote:
        "TimeMachine records that the repository's tests fail after migration, not which API changed. The label maps only to the claim that the project is affected, never to a Drift breaking-change kind.",
      polarity: 'positive' as const,
    },
    durationMs: input.durationMs,
  };

  if (!prediction) return { ...base, prediction: {}, outcomes: {}, excluded: input.excluded };

  const repinnedNames = new Set(prediction.repinned.map((entry) => normalizeName(entry.name)));
  const detectionAdjudicated = repinnedNames.size > 0;
  const detectedUpdate = detectionAdjudicated
    ? prediction.dependencyChanges.some((change) => repinnedNames.has(normalizeName(change.name)))
    : undefined;
  // TimeMachine's positive label belongs to the complete migrated project,
  // not to any one dependency in it. An exact subset can adjudicate whether
  // Drift detected those exact updates, but it cannot inherit the corpus's
  // whole-project failure label while another direct transition remains an
  // unresolved range.
  const projectAdjudicated = detectionAdjudicated && prediction.unresolved.length === 0;
  const exactVersionReason =
    'the historical requirement is a range and the corpus does not supply its exact resolved before version';
  const partialMigrationReason =
    'the constructed migration includes direct dependencies without authoritative exact before versions, so the corpus whole-project failure cannot adjudicate the exact subset';
  // Localization is a strict subset of affected-identification: pointing at a
  // consumer line only counts as a "yes" when Drift also stood behind the
  // conclusion that the repository is affected. Scoring them as independent
  // conditions let `localized` exceed `identifiedAffected` — a case with impact
  // sites but a hedged (`verification-incomplete` / `insufficient-evidence`)
  // verdict — which is impossible per case and made the pooled rates disagree.
  const identifiedAffected = prediction.verdict === 'locally-affected';
  const outcomes = {
    ...(detectionAdjudicated ? { detectedUpdate } : {}),
    ...(projectAdjudicated
      ? {
          identifiedAffected,
          // Source sites only — see the note on the same rule in `bump.ts`.
          localized:
            identifiedAffected && prediction.impactSites.some((site) => site.siteKind === undefined),
          falseSafe: SAFE_EQUIVALENT.has(prediction.verdict),
        }
      : {}),
  };
  const notAdjudicated = {
    ...(!detectionAdjudicated ? { detectedUpdate: exactVersionReason } : {}),
    ...(!projectAdjudicated
      ? {
          identifiedAffected: detectionAdjudicated ? partialMigrationReason : exactVersionReason,
          localized: detectionAdjudicated ? partialMigrationReason : exactVersionReason,
          falseSafe: detectionAdjudicated ? partialMigrationReason : exactVersionReason,
        }
      : {}),
  };
  return {
    ...base,
    prediction: { ...prediction } as Record<string, unknown>,
    impactFunnel: prediction.impactFunnel,
    outcomes,
    ...(Object.keys(notAdjudicated).length > 0 ? { notAdjudicated } : {}),
    excluded: null,
  };
}
