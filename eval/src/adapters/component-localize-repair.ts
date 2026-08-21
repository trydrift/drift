import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalFixture } from '../load.ts';
import { runOracleStage, type OracleStageResult } from '../oracle.ts';
import { createRepairCaptureBuilder, EMPTY_REPAIR_CAPTURE, type RepairCaptureBuilder } from './repair-capture.ts';
import type { DriftVerdict, EvalPrediction } from '../score.ts';
import {
  DriftConfigSchema,
  applyBuiltinCodemod,
  applyCommitFixPlan,
  attemptCodemod,
  buildIndex,
  buildPlan,
  classifyBump,
  localize,
  stableId,
  validateFixPlan,
  walkSourceFiles,
  type BreakingChange,
  type CommitUnit,
  type DependencyChange,
  type Ecosystem,
  type Evidence,
  type FixPlan,
  type Logger,
  type RepoContext,
} from '../../../dist/index.js';

/**
 * `drift-component-localize-repair` (formerly `drift-structured-fixture`).
 *
 * NOT a detection benchmark: `fixture.scenarioLabel` is read directly to
 * construct a known `BreakingChange` (and, for a fixture whose repair needs
 * more than the built-in rename codemod, a known `FixPlan`). This adapter
 * only answers "given a known finding, does localization find the right
 * sites and does repair apply correctly?" Never contributes to headline
 * detection F1 — see eval/README.md for why full-pipeline detection lives in
 * `drift-known-bump-analysis` instead.
 */

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

const COMPONENT_CONFIG = DriftConfigSchema.parse({});

const SUPPORTED_SCENARIOS = new Set(['renamed-export', 'member-rename']);

/** Only handles rename-shaped fixtures — see `knownChange` below. Any other scenario is out of this component's scope. */
export function supportsFixture(fixture: EvalFixture): boolean {
  return SUPPORTED_SCENARIOS.has(fixture.scenarioLabel);
}

/**
 * `_adjudication` is accepted only so this adapter's signature matches the
 * `run.ts` adapter table's shared type. This component never compares
 * against a gold patch — `repairGoldPatchExact` is always `'not-applicable'`.
 */
