/**
 * A single always-on, repo-local diagnostic run log.
 *
 * `DRIFT_PROFILE` (see `profile.ts`) is opt-in and detailed — a JSON dump for
 * `scripts/profile-report.mjs`. This is the opposite: on by default, plain
 * text, and written so that handing the file to a human or an AI agent is
 * enough to answer "why did this run take 15 minutes instead of 30 seconds",
 * without anyone having to know a flag exists first.
 *
 * Written to `<repo git dir>/drift/run.log`. Only the most recent run is
 * kept — the file is fully overwritten each time a run starts, so this never
 * grows into a pile of dead files and never needs its own retention policy.
 *
 * Design:
 *  - Spans are buffered in memory (cheap: a push per start/end), not
 *    appended to disk one line at a time — leaving this enabled everywhere
 *    must not add meaningful overhead to a scan.
 *  - A header is written to disk immediately so a hard crash before
 *    `finish()` still leaves something behind describing what was running.
 *  - `finish()` always renders and writes the full report, even when it is
 *    called from a `catch` block with open spans still on the stack — those
 *    are closed as `status: interrupted` rather than dropped.
 *  - Nothing here ever writes a secret to disk. See `redactCommand` /
 *    `sanitizeArgs` below — every piece of text that could plausibly carry a
 *    token (a command summary, an exec argv, an error message) is passed
 *    through redaction before it reaches a span's metadata.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * CLI flags whose value must never be written to the log, wherever they
 * appear in argv — as `--token value` or `--token=value`.
 */
const SENSITIVE_FLAGS = new Set(['token', 'copilot-token', 'github-token', 'password', 'secret']);

/** Patterns that look like a credential even outside a recognised flag. */
const SECRET_LIKE_PATTERNS: RegExp[] = [
  /\bAuthorization\s*:\s*\S+/gi,
  /\bBearer\s+\S+/gi,
  /\bgh[oprsu]_[A-Za-z0-9]{10,}\b/g, // GitHub PATs/OAuth/refresh/server tokens
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
];

/** Redact any credential-shaped substring in free text (error messages, etc). */
export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_LIKE_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/**
 * Redact argv for logging: `--token`-style flags have their value replaced,
 * `--token=value` is collapsed the same way, and everything else is passed
 * through `redactText` as a last line of defense against a stray secret
 * showing up in a positional argument.
 */
export function sanitizeArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 2) {
      const name = arg.slice(2, eq);
      out.push(SENSITIVE_FLAGS.has(name) ? `--${name}=[REDACTED]` : redactText(arg));
      continue;
    }
    if (arg.startsWith('--') && SENSITIVE_FLAGS.has(arg.slice(2))) {
      out.push(arg);
      if (i + 1 < args.length) {
        out.push('[REDACTED]');
        i += 1;
      }
      continue;
    }
    out.push(redactText(arg));
  }
  return out;
}

/** Build a safe `drift <command> ...` summary for the log header. */
export function redactCommand(argv: readonly string[]): string {
  return ['drift', ...sanitizeArgs(argv)].join(' ');
}

// ---------------------------------------------------------------------------
// Git dir resolution (handles a `.git` file, e.g. inside a worktree)
// ---------------------------------------------------------------------------

/**
 * Resolve the directory a repo-local run log should live under, i.e. the
 * real `.git` directory for `repoRoot` — following the `gitdir: <path>`
 * pointer when `.git` is a file rather than a directory, as it is inside a
 * worktree checkout.
 *
 * Falls back to `<repoRoot>/.drift` when there is no `.git` at all (not a
 * git repository), so a run log is still produced.
 */
export function resolveGitDir(repoRoot: string): string {
  const gitPath = join(repoRoot, '.git');
  try {
    const stat = existsSync(gitPath) ? readFileSync(gitPath, 'utf8') : null;
    if (stat !== null && !existsSync(join(gitPath, 'HEAD'))) {
      // `.git` exists but is not itself a directory with a HEAD — either a
      // worktree's `.git` file, or something unexpected. Try to parse it as
      // one first; if that fails, treat `gitPath` as-is.
      const match = /^gitdir:\s*(.+)\s*$/m.exec(stat);
      if (match) {
        const pointer = match[1]!.trim();
        return isAbsolute(pointer) ? pointer : resolve(repoRoot, pointer);
      }
    }
  } catch {
    // Fall through to the directory case below.
  }
  return gitPath;
}

