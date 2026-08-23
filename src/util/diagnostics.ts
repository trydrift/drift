/**
 * A single always-on, repo-local diagnostic run log.
 *
 * `DRIFT_PROFILE` (see `profile.ts`) is opt-in and detailed — a JSON dump for
 * `scripts/profile-report.mjs`. This is the opposite: on by default, plain
 * text, and written so that handing the file to a human or an AI agent is
 * enough to answer "why did this run take 15 minutes instead of 30 seconds",
 * without anyone having to know a flag exists first.
 *
 * Written to `<repo git dir>/drift/run.log`. Only the most recent *completed*
 * run is kept.
 *
 * Design:
 *  - Attribution is scoped through `AsyncLocalStorage`, not a single mutable
 *    module-level variable. Two operations against two repositories (or two
 *    concurrent packages within one operation, via `Promise.all`) each carry
 *    their own run/parent-span context through every `await`, so neither can
 *    write into the other's report and neither can appear as the other's
 *    child span. See `withRun` and `withSpan`.
 *  - Spans are buffered in memory, not appended to disk one line at a time —
 *    leaving this enabled everywhere must not add meaningful overhead.
 *  - The final report is rendered fully in memory and promoted into place
 *    with a single `rename()`, so a concurrent reader never observes a
 *    half-written file, and a run that finishes cannot be interleaved with
 *    another run's bytes. `run.in-progress` is a filesystem-backed ownership
 *    record with a unique run ID; starting a run and finishing a run both
 *    take the same repository-local lock, so an older process finishing after
 *    a newer process started cannot overwrite the newer report.
 *  - A crash-marker file (`run.in-progress`) is written synchronously when a
 *    run starts, so a hard crash before `finish()` still leaves something
 *    behind describing what was running — but it is never the artifact
 *    handed to anyone; `run.log` is, always.
 *  - Nothing here ever writes a secret to disk. See `redactCommand` /
 *    `sanitizeArgs` below — every piece of text that could plausibly carry a
 *    token (a command summary, an exec argv, an error message) is passed
 *    through redaction before it reaches a span's metadata.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  /\bAuthorization\s*:\s*[^\n]+/gi,
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

/** Redact an arbitrary error into a string safe to write to the log. */
function redactError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
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
  /** Offset from the run's start, on the same monotonic clock as spans. */
  startOffsetMs: number;
  durationMs: number;
  status: number | null;
  cache: 'memory_hit' | 'disk_hit' | 'coalesced_hit' | 'revalidated_304' | 'miss' | 'hit' | 'n/a';
  bytes?: number;
  /** Number of retries actually performed (attempts minus one), not the attempt index of any single try. */
  retries?: number;
  /** Cumulative time spent sleeping between retries, separate from request time itself. */
  backoffMs?: number;
  failure?: string;
}

export interface HttpAttemptRecord {
  host: string;
  method: string;
  path: string;
  /** Offset and duration for actual network I/O, excluding retry backoff sleeps. */
  startOffsetMs: number;
  durationMs: number;
  status: number | null;
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
  /** Path the report was (or will be) written to, or null if logging is unavailable. */
  readonly path: string | null;
  /**
   * Run `fn` with this run active as the ambient diagnostics context for
   * every span/HTTP/exec/cache call made during it — including inside
   * concurrent `Promise.all` work, which each keep their own nested context.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Close the run, render the report, and promote it into place. Safe to call at most once. */
  finish(status: string, meta?: Record<string, unknown>): void;
}

interface Header {
  runId: string;
  command: string;
  mode: string;
  repoRoot: string;
  gitHead: string;
  driftVersion: string;
}

class RunState {
  readonly startedAtMs = Date.now();
  readonly startPerf = performance.now();
  readonly spans: SpanRecord[] = [];
  readonly counters = new Map<string, number>();
  readonly caches = new Map<string, CacheStats>();
  readonly httpRequests: HttpRequestRecord[] = [];
  readonly httpAttempts: HttpAttemptRecord[] = [];
  readonly execCommands: ExecRecord[] = [];
  nextSpanId = 1;
  finished = false;