export async function componentLocalizeRepairPrediction(fixture: EvalFixture, _adjudication?: unknown): Promise<EvalPrediction> {
  if (!supportsFixture(fixture)) {
    throw new Error(
      `drift-component-localize-repair only handles rename-shaped fixtures (renamed-export, member-rename); ${fixture.id} declares scenarioLabel '${fixture.scenarioLabel}'. Skip this adapter for this fixture rather than running it.`,
    );
  }
  const started = Date.now();
  const fixtureDir = join(process.cwd(), 'eval', 'fixtures', fixture.id);
  const consumerDir = join(fixtureDir, 'consumer');
  const oldDir = join(fixtureDir, 'upstream', 'old');
  const newDir = join(fixtureDir, 'upstream', 'new');

  const newPkg = JSON.parse(await readFile(join(newDir, 'package.json'), 'utf8')) as { exports?: string };
  const entryFile = typeof newPkg.exports === 'string' ? newPkg.exports.replace(/^\.\//, '') : 'index.js';
  const oldExports = extractJsExportNames(await readFile(join(oldDir, entryFile), 'utf8').catch(() => ''));
  const newExports = extractJsExportNames(await readFile(join(newDir, entryFile), 'utf8').catch(() => ''));

  const dependencyChange: DependencyChange = {
    name: fixture.dependency,
    ecosystem: fixture.ecosystem as Ecosystem,
    from: fixture.fromVersion,
    to: fixture.toVersion,
    kind: 'runtime',
    bump: classifyBump(fixture.fromVersion, fixture.toVersion),
    manifestPath: 'consumer/package.json',
  };

  const { breakingChange, evidence, fixPlan } = knownChange(fixture, oldExports, newExports);

  const files = await walkSourceFiles(consumerDir, {});
  const index = buildIndex(files);
  const impactSites = localize([breakingChange], [dependencyChange], index, files, { logger: SILENT_LOGGER });
  const fileContents = new Map(files.map((file) => [file.path, file.content]));
  const sitesForChange = impactSites.filter((site) => site.breakingChangeId === breakingChange.id);
  const codemod = attemptCodemod(breakingChange, sitesForChange, fileContents);
  const codemods = codemod ? new Map([[breakingChange.id, codemod]]) : undefined;
  const fixPlans =
    !codemod && fixPlan
      ? new Map([
          [
            breakingChange.id,
            validateFixPlan({ plan: fixPlan, change: breakingChange, sites: sitesForChange, fileContents, evidence }),
          ],
        ])
      : undefined;

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
    config: COMPONENT_CONFIG,
    changes: [dependencyChange],
    evidence,
    breakingChanges: [breakingChange],
    impactSites,
    localizationRan: true,
    codemods,
    fixPlans,
  });

  const repairableCommits = plan.commits.filter((commit) => commit.codemod || commit.fixPlan);
  const repairAttempted = repairableCommits.length > 0;
  const captureBuilder = createRepairCaptureBuilder();

  const oracleStages: OracleStageResult[] = [
    await runOracleStage(fixtureDir, fixture.dependency, {
      stage: 'baseline',
      command: fixture.oracles.baseline.command,
      expected: fixture.oracles.baseline.expect,
      dependencyVersion: 'old',
    }),
    await runOracleStage(fixtureDir, fixture.dependency, {
      stage: 'broken',
      command: fixture.oracles.broken.command,
      expected: fixture.oracles.broken.expect,
      dependencyVersion: 'new',
    }),
  ];
  if (repairAttempted) {
    oracleStages.push(
      await runOracleStage(fixtureDir, fixture.dependency, {
        stage: 'repaired',
        command: fixture.oracles.repaired.command,
        expected: fixture.oracles.repaired.expect,
        dependencyVersion: 'new',
        prepareConsumer: (dir) => applyRepair(dir, repairableCommits, captureBuilder),
      }),
    );
  }

  const repairCapture = repairAttempted ? await captureBuilder.finalize() : EMPTY_REPAIR_CAPTURE;
  const repairedStage = oracleStages.find((s) => s.stage === 'repaired');
  const repairOutcome: EvalPrediction['repairOutcome'] = !repairAttempted
    ? 'not-attempted'
    : repairedStage?.observed === 'pass'
      ? 'passed'
      : 'failed';

  const verdict: DriftVerdict = impactSites.length > 0 ? 'locally-affected' : 'no-incompatible-change-in-checked-surfaces';

  return {
    fixtureId: fixture.id,
    adapter: 'drift-component-localize-repair',
    // Both supported scenarios are, at the ground-truth level, a rename — see
    // eval/review-prompts and each fixture's adjudication.yml. `scenarioLabel`
    // itself is not used here so this stays comparable to ground truth's
    // finding ids regardless of which mechanical tier applies the fix.
    upstreamFindings: evidence.flatMap((record) => record.findings ?? []).map((f) => `${fixture.dependency}:${f.symbol}:renamed-export`),
    impactSites: [...new Set(plan.impactSites.map((site) => `${site.file}:${site.matchedSymbol}`))],
    taxonomy: plan.breakingChanges[0]?.taxonomy
      ? {
          nature: plan.breakingChanges[0].taxonomy.nature,
          detectability: plan.breakingChanges[0].taxonomy.detectability,
          scope: plan.breakingChanges[0].taxonomy.scope,
          visibility: plan.breakingChanges[0].taxonomy.visibility,
        }
      : undefined,
    gaps: plan.gaps.map((gap) => gap.reason),
    planNodes: plan.commits.map((commit) => commit.id),
    verdict,
    repairAction: repairAttempted ? 'repair-attempted' : 'abstained',
    repairOutcome,
    repairChangedFiles: repairCapture.changedFiles,
    repairScopeEscapeFiles: repairCapture.productionScopeEscapeFiles,
    repairGoldPatchExact: 'not-applicable',
    oracleStages,
    costUsd: 0,
    latencyMs: Date.now() - started,
  };
}

