/**
 * Repo-local diagnostic run logging.
 *
 * Recording policy lives at the CLI/extension boundary and is opt-in by
 * default. This module is the mechanism: once a surface starts a run, it
 * captures enough plain-text timing and attribution data to answer questions
 * such as "why did this run take 15 minutes instead of 30 seconds?".
 * `DRIFT_PROFILE` (see `profile.ts`) remains a separate, more detailed JSON
 * profiler for `scripts/profile-report.mjs`.
 *
 * Typed runs are written as immutable artifacts under `<repo git dir>/drift/`:
 * `run-<type>-<started-at>-<run-id>.log`. Following a worktree's `.git`
 * pointer keeps each linked worktree's history independent.
 *
 * Design:
 *  - Attribution is scoped through `AsyncLocalStorage`, not a single mutable
 *    module-level variable. Concurrent packages and repositories keep their
 *    own run/parent-span context through every `await`.
 *  - Spans are buffered in memory and the final report is promoted into place
 *    with a single rename, so diagnostics do not turn into a stream
 *    of filesystem writes.
 *  - Each typed run owns a unique final path and crash marker, so overlapping
 *    runs never overwrite, suppress, or clean up one another.
 *  - Nothing here writes credentials. Free text and command arguments are
 *    redacted before they reach the report.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SENSITIVE_FLAGS = new Set(['token', 'copilot-token', 'github-token', 'password', 'secret']);

const SECRET_LIKE_PATTERNS: RegExp[] = [
  /\bAuthorization\s*:\s*[^\n]+/gi,
  /\bBearer\s+\S+/gi,
  /\bgh[oprsu]_[A-Za-z0-9]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
];

export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_LIKE_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

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

export function redactCommand(argv: readonly string[]): string {
  return ['drift', ...sanitizeArgs(argv)].join(' ');
}

function redactError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// Git-dir resolution
// ---------------------------------------------------------------------------

export function resolveGitDir(repoRoot: string): string {
  const gitPath = join(repoRoot, '.git');
  try {
    const stat = existsSync(gitPath) ? readFileSync(gitPath, 'utf8') : null;
    if (stat !== null && !existsSync(join(gitPath, 'HEAD'))) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(stat);
      if (match) {
        const pointer = match[1]!.trim();
        return isAbsolute(pointer) ? pointer : resolve(repoRoot, pointer);
      }
    }
  } catch {
    // Fall through to the ordinary repository layout.
  }
  return gitPath;
}

// ---------------------------------------------------------------------------
// Span/event model
// ---------------------------------------------------------------------------

export interface SpanHandle {
  end(meta?: Record<string, unknown>): void;
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
  startOffsetMs: number;
  durationMs: number;
  status: number | null;
  cache: 'memory_hit' | 'disk_hit' | 'coalesced_hit' | 'revalidated_304' | 'miss' | 'hit' | 'n/a';
  bytes?: number;
  retries?: number;
  backoffMs?: number;
  failure?: string;
}

export interface HttpAttemptRecord {
  host: string;
  method: string;
  path: string;
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
  readonly path: string | null;
  run<T>(fn: () => Promise<T>): Promise<T>;
  finish(status: string, meta?: Record<string, unknown>): void;
}

interface Header {
  runId: string;
  command: string;
  type?: string;
  mode: string;
  repoRoot: string;
  gitHead: string;
  driftVersion: string;
}

interface RunOwner {
  runId: string;
  startedAtMs: number;
}

class RunState {
  readonly startedAtMs: number;
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
    readonly markerPath: string | null,
    readonly legacySingleFile: boolean,
  ) {
    this.startedAtMs = owner.startedAtMs;
  }

  now(): number {
    return performance.now() - this.startPerf;
  }
}

interface RunFrame {
  state: RunState;
  parentId: number | null;
}

const als = new AsyncLocalStorage<RunFrame>();

function currentFrame(): RunFrame | undefined {
  return als.getStore();
}

export function runElapsedMs(): number {
  return currentFrame()?.state.now() ?? 0;
}

export function hasActiveRun(): boolean {
  const frame = currentFrame();
  return frame !== undefined && !frame.state.finished;
}

export function recordHttpRequest(rec: HttpRequestRecord): void {
  currentFrame()?.state.httpRequests.push(rec);
}

export function recordHttpAttempt(rec: HttpAttemptRecord): void {
  currentFrame()?.state.httpAttempts.push(rec);
}

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

export function countWork(name: string, by = 1): void {
  const state = currentFrame()?.state;
  if (!state) return;
  state.counters.set(name, (state.counters.get(name) ?? 0) + by);
}

const NOOP_SPAN: SpanHandle = Object.freeze({ end() {}, fail() {} });

function openSpan(
  state: RunState,
  parentId: number | null,
  name: string,
  meta?: Record<string, unknown>,
): SpanRecord {
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

function closeSpan(
  record: SpanRecord,
  state: RunState,
  outcome: 'ok' | 'error',
  errorOrMeta?: unknown,
  meta?: Record<string, unknown>,
): void {
  if (record.endMs !== null) return;
  record.endMs = state.now();
  if (outcome === 'error') {
    record.status = 'error';
    record.error = redactError(errorOrMeta);
    Object.assign(record.meta, meta);
  } else {
    Object.assign(record.meta, errorOrMeta as Record<string, unknown> | undefined);
  }
}

export function startSpan(name: string, meta?: Record<string, unknown>): SpanHandle {
  const frame = currentFrame();
  if (!frame || frame.state.finished) return NOOP_SPAN;
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

export async function withSpan<T>(
  name: string,
  meta: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const frame = currentFrame();
  if (!frame || frame.state.finished) return fn();
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
// Run ownership / lifecycle
// ---------------------------------------------------------------------------

export interface StartRunOptions {
  command: string;
  type?: string;
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
    ...(h.type ? [`type: ${h.type}`] : []),
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

function sanitizeRunType(type: string): string {
  const sanitized = type
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'run';
}

function runTimestamp(startedAtMs: number): string {
  return new Date(startedAtMs).toISOString().replace(/:/g, '-');
}

function inferredRunType(command: string, mode: string): string | null {
  const vscode = /^vscode:\s+drift\.([A-Za-z0-9_-]+)/.exec(command);
  if (vscode) return vscode[1] ?? null;

  const cli = /^drift\s+(analyze|analyse|outdated|fix|pr)\b/.exec(command);
  if (!cli) return null;

  const operation = cli[1] === 'analyse' ? 'analyze' : cli[1]!;
  if (operation === 'outdated') {
    const includeDev = !/(?:^|\s)--no-dev(?:\s|$)/.test(command);
    return `${includeDev ? 'dev' : 'runtime'}-${mode}`;
  }
  return `${operation}-${mode}`;
}

function runArtifactBase(type: string, owner: RunOwner): string {
  return `run-${sanitizeRunType(type)}-${runTimestamp(owner.startedAtMs)}-${owner.runId.slice(0, 8)}`;
}

export function startRunLog(options: StartRunOptions): RunLogHandle {
  const owner: RunOwner = { runId: randomUUID(), startedAtMs: Date.now() };
  const type = options.type ?? inferredRunType(options.command, options.mode) ?? undefined;
  const header: Header = {
    runId: owner.runId,
    command: options.command,
    type: type ? sanitizeRunType(type) : undefined,
    mode: options.mode,
    repoRoot: options.repoRoot,
    gitHead: options.gitHead ?? 'unknown',
    driftVersion: options.driftVersion ?? '0.0.0',
  };

  const gitDir = resolveGitDir(options.repoRoot);
  let dir: string | null = null;
  let path: string | null = null;
  let markerPath: string | null = null;
  const legacySingleFile = !header.type;
  try {
    dir = join(gitDir, 'drift');
    mkdirSync(dir, { recursive: true });

    if (header.type) {
      const base = runArtifactBase(header.type, owner);
      path = join(dir, `${base}.log`);
      markerPath = join(dir, `${base}.in-progress`);
      const markerTmp = `${markerPath}.${process.pid}.tmp`;
      writeFileSync(markerTmp, ownerText(owner, header), 'utf8');
      renameSync(markerTmp, markerPath);
    } else {
      path = join(dir, 'run.log');
      markerPath = join(dir, 'run.in-progress');
      withRunLogLock(dir, () => {
        const markerTmp = join(dir!, `run.in-progress.${process.pid}.${owner.runId}.tmp`);
        writeFileSync(markerTmp, ownerText(owner, header), 'utf8');
        renameSync(markerTmp, markerPath!);
      });
    }
  } catch {
    path = null;
    markerPath = null;
  }

  const state = new RunState(header, path, gitDir, owner, markerPath, legacySingleFile);
  return {
    path,
    run: (fn) => als.run({ state, parentId: null }, fn),
    finish(status, meta) {
      if (state.finished) return;
      state.finished = true;

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

        if (!state.legacySingleFile) {
          const tmp = `${state.path}.${process.pid}.tmp`;
          writeFileSync(tmp, report, 'utf8');
          renameSync(tmp, state.path);
          if (state.markerPath) rmSync(state.markerPath, { force: true });
          return;
        }

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
        // Diagnostics must never fail the operation being diagnosed.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
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

function durationOf(span: SpanRecord): number {
  return span.endMs === null ? 0 : span.endMs - span.startMs;
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
    lines.push(`${indent}[+${fmtMs(span.startMs)}] BEGIN ${span.name}${fmtMeta(span.meta)}`);
    for (const child of children.get(span.id) ?? []) visit(child);
    const statusSuffix =
      span.status === 'ok' ? '' : ` status=${span.status}${span.error ? ` error=${JSON.stringify(span.error)}` : ''}`;
    lines.push(`${indent}[+${fmtMs(span.endMs ?? span.startMs)}] END ${span.name} duration=${fmtMs(durationOf(span))}${statusSuffix}`);
  };
  for (const top of children.get(null) ?? []) visit(top);
  return lines.join('\n');
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

function intervalsFor(spans: readonly SpanRecord[]): { start: number; end: number }[] {
  return spans
    .filter((s): s is SpanRecord & { endMs: number } => s.endMs !== null)
    .map((s) => ({ start: s.startMs, end: s.endMs }));
}

/**
 * Major stages are intentionally selected from inside the command wrapper.
 * The old implementation considered only root spans, so a VS Code run whose
 * root was `dependency.scan` always printed one useless line: 100% scan.
 */
