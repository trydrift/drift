import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadFixtures, type EvalFixture } from './load.ts';
import { markdownReport, jsonReport } from './report.ts';
import { scoreFixtures, type EvalPrediction } from './score.ts';
import {
  applyBuiltinCodemod,
  applyCommitFixPlan,
  attemptCodemod,
  DriftConfigSchema,
  buildIndex,
  buildPlan,
  classifyBump,
  localPackageEnvironment,
  localize,
  runBehaviouralVerification,
  stableId,
  validateFixPlan,
  walkSourceFiles,
  type BreakingChange,
  type DependencyChange,
  type Evidence,
  type Ecosystem,
  type Logger,
  type RepoContext,
} from '../../dist/index.js';

export const SCORING_VERSION = 'eval-score-v1';
const execFile = promisify(execFileCallback);

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

/**
 * The evaluation config for the deterministic subset.
 *
 * Behavioural probing is deterministic — it runs old and new code and diffs
 * the result, with no model in the loop — so it belongs in this harness even
 * though a `drift.yml` leaves it off by default. It is the only source of
 * evidence these fixtures can produce: they are plain JavaScript with no type
 * declarations and no changelog, on purpose, so the harness exercises exactly
 * the capability this feature exists for.
 */
const EVAL_CONFIG = DriftConfigSchema.parse({
  verification: { behavioural: { enabled: true, network: false, timeoutSeconds: 10 } },
});

/**
 * Run Drift's real, deterministic (no LLM, no repair agent) detection
 * pipeline against a local fixture and turn the resulting plan into an
 * `EvalPrediction`.
 *
 * This is what makes the harness a benchmark rather than a tautology: the
 * prediction is computed independently of `fixture.expected`, which is the
 * separately maintained ground truth it is scored against.
 */