  constructor(
    readonly header: Header,
    readonly path: string | null,
    readonly gitDir: string,
    readonly owner: RunOwner,
  ) {}

  now(): number {
    return performance.now() - this.startPerf;
  }
}

interface RunFrame {
  state: RunState;
  parentId: number | null;
}

/**
 * Ambient run/parent-span context, propagated through `await` (including
 * concurrent `Promise.all` branches) the way a mutable global never can.
 * This is what makes two overlapping operations — two repos, or two
 * concurrently-analysed packages within one operation — attribute correctly
 * instead of cross-contaminating each other's spans and events.
 */
const als = new AsyncLocalStorage<RunFrame>();

function currentFrame(): RunFrame | undefined {
  return als.getStore();
}

/** Milliseconds since the active run started, or 0 with no active run (mainly for HTTP/exec start offsets). */
export function runElapsedMs(): number {
  return currentFrame()?.state.now() ?? 0;
}

/** True if a run is currently active in this async context (mainly for tests). */
export function hasActiveRun(): boolean {
  return currentFrame() !== undefined;
}

/** Called by `http.ts` for every request; a no-op when no run is active. */
export function recordHttpRequest(rec: HttpRequestRecord): void {
  currentFrame()?.state.httpRequests.push(rec);
}

/** Called by `http.ts` for every actual network attempt; a no-op when no run is active. */
export function recordHttpAttempt(rec: HttpAttemptRecord): void {
  currentFrame()?.state.httpAttempts.push(rec);
}

/** Called by `exec.ts` for every subprocess invocation; a no-op when no run is active. */
export function recordExecCommand(rec: ExecRecord): void {
  currentFrame()?.state.execCommands.push(rec);
}

export type CacheEvent =
  | 'memory_hit'
  | 'disk_hit'
  | 'coalesced_hit'
  | 'revalidated_304'
  | 'miss'
  | 'write';

interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
  memoryHits: number;
  diskHits: number;
  coalescedHits: number;
  revalidated304: number;
}

function emptyCacheStats(): CacheStats {
  return { hits: 0, misses: 0, writes: 0, memoryHits: 0, diskHits: 0, coalescedHits: 0, revalidated304: 0 };
}

/** Called by any cache to report a lookup; a no-op when no run is active. */
export function noteCache(cacheName: string, event: CacheEvent): void;
export function noteCache(cacheName: string, hit: boolean, write?: boolean): void;
export function noteCache(cacheName: string, eventOrHit: CacheEvent | boolean, write = false): void {
  const state = currentFrame()?.state;
  if (!state) return;
  const entry = state.caches.get(cacheName) ?? emptyCacheStats();
  if (typeof eventOrHit === 'boolean') {
    if (eventOrHit) entry.hits += 1;
    else entry.misses += 1;
    if (write) entry.writes += 1;
    state.caches.set(cacheName, entry);
    return;
  }
  if (eventOrHit === 'memory_hit') {
    entry.memoryHits += 1;
    entry.hits += 1;
  } else if (eventOrHit === 'disk_hit') {
    entry.diskHits += 1;
    entry.hits += 1;
  } else if (eventOrHit === 'coalesced_hit') {
    entry.coalescedHits += 1;
    entry.hits += 1;
  } else if (eventOrHit === 'revalidated_304') {
    entry.revalidated304 += 1;
  } else if (eventOrHit === 'miss') {
    entry.misses += 1;
  } else if (eventOrHit === 'write') {
    entry.writes += 1;
  }
  state.caches.set(cacheName, entry);
}

/** Increment a named counter on the active run; a no-op when no run is active. */
export function countWork(name: string, by = 1): void {
  const state = currentFrame()?.state;
  if (!state) return;
  state.counters.set(name, (state.counters.get(name) ?? 0) + by);
}

