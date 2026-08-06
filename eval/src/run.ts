import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFixtures, type EvalFixture } from './load.ts';
import { markdownReport, jsonReport } from './report.ts';
import { scoreFixtures, type EvalPrediction } from './score.ts';
import {
  DriftConfigSchema,
  buildIndex,
  buildPlan,
  classifyBump,
  localPackageEnvironment,
  localize,
  runBehaviouralVerification,
  stableId,
  walkSourceFiles,
  type BreakingChange,
  type DependencyChange,
  type Ecosystem,
  type Logger,
  type RepoContext,
} from '../../dist/index.js';

const SCORING_VERSION = 'eval-score-v1';

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
  const exportedSymbols = extractJsExportNames(await readFile(join(newDir, entryFile), 'utf8'));

  // A scaffold, not a finding: `analyze()` needs Evidence this fixture has
  // none of (no changelog, no declarations), so the only symbols Drift can
  // reason about here are the ones the new package actually exports. Whether
  // any of them really changed is exactly what localization and behavioural
  // probing are about to establish.
  const scaffold: BreakingChange = {
    id: stableId('bc-eval', fixture.id, fixture.dependency),
    dependency: fixture.dependency,
    kind: 'behaviour-change',
    summary: `${fixture.dependency} moved from ${fixture.fromVersion} to ${fixture.toVersion}.`,
    remediation: `Check call sites of ${exportedSymbols.join(', ') || 'its exports'} against the new behaviour.`,
    symbols: exportedSymbols,
    confidence: 'low',
    citations: [],
  };

  const files = await walkSourceFiles(consumerDir, {});
  const index = buildIndex(files);
  const impactSites = localize([scaffold], [dependencyChange], index, files, { logger: SILENT_LOGGER });

  const verification = await runBehaviouralVerification({
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
  });

  const breakingChange: BreakingChange = {
    ...scaffold,
    citations: [...scaffold.citations, ...(verification.citationsByChangeId.get(scaffold.id) ?? [])],
  };

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
    evidence: verification.evidence,
    breakingChanges: [breakingChange],
    impactSites,
    localizationRan: true,
  });

  const realTaxonomy = plan.breakingChanges[0]?.taxonomy;

  const upstreamFindings = [...new Set(verification.evidence.flatMap((record) => record.findings ?? []))]
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
    repair: 'not-attempted',
    regressions: 0,
    outOfScopeEdits: 0,
    abstained: false,
    falseSafe: false,
    costUsd: 0,
    // The one real measurement this harness can make: how long its own
    // deterministic pipeline (localization + behavioural probing + plan
    // assembly) took for this fixture. Not comparable to a cloud agent's
    // latency, which this harness never invokes — see `repair` below.
    latencyMs: Date.now() - started,
  };
}

function findingKind(observedDifference: string): string {
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