function knownChange(
  fixture: EvalFixture,
  oldExports: readonly string[],
  newExports: readonly string[],
): { breakingChange: BreakingChange; evidence: Evidence[]; fixPlan?: FixPlan } {
  const evidenceId = stableId('evidence-eval', fixture.id, fixture.dependency);
  const base = {
    id: stableId('bc-eval', fixture.id, fixture.dependency),
    dependency: fixture.dependency,
    confidence: 'high' as const,
    citations: [evidenceId],
  };

  const removed = oldExports.find((name) => !newExports.includes(name)) ?? oldExports[0] ?? 'oldName';
  const added = newExports.find((name) => !oldExports.includes(name)) ?? newExports[0] ?? 'newName';

  if (fixture.scenarioLabel === 'member-rename') {
    return {
      breakingChange: {
        ...base,
        kind: 'signature-change',
        summary: `${fixture.dependency} renamed member ${removed} to ${added}.`,
        remediation: `Rename ${removed} member calls to ${added}.`,
        symbols: [removed],
        replacementSymbols: [added],
      },
      evidence: [
        {
          id: evidenceId,
          source: 'migration-guide',
          dependency: fixture.dependency,
          locator: 'fixture.yml',
          title: `${fixture.dependency} fixture migration guide`,
          content: `The ${removed} member was renamed to ${added}.`,
          findings: [{ code: 'member-renamed', symbol: removed, detail: `renamed member ${removed} to ${added}`, after: added }],
          weight: 1,
        },
      ],
      fixPlan: {
        schemaVersion: 2,
        id: stableId('fixplan-eval', fixture.id, fixture.dependency),
        breakingChangeId: base.id,
        dependency: fixture.dependency,
        fromVersion: fixture.fromVersion,
        toVersion: fixture.toVersion,
        changeKind: 'signature-change',
        migration: `Rename ${removed} member calls to ${added}.`,
        rationale: `The fixture migration guide states that ${removed} was renamed to ${added}.`,
        ops: [{ kind: 'rename-member', from: removed, to: added }],
        citations: [evidenceId],
        provenance: { author: 'user', authoredAt: new Date(0).toISOString() },
      },
    };
  }

  // Default: renamed-export, handled by the built-in codemod directly.
  return {
    breakingChange: {
      ...base,
      kind: 'renamed-export',
      summary: `${fixture.dependency} renamed ${removed} to ${added}.`,
      remediation: `Rename ${removed} imports and call sites to ${added}.`,
      symbols: [removed],
      replacementSymbols: [added],
    },
    evidence: [
      {
        id: evidenceId,
        source: 'type-surface-diff',
        dependency: fixture.dependency,
        title: `${fixture.dependency} fixture export diff`,
        content: `${removed} was renamed to ${added}.`,
        findings: [{ code: 'export-renamed', symbol: removed, detail: `renamed export ${removed} to ${added}`, after: added }],
        weight: 1,
      },
    ],
  };
}

async function applyRepair(consumerDir: string, commits: readonly CommitUnit[], capture: RepairCaptureBuilder): Promise<void> {
  for (const commit of commits) {
    const before = new Map(
      await Promise.all(commit.allowedFiles.map(async (path) => [path, await readFile(join(consumerDir, path), 'utf8')] as const)),
    );
    const result = commit.codemod ? applyBuiltinCodemod(commit, before) : applyCommitFixPlan(commit, before);
    capture.recordCommit(commit.allowedFiles, before, result.edits);
    for (const edit of result.edits) {
      await writeFile(join(consumerDir, edit.path), edit.content, 'utf8');
    }
  }
}

function extractJsExportNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  for (const match of source.matchAll(/\bexport\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  return [...names];
}
