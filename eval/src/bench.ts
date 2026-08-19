import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { loadPublicCase, loadPublicCases, publicCaseDir } from './case/load.ts';
import { materializeCase, type MaterializedCase } from './case/materialize.ts';
import type { HiddenCheck, PublicCase } from './case/schema.ts';
import { runEndToEndDetection, ADAPTER_VERSION as E2E_VERSION } from './adapters/end-to-end.ts';
import { runCaseStage } from './oracle/stage.ts';
import { loadHiddenChecks } from './oracle/hidden.ts';
import { runCodemodTrack } from './tiers/codemod.ts';
import { runFixPlanCacheTrack, runFixPlanRecipeTrack, runModelFixPlanTrack, type FixPlanTrackOptions } from './tiers/model-fixplan.ts';
import { runAgentTrack, type AgentTrackOptions } from './tiers/agent.ts';
import { runFullRemediationTrack } from './tiers/full-remediation.ts';
import type { RepairContext, TrackOutcome } from './tiers/context.ts';
import {
  ARTIFACT_SCHEMA_VERSION,
  deterministicProvenance,
  experimentModeFor,
  UNAVAILABLE,
  type OracleStageArtifact,
  type PredictionArtifact,
  type Track,
} from './artifacts/prediction.ts';
import { driftRevision, newRunId, writeArtifact, writeManifest, RUN_MANIFEST_VERSION } from './runs/store.ts';
import { hashPublicCapsule } from './runs/capsule.ts';
import { isolationRecord } from './case/isolation-level.ts';
import { DriftConfigSchema, type Logger } from '../../dist/index.js';

const execFile = promisify(execFileCallback);

/**
 * The benchmark runner: turns cases into prediction artifacts, and nothing else.
 *
 * Scoring deliberately does not happen here. Generation and evaluation are
 * separated the way `swe-bump-bench` separates `collect` from `evaluate`, and
 * for a stronger reason than convenience: once a live agent is in the loop, a
 * runner that also scored could — accidentally or by a later well-meaning
 * change — use an oracle result to choose between attempts. Keeping the
 * evaluator downstream of an immutable artifact makes that impossible rather
 * than merely discouraged.
 *
 * Every track gets its own materialization. Repair tracks mutate the workspace
 * (or work in a git worktree over it), so a shared one would let the second
 * track score against the first track's repair.
 */

export const SCORING_VERSION = 'drift-bench-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

export interface BenchOptions {
  /** Restrict the run to these case ids. Empty means every benchmark-ready case. */
  caseIds?: string[];
  tracks: Track[];
  /** Independent repetitions per case × track. Research default 3 for live tracks; 1 is correct for deterministic ones. */
  trials?: number;
  agent?: AgentTrackOptions;
  /** Inputs the cache and recipe tiers need. Absent means those tracks report they had none. */
  fixPlan?: FixPlanTrackOptions;
  runId?: string;
  notes?: string;
  /**
   * Repository root the corpus and the run directory live under. Defaults to
   * the working directory; a test supplies a copy so a harness-level test can
   * exercise the real pipeline without writing into the recorded runs.
   */
  root?: string;
}

export async function runBenchmark(options: BenchOptions): Promise<{ runId: string; artifacts: PredictionArtifact[] }> {
  const runId = options.runId ?? newRunId(options.tracks.join('+'));
  const revision = await driftRevision();
  const all = await loadPublicCases(options.root);
  const selected = all.filter(
    (entry) => entry.status === 'benchmark-ready' && (options.caseIds?.length ? options.caseIds.includes(entry.id) : true),
  );

  await writeManifest({
    version: RUN_MANIFEST_VERSION,
    runId,
    createdAt: new Date().toISOString(),
    driftCommit: revision.commit,
    driftTreeDirty: revision.dirty,
    scoringVersion: SCORING_VERSION,
    command: process.argv.join(' '),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cases: await Promise.all(
      selected.map(async (entry) => ({
        caseId: entry.id,
        publicCapsuleHash: await hashPublicCapsule(entry.id, options.root),
      })),
    ),
    notes: options.notes ?? '',
  }, options.root);

  const artifacts: PredictionArtifact[] = [];
  const trials = Math.max(1, options.trials ?? 1);

  for (const publicCase of selected) {
    const publicCapsuleHash = await hashPublicCapsule(publicCase.id, options.root);
    // The only private material this file touches, read here so it is
    // impossible to miss. It never reaches an adapter, a repair tier, or the
    // materialized workspace — only the throwaway copies `runCaseStage` makes
    // *after* a repair already exists.
    const hiddenChecks = await loadHiddenChecks(publicCase.id, options.root);

    for (const track of options.tracks) {
      // A deterministic track repeated N times produces N identical artifacts
      // and no information, so repetition is reserved for tracks that can
      // actually vary. This is stated rather than assumed: the artifact
      // records `trialsPlanned`, so a reader can see the run only ever
      // intended one.
      const trackTrials = isLiveTrack(track) ? trials : 1;

      for (let trial = 1; trial <= trackTrials; trial += 1) {
        const artifact = await runOne({ publicCase, publicCapsuleHash, hiddenChecks, track, trial, trialsPlanned: trackTrials, runId, revision, agent: options.agent, fixPlan: options.fixPlan, ...(options.root ? { root: options.root } : {}) });
        await writeArtifact(artifact, options.root);
        artifacts.push(artifact);
      }
    }
  }

  return { runId, artifacts };
}