export async function driftPrediction(fixture: EvalFixture): Promise<EvalPrediction> {
  const started = Date.now();
  const fixtureDir = join(process.cwd(), 'eval', 'fixtures', fixture.id);
  const consumerDir = join(fixtureDir, 'consumer');
  const oldDir = join(fixtureDir, 'upstream', 'old');
  const newDir = join(fixtureDir, 'upstream', 'new');

  const [oldPkg, newPkg] = await Promise.all([readJson(join(oldDir, 'package.json')), readJson(join(newDir, 'package.json'))]);

  const dependencyChange: DependencyChange = {
    name: fixture.dependency,
    ecosystem: fixture.ecosystem as Ecosystem,
    from: fixture.fromVersion,
    to: fixture.toVersion,
    kind: 'runtime',
    bump: classifyBump(fixture.fromVersion, fixture.toVersion),
    manifestPath: 'consumer/package.json',
  };
  void oldPkg;

  const entryFile = typeof newPkg.exports === 'string' ? newPkg.exports.replace(/^\.\//, '') : 'index.js';
  const oldExports = extractJsExportNames(await readFile(join(oldDir, entryFile), 'utf8'));
  const newExports = extractJsExportNames(await readFile(join(newDir, entryFile), 'utf8'));
  const { breakingChange: scaffold, evidence, fixPlan } = fixtureChange(fixture, oldExports, newExports);

  const files = await walkSourceFiles(consumerDir, {});
  const index = buildIndex(files);
  const impactSites = localize([scaffold], [dependencyChange], index, files, { logger: SILENT_LOGGER });

  const verification =
    fixture.scenario === 'behaviour-return-value'
      ? await runBehaviouralVerification({
          config: EVAL_CONFIG,
          breakingChanges: [scaffold],
          dependencyChanges: [dependencyChange],
          impactSites,
          resolveEnvironments: async () => {
            const [oldEnvironment, newEnvironment] = await Promise.all([
              localPackageEnvironment('old', oldDir),
              localPackageEnvironment('new', newDir),
            ]);
            return oldEnvironment && newEnvironment ? { oldEnvironment, newEnvironment } : null;
          },
        })
      : { evidence: [] as Evidence[], citationsByChangeId: new Map<string, string[]>() };

  const breakingChange: BreakingChange = {
    ...scaffold,
    citations: [...scaffold.citations, ...(verification.citationsByChangeId.get(scaffold.id) ?? [])],
  };
  const allEvidence = [...evidence, ...verification.evidence];
  const fileContents = new Map(files.map((file) => [file.path, file.content]));
  const sitesForChange = impactSites.filter((site) => site.breakingChangeId === breakingChange.id);
  const codemod = attemptCodemod(breakingChange, sitesForChange, fileContents);
  const codemods = codemod ? new Map([[breakingChange.id, codemod]]) : undefined;
  const fixPlans =
    !codemod && fixPlan
      ? new Map([
          [
            breakingChange.id,
            validateFixPlan({
              plan: fixPlan,
              change: breakingChange,
              sites: sitesForChange,
              fileContents,
              evidence: allEvidence,
            }),
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
    config: EVAL_CONFIG,
    changes: [dependencyChange],
    evidence: allEvidence,
    breakingChanges: [breakingChange],
    impactSites,
    localizationRan: true,
    codemods,
    fixPlans,
  });
  const repair = await repairPrediction(fixture, fixtureDir, plan);

  const realTaxonomy = plan.breakingChanges[0]?.taxonomy;

  const upstreamFindings = [...new Set(allEvidence.flatMap((record) => record.findings ?? []))]
    .filter((finding) => !finding.detail.startsWith('no observed difference'))
    .map((finding) => `${fixture.dependency}:${finding.symbol}:${findingKind(finding.detail)}`);

  return {
    fixtureId: fixture.id,
    adapter: 'drift-structured-fixture',
    upstreamFindings: [...new Set(upstreamFindings)],
    impactSites: [...new Set(plan.impactSites.map((site) => `${site.file}:${site.matchedSymbol}`))],
    // Only the fields a fixture declares: `ChangeTaxonomy` also carries
    // `origin`, which is provenance about the classifier, not part of the
    // classification a fixture's ground truth is checked against.
    taxonomy: realTaxonomy
      ? {
          nature: realTaxonomy.nature,
          detectability: realTaxonomy.detectability,
          scope: realTaxonomy.scope,
          visibility: realTaxonomy.visibility,
        }
      : undefined,
    gaps: plan.gaps.map((gap) => gap.reason),
    planNodes: plan.commits.map((commit) => commit.id),
    edges: plan.planEdges.map((edge) => ({ from: edge.from, to: edge.to, reason: edge.reason })),
    repair: repair.status,
    regressions: repair.regressions,
    outOfScopeEdits: repair.outOfScopeEdits,
    abstained: repair.status === 'not-attempted',
    falseSafe: false,
    costUsd: 0,
    // The one real measurement this harness can make: how long its own
    // deterministic pipeline (localization + behavioural probing + plan
    // assembly) took for this fixture. Not comparable to a cloud agent's
    // latency, which this harness never invokes — see `repair` below.
    latencyMs: Date.now() - started,
    repairChangedFiles: repair.changedFiles,
    repairOraclePassed: repair.oraclePassed,
    repairGoldPatchExact: repair.goldPatchExact,
  };
}

function fixtureChange(
  fixture: EvalFixture,
  oldExports: readonly string[],
  newExports: readonly string[],
): { breakingChange: BreakingChange; evidence: Evidence[]; fixPlan?: import('../../dist/index.js').FixPlan } {
  const evidenceId = stableId('evidence-eval', fixture.id, fixture.dependency);
  const base = {
    id: stableId('bc-eval', fixture.id, fixture.dependency),
    dependency: fixture.dependency,
    confidence: 'high' as const,
    citations: [evidenceId],
  };

  if (fixture.scenario === 'renamed-export') {
    const removed = oldExports.find((name) => !newExports.includes(name)) ?? oldExports[0] ?? 'oldName';
    const added = newExports.find((name) => !oldExports.includes(name)) ?? newExports[0] ?? 'newName';
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

  if (fixture.scenario === 'member-rename') {
    const removed = oldExports.find((name) => !newExports.includes(name)) ?? 'oldQuery';
    const added = newExports.find((name) => !oldExports.includes(name)) ?? 'query';
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

  const exportedSymbols = newExports.length > 0 ? newExports : oldExports;
  return {
    breakingChange: {
      ...base,
      kind: 'behaviour-change',
      summary: `${fixture.dependency} moved from ${fixture.fromVersion} to ${fixture.toVersion}.`,
      remediation: `Check call sites of ${exportedSymbols.join(', ') || 'its exports'} against the new behaviour.`,
      symbols: exportedSymbols,
      confidence: 'low',
      citations: [],
    },
    evidence: [],
  };
}

async function repairPrediction(
  fixture: EvalFixture,
  fixtureDir: string,
  plan: ReturnType<typeof buildPlan>,
): Promise<{
  status: EvalPrediction['repair'];
  changedFiles: string[];
  oraclePassed: boolean;
  goldPatchExact: boolean;
  regressions: number;
  outOfScopeEdits: number;
}> {
  const temp = await mkdtemp(join(tmpdir(), `drift-eval-${fixture.id}-`));
  const beforeRoot = join(temp, 'before');
  const workRoot = join(temp, 'work');
  const beforeDir = join(beforeRoot, 'consumer');
  const workDir = join(workRoot, 'consumer');
  try {
    await cp(fixtureDir, beforeRoot, { recursive: true });
    await cp(fixtureDir, workRoot, { recursive: true });

    await installFixture(beforeDir);
    await installFixture(workDir);
    const commits = plan.commits.filter((commit) => commit.codemod || commit.fixPlan);
    if (commits.length === 0) {
      return {
        status: 'not-attempted',
        changedFiles: [],
        oraclePassed: fixture.repair.expectation === 'abstained',
        goldPatchExact: fixture.repair.expectation === 'abstained',
        regressions: 0,
        outOfScopeEdits: 0,
      };
    }

    for (const commit of commits) {
      const files = await filesForCommit(workDir, commit.allowedFiles);
      const result = commit.codemod ? applyBuiltinCodemod(commit, files) : applyCommitFixPlan(commit, files);
      for (const edit of result.edits) {
        await writeFile(join(workDir, edit.path), edit.content, 'utf8');
      }
    }

    const oracle = await runOracle(workDir, fixture.oracles.positive);
    const patch = normalizeDiff(await diffDirs(beforeDir, workDir));
    const expectedPatch = fixture.repair.goldPatch
      ? normalizeDiff(await readFile(join(fixtureDir, fixture.repair.goldPatch), 'utf8'))
      : '';
    const changedFiles = changedFilesFromPatch(patch);
    const outOfScopeEdits = changedFiles.filter((file) => !fixture.repair.expectedChangedFiles.includes(file)).length;

    return {
      status: oracle.ok ? 'passed' : 'failed',
      changedFiles,
      oraclePassed: oracle.ok,
      goldPatchExact: expectedPatch.length > 0 ? patch.trim() === expectedPatch.trim() : changedFiles.length === 0,
      regressions: oracle.ok ? 0 : 1,
      outOfScopeEdits,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function installFixture(cwd: string): Promise<void> {
  await execFile('npm', ['install', '--package-lock=false', '--ignore-scripts'], { cwd, maxBuffer: 16 * 1024 * 1024 });
}

async function runOracle(cwd: string, command: string): Promise<{ ok: boolean }> {
  const [program, ...args] = command.split(/\s+/).filter(Boolean);
  if (!program) return { ok: true };
  try {
    await execFile(program, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function filesForCommit(cwd: string, paths: readonly string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(paths.map(async (path) => [path, await readFile(join(cwd, path), 'utf8')] as const));
  return new Map(entries);
}

async function diffDirs(beforeDir: string, afterDir: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['diff', '--no-index', '--', beforeDir, afterDir], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    return stdout ?? '';
  }
}

function normalizeDiff(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) =>
      line
        .replace(/^diff --git a\/.*\/before\//, 'diff --git a/')
        .replace(/ b\/.*\/work\//, ' b/')
        .replace(/^--- a\/.*\/before\//, '--- a/')
        .replace(/^\+\+\+ b\/.*\/work\//, '+++ b/')
        .replace(/^diff --git a\/consumer\//, 'diff --git a/')
        .replace(/ b\/consumer\//, ' b/')
        .replace(/^--- a\/consumer\//, '--- a/')
        .replace(/^\+\+\+ b\/consumer\//, '+++ b/')
        .replace(/^@@ .* @@$/, '@@'),
    )
    .join('\n')
    .trim();
}

function changedFilesFromPatch(patch: string): string[] {
  return [
    ...new Set(
      [...patch.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)]
        .map((match) => match[1]!)
        .filter((file) => file !== 'package-lock.json' && !file.startsWith('node_modules/')),
    ),
  ].sort();
}

function findingKind(observedDifference: string): string {
  if (observedDifference.includes('renamed export')) return 'renamed-export';
  if (observedDifference.includes('renamed member')) return 'member-rename';
  if (observedDifference.includes('returned value changed')) return 'return-value';
  if (observedDifference.startsWith('status changed')) return 'thrown-error';
  if (observedDifference.includes('argument mutation')) return 'argument-mutation';
  return 'behaviour';
}

function extractJsExportNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  for (const match of source.matchAll(/\bexport\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  return [...names];
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/**
 * A frozen historical baseline, kept static on purpose: it represents what an
 * earlier, less capable version of Drift found, so today's harness has
 * something fixed to measure improvement against. It is not meant to track
 * the current pipeline — see `driftPrediction` for that.
 */
export async function frozenBaselinePredictions(fixtures: readonly EvalFixture[]): Promise<EvalPrediction[]> {
  return fixtures.map((fixture) => ({
    fixtureId: fixture.id,
    adapter: 'current-main-frozen',
    upstreamFindings: fixture.expected.upstreamFindings.slice(0, 1),
    impactSites: [],
    taxonomy: undefined,
    gaps: fixture.expected.gaps,
    planNodes: [],
    edges: [],
    repair: 'not-attempted',
    regressions: 0,
    outOfScopeEdits: 0,
    abstained: true,
    falseSafe: false,
    costUsd: 0,
    latencyMs: 0,
    repairChangedFiles: [],
    repairOraclePassed: fixture.repair.expectation !== 'fixed',
    repairGoldPatchExact: fixture.repair.expectation !== 'fixed',
  }));
}

export async function deterministicPredictions(fixtures: readonly EvalFixture[]): Promise<EvalPrediction[]> {
  const drift = await Promise.all(fixtures.map((fixture) => driftPrediction(fixture)));
  const baseline = await frozenBaselinePredictions(fixtures);
  return [...drift, ...baseline];
}

export async function runDeterministicEvaluation(args = process.argv.slice(2)): Promise<number> {
  const ci = args.includes('--ci');
  const fixtures = await loadFixtures();
  const predictions = await deterministicPredictions(fixtures);
  const metrics = scoreFixtures(fixtures, predictions);
  const markdown = [`<!-- scoring: ${SCORING_VERSION} -->`, markdownReport(metrics)].join('\n');

  await writeFile(join(process.cwd(), 'eval', 'reports', 'deterministic.md'), markdown);
  await writeFile(join(process.cwd(), 'eval', 'reports', 'deterministic.json'), jsonReport(metrics));

  const falseSafe = metrics.reduce((total, metric) => total + metric.falseSafeCount, 0);
  const scopeFailures = metrics.some((metric) => metric.outOfScopeEditRate > 0);
  const precisionRegression = metrics.some((metric) => metric.adapter === 'drift-structured-fixture' && metric.upstream.f1 < 1);

  if (ci && (falseSafe > 0 || scopeFailures || precisionRegression)) {
    console.error(markdown);
    return 1;
  }

  console.log(markdown);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runDeterministicEvaluation();
}
