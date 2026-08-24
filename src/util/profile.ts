/**
 * Where a scan's time actually went.
 *
 * A CPU profile answers "which function burned cycles", and for Drift that is
 * mostly the wrong question: a scan is overwhelmingly *waiting* — on registries,
 * on jsDelivr, on `npm install`, on a typecheck — and none of that waiting shows
 * up in `--cpu-prof` at all. What is needed instead is a record of when each
 * piece of work started and stopped, so a slow run can be attributed rather than
 * guessed at.
 *
 * Two numbers matter for every category of work, and confusing them is the
 * classic way to optimise the wrong thing:
 *
 * - **Cumulative** — the sum of every span's duration. Four HTTP requests taking
 *   ten seconds each is forty seconds cumulative.
 * - **Wall-clock contribution** — the union of those spans' intervals. If the
 *   same four ran concurrently it is ten seconds of the run, not forty. Halving
 *   the cumulative number of something already fully overlapped buys nothing.
 *
 * So spans are recorded as intervals and reduced by union, and `maxConcurrency`
 * falls out of the same reduction — which is what says whether a limit is
 * actually being reached or was set for a bottleneck that no longer exists.
 *
 * `DRIFT_PROFILE` still controls the detailed JSON profile written for
 * `scripts/profile-report.mjs`. The repo-local run diagnostic is different: when
 * one is active, these same spans are mirrored into it even with
 * `DRIFT_PROFILE` unset. That keeps the cheap always-on log causally useful
 * without maintaining a second set of instrumentation around the exact same
 * operations. With neither facility active, every entry point remains a
 * predictable no-op returning a shared frozen handle.
 *
 * Usage:
 *
 *     DRIFT_PROFILE=1 drift outdated            # writes drift-profile.json
 *     DRIFT_PROFILE=/tmp/scan.json drift outdated
 *
 * and `node scripts/profile-report.mjs <file>` renders it.
 */

import { writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import {
  countWork as countDiagnosticWork,
  hasActiveRun,
  startSpan as startDiagnosticSpan,
  type SpanHandle as DiagnosticSpanHandle,
} from './diagnostics.js';

/** One completed unit of work, in milliseconds since the profile began. */
export interface ProfileSpan {
  /** Coarse bucket the report groups by — `http`, `exec`, `phase`, `verify`… */
  cat: string;
  /** What this particular span was, within its category. */
  name: string;
  start: number;
  end: number;
  /** Anything worth keeping that is not timing — a status code, a package name. */
  meta?: Record<string, string | number | boolean>;
}

export interface ProfileHandle {
  /** Close the span. Extra metadata discovered while it ran is merged in. */
  end(meta?: Record<string, string | number | boolean>): void;
}

const NOOP: ProfileHandle = Object.freeze({ end() {} });

const enabledRaw = process.env.DRIFT_PROFILE;
const enabled = Boolean(enabledRaw) && enabledRaw !== '0' && enabledRaw !== 'false';

const spans: ProfileSpan[] = [];
const counters = new Map<string, number>();
const origin = enabled ? Date.now() : 0;
const startedAt = enabled ? performance.now() : 0;

/** Milliseconds since the profile began, at sub-millisecond resolution. */
function now(): number {
  return performance.now() - startedAt;
}

export function profiling(): boolean {
  return enabled;
}

function diagnosticMeta(
  cat: string,
  name: string,
  meta?: Record<string, string | number | boolean>,
): Record<string, unknown> {
  // Several profiler categories use the package name as `name`; preserve that
  // fact explicitly so the run-log summary can attribute a stall to a package
  // without knowing each call site's naming convention.
  const packageNamed = new Set(['surface', 'surface-sources', 'surface-deps', 'evidence']);
  return {
    operation: name,
    ...(packageNamed.has(cat) ? { package: name } : {}),
    ...meta,
  };
}

/**
 * Open a span. The returned handle must be closed exactly once.
 *
 * Prefer {@link measure} where the work is a single awaited expression; this
 * exists for the cases where start and end are genuinely far apart.
 */
export function span(cat: string, name: string, meta?: Record<string, string | number | boolean>): ProfileHandle {
  const diagnosticsEnabled = hasActiveRun();
  if (!enabled && !diagnosticsEnabled) return NOOP;

  const start = enabled ? now() : 0;
  const diagnostic: DiagnosticSpanHandle | null = diagnosticsEnabled
    ? startDiagnosticSpan(`work.${cat}`, diagnosticMeta(cat, name, meta))
    : null;
  let closed = false;

  return {
    end(extra) {
      // A double `end()` would record the same work twice and inflate both the
      // cumulative total and the concurrency estimate. Cheaper to ignore than
      // to make every caller prove it cannot happen.
      if (closed) return;
      closed = true;
      if (enabled) {
        spans.push({ cat, name, start, end: now(), ...(meta || extra ? { meta: { ...meta, ...extra } } : {}) });
      }
      diagnostic?.end(extra);
    },
  };
}

/** Time one awaited expression. Records the span whether it resolves or throws. */
export async function measure<T>(
  cat: string,
  name: string,
  work: () => Promise<T>,
  meta?: Record<string, string | number | boolean>,
): Promise<T> {
  const handle = span(cat, name, meta);
  try {
    return await work();
  } finally {
    handle.end();
  }
}

/** A running total — request counts, cache hits, install invocations. */
export function count(name: string, by = 1): void {
  if (enabled) counters.set(name, (counters.get(name) ?? 0) + by);
  if (hasActiveRun()) countDiagnosticWork(`profile.${name}`, by);
}

export interface ProfileDocument {
  startedAt: string;
  /** Total wall time from the first import of this module to the dump. */
  durationMs: number;
  spans: ProfileSpan[];
  counters: Record<string, number>;
  /** Enough about the machine to compare two runs honestly. */
  machine: {
    platform: string;
    arch: string;
    cpus: number;
    totalMemMb: number;
    node: string;
  };
  /** Peak resident set observed at dump time, in megabytes. */
  peakRssMb: number;
  env: Record<string, string>;
}

let peakRssMb = 0;
if (enabled) {
  // Sampled rather than derived: Node exposes current RSS, never a high-water
  // mark, so a peak that happens mid-scan is invisible unless something looks.
  const timer = setInterval(() => {
    peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage.rss() / (1024 * 1024)));
  }, 250);
  timer.unref();
}

export function profileDocument(): ProfileDocument {
  const tracked = ['DRIFT_CONCURRENCY', 'DRIFT_NETWORK_CONCURRENCY', 'DRIFT_LOCAL_CONCURRENCY'];
  return {
    startedAt: new Date(origin).toISOString(),
    durationMs: Math.round(now()),
    spans,
    counters: Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b))),
    machine: {
      platform: platform(),
      arch: arch(),
      cpus: cpus().length,
      totalMemMb: Math.round(totalmem() / (1024 * 1024)),
      node: process.version,
    },
    peakRssMb: Math.max(peakRssMb, Math.round(process.memoryUsage.rss() / (1024 * 1024))),
    env: Object.fromEntries(tracked.filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
  };
}

/**
 * Write the profile out.
 *
 * Synchronous and registered on `exit` because that is the only hook that still
 * runs when a CLI finishes normally, and an async write there never lands.
 */
export function writeProfile(path?: string): void {
  if (!enabled) return;
  const target = path ?? (enabledRaw && enabledRaw !== '1' ? enabledRaw : 'drift-profile.json');
  try {
    writeFileSync(target, JSON.stringify(profileDocument()), 'utf8');
    process.stderr.write(`\ndrift: profile written to ${target}\n`);
  } catch (err) {
    process.stderr.write(`drift: could not write profile: ${(err as Error).message}\n`);
  }
}

if (enabled) process.on('exit', () => writeProfile());
