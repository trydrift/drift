import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalFixture } from '../load.ts';
import { installNpmFetchStub } from './npm-fetch-stub.ts';
import { runOracleStage, type OracleStageResult } from '../oracle.ts';
import type { DriftVerdict, EvalPrediction } from '../score.ts';
import {
  DriftConfigSchema,
  applyBuiltinCodemod,
  attemptCodemod,
  buildIndex,
  buildPlan,
  classifyBump,
  gatherEvidence,
  analyze,
  localPackageEnvironment,
  localize,
  runBehaviouralVerification,
  verdictFor,
  walkSourceFiles,
  type BreakingChange,
  type CodemodResult,
  type CommitUnit,
  type DependencyChange,
  type Ecosystem,
  type EvidenceContext,
  type Logger,
  type RepoContext,
} from '../../../dist/index.js';
import { clearHttpCache } from '../../../dist/util/http.js';
import { clearTypeSurfaceCache } from '../../../dist/evidence/type-surface.js';

/**
 * The authoritative, headline detection/repair benchmark.
 *
 * Discovers the breaking change through the same production analysis path a
 * real user's `drift analyze` run takes: `gatherEvidence` → `analyze` →
 * `localize` → `attemptCodemod` → `buildPlan` → `verdictFor`. The only
 * substitution is transport — `installNpmFetchStub` serves the fixture's own
 * `upstream/old`/`upstream/new` trees as jsDelivr responses, and
 * `localPackageEnvironment` points behavioural verification at local package
 * directories instead of installing from a registry — both are real seams
 * production code already has (see `test/scan-rows.test.ts` for the fetch-stub
 * pattern, and `src/verification/environment.ts` for the local-package one).
 *
 * `fixture.scenarioLabel` is never read here. Model-backed fix-plan
 * generation and coding-agent repair (tiers 2c/3) are also never invoked —
 * this adapter only credits deterministic, model-free repair (tier 1's
 * built-in codemod), consistent with keeping paid model calls out of
 * deterministic CI.
 */

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

const PIPELINE_CONFIG = DriftConfigSchema.parse({
  evidence: { typeSurface: true },
  verification: { behavioural: { enabled: true, network: false, timeoutSeconds: 10 } },
});