/**
 * Tracks that start an external process inside the workspace.
 *
 * Every repair track shells out — to the package manager, to git, or to a
 * coding agent — so any of them could in principle read a path outside the
 * workspace. `detect-end-to-end` runs Drift in-process and starts nothing,
 * which is a stronger position, and the artifact records the difference rather
 * than flattening both into one isolation claim.
 */
const SUBPROCESS_TRACKS = new Set<Track>([
  'repair-codemod',
  'repair-fixplan-cache',
  'repair-fixplan-recipe',
  'repair-fixplan-model',
  'repair-agent',
  'repair-full-remediation',
]);

function isLiveTrack(track: Track): boolean {
  return track === 'repair-agent' || track === 'repair-fixplan-model' || track === 'repair-full-remediation';
}

interface RunOneInput {
  publicCase: PublicCase;
  publicCapsuleHash: string;
  /**
   * Benchmark-added behavioural assertions for this case, loaded once per run.
   *
   * They travel as a parameter rather than being read inside `runOne` so the
   * single place that reads private truth stays visible at the top of this
   * file, and so a test can drive the whole pipeline with checks of its own.
   */
  hiddenChecks: readonly HiddenCheck[];
  track: Track;
  trial: number;
  trialsPlanned: number;
  runId: string;
  revision: { commit: string; dirty: boolean };
  agent?: AgentTrackOptions;
  fixPlan?: FixPlanTrackOptions;
  root?: string;
}

async function runOne(input: RunOneInput): Promise<PredictionArtifact> {
  const { publicCase, track } = input;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const observedCommands: string[] = [];

  const workspace = await materializeCase(publicCase, input.root);
  const config = DriftConfigSchema.parse({
    // `auto` is a real production mode and the only one under which a repair
    // result means anything: in `approve` — the default — `dispositionFor`
    // proposes every fix plan for a human and applies nothing, so every
    // deterministic tier would score `abstained-by-policy` on every case and
    // the benchmark would be measuring the default config rather than the
    // product. What `auto` does *not* do is loosen the gate: an unattested
    // replacement is still rejected, a plan that changes expression structure
    // still needs the project's checks to have passed, and the agent tier is
    // still bounded by scope validation.
    mode: 'auto',
    // `review` — the default — proposes every fix plan and applies none, so
    // the tier could never be measured under it. `proven` is the most
    // conservative setting that lets it act at all: only plans whose every
    // operation swaps one token for another of the same kind, anchored to an
    // occurrence Drift localized itself. A plan that changes expression
    // structure still needs the project's own checks to have passed, which
    // `verified` would be required for and which this benchmark does not
    // enable — so results here understate what a `verified` configuration
    // could apply, rather than overstating it.
    remediation: { fixPlans: { autoApply: 'proven' } },
    evidence: { typeSurface: true },
    verification: { behavioural: { enabled: true, network: false, timeoutSeconds: 20 } },
  });

  try {
    const detection = await runEndToEndDetection(publicCase, workspace);

    if (track === 'detect-end-to-end') {
      return base(input, startedAt, started, workspace, { detection: detection.detection, observedCommands });
    }

    // Baseline and bump-only run against the pristine workspace, before any
    // track has touched it. Their signatures are what the whole fail-to-pass
    // judgement is anchored on, so they must not be observed after a repair.
    const oracleStages: OracleStageArtifact[] = [
      await runCaseStage(publicCase, workspace, {
        stage: 'baseline',
        command: publicCase.oracles.baseline.command,
        expected: publicCase.oracles.baseline.expect,
        dependencyVersion: 'old',
        hiddenChecks: input.hiddenChecks,
      }),
      await runCaseStage(publicCase, workspace, {
        stage: 'broken',
        command: publicCase.oracles.broken.command,
        expected: publicCase.oracles.broken.expect,
        dependencyVersion: 'new',
        hiddenChecks: input.hiddenChecks,
      }),
    ];

    const context: RepairContext = {
      publicCase,
      workspace,
      plan: detection.plan,
      config,
      logger: SILENT_LOGGER,
      observedCommands,
    };

    const outcome = await runTrack(track, context, input.agent, input.fixPlan);

    if (outcome.repair.attempted && outcome.repair.patch.trim().length > 0) {
      // The repaired stage applies the *patch* to a fresh materialization
      // rather than reusing whatever the track left on disk. Uniform across
      // every track — codemod edits in place, the agent works in a worktree —
      // and it makes the artifact's patch the thing that was actually
      // evaluated, so a replay scores exactly what a reader can see.
      const fresh = await materializeCase(publicCase, input.root);
      try {
        oracleStages.push(
          await runCaseStage(publicCase, fresh, {
            stage: 'repaired',
            command: publicCase.oracles.repaired.command,
            expected: publicCase.oracles.repaired.expect,
            dependencyVersion: 'new',
            hiddenChecks: input.hiddenChecks,
            prepareConsumer: (consumerDir) => applyPatch(consumerDir, outcome.repair.patch),
          }),
        );
      } finally {
        await fresh.teardown();
      }
    }

    return base(input, startedAt, started, workspace, {
      detection: detection.detection,
      repair: outcome.repair,
      oracleStages,
      observedCommands,
      provenanceOverrides: outcome.provenance,
    });
  } catch (err) {
    return base(input, startedAt, started, workspace, { observedCommands, error: (err as Error).message });
  } finally {
    await workspace.teardown();
  }
}