function stageBreakdown(state: RunState): { name: string; ms: number }[] {
  const preferred = ['manifest.discovery', 'version.discovery', 'security.batch', 'analysis', 'verification'];
  const rows = preferred
    .map((name) => ({
      name,
      ms: unionDuration(intervalsFor(state.spans.filter((s) => s.name === name))),
    }))
    .filter((row) => row.ms > 0);
  if (rows.length > 0) return rows.sort((a, b) => b.ms - a.ms);

  const top = state.spans.filter((s) => s.parentId === null && s.endMs !== null);
  const byName = new Map<string, number>();
  for (const span of top) byName.set(span.name, (byName.get(span.name) ?? 0) + durationOf(span));
  return [...byName.entries()].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}

/**
 * A package's critical span begins before its final `package` block. Shared
 * upstream evidence/rationale preparation can be almost the entire run (as in
 * the 27-minute `next` case), so excluding it made the summary name pandas as
 * hottest while next actually held the scan open for 99% of wall time.
 *
 * Union, never sum: rationale preparation and upstream analysis run together,
 * and duplicate workspace rows may overlap too.
 */
function packageBreakdown(state: RunState): { name: string; ms: number }[] {
  const PACKAGE_SPANS = new Set(['upstream.analysis', 'rationale.prepare', 'package']);
  const byPackage = new Map<string, { start: number; end: number }[]>();
  for (const span of state.spans) {
    if (!PACKAGE_SPANS.has(span.name) || span.endMs === null) continue;
    const name = typeof span.meta.package === 'string' ? span.meta.package : null;
    if (!name) continue;
    const list = byPackage.get(name) ?? [];
    list.push({ start: span.startMs, end: span.endMs });
    byPackage.set(name, list);
  }
  return [...byPackage.entries()]
    .map(([name, intervals]) => ({ name, ms: unionDuration(intervals) }))
    .sort((a, b) => b.ms - a.ms);
}