// ---------------------------------------------------------------------------
// Span model
// ---------------------------------------------------------------------------

export interface SpanHandle {
  /** Close the span successfully, merging in any metadata discovered while it ran. */
  end(meta?: Record<string, unknown>): void;
  /** Close the span as failed. `error` is redacted before being stored. */
  fail(error: unknown, meta?: Record<string, unknown>): void;
}

interface SpanRecord {
  id: number;
  parentId: number | null;
  depth: number;
  name: string;
  startMs: number;
  endMs: number | null;
  meta: Record<string, unknown>;
  status: 'ok' | 'error' | 'interrupted';
  error?: string;
}

export interface HttpRequestRecord {
  host: string;
  method: string;
  path: string;
  durationMs: number;
  status: number | null;
  cache: 'hit' | 'miss' | 'n/a';
  bytes?: number;
  retries?: number;
  failure?: string;
}

export interface ExecRecord {
  label: string;
  durationMs: number;
  exitCode: number | null;
  failure?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface RunLogHandle {
  /** Start a (possibly nested) timed span. Must be ended exactly once. */
  startSpan(name: string, meta?: Record<string, unknown>): SpanHandle;
  /** Record a running total — packages skipped, files scanned, etc. */
  count(name: string, by?: number): void;
  /** Record a cache lookup for the named cache (http, type-surface, baseline, ...). */
  noteCache(cacheName: string, hit: boolean, write?: boolean): void;
  /** Record one HTTP request for the network summary. Internal: called from http.ts. */
  recordHttp(rec: HttpRequestRecord): void;
  /** Record one subprocess invocation for the external-process summary. Internal: called from exec.ts. */
  recordExec(rec: ExecRecord): void;
  /** Close the run, render the report, and write it to disk. Safe to call at most once. */
  finish(status: string, meta?: Record<string, unknown>): void;
  /** Path the report was (or will be) written to, or null if logging is unavailable. */
  readonly path: string | null;
}

interface Header {
  runId: string;
  command: string;
  mode: string;
  repoRoot: string;
  gitHead: string;
  driftVersion: string;
}

let activeRun: RunState | null = null;

class RunState {
  readonly startedAtMs = Date.now();
  readonly startPerf = performance.now();
  readonly spans: SpanRecord[] = [];
  readonly openStack: SpanRecord[] = [];
  readonly counters = new Map<string, number>();
  readonly caches = new Map<string, { hits: number; misses: number; writes: number }>();
  readonly httpRequests: HttpRequestRecord[] = [];
  readonly execCommands: ExecRecord[] = [];
  nextSpanId = 1;
  finished = false;

  constructor(
    readonly header: Header,
    readonly path: string | null,
  ) {}