const NOOP_SPAN: SpanHandle = Object.freeze({ end() {}, fail() {} });

function openSpan(state: RunState, parentId: number | null, name: string, meta?: Record<string, unknown>): SpanRecord {
  const parent = parentId !== null ? state.spans.find((s) => s.id === parentId) : undefined;
  const record: SpanRecord = {
    id: state.nextSpanId++,
    parentId,
    depth: parent ? parent.depth + 1 : 0,
    name,
    startMs: state.now(),
    endMs: null,
    meta: { ...meta },
    status: 'ok',
  };
  state.spans.push(record);
  return record;
}

function closeSpan(record: SpanRecord, state: RunState, outcome: 'ok' | 'error', errorOrMeta?: unknown, meta?: Record<string, unknown>): void {
  if (record.endMs !== null) return; // already closed — a double end()/fail() must not double-count
  record.endMs = state.now();
  if (outcome === 'error') {
    record.status = 'error';
    record.error = redactError(errorOrMeta);
    Object.assign(record.meta, meta);
  } else {
    Object.assign(record.meta, errorOrMeta as Record<string, unknown> | undefined);
  }
}

/**
 * Start a (possibly nested) timed span in the current ambient context, or a
 * no-op handle with no active run. This does *not* itself become the ambient
 * parent for further spans — only `withSpan` does that, deliberately: a
 * bare `startSpan`/`end()` pair is for a leaf measurement (one HTTP request,
 * one subprocess) that has no children of its own to attribute, so there is
 * no shared mutable "current span stack" anywhere in this module for
 * concurrent work to corrupt.
 */
export function startSpan(name: string, meta?: Record<string, unknown>): SpanHandle {
  const frame = currentFrame();
  if (!frame) return NOOP_SPAN;
  const { state } = frame;
  const record = openSpan(state, frame.parentId, name, meta);
  let closed = false;
  return {
    end(extra) {
      if (closed) return;
      closed = true;
      closeSpan(record, state, 'ok', extra);
    },
    fail(error, extra) {
      if (closed) return;
      closed = true;
      closeSpan(record, state, 'error', error, extra);
    },
  };
}

/**
 * Run `fn` as a named span, with `fn`'s own body seeing this span as its
 * ambient parent — this is the nesting-safe primitive. Concurrent callers
 * (e.g. several packages analysed via `Promise.all`) each get their own span
 * and their own child context, because `AsyncLocalStorage` snapshots the
 * frame per async continuation rather than sharing one mutable "current"
 * pointer that a sibling could stomp on mid-flight.
 */
export async function withSpan<T>(
  name: string,
  meta: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const frame = currentFrame();
  if (!frame) return fn();
  const { state } = frame;
  const record = openSpan(state, frame.parentId, name, meta);
  try {
    const result = await als.run({ state, parentId: record.id }, fn);
    closeSpan(record, state, 'ok');
    return result;
  } catch (err) {
    closeSpan(record, state, 'error', err);
    throw err;
  }
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
    '',
  ].join('\n');
}

interface RunOwner {
  runId: string;
  startedAtMs: number;
}

function ownerText(owner: RunOwner, header: Header): string {
  return `${JSON.stringify({ schemaVersion: 1, ...owner })}\n${headerText(header, new Date(owner.startedAtMs).toISOString())}`;
}

function readOwner(path: string): RunOwner | null {
  try {
    const firstLine = readFileSync(path, 'utf8').split('\n')[0] ?? '';
    const parsed = JSON.parse(firstLine) as Partial<RunOwner>;
    if (typeof parsed.runId !== 'string' || typeof parsed.startedAtMs !== 'number') return null;
    return { runId: parsed.runId, startedAtMs: parsed.startedAtMs };
  } catch {
    return null;
  }
}