function spanLabel(span: SpanRecord): string {
  const operation = typeof span.meta.operation === 'string' ? span.meta.operation : null;
  const pkg = typeof span.meta.package === 'string' ? span.meta.package : null;
  const path = typeof span.meta.path === 'string' ? span.meta.path : null;
  const qualifiers = [operation && operation !== pkg ? operation : null, pkg, path].filter(Boolean);
  return qualifiers.length ? `${span.name}@${qualifiers.join('@')}` : span.name;
}

function slowWork(state: RunState): SpanRecord[] {
  return state.spans
    .filter((s) => s.name.startsWith('work.') && s.endMs !== null)
    .sort((a, b) => durationOf(b) - durationOf(a))
    .slice(0, 12);
}

interface EventLoopStall {
  atMs: number;
  lagMs: number;
  overlaps: string[];
}

function eventLoopStalls(state: RunState): EventLoopStall[] {
  const lags = state.spans
    .filter((s) => s.name === 'event-loop.lag' && typeof s.meta.lagMs === 'number')
    .map((s) => ({ atMs: s.startMs, lagMs: Number(s.meta.lagMs) }))
    .sort((a, b) => b.lagMs - a.lagMs)
    .slice(0, 10);

  return lags.map(({ atMs, lagMs }) => {
    const from = Math.max(0, atMs - lagMs);
    const overlaps = state.spans
      .filter((s) =>
        s.name !== 'event-loop.lag' &&
        s.endMs !== null &&
        s.startMs <= atMs &&
        s.endMs >= from,
      )
      .sort((a, b) => b.depth - a.depth || durationOf(a) - durationOf(b))
      .map(spanLabel)
      .filter((label, index, all) => all.indexOf(label) === index)
      .slice(0, 8);
    return { atMs, lagMs, overlaps };
  });
}