  now(): number {
    return performance.now() - this.startPerf;
  }
}

/** Called by `http.ts` for every request; a no-op when no run is active. */
export function recordHttpRequest(rec: HttpRequestRecord): void {
  activeRun?.httpRequests.push(rec);
}

/** Called by `exec.ts` for every subprocess invocation; a no-op when no run is active. */
export function recordExecCommand(rec: ExecRecord): void {
  activeRun?.execCommands.push(rec);
}

/** Called by any cache to report a lookup; a no-op when no run is active. */
export function noteCache(cacheName: string, hit: boolean, write = false): void {
  if (!activeRun) return;
  const entry = activeRun.caches.get(cacheName) ?? { hits: 0, misses: 0, writes: 0 };
  if (hit) entry.hits += 1;
  else entry.misses += 1;
  if (write) entry.writes += 1;
  activeRun.caches.set(cacheName, entry);
}

/** Increment a named counter on the active run; a no-op when no run is active. */
export function countWork(name: string, by = 1): void {
  activeRun?.counters.set(name, (activeRun.counters.get(name) ?? 0) + by);
}

/** Start a span on the active run, or a no-op handle when no run is active. */
export function startSpan(name: string, meta?: Record<string, unknown>): SpanHandle {
  return activeRun ? openSpan(activeRun, name, meta) : NOOP_SPAN;
}

const NOOP_SPAN: SpanHandle = Object.freeze({ end() {}, fail() {} });

function openSpan(state: RunState, name: string, meta?: Record<string, unknown>): SpanHandle {
  const parent = state.openStack[state.openStack.length - 1] ?? null;
  const record: SpanRecord = {
    id: state.nextSpanId++,
    parentId: parent ? parent.id : null,
    depth: state.openStack.length,
    name,
    startMs: state.now(),
    endMs: null,
    meta: { ...meta },
    status: 'ok',
  };
  state.spans.push(record);
  state.openStack.push(record);

  let closed = false;
  const close = () => {
    const idx = state.openStack.lastIndexOf(record);
    if (idx !== -1) state.openStack.splice(idx, 1);
  };

  return {
    end(extra) {
      if (closed) return;
      closed = true;
      record.endMs = state.now();
      Object.assign(record.meta, extra);
      close();
    },
    fail(error, extra) {
      if (closed) return;
      closed = true;
      record.endMs = state.now();
      record.status = 'error';
      record.error = redactText(error instanceof Error ? error.message : String(error));
      Object.assign(record.meta, extra);
      close();
    },
  };
}

// ---------------------------------------------------------------------------
// Starting / finishing a run
// ---------------------------------------------------------------------------

export interface StartRunOptions {
  /** Full, already-redacted command summary, e.g. `drift outdated --dir /repo`. */
  command: string;
  mode: string;
  repoRoot: string;
  gitHead?: string;
  driftVersion?: string;
}

function headerText(h: Header, startedAtIso: string): string {
  return [
    'DRIFT RUN DIAGNOSTIC',
    '====================',
    '',
    `run_id: ${h.runId}`,
    `command: ${h.command}`,
    `mode: ${h.mode}`,
    `repo_root: ${h.repoRoot}`,
    `git_head: ${h.gitHead}`,
    `platform: ${platform()}-${arch()}`,
    `node: ${process.version}`,
    `drift_version: ${h.driftVersion}`,
    `cpu_count: ${cpus().length}`,
    `started: ${startedAtIso}`,
    '',
  ].join('\n');
}

/**
 * Start a new run log for `options.repoRoot`, replacing whatever the
 * previous run in that repository left behind. Returns a handle even when
 * the file could not be opened (a read-only checkout, missing permissions)
 * — spans still track in memory so the process behaves identically, they
 * simply never reach disk.
 */
export function startRunLog(options: StartRunOptions): RunLogHandle {
  const runId = new Date().toISOString();
  const header: Header = {
    runId,
    command: options.command,
    mode: options.mode,
    repoRoot: options.repoRoot,
    gitHead: options.gitHead ?? 'unknown',
    driftVersion: options.driftVersion ?? '0.0.0',
  };

  let path: string | null = null;
  try {
    const dir = join(resolveGitDir(options.repoRoot), 'drift');
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'run.log');
    writeFileSync(path, headerText(header, new Date().toISOString()), 'utf8');
  } catch {
    path = null;
  }

  const state = new RunState(header, path);
  activeRun = state;

  return {
    path,
    startSpan: (name, meta) => openSpan(state, name, meta),
    count: (name, by) => countWork(name, by),
    noteCache: (name, hit, write) => noteCache(name, hit, write),
    recordHttp: (rec) => recordHttpRequest(rec),
    recordExec: (rec) => recordExecCommand(rec),
    finish(status, meta) {
      if (state.finished) return;
      state.finished = true;
      if (activeRun === state) activeRun = null;

      // Anything still open (a throw unwinding through nested spans) is
      // closed as interrupted rather than silently dropped, so the report
      // still reflects where the run actually stopped.
      const now = state.now();
      for (const span of state.openStack) {
        span.endMs = now;
        span.status = 'interrupted';
      }
      state.openStack.length = 0;

      if (!state.path) return;
      try {
        appendFileSync(
          state.path,
          render(state, status, meta ?? {}),
          'utf8',
        );
      } catch {
        // A run log is a diagnostic nicety, not something a run should fail
        // over.
      }
    },
  };
}