async function runTrack(
  track: Track,
  context: RepairContext,
  agent?: AgentTrackOptions,
  fixPlan?: FixPlanTrackOptions,
): Promise<TrackOutcome> {
  switch (track) {
    case 'repair-codemod':
      return runCodemodTrack(context);
    case 'repair-fixplan-cache':
      return runFixPlanCacheTrack(context, fixPlan ?? {});
    case 'repair-fixplan-recipe':
      return runFixPlanRecipeTrack(context, fixPlan ?? {});
    case 'repair-fixplan-model':
      return runModelFixPlanTrack(context, fixPlan ?? {});
    case 'repair-agent':
      return runAgentTrack(context, agent);
    case 'repair-full-remediation':
      return runFullRemediationTrack(context, agent ?? {});
    default:
      throw new Error(`Track ${track} has no runner.`);
  }
}

interface BaseInput {
  detection?: PredictionArtifact['detection'];
  repair?: PredictionArtifact['repair'];
  oracleStages?: OracleStageArtifact[];
  observedCommands: string[];
  error?: string;
  provenanceOverrides?: TrackOutcome['provenance'];
}

function base(
  input: RunOneInput,
  startedAt: string,
  started: number,
  workspace: MaterializedCase,
  parts: BaseInput,
): PredictionArtifact {
  const provenance = {
    ...deterministicProvenance({
      driftCommit: input.revision.commit,
      driftTreeDirty: input.revision.dirty,
      adapterVersion: E2E_VERSION,
      startedAt,
      finishedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    }),
    trial: input.trial,
    trialsPlanned: input.trialsPlanned,
    ...(parts.provenanceOverrides ?? {}),
  };

  // A track that reported live provenance is a live trial and must not claim a
  // zero cost it did not measure. `null` reads as "not exposed by this
  // provider", which is the truth, where `0` would be a false economy claim.
  if (provenance.model !== UNAVAILABLE || provenance.agentId !== UNAVAILABLE) provenance.costUsd = null;

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    runId: input.runId,
    caseId: input.publicCase.id,
    publicCapsuleHash: input.publicCapsuleHash,
    track: input.track,
    experimentMode: experimentModeFor(input.track),
    provenance,
    isolation: isolationRecord({
      pathsAudited: workspace.auditedPaths,
      networkPolicy: input.publicCase.networkPolicy,
      // No sandbox is applied by this runner, so the weakest level is the only
      // honest one. It is passed rather than defaulted so that the day a
      // sandbox exists, the runner is where it is declared.
      spawnsSubprocesses: SUBPROCESS_TRACKS.has(input.track),
    }),
    ...(parts.detection ? { detection: parts.detection } : {}),
    ...(parts.repair ? { repair: parts.repair } : {}),
    oracleStages: parts.oracleStages ?? [],
    observedCommands: parts.observedCommands,
    error: parts.error ?? null,
  };
}

async function applyPatch(consumerDir: string, patch: string): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'drift-eval-patch-'));
  try {
    const path = join(temp, 'repair.patch');
    await writeFile(path, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8');
    await execFile('git', ['apply', '-p1', '--whitespace=nowarn', path], { cwd: consumerDir });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export { loadPublicCase };