interface TimeoutOverrun {
  span: SpanRecord;
  timeoutMs: number;
  overrunMs: number;
}

function timeoutOverruns(state: RunState): TimeoutOverrun[] {
  return state.spans
    .filter((s) =>
      (s.name === 'work.http' || s.name === 'work.archive') &&
      s.endMs !== null &&
      typeof s.meta.timeoutMs === 'number' &&
      durationOf(s) > Number(s.meta.timeoutMs) + 100,
    )
    .map((span) => {
      const timeoutMs = Number(span.meta.timeoutMs);
      return { span, timeoutMs, overrunMs: durationOf(span) - timeoutMs };
    })
    .sort((a, b) => b.overrunMs - a.overrunMs)
    .slice(0, 10);
}

function coalescedWaits(state: RunState): SpanRecord[] {
  return state.spans
    .filter((s) => s.name.startsWith('work.http-coalesced-') && s.endMs !== null)
    .sort((a, b) => durationOf(b) - durationOf(a))
    .slice(0, 10);
}

/** Where the same expensive identity ran more than once. */
function repeatedOperations(state: RunState): { key: string; count: number; ms: number }[] {
  const REPEAT_TRACKED = new Set(['surface.current', 'surface.target', 'registry.lookup', 'evidence', 'api.diff', 'localization']);
  const byKey = new Map<string, { count: number; ms: number }>();
  for (const span of state.spans) {
    if (!REPEAT_TRACKED.has(span.name) || span.endMs === null) continue;
    const identity = [span.name, span.meta.package, span.meta.version].filter(Boolean).join('@');
    const entry = byKey.get(identity) ?? { count: 0, ms: 0 };
    entry.count += 1;
    entry.ms += durationOf(span);
    byKey.set(identity, entry);
  }
  return [...byKey.entries()]
    .filter(([, value]) => value.count > 1)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.ms - a.ms);
}