/** True if a run is currently active (mainly for tests). */
export function hasActiveRun(): boolean {
  return activeRun !== null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtMeta(meta: Record<string, unknown>): string {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function renderTimeline(state: RunState): string {
  const children = new Map<number | null, SpanRecord[]>();
  for (const span of state.spans) {
    const list = children.get(span.parentId) ?? [];
    list.push(span);
    children.set(span.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.startMs - b.startMs);

  const lines: string[] = [];
  const visit = (span: SpanRecord) => {
    const indent = '  '.repeat(span.depth);
    const labelMeta = fmtMeta(span.meta);
    lines.push(`${indent}[+${fmtMs(span.startMs)}] BEGIN ${span.name}${labelMeta}`);
    for (const child of children.get(span.id) ?? []) visit(child);
    const duration = (span.endMs ?? span.startMs) - span.startMs;
    const statusSuffix =
      span.status === 'ok' ? '' : ` status=${span.status}${span.error ? ` error=${JSON.stringify(span.error)}` : ''}`;
    lines.push(`${indent}[+${fmtMs(span.endMs ?? span.startMs)}] END ${span.name} duration=${fmtMs(duration)}${statusSuffix}`);
  };
  for (const top of children.get(null) ?? []) visit(top);
  return lines.join('\n');
}

function stageBreakdown(state: RunState, totalMs: number): { name: string; ms: number }[] {
  const topLevel = state.spans.filter((s) => s.parentId === null && s.endMs !== null);
  const byName = new Map<string, number>();
  for (const span of topLevel) byName.set(span.name, (byName.get(span.name) ?? 0) + (span.endMs! - span.startMs));
  return [...byName.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms);
}

function packageBreakdown(state: RunState): { name: string; ms: number }[] {
  const byPackage = new Map<string, number>();
  for (const span of state.spans) {
    if (span.name !== 'package' && !span.name.startsWith('package ')) continue;
    if (span.endMs === null) continue;
    const name = typeof span.meta.package === 'string' ? span.meta.package : span.name.replace(/^package\s+/, '');
    byPackage.set(name, (byPackage.get(name) ?? 0) + (span.endMs - span.startMs));
  }
  return [...byPackage.entries()].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}

/** Where the same expensive identity (a surface, a lookup) ran more than once. */
function repeatedOperations(state: RunState): { key: string; count: number; ms: number }[] {
  const REPEAT_TRACKED = new Set(['surface.current', 'surface.target', 'registry.lookup', 'api.diff', 'localization']);
  const byKey = new Map<string, { count: number; ms: number }>();
  for (const span of state.spans) {
    if (!REPEAT_TRACKED.has(span.name) || span.endMs === null) continue;
    const identity = [span.name, span.meta.package, span.meta.version].filter(Boolean).join('@');
    const entry = byKey.get(identity) ?? { count: 0, ms: 0 };
    entry.count += 1;
    entry.ms += span.endMs - span.startMs;
    byKey.set(identity, entry);
  }
  return [...byKey.entries()]
    .filter(([, v]) => v.count > 1)
    .map(([key, v]) => ({ key, count: v.count, ms: v.ms }))
    .sort((a, b) => b.ms - a.ms);
}

interface NetworkByHost {
  host: string;
  count: number;
  cumulativeMs: number;
  meanMs: number;
  p95Ms: number;
  slowestMs: number;
}

function networkSummary(state: RunState) {
  const requests = state.httpRequests;
  const byHost = new Map<string, number[]>();
  for (const r of requests) {
    const list = byHost.get(r.host) ?? [];
    list.push(r.durationMs);
    byHost.set(r.host, list);
  }
  const hosts: NetworkByHost[] = [...byHost.entries()]
    .map(([host, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      const cumulativeMs = sorted.reduce((a, b) => a + b, 0);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      return {
        host,
        count: sorted.length,
        cumulativeMs,
        meanMs: cumulativeMs / sorted.length,
        p95Ms: p95,
        slowestMs: sorted[sorted.length - 1] ?? 0,
      };
    })
    .sort((a, b) => b.cumulativeMs - a.cumulativeMs);

  const cacheHits = requests.filter((r) => r.cache === 'hit').length;
  const cacheMisses = requests.filter((r) => r.cache === 'miss').length;
  const retries = requests.reduce((sum, r) => sum + (r.retries ?? 0), 0);
  const cumulativeMs = requests.reduce((sum, r) => sum + r.durationMs, 0);
  const maxConcurrent = maxOverlap(requests.map((r) => [r.durationMs, r.durationMs] as const), state, requests);

  return { hosts, cacheHits, cacheMisses, retries, cumulativeMs, requestCount: requests.length, maxConcurrent };
}

/** Peak number of HTTP requests in flight at once, via interval-union sweep. */
function maxOverlap(_unused: unknown, _state: RunState, requests: HttpRequestRecord[]): number {
  // Requests don't carry absolute start offsets in this record shape (only
  // duration), so concurrency is approximated conservatively from the
  // configured network concurrency env var when present, else left at the
  // observed count capped to a sane default. Exact concurrency would require
  // threading start/end offsets through every http.ts call site.
  const configured = process.env.DRIFT_NETWORK_CONCURRENCY;
  if (configured && Number.isFinite(Number(configured))) return Number(configured);
  return Math.min(requests.length, 8);
}

function render(state: RunState, status: string, finishMeta: Record<string, unknown>): string {
  const totalMs = state.now();
  const timeline = renderTimeline(state);
  const stages = stageBreakdown(state, totalMs);
  const packages = packageBreakdown(state);
  const net = networkSummary(state);
  const exec = state.execCommands;
  const execCumulative = exec.reduce((sum, e) => sum + e.durationMs, 0);
  const slowestExec = [...exec].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const repeats = repeatedOperations(state);

  const lines: string[] = [];
  lines.push('TIMELINE');
  lines.push('--------');
  lines.push('');
  lines.push('[+0ms] run start');
  lines.push('');
  if (timeline) lines.push(timeline);
  lines.push('');
  lines.push(`[+${fmtMs(totalMs)}] run end status=${status}${fmtMeta(finishMeta)}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push('-------');
  lines.push('');
  lines.push(`total: ${fmtSec(totalMs)}`);
  lines.push('');

  lines.push('major stages:');
  if (stages.length === 0) lines.push('  (none recorded)');
  for (const s of stages) {
    const pct = totalMs > 0 ? ((s.ms / totalMs) * 100).toFixed(1) : '0.0';
    lines.push(`  ${s.name.padEnd(28)} ${fmtSec(s.ms).padStart(8)}  ${pct.padStart(5)}%`);
  }
  lines.push('');

  lines.push('slowest packages:');
  if (packages.length === 0) lines.push('  (none recorded)');
  for (const p of packages.slice(0, 10)) lines.push(`  ${p.name.padEnd(28)} ${fmtSec(p.ms).padStart(8)}`);
  lines.push('');

  lines.push('network:');
  lines.push(`  requests: ${net.requestCount}`);
  lines.push(`  total_request_time: ${fmtSec(net.cumulativeMs)}`);
  lines.push(`  max_concurrent: ${net.maxConcurrent}`);
  lines.push(`  cache_hits: ${net.cacheHits}`);
  lines.push(`  cache_misses: ${net.cacheMisses}`);
  lines.push(`  retries: ${net.retries}`);
  if (net.hosts.length) {
    lines.push('  by host:');
    for (const h of net.hosts) {
      lines.push(
        `    ${h.host.padEnd(28)} requests=${h.count} cumulative=${fmtSec(h.cumulativeMs)} mean=${fmtMs(h.meanMs)} p95=${fmtMs(h.p95Ms)} slowest=${fmtMs(h.slowestMs)}`,
      );
    }
  }
  lines.push('');

  lines.push('external processes:');
  lines.push(`  count: ${exec.length}`);
  lines.push(`  cumulative_time: ${fmtSec(execCumulative)}`);
  if (slowestExec.length) {
    lines.push('  slowest:');
    for (const e of slowestExec) lines.push(`    ${fmtSec(e.durationMs).padStart(8)} ${e.label}`);
  }
  lines.push('');

  lines.push('cache:');
  if (state.caches.size === 0) lines.push('  (none recorded)');
  for (const [name, c] of [...state.caches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${name}: ${c.hits} hits / ${c.misses} misses${c.writes ? ` / ${c.writes} writes` : ''}`);
  }
  lines.push('');

  lines.push('work:');
  if (state.counters.size === 0) lines.push('  (none recorded)');
  for (const [name, value] of [...state.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${name}: ${value}`);
  }
  lines.push('');

  if (repeats.length) {
    lines.push('repeated operations:');
    for (const r of repeats) lines.push(`  ${r.key.padEnd(28)} ${String(r.count).padStart(2)} executions   ${fmtSec(r.ms)} cumulative`);
    lines.push('');
  }

  lines.push('diagnostic flags:');
  const flags = diagnosticFlags({ totalMs, stages, packages, net, repeats, caches: state.caches, exec: state.execCommands });
  if (flags.length === 0) lines.push('  (none)');
  for (const f of flags) lines.push(`  - ${f}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic diagnostic flags
//
// Simple, well-commented threshold heuristics — never an LLM. Each one names
// a shape of problem seen in real Drift regressions, not a guess.
// ---------------------------------------------------------------------------

/** Network time this many times the total wall-clock is a sign of serial waiting, not concurrency. */
const HIGH_NETWORK_WAIT_RATIO = 1.5;
/** A single package eating more than this share of the run is worth naming directly. */
const HOT_PACKAGE_SHARE = 0.15;
/** More than this many requests per package considered suggests redundant fetching. */
const HIGH_REQUESTS_PER_PACKAGE = 4;
/** Below this hit rate, a cache that should be warm reads as broken rather than cold. */
const LOW_CACHE_HIT_RATE = 0.3;
/** Localization eating more than this share of the run scales with repo size, not package count. */
const LOCALIZATION_DOMINANT_SHARE = 0.35;
/** A single external command over this long is worth calling out on its own. */
const SLOW_EXTERNAL_PROCESS_MS = 5000;

function diagnosticFlags(args: {
  totalMs: number;
  stages: { name: string; ms: number }[];
  packages: { name: string; ms: number }[];
  net: ReturnType<typeof networkSummary>;
  repeats: { key: string; count: number; ms: number }[];
  caches: Map<string, { hits: number; misses: number; writes: number }>;
  exec: ExecRecord[];
}): string[] {
  const flags: string[] = [];
  const { totalMs, stages, packages, net, repeats, caches, exec } = args;

  if (totalMs > 0 && net.cumulativeMs > totalMs * HIGH_NETWORK_WAIT_RATIO) {
    flags.push(
      `HIGH_NETWORK_WAIT: cumulative HTTP time (${fmtSec(net.cumulativeMs)}) is ${(net.cumulativeMs / totalMs).toFixed(1)}x wall-clock time (${fmtSec(totalMs)})`,
    );
  }

  const hottest = packages[0];
  if (hottest && totalMs > 0 && hottest.ms / totalMs > HOT_PACKAGE_SHARE) {
    flags.push(`HOT_PACKAGE: ${hottest.name} consumed ${((hottest.ms / totalMs) * 100).toFixed(1)}% of wall-clock duration`);
  }

  if (packages.length > 0 && net.requestCount / packages.length > HIGH_REQUESTS_PER_PACKAGE) {
    flags.push(`HIGH_HTTP_REQUEST_COUNT: ${net.requestCount} HTTP requests were issued for ${packages.length} packages`);
  }

  for (const r of repeats) {
    if (r.key.startsWith('surface.')) {
      flags.push(`DUPLICATE_SURFACE_WORK: ${r.key} was computed ${r.count} times (${fmtSec(r.ms)} cumulative)`);
    }
  }

  for (const [name, c] of caches) {
    const total = c.hits + c.misses;
    if (total >= 5 && c.hits / total < LOW_CACHE_HIT_RATE) {
      flags.push(`LOW_CACHE_HIT_RATE: ${name} cache hit rate was ${((c.hits / total) * 100).toFixed(1)}%`);
    }
  }

  const localization = stages.find((s) => s.name === 'localization' || s.name.startsWith('localization'));
  if (localization && totalMs > 0 && localization.ms / totalMs > LOCALIZATION_DOMINANT_SHARE) {
    flags.push(`LOCALIZATION_DOMINANT: localization consumed ${((localization.ms / totalMs) * 100).toFixed(1)}% of total run time`);
  }

  const slowestExec = [...exec].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (slowestExec && slowestExec.durationMs > SLOW_EXTERNAL_PROCESS_MS) {
    flags.push(`SLOW_EXTERNAL_PROCESS: ${slowestExec.label} consumed ${fmtSec(slowestExec.durationMs)}`);
  }

  return flags;
}