export async function fullPipelinePrediction(fixture: EvalFixture): Promise<EvalPrediction> {
  const started = Date.now();
  const fixtureDir = join(process.cwd(), 'eval', 'fixtures', fixture.id);
  const consumerDir = join(fixtureDir, 'consumer');
  const oldDir = join(fixtureDir, 'upstream', 'old');
  const newDir = join(fixtureDir, 'upstream', 'new');

  const dependencyChange: DependencyChange = {
    name: fixture.dependency,
    ecosystem: fixture.ecosystem as Ecosystem,
    from: fixture.fromVersion,
    to: fixture.toVersion,
    kind: 'runtime',
    bump: classifyBump(fixture.fromVersion, fixture.toVersion),
    manifestPath: 'consumer/package.json',
  };

  const uninstallFetchStub =
    fixture.network === 'disabled' && fixture.ecosystem === 'npm'
      ? installNpmFetchStub([
          { name: fixture.dependency, version: fixture.fromVersion, dir: oldDir },
          { name: fixture.dependency, version: fixture.toVersion, dir: newDir },
        ])
      : () => undefined;

  let surfaceComputedClean = false;

  // Every fixture's synthetic package shares the name `fixture-lib` at the
  // same two version numbers, and `fetchTypeSurface`/`fetchText` cache by
  // `packageName@version` at module scope — a real production behaviour
  // (the same published version is immutable across a whole scan) that
  // becomes a correctness bug here, where two different fixtures' local
  // trees answer to the identical cache key. Without clearing both caches
  // before every fixture, a later fixture silently reads an earlier one's
  // declarations.
  clearHttpCache();
  clearTypeSurfaceCache();

  try {
    const evidenceCtx: EvidenceContext = {
      config: PIPELINE_CONFIG,
      logger: SILENT_LOGGER,
      onSurfaceComputed: (_change, diff) => {
        if (diff.changes.length === 0) surfaceComputedClean = true;
      },
    };
    const evidence = await gatherEvidence([dependencyChange], evidenceCtx);
    const breakingChanges = await analyze([dependencyChange], evidence, { config: PIPELINE_CONFIG, logger: SILENT_LOGGER });

    const files = await walkSourceFiles(consumerDir, {});
    const index = buildIndex(files);
    const impactSites = localize(breakingChanges, [dependencyChange], index, files, { logger: SILENT_LOGGER });

    const verification = await runBehaviouralVerification({
      config: PIPELINE_CONFIG,
      breakingChanges,
      dependencyChanges: [dependencyChange],
      impactSites,
      resolveEnvironments: async () => {
        const [oldEnvironment, newEnvironment] = await Promise.all([
          localPackageEnvironment('old', oldDir),
          localPackageEnvironment('new', newDir),
        ]);
        return oldEnvironment && newEnvironment ? { oldEnvironment, newEnvironment } : null;
      },
    });

    const citedBreakingChanges = breakingChanges.map((change) => ({
      ...change,
      citations: [...change.citations, ...(verification.citationsByChangeId.get(change.id) ?? [])],
    }));
    const allEvidence = [...evidence, ...verification.evidence];
    const fileContents = new Map(files.map((file) => [file.path, file.content]));

    const codemods = new Map<string, CodemodResult>();
    for (const change of citedBreakingChanges) {
      const sitesForChange = impactSites.filter((site) => site.breakingChangeId === change.id);
      const codemod = attemptCodemod(change, sitesForChange, fileContents);
      if (codemod) codemods.set(change.id, codemod);
    }

    const repo: RepoContext = {
      owner: 'drift-eval',
      repo: fixture.id,
      baseBranch: 'main',
      beforeSha: 'old',
      afterSha: 'new',
      workspace: consumerDir,
    };

    const plan = buildPlan({
      repo,
      config: PIPELINE_CONFIG,
      changes: [dependencyChange],
      evidence: allEvidence,
      breakingChanges: citedBreakingChanges,
      impactSites,
      localizationRan: true,
      codemods: codemods.size > 0 ? codemods : undefined,
    });

    // `verdictFor` reads `change.assessment`, which only `buildPlan` attaches
    // (via `assess`) — the pre-plan `citedBreakingChanges` never carry it.
    const verdict = deriveVerdict(plan.breakingChanges, surfaceComputedClean);
    const repairableCommits = plan.commits.filter((commit) => commit.codemod);
    const repairAttempted = repairableCommits.length > 0;

    const capture: RepairCapture = { changedFiles: [] };
    const oracleStages = await runRepairOracles(fixture, fixtureDir, repairAttempted, repairableCommits, capture);
    const repairedStage = oracleStages.find((s) => s.stage === 'repaired');
    const repairOutcome: EvalPrediction['repairOutcome'] = !repairAttempted
      ? 'not-attempted'
      : repairedStage?.observed === 'pass'
        ? 'passed'
        : 'failed';

    const changedFiles = capture.changedFiles;
    const goldPatchExact = false; // secondary metric; see Blocker 22 — a semantically correct, non-exact patch must not be penalized.

    const upstreamFindings = [...new Set(allEvidence.flatMap((record) => record.findings ?? []))]
      .filter((finding) => finding.detail && !finding.detail.startsWith('no observed difference') && !finding.detail.startsWith('probe unavailable'))
      .map((finding) => `${fixture.dependency}:${finding.symbol}:${findingKind(finding.code, finding.detail)}`);

    const realTaxonomy = plan.breakingChanges[0]?.taxonomy;

    return {
      fixtureId: fixture.id,
      adapter: 'drift-full-pipeline',
      upstreamFindings: [...new Set(upstreamFindings)],
      impactSites: [...new Set(plan.impactSites.map((site) => `${site.file}:${site.matchedSymbol}`))],
      taxonomy: realTaxonomy
        ? { nature: realTaxonomy.nature, detectability: realTaxonomy.detectability, scope: realTaxonomy.scope, visibility: realTaxonomy.visibility }
        : undefined,
      gaps: plan.gaps.map((gap) => gap.reason),
      planNodes: plan.commits.map((commit) => commit.id),
      verdict,
      repairAction: repairAttempted ? 'repair-attempted' : 'abstained',
      repairOutcome,
      repairChangedFiles: changedFiles,
      repairOutOfScopeFiles: [],
      repairGoldPatchExact: goldPatchExact,
      oracleStages,
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
  } finally {
    uninstallFetchStub();
  }
}

function deriveVerdict(breakingChanges: readonly BreakingChange[], surfaceComputedClean: boolean): DriftVerdict {
  if (breakingChanges.length === 0) {
    if (surfaceComputedClean) return 'no-incompatible-change-in-checked-surfaces';
    // Never claim safe over an absence of evidence, even when nothing broke:
    // the only way to earn a safe-equivalent verdict is a surface that was
    // actually computed and found clean, not merely "nothing was flagged."
    return 'insufficient-evidence';
  }

  const priority: DriftVerdict[] = [
    'locally-affected',
    'insufficient-evidence',
    'verification-incomplete',
    'detected-not-locally-reachable',
    'no-incompatible-change-in-checked-surfaces',
  ];
  const verdicts = breakingChanges.map((change) => verdictFor(change) as DriftVerdict);
  return priority.find((v) => verdicts.includes(v)) ?? verdicts[0]!;
}

interface RepairCapture {
  changedFiles: string[];
}

async function runRepairOracles(
  fixture: EvalFixture,
  fixtureDir: string,
  repairAttempted: boolean,
  repairableCommits: readonly CommitUnit[],
  capture: RepairCapture,
): Promise<OracleStageResult[]> {
  const stages: OracleStageResult[] = [];
  stages.push(
    await runOracleStage(fixtureDir, fixture.dependency, {
      stage: 'baseline',
      command: fixture.oracles.baseline.command,
      expected: fixture.oracles.baseline.expect,
      dependencyVersion: 'old',
    }),
  );
  stages.push(
    await runOracleStage(fixtureDir, fixture.dependency, {
      stage: 'broken',
      command: fixture.oracles.broken.command,
      expected: fixture.oracles.broken.expect,
      dependencyVersion: 'new',
    }),
  );

  if (repairAttempted) {
    stages.push(
      await runOracleStage(fixtureDir, fixture.dependency, {
        stage: 'repaired',
        command: fixture.oracles.repaired.command,
        expected: fixture.oracles.repaired.expect,
        dependencyVersion: 'new',
        prepareConsumer: (consumerDir) => applyRepair(consumerDir, repairableCommits, capture),
      }),
    );
  }

  return stages;
}

/** Applies the plan's codemods in a disposable consumer copy, recording which files actually changed. */
async function applyRepair(
  consumerDir: string,
  repairableCommits: readonly CommitUnit[],
  capture: RepairCapture,
): Promise<void> {
  const changed = new Set<string>();
  for (const commit of repairableCommits) {
    const before = new Map(
      await Promise.all(
        commit.allowedFiles.map(async (path) => [path, await readFile(join(consumerDir, path), 'utf8')] as const),
      ),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = applyBuiltinCodemod(commit, before);
    for (const edit of result.edits) {
      if (edit.content !== before.get(edit.path)) changed.add(edit.path);
      await writeFile(join(consumerDir, edit.path), edit.content, 'utf8');
    }
  }
  capture.changedFiles = [...changed].sort();
}

function findingKind(code: string, detail: string): string {
  if (code === 'export-removed') return 'removed-export';
  if (code === 'member-removed') return 'member-removed';
  if (code === 'signature-changed') return 'signature-change';
  if (code === 'kind-changed') return 'kind-change';
  if (code === 'member-now-required') return 'member-now-required';
  if (code === 'entry-point-moved' || code === 'package-removed') return 'moved-export';
  if (code === 'constant-value-changed') return 'constant-value-changed';
  if (detail.includes('returned value changed')) return 'return-value';
  if (detail.startsWith('status changed')) return 'thrown-error';
  if (detail.includes('argument mutation')) return 'argument-mutation';
  return 'behaviour';
}