function repeatedExecCommands(exec: ExecRecord[]): { label: string; count: number; ms: number }[] {
  const byLabel = new Map<string, { count: number; ms: number }>();
  for (const entry of exec) {
    const current = byLabel.get(entry.label) ?? { count: 0, ms: 0 };
    current.count += 1;
    current.ms += entry.durationMs;
    byLabel.set(entry.label, current);
  }
  return [...byLabel.entries()]
    .filter(([, value]) => value.count > 1)
    .map(([label, value]) => ({ label, ...value }))
    .sort((a, b) => b.ms - a.ms);
}

function maxOverlap(intervals: { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0;
  const events: [number, number][] = [];
  for (const { start, end } of intervals) {
    events.push([start, 1]);
    events.push([Math.max(end, start), -1]);
  }
  // Ends before starts at equal timestamps: back-to-back attempts are not concurrent.
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
  physicalCount: number;
  cumulativeMs: number;
  physicalMs: number;
  meanMs: number;
  p95Ms: number;
  slowestMs: number;
}

function networkSummary(state: RunState) {
  const requests = state.httpRequests;
  const attempts = state.httpAttempts;
  const logicalByHost = new Map<string, number[]>();
  const physicalByHost = new Map<string, number[]>();
  for (const request of requests) {
    const list = logicalByHost.get(request.host) ?? [];
    list.push(request.durationMs);
    logicalByHost.set(request.host, list);
  }
  for (const attempt of attempts) {
    const list = physicalByHost.get(attempt.host) ?? [];
    list.push(attempt.durationMs);
    physicalByHost.set(attempt.host, list);
  }

  const hosts: NetworkByHost[] = [...logicalByHost.entries()]
    .map(([host, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      const physical = physicalByHost.get(host) ?? [];
      const cumulativeMs = sorted.reduce((a, b) => a + b, 0);
      const physicalMs = physical.reduce((a, b) => a + b, 0);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      return {
        host,
        count: sorted.length,
        physicalCount: physical.length,
        cumulativeMs,
        physicalMs,
        meanMs: cumulativeMs / sorted.length,
        p95Ms: p95,
        slowestMs: sorted[sorted.length - 1] ?? 0,
      };
    })
    .sort((a, b) => b.cumulativeMs - a.cumulativeMs);

  const revalidated = requests.filter((r) => r.cache === 'revalidated_304' || (r.cache === 'hit' && r.status === 304)).length;
  const networkRequired = requests.filter((r) => r.cache === 'miss' || r.cache === 'revalidated_304' || (r.cache === 'hit' && r.status === 304)).length;
  const retries = requests.reduce((sum, request) => sum + (request.retries ?? 0), 0);
  const backoffMs = requests.reduce((sum, request) => sum + (request.backoffMs ?? 0), 0);
  const cumulativeMs = requests.reduce((sum, request) => sum + request.durationMs, 0);
  const attemptCumulativeMs = attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
  const maxConcurrentAttempts = maxOverlap(
    attempts.map((attempt) => ({
      start: attempt.startOffsetMs,
      end: attempt.startOffsetMs + attempt.durationMs,
    })),
  );

  const byResource = new Map<string, number>();
  for (const request of requests) {
    if (request.cache !== 'miss') continue;
    const key = `${request.host}${request.path}`;
    byResource.set(key, (byResource.get(key) ?? 0) + 1);
  }
  const repeatedFetches = [...byResource.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1]);

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
    slowest: [...requests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
    slowestAttempts: [...attempts].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function render(state: RunState, status: string, finishMeta: Record<string, unknown>): string {
  const totalMs = state.now();
  const timeline = renderTimeline(state);
  const stages = stageBreakdown(state);
  const packages = packageBreakdown(state);
  const net = networkSummary(state);
  const slowWorkSpans = slowWork(state);
  const stalls = eventLoopStalls(state);
  const overruns = timeoutOverruns(state);
  const sharedWaits = coalescedWaits(state);
  const exec = state.execCommands;
  const execCumulative = exec.reduce((sum, entry) => sum + entry.durationMs, 0);
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
  for (const stage of stages) {
    const pct = totalMs > 0 ? ((stage.ms / totalMs) * 100).toFixed(1) : '0.0';
    lines.push(`  ${stage.name.padEnd(28)} ${fmtSec(stage.ms).padStart(8)}  ${pct.padStart(5)}%`);
  }
  lines.push('');

  lines.push('critical package spans:');
  if (packages.length === 0) lines.push('  (none recorded)');
  for (const pkg of packages.slice(0, 10)) {
    const pct = totalMs > 0 ? ((pkg.ms / totalMs) * 100).toFixed(1) : '0.0';
    lines.push(`  ${pkg.name.padEnd(28)} ${fmtSec(pkg.ms).padStart(8)}  ${pct.padStart(5)}%`);
  }
  lines.push('');

  lines.push('slowest work spans:');
  if (slowWorkSpans.length === 0) lines.push('  (none recorded)');
  for (const work of slowWorkSpans) {
    lines.push(`  ${fmtSec(durationOf(work)).padStart(8)} ${spanLabel(work)}${fmtMeta(work.meta)}`);
  }
  lines.push('');

  lines.push('event loop:');
  if (stalls.length === 0) {
    lines.push('  no stalls >=50ms recorded');
  } else {
    lines.push(`  stalls_over_50ms: ${state.spans.filter((s) => s.name === 'event-loop.lag').length}`);
    lines.push(`  max_lag: ${fmtMs(stalls[0]!.lagMs)}`);
    lines.push('  worst stalls:');
    for (const stall of stalls.slice(0, 5)) {
      lines.push(
        `    lag=${fmtMs(stall.lagMs)} callback_at=+${fmtMs(stall.atMs)}` +
          `${stall.overlaps.length ? ` overlapping=${stall.overlaps.join(',')}` : ''}`,
      );
    }
  }
  lines.push('');

  lines.push('timeout overruns:');
  if (overruns.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const overrun of overruns) {
      const span = overrun.span;
      lines.push(
        `  ${spanLabel(span)} duration=${fmtSec(durationOf(span))} timeout=${fmtMs(overrun.timeoutMs)} overrun=${fmtSec(overrun.overrunMs)}` +
          ` abort_timer_fired=${String(span.meta.abortTimerFired ?? 'unknown')}` +
          `${typeof span.meta.abortDelayMs === 'number' ? ` abort_delay=${fmtMs(Number(span.meta.abortDelayMs))}` : ''}` +
          `${typeof span.meta.headersMs === 'number' ? ` headers=${fmtMs(Number(span.meta.headersMs))}` : ''}` +
          `${typeof span.meta.bodyMs === 'number' ? ` body=${fmtMs(Number(span.meta.bodyMs))}` : ''}` +
          `${typeof span.meta.requestKey === 'string' ? ` request_key=${span.meta.requestKey}` : ''}`,
      );
    }
  }
  lines.push('');

  lines.push('coalesced waits:');
  if (sharedWaits.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const wait of sharedWaits) {
      lines.push(
        `  ${fmtSec(durationOf(wait)).padStart(8)} ${spanLabel(wait)}` +
          `${typeof wait.meta.requestKey === 'string' ? ` request_key=${wait.meta.requestKey}` : ''}`,
      );
    }
  }
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
    for (const host of net.hosts) {
      lines.push(
        `    ${host.host.padEnd(28)} requests=${host.count} physical_attempts=${host.physicalCount}` +
          ` cumulative=${fmtSec(host.cumulativeMs)} physical_time=${fmtSec(host.physicalMs)}` +
          ` mean=${fmtMs(host.meanMs)} p95=${fmtMs(host.p95Ms)} slowest=${fmtMs(host.slowestMs)}`,
      );
    }
  }
  if (net.slowest.length) {
    lines.push('  slowest logical requests:');
    for (const request of net.slowest) {
      lines.push(
        `    ${fmtSec(request.durationMs).padStart(8)} ${request.method} ${request.host}${request.path} cache=${request.cache}`,
      );
    }
  }
  if (net.slowestAttempts.length) {
    lines.push('  slowest network attempts:');
    for (const attempt of net.slowestAttempts) {
      lines.push(`    ${fmtSec(attempt.durationMs).padStart(8)} ${attempt.method} ${attempt.host}${attempt.path}`);
    }
  }
  if (net.repeatedFetches.length) {
    lines.push('  repeated fetches (same resource, more than once):');
    for (const [resource, count] of net.repeatedFetches.slice(0, 10)) {
      lines.push(`    ${String(count).padStart(2)}x ${resource}`);
    }
  }
  lines.push('');

  lines.push('external processes:');
  lines.push(`  count: ${exec.length}`);
  lines.push(`  cumulative_time: ${fmtSec(execCumulative)}`);
  if (slowestExec.length) {
    lines.push('  slowest:');
    for (const entry of slowestExec) lines.push(`    ${fmtSec(entry.durationMs).padStart(8)} ${entry.label}`);
  }
  if (execRepeats.length) {
    lines.push('  repeated commands:');
    for (const repeat of execRepeats.slice(0, 10)) {
      lines.push(`    ${repeat.label.padEnd(28)} ${String(repeat.count).padStart(2)}x   ${fmtSec(repeat.ms)} cumulative`);
    }
  }
  lines.push('');

  lines.push('cache:');
  if (state.caches.size === 0) lines.push('  (none recorded)');
  for (const [name, cache] of [...state.caches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const categorizedHits = cache.memoryHits + cache.diskHits + cache.coalescedHits;
    const uncategorizedHits = Math.max(0, cache.hits - categorizedHits);
    const avoided = categorizedHits + uncategorizedHits;
    const denominator = avoided + cache.misses;
    const avoidanceRate = denominator > 0 ? `${((100 * avoided) / denominator).toFixed(1)}%` : 'n/a';
    lines.push(
      `  ${name}: memory_hits=${cache.memoryHits} disk_hits=${cache.diskHits}` +
        ` coalesced_hits=${cache.coalescedHits} uncategorized_hits=${uncategorizedHits}` +
        ` revalidated_304=${cache.revalidated304} misses=${cache.misses} writes=${cache.writes}` +
        ` avoidance_rate=${avoidanceRate}`,
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
    for (const repeat of repeats) {
      lines.push(`  ${repeat.key.padEnd(28)} ${String(repeat.count).padStart(2)} executions   ${fmtSec(repeat.ms)} cumulative`);
    }
    lines.push('');
  }

  lines.push('diagnostic flags:');
  const flags = diagnosticFlags({
    totalMs,
    packages,
    net,
    repeats,
    caches: state.caches,
    exec: state.execCommands,
    stalls,
    overruns,
  });
  if (flags.length === 0) lines.push('  (none)');
  for (const flag of flags) lines.push(`  - ${flag}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Evidence-only flags
// ---------------------------------------------------------------------------

const HOT_PACKAGE_SHARE = 0.15;
const HIGH_REQUESTS_PER_PACKAGE = 4;
const LOW_CACHE_HIT_RATE = 0.3;
const SLOW_EXTERNAL_PROCESS_MS = 5000;
const SLOW_HTTP_REQUEST_MS = 3000;
const MIN_REQUESTS_FOR_CONCURRENCY_NOTE = 10;
const HIGH_RETRY_COUNT = 5;
const SIGNIFICANT_EVENT_LOOP_LAG_MS = 250;

function diagnosticFlags(args: {
  totalMs: number;
  packages: { name: string; ms: number }[];
  net: ReturnType<typeof networkSummary>;
  repeats: { key: string; count: number; ms: number }[];
  caches: Map<string, CacheStats>;
  exec: ExecRecord[];
  stalls: EventLoopStall[];
  overruns: TimeoutOverrun[];
}): string[] {
  const flags: string[] = [];
  const { totalMs, packages, net, repeats, caches, exec, stalls, overruns } = args;

  const hottest = packages[0];
  if (hottest && totalMs > 0 && hottest.ms / totalMs > HOT_PACKAGE_SHARE) {
    flags.push(
      `HOT_PACKAGE: ${hottest.name} held a critical package span for ${((hottest.ms / totalMs) * 100).toFixed(1)}% of the run's wall-clock time`,
    );
  }

  if (packages.length > 0 && net.requestCount / packages.length > HIGH_REQUESTS_PER_PACKAGE) {
    flags.push(`HIGH_HTTP_REQUEST_COUNT: ${net.requestCount} logical HTTP requests were issued for ${packages.length} packages`);
  }

  for (const repeat of repeats) {
    if (repeat.key.startsWith('surface.')) {
      flags.push(`DUPLICATE_SURFACE_WORK: ${repeat.key} was computed ${repeat.count} times (${fmtSec(repeat.ms)} cumulative)`);
    }
  }

  for (const [name, cache] of caches) {
    const avoided =
      cache.memoryHits +
      cache.diskHits +
      cache.coalescedHits +
      Math.max(0, cache.hits - cache.memoryHits - cache.diskHits - cache.coalescedHits);
    const total = avoided + cache.misses;
    if (total >= 5 && avoided / total < LOW_CACHE_HIT_RATE) {
      flags.push(`LOW_CACHE_HIT_RATE: ${name} cache network avoidance rate was ${((avoided / total) * 100).toFixed(1)}%`);
    }
  }

  const slowestExec = [...exec].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (slowestExec && slowestExec.durationMs > SLOW_EXTERNAL_PROCESS_MS) {
    flags.push(`SLOW_EXTERNAL_PROCESS: ${slowestExec.label} consumed ${fmtSec(slowestExec.durationMs)}`);
  }

  const slowestRequest = net.slowest[0];
  if (slowestRequest && slowestRequest.durationMs > SLOW_HTTP_REQUEST_MS) {
    flags.push(
      `SLOW_HTTP_REQUEST: ${slowestRequest.method} ${slowestRequest.host}${slowestRequest.path} took ${fmtSec(slowestRequest.durationMs)} (cache=${slowestRequest.cache})`,
    );
  }

  if (net.attemptCount >= MIN_REQUESTS_FOR_CONCURRENCY_NOTE && net.maxConcurrentAttempts <= 1) {
    flags.push(
      `LOW_OBSERVED_CONCURRENCY: ${net.attemptCount} HTTP network attempts were made but the maximum observed attempt concurrency was ${net.maxConcurrentAttempts}`,
    );
  }

  if (net.retries > HIGH_RETRY_COUNT) {
    flags.push(`HIGH_RETRY_COUNT: ${net.retries} retries observed across ${net.requestCount} logical requests (${fmtSec(net.backoffMs)} spent backing off)`);
  }

  if (net.repeatedFetches.length > 0) {
    const [resource, count] = net.repeatedFetches[0]!;
    flags.push(`REPEATED_NETWORK_FETCH: ${resource} was fetched from the network ${count} times`);
  }

  if (stalls[0] && stalls[0].lagMs >= SIGNIFICANT_EVENT_LOOP_LAG_MS) {
    flags.push(
      `EVENT_LOOP_STALL: the event loop was delayed by ${fmtSec(stalls[0].lagMs)}; see the event-loop section for overlapping work`,
    );
  }

  if (overruns[0]) {
    const { span, timeoutMs, overrunMs } = overruns[0];
    flags.push(
      `HTTP_TIMEOUT_OVERRUN: ${spanLabel(span)} exceeded its ${fmtMs(timeoutMs)} timer by ${fmtSec(overrunMs)} (abort_timer_fired=${String(span.meta.abortTimerFired ?? 'unknown')})`,
    );
  }

  return flags;
}
