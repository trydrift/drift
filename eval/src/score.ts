import type { EvalFixture } from './load.ts';

export interface EvalPrediction {
  fixtureId: string;
  adapter: string;
  upstreamFindings: string[];
  impactSites: string[];
  taxonomy?: EvalFixture['taxonomy'];
  gaps: string[];
  planNodes: string[];
  edges: { from: string; to: string; reason: string }[];
  repair: 'passed' | 'failed' | 'not-attempted';
  regressions: number;
  outOfScopeEdits: number;
  abstained: boolean;
  falseSafe: boolean;
  costUsd: number;
  latencyMs: number;
}

export interface EvalMetrics {
  adapter: string;
  fixtures: number;
  upstream: Prf;
  impactSites: Prf;
  taxonomyAccuracy: number;
  gapRecall: number;
  planNodeRecall: number;
  edgePrecision: number;
  executableRepairRate: number;
  regressionRate: number;
  outOfScopeEditRate: number;
  abstentionQuality: number;
  costUsd: number;
  latencyMs: number;
  falseSafeCount: number;
  costSensitiveScore: number;
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

export function scoreFixtures(fixtures: readonly EvalFixture[], predictions: readonly EvalPrediction[]): EvalMetrics[] {
  const byAdapter = new Map<string, EvalPrediction[]>();
  for (const prediction of predictions) {
    const list = byAdapter.get(prediction.adapter) ?? [];
    list.push(prediction);
    byAdapter.set(prediction.adapter, list);
  }

  return [...byAdapter.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([adapter, runs]) => {
    const pairs = runs.map((run) => {
      const fixture = fixtures.find((candidate) => candidate.id === run.fixtureId);
      if (!fixture) throw new Error(`Prediction references unknown fixture ${run.fixtureId}.`);
      return { fixture, run };
    });

    const upstream = prf(
      pairs.flatMap(({ fixture }) => fixture.expected.upstreamFindings),
      pairs.flatMap(({ run }) => run.upstreamFindings),
    );
    const impactSites = prf(
      pairs.flatMap(({ fixture }) => fixture.expected.impactSites),
      pairs.flatMap(({ run }) => run.impactSites),
    );
    const edgePrecision = precision(
      pairs.flatMap(({ fixture }) => fixture.expected.edges.map(edgeKey)),
      pairs.flatMap(({ run }) => run.edges.map(edgeKey)),
    );
    const taxonomyCorrect = pairs.filter(({ fixture, run }) => taxonomyEqual(fixture.taxonomy, run.taxonomy)).length;
    const gapRecall = recall(
      pairs.flatMap(({ fixture }) => fixture.expected.gaps),
      pairs.flatMap(({ run }) => run.gaps),
    );
    const planNodeRecall = recall(
      pairs.flatMap(({ fixture }) => fixture.expected.planNodes),
      pairs.flatMap(({ run }) => run.planNodes),
    );
    const repairAttempts = pairs.filter(({ run }) => run.repair !== 'not-attempted');
    const repairsPassed = repairAttempts.filter(({ run }) => run.repair === 'passed').length;
    const regressions = sum(pairs.map(({ run }) => run.regressions));
    const outOfScope = sum(pairs.map(({ run }) => run.outOfScopeEdits));
    const falseSafe = sum(pairs.map(({ run }) => (run.falseSafe ? 1 : 0)));
    const abstentions = pairs.filter(({ run }) => run.abstained);
    const usefulAbstentions = abstentions.filter(({ run }) => run.falseSafe === false && run.repair !== 'passed').length;
    const cost = sum(pairs.map(({ run }) => run.costUsd));
    const latency = sum(pairs.map(({ run }) => run.latencyMs));

    const visibleAverage =
      (upstream.f1 + impactSites.f1 + gapRecall + planNodeRecall + (pairs.length ? taxonomyCorrect / pairs.length : 0)) / 5;

    return {
      adapter,
      fixtures: pairs.length,
      upstream,
      impactSites,
      taxonomyAccuracy: round(pairs.length ? taxonomyCorrect / pairs.length : 0),
      gapRecall: round(gapRecall),
      planNodeRecall: round(planNodeRecall),
      edgePrecision: round(edgePrecision),
      executableRepairRate: round(repairAttempts.length ? repairsPassed / repairAttempts.length : 0),
      regressionRate: round(pairs.length ? regressions / pairs.length : 0),
      outOfScopeEditRate: round(pairs.length ? outOfScope / pairs.length : 0),
      abstentionQuality: round(abstentions.length ? usefulAbstentions / abstentions.length : 1),
      costUsd: round(cost),
      latencyMs: latency,
      falseSafeCount: falseSafe,
      costSensitiveScore: round(Math.max(0, visibleAverage - falseSafe * 0.35 - regressions * 0.15 - outOfScope * 0.2)),
    };
  });
}

export function prf(expected: readonly string[], actual: readonly string[]): Prf {
  const p = precision(expected, actual);
  const r = recall(expected, actual);
  return { precision: round(p), recall: round(r), f1: round(p + r === 0 ? 0 : (2 * p * r) / (p + r)) };
}

function precision(expected: readonly string[], actual: readonly string[]): number {
  if (actual.length === 0) return expected.length === 0 ? 1 : 0;
  const wanted = new Set(expected);
  return actual.filter((item) => wanted.has(item)).length / actual.length;
}

function recall(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) return 1;
  const got = new Set(actual);
  return expected.filter((item) => got.has(item)).length / expected.length;
}

function taxonomyEqual(expected: EvalFixture['taxonomy'], actual: EvalFixture['taxonomy'] | undefined): boolean {
  if (!actual) return false;
  return JSON.stringify(sortTaxonomy(expected)) === JSON.stringify(sortTaxonomy(actual));
}

function sortTaxonomy(taxonomy: EvalFixture['taxonomy']): EvalFixture['taxonomy'] {
  return {
    ...taxonomy,
    detectability: [...taxonomy.detectability].sort(),
    visibility: [...taxonomy.visibility].sort(),
  };
}

function edgeKey(edge: { from: string; to: string; reason: string }): string {
  return `${edge.from}->${edge.to}:${edge.reason}`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
