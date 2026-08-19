import type { EvalMetrics } from './score.ts';

export function markdownReport(metrics: readonly EvalMetrics[]): string {
  const lines = [
    '# Drift Evaluation Report',
    '',
    '| Adapter | Fixtures | Upstream F1 | Impact F1 | Taxonomy | Gap Recall | Plan Recall | Edge Precision | Repair Attempt | Oracle Pass | Gold Patch | Repair Files F1 | Regressions | Out-of-scope | False-safe | Cost | Latency ms | Score |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const metric of metrics) {
    lines.push(
      [
        metric.adapter,
        metric.fixtures,
        metric.upstream.f1.toFixed(3),
        metric.impactSites.f1.toFixed(3),
        metric.taxonomyAccuracy.toFixed(3),
        metric.gapRecall.toFixed(3),
        metric.planNodeRecall.toFixed(3),
        metric.edgePrecision.toFixed(3),
        metric.repairAttemptRate.toFixed(3),
        metric.repairOraclePassRate.toFixed(3),
        metric.repairGoldPatchExactRate.toFixed(3),
        metric.repairChangedFiles.f1.toFixed(3),
        metric.regressionRate.toFixed(3),
        metric.outOfScopeEditRate.toFixed(3),
        metric.falseSafeCount,
        metric.costUsd.toFixed(3),
        metric.latencyMs,
        metric.costSensitiveScore.toFixed(3),
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    );
  }

  lines.push('', 'False-safe count is shown separately and also carries the largest cost-sensitive penalty.');
  return `${lines.join('\n')}\n`;
}

export function jsonReport(metrics: readonly EvalMetrics[]): string {
  return `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date(0).toISOString(), metrics }, null, 2)}\n`;
}