function sameOwner(a: RunOwner | null, b: RunOwner): boolean {
  return a?.runId === b.runId && a.startedAtMs === b.startedAtMs;
}

function withRunLogLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, 'run.lock');
  const deadline = Date.now() + 5000;
  const sleepArray = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('Timed out waiting for run log lock');
      Atomics.wait(sleepArray, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Start a new run log for `options.repoRoot`. Returns a handle even when the
 * file could not be opened (a read-only checkout, missing permissions) —
 * spans still track in memory so the process behaves identically, they
 * simply never reach disk.
 *
 * Starting a run atomically replaces `run.in-progress` with this run's unique
 * ownership record. Finishing a run promotes its rendered report only while
 * that marker still names the same run, under the same filesystem lock used
 * by starters. That keeps stale reports from overwriting newer runs across
 * separate Node processes.
 */
export function startRunLog(options: StartRunOptions): RunLogHandle {
  const owner: RunOwner = { runId: randomUUID(), startedAtMs: Date.now() };
  const header: Header = {
    runId: owner.runId,
    command: options.command,
    mode: options.mode,
    repoRoot: options.repoRoot,
    gitHead: options.gitHead ?? 'unknown',
    driftVersion: options.driftVersion ?? '0.0.0',
  };

  const gitDir = resolveGitDir(options.repoRoot);

  let dir: string | null = null;
  let path: string | null = null;
  try {
    dir = join(gitDir, 'drift');
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'run.log');
    withRunLogLock(dir, () => {
      const markerTmp = join(dir!, `run.in-progress.${process.pid}.${owner.runId}.tmp`);
      writeFileSync(markerTmp, ownerText(owner, header), 'utf8');
      renameSync(markerTmp, join(dir!, 'run.in-progress'));
    });
  } catch {
    path = null;
  }

  const state = new RunState(header, path, gitDir, owner);

  return {
    path,
    run: (fn) => als.run({ state, parentId: null }, fn),
    finish(status, meta) {
      if (state.finished) return;
      state.finished = true;

      // Anything still open (a throw unwinding through nested spans) is
      // closed as interrupted rather than silently dropped, so the report
      // still reflects where the run actually stopped.
      const now = state.now();
      for (const span of state.spans) {
        if (span.endMs === null) {
          span.endMs = now;
          span.status = 'interrupted';
        }
      }

      if (!state.path || !dir) return;
      try {
        const report = headerText(state.header, new Date(state.startedAtMs).toISOString()) + render(state, status, meta ?? {});
        const tmp = join(dir, `run.log.${process.pid}.${state.owner.runId}.tmp`);
        writeFileSync(tmp, report, 'utf8');
        withRunLogLock(dir, () => {
          const marker = join(dir!, 'run.in-progress');
          if (!sameOwner(readOwner(marker), state.owner)) {
            rmSync(tmp, { force: true });
            return;
          }
          renameSync(tmp, state.path!);
          rmSync(marker, { force: true });
        });
      } catch {
        // A run log is a diagnostic nicety, not something a run should fail
        // over.
      }
    },
  };
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

function stageBreakdown(state: RunState): { name: string; ms: number }[] {
  const topLevel = state.spans.filter((s) => s.parentId === null && s.endMs !== null);
  const byName = new Map<string, number>();
  for (const span of topLevel) byName.set(span.name, (byName.get(span.name) ?? 0) + (span.endMs! - span.startMs));
  return [...byName.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms);
}

function packageBreakdown(state: RunState): { name: string; ms: number }[] {
  const byPackage = new Map<string, { start: number; end: number }[]>();
  for (const span of state.spans) {
    if (span.name !== 'package' || span.endMs === null) continue;
    const name = typeof span.meta.package === 'string' ? span.meta.package : 'unknown';
    const list = byPackage.get(name) ?? [];
    list.push({ start: span.startMs, end: span.endMs });
    byPackage.set(name, list);
  }
  return [...byPackage.entries()].map(([name, intervals]) => ({ name, ms: unionDuration(intervals) })).sort((a, b) => b.ms - a.ms);
}

function unionDuration(intervals: { start: number; end: number }[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let current: { start: number; end: number } | null = null;
  for (const interval of sorted) {
    if (!current) {
      current = { ...interval };
      continue;
    }
    if (interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end);
      continue;
    }
    total += current.end - current.start;
    current = { ...interval };
  }
  if (current) total += current.end - current.start;
  return total;
}

/** Where the same expensive identity (a surface, a lookup) ran more than once. */
function repeatedOperations(state: RunState): { key: string; count: number; ms: number }[] {
  const REPEAT_TRACKED = new Set(['surface.current', 'surface.target', 'registry.lookup', 'evidence', 'api.diff', 'localization']);
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

/** The same subprocess label (e.g. `git ls-files`) invoked more than once in one run. */
function repeatedExecCommands(exec: ExecRecord[]): { label: string; count: number; ms: number }[] {
  const byLabel = new Map<string, { count: number; ms: number }>();
  for (const e of exec) {
    const entry = byLabel.get(e.label) ?? { count: 0, ms: 0 };
    entry.count += 1;
    entry.ms += e.durationMs;
    byLabel.set(e.label, entry);
  }
  return [...byLabel.entries()]
    .filter(([, v]) => v.count > 1)
    .map(([label, v]) => ({ label, count: v.count, ms: v.ms }))
    .sort((a, b) => b.ms - a.ms);
}

/** Peak number of overlapping intervals — a real sweep, not a guess from request count or configured concurrency. */
function maxOverlap(intervals: { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0;
  // Ends sort before starts at an identical timestamp, so two genuinely
  // back-to-back (serial) requests are never counted as overlapping.
  const events: [number, number][] = [];
  for (const { start, end } of intervals) {
    events.push([start, 1]);
    events.push([Math.max(end, start), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
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
  const attempts = state.httpAttempts;
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

  const revalidated = requests.filter((r) => r.cache === 'revalidated_304' || (r.cache === 'hit' && r.status === 304)).length;
  const networkRequired = requests.filter((r) => r.cache === 'miss' || r.cache === 'revalidated_304' || (r.cache === 'hit' && r.status === 304)).length;
  // One retry count per logical request (recorded once, at its final
  // attempt) — never summed per-attempt, which would overcount a
  // twice-retried request as three retries instead of two.
  const retries = requests.reduce((sum, r) => sum + (r.retries ?? 0), 0);
  const backoffMs = requests.reduce((sum, r) => sum + (r.backoffMs ?? 0), 0);
  const cumulativeMs = requests.reduce((sum, r) => sum + r.durationMs, 0);
  const attemptCumulativeMs = attempts.reduce((sum, r) => sum + r.durationMs, 0);
  const maxConcurrentAttempts = maxOverlap(attempts.map((r) => ({ start: r.startOffsetMs, end: r.startOffsetMs + r.durationMs })));

  // The same host+path fetched from the network (not served from cache) more
  // than once in one run — wasted, evidence-backed, no guessing about why.
  const byResource = new Map<string, number>();
  for (const r of requests) {
    if (r.cache !== 'miss') continue;
    const key = `${r.host}${r.path}`;
    byResource.set(key, (byResource.get(key) ?? 0) + 1);
  }
  const repeatedFetches = [...byResource.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);

  const slowest = [...requests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const slowestAttempts = [...attempts].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

  return {
    hosts,
    revalidated,
    networkRequired,
    retries,
    backoffMs,
    cumulativeMs,
    attemptCumulativeMs,
    requestCount: requests.length,
    attemptCount: attempts.length,
    maxConcurrentAttempts,
    repeatedFetches,
    slowest,
    slowestAttempts,
  };
}

function render(state: RunState, status: string, finishMeta: Record<string, unknown>): string {
  const totalMs = state.now();
  const timeline = renderTimeline(state);
  const stages = stageBreakdown(state);
  const packages = packageBreakdown(state);
  const net = networkSummary(state);
  const exec = state.execCommands;
  const execCumulative = exec.reduce((sum, e) => sum + e.durationMs, 0);
  const slowestExec = [...exec].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const execRepeats = repeatedExecCommands(exec);
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
  lines.push(`  logical_requests: ${net.requestCount}`);
  lines.push(`  total_logical_request_time: ${fmtSec(net.cumulativeMs)}`);
  lines.push(`  network_attempts: ${net.attemptCount}`);
  lines.push(`  total_attempt_time: ${fmtSec(net.attemptCumulativeMs)}`);
  lines.push(`  max_concurrent_attempts: ${net.maxConcurrentAttempts}`);
  lines.push(`  revalidated_304: ${net.revalidated}`);
  lines.push(`  network_required_requests: ${net.networkRequired}`);
  lines.push(`  retries: ${net.retries}`);
  lines.push(`  retry_backoff_time: ${fmtSec(net.backoffMs)}`);
  if (net.hosts.length) {
    lines.push('  by host:');
    for (const h of net.hosts) {
      lines.push(
        `    ${h.host.padEnd(28)} requests=${h.count} cumulative=${fmtSec(h.cumulativeMs)} mean=${fmtMs(h.meanMs)} p95=${fmtMs(h.p95Ms)} slowest=${fmtMs(h.slowestMs)}`,
      );
    }
  }
  if (net.slowest.length) {
    lines.push('  slowest logical requests:');
    for (const r of net.slowest) lines.push(`    ${fmtSec(r.durationMs).padStart(8)} ${r.method} ${r.host}${r.path}`);
  }
  if (net.slowestAttempts.length) {
    lines.push('  slowest network attempts:');
    for (const r of net.slowestAttempts) lines.push(`    ${fmtSec(r.durationMs).padStart(8)} ${r.method} ${r.host}${r.path}`);
  }
  if (net.repeatedFetches.length) {
    lines.push('  repeated fetches (same resource, more than once):');
    for (const [resource, count] of net.repeatedFetches.slice(0, 10)) lines.push(`    ${String(count).padStart(2)}x ${resource}`);
  }
  lines.push('');

  lines.push('external processes:');
  lines.push(`  count: ${exec.length}`);
  lines.push(`  cumulative_time: ${fmtSec(execCumulative)}`);
  if (slowestExec.length) {
    lines.push('  slowest:');
    for (const e of slowestExec) lines.push(`    ${fmtSec(e.durationMs).padStart(8)} ${e.label}`);
  }
  if (execRepeats.length) {
    lines.push('  repeated commands:');
    for (const r of execRepeats.slice(0, 10)) {
      lines.push(`    ${r.label.padEnd(28)} ${String(r.count).padStart(2)}x   ${fmtSec(r.ms)} cumulative`);
    }
  }
  lines.push('');

  lines.push('cache:');
  if (state.caches.size === 0) lines.push('  (none recorded)');
  for (const [name, c] of [...state.caches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const categorizedHits = c.memoryHits + c.diskHits + c.coalescedHits;
    const uncategorizedHits = Math.max(0, c.hits - categorizedHits);
    const avoided = categorizedHits + uncategorizedHits;
    const avoidanceDenominator = avoided + c.misses;
    const avoidanceRate = avoidanceDenominator > 0 ? `${((100 * avoided) / avoidanceDenominator).toFixed(1)}%` : 'n/a';
    lines.push(
      `  ${name}: memory_hits=${c.memoryHits} disk_hits=${c.diskHits} coalesced_hits=${c.coalescedHits} uncategorized_hits=${uncategorizedHits} revalidated_304=${c.revalidated304} misses=${c.misses} writes=${c.writes} avoidance_rate=${avoidanceRate}`,
    );
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
// Simple, well-commented threshold heuristics — never an LLM, and never a
// causal claim the recorded numbers don't actually support. Each one states
// only the evidence: a share, a count, a duration — not a diagnosis of why.
// ---------------------------------------------------------------------------

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
/** A single HTTP request over this long is worth naming, independent of the rest of the run. */
const SLOW_HTTP_REQUEST_MS = 3000;
/** Enough network requests that "fully serial" is a meaningful, not coincidental, observation. */
const MIN_REQUESTS_FOR_CONCURRENCY_NOTE = 10;
/** More than this many retries across the run is worth surfacing on its own. */
const HIGH_RETRY_COUNT = 5;

function diagnosticFlags(args: {
  totalMs: number;
  stages: { name: string; ms: number }[];
  packages: { name: string; ms: number }[];
  net: ReturnType<typeof networkSummary>;
  repeats: { key: string; count: number; ms: number }[];
  caches: Map<string, CacheStats>;
  exec: ExecRecord[];
}): string[] {
  const flags: string[] = [];
  const { totalMs, stages, packages, net, repeats, caches, exec } = args;

  const hottest = packages[0];
  if (hottest && totalMs > 0 && hottest.ms / totalMs > HOT_PACKAGE_SHARE) {
    // "Spanned", not "consumed": packages are analysed concurrently, so this
    // is the fraction of wall-clock time this package's own span covered —
    // not a claim that removing it would free up that share of the run.
    flags.push(`HOT_PACKAGE: ${hottest.name} was the slowest package, spanning ${((hottest.ms / totalMs) * 100).toFixed(1)}% of the run's wall-clock time`);
  }

  if (packages.length > 0 && net.requestCount / packages.length > HIGH_REQUESTS_PER_PACKAGE) {
    flags.push(`HIGH_HTTP_REQUEST_COUNT: ${net.requestCount} logical HTTP requests were issued for ${packages.length} packages`);
  }

  for (const r of repeats) {
    if (r.key.startsWith('surface.')) {
      flags.push(`DUPLICATE_SURFACE_WORK: ${r.key} was computed ${r.count} times (${fmtSec(r.ms)} cumulative)`);
    }
  }

  for (const [name, c] of caches) {
    const avoided = c.memoryHits + c.diskHits + c.coalescedHits + Math.max(0, c.hits - c.memoryHits - c.diskHits - c.coalescedHits);
    const total = avoided + c.misses;
    if (total >= 5 && avoided / total < LOW_CACHE_HIT_RATE) {
      flags.push(`LOW_CACHE_HIT_RATE: ${name} cache network avoidance rate was ${((avoided / total) * 100).toFixed(1)}%`);
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

  const slowestRequest = net.slowest[0];
  if (slowestRequest && slowestRequest.durationMs > SLOW_HTTP_REQUEST_MS) {
    flags.push(`SLOW_HTTP_REQUEST: ${slowestRequest.method} ${slowestRequest.host}${slowestRequest.path} took ${fmtSec(slowestRequest.durationMs)}`);
  }

  if (net.attemptCount >= MIN_REQUESTS_FOR_CONCURRENCY_NOTE && net.maxConcurrentAttempts <= 1) {
    flags.push(`LOW_OBSERVED_CONCURRENCY: ${net.attemptCount} HTTP network attempts were made but the maximum observed attempt concurrency was ${net.maxConcurrentAttempts}`);
  }

  if (net.retries > HIGH_RETRY_COUNT) {
    flags.push(`HIGH_RETRY_COUNT: ${net.retries} retries observed across ${net.requestCount} logical requests (${fmtSec(net.backoffMs)} spent backing off)`);
  }

  if (net.repeatedFetches.length > 0) {
    const [resource, count] = net.repeatedFetches[0]!;
    flags.push(`REPEATED_NETWORK_FETCH: ${resource} was fetched from the network ${count} times`);
  }

  return flags;
}
