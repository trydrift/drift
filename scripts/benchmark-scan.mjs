#!/usr/bin/env node
/**
 * One scan, measured, in a process of its own.
 *
 * Run by `benchmark.mjs`. Everything it needs arrives in the environment so the
 * child has no argument parsing of its own, and the only thing on stdout is a
 * single JSON object on the last line — the parent reads that and ignores the
 * rest, which leaves Drift's own progress output free to go to stderr.
 *
 * The scan is configured exactly as the capture harness configures it (the
 * CLI's own breadth defaults, a pinned concurrency) so a benchmark number and a
 * recording are measurements of the same work.
 */

import { resourceUsage } from 'node:process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const root = process.env.DRIFT_BENCH_ROOT;
/**
 * Which build to measure.
 *
 * A/B-ing two commits of the engine by rebuilding between runs makes the
 * comparison hostage to whatever the network was doing an hour apart. Pointing
 * two child processes at two `dist` directories in the same minute does not.
 */
const dist = process.env.DRIFT_BENCH_DIST ?? join(repoRoot, 'dist');

const { scanUpgrades } = await import(join(dist, 'upgrade/scan.js'));
const { DriftConfigSchema } = await import(join(dist, 'config/schema.js'));
const { createLogger } = await import(join(dist, 'util/logger.js'));
const { configureHttpDiskCache } = await import(join(dist, 'util/http.js'));

configureHttpDiskCache(process.env.DRIFT_BENCH_CACHE);

const config = DriftConfigSchema.parse({});
const logger = createLogger('error');

let outdated = 0;
const started = Date.now();
const result = await scanUpgrades({
  root,
  repo: { owner: 'bench', repo: 'bench', baseBranch: 'main', beforeSha: 'HEAD', afterSha: 'HEAD', workspace: root },
  config,
  logger,
  ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
  // The capture harness's own breadth and concurrency, so the two agree.
  breadth: { includeDev: false, maxSites: 40, maxPackages: 0 },
  concurrency: 8,
  onOutdated: (summary) => {
    outdated = summary.outdated.length;
  },
}).catch((err) => ({ error: String(err?.message ?? err), candidates: [], checked: 0 }));

const usage = resourceUsage();

/**
 * A fingerprint of the semantic answer, not of the whole object.
 *
 * The point of a benchmark run is to prove an optimisation changed the timing
 * and nothing else, and the whole `UpgradeCandidate` is full of fields that
 * legitimately differ between runs (durations, ordering inside best-effort
 * evidence). These are the fields a change in behaviour would have to move.
 */
const fingerprint = (result.candidates ?? [])
  .map((c) => ({
    id: c.id,
    name: c.name,
    ecosystem: c.ecosystem,
    current: c.current,
    selected: c.selected,
    latest: c.latest,
    safeLatest: c.safeLatest ?? null,
    status: c.status,
    risk: c.risk,
    breakingCount: c.breakingCount,
    impactCount: c.impactCount,
    impactFiles: c.impactFiles,
    evidenceCount: c.evidenceCount,
    recommendation: c.recommendation ?? null,
    verification: c.verification?.status ?? null,
    gaps: [...(c.gaps ?? [])].sort(),
    breaking: [...(c.plan?.breakingChanges ?? [])]
      .map((b) => ({ kind: b.kind, summary: b.summary, symbols: [...b.symbols].sort(), confidence: b.confidence }))
      .sort((a, b) => a.summary.localeCompare(b.summary)),
    sites: [...(c.plan?.impactSites ?? [])]
      .map((s) => `${s.file}:${s.line}:${s.matchedSymbol}:${s.confidence}`)
      .sort(),
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

process.stdout.write(
  `\n${JSON.stringify({
    durationMs: Date.now() - started,
    checked: result.checked ?? 0,
    upToDate: result.upToDate ?? 0,
    unchecked: (result.unchecked ?? []).length,
    outdated,
    candidates: (result.candidates ?? []).length,
    manifests: (result.targets ?? []).map((t) => t.manifestPath),
    userCpuMs: Math.round(usage.userCPUTime / 1000),
    systemCpuMs: Math.round(usage.systemCPUTime / 1000),
    maxRssMb: Math.round(usage.maxRSS / 1024),
    ...(result.error ? { error: result.error } : {}),
    fingerprint,
  })}\n`,
);
