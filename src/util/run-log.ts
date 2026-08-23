/**
 * A single always-on run log, for diagnosing why a scan was slow.
 *
 * `DRIFT_PROFILE` (see `profile.ts`) is opt-in and detailed — spans, machine
 * info, a JSON document meant for `scripts/profile-report.mjs`. This is the
 * opposite: on by default, minimal, plain text, and answers a much smaller
 * question — "what did the last run do, and how long did each part take" —
 * without anyone having to know a flag exists first.
 *
 * Written to `.drift/logs/<repo>-<timestamp>.log` under the repository being
 * worked on. Only the most recent run is kept: the directory is cleared each
 * time a new log starts, so this never grows into a pile of dead files.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface RunLogHandle {
  /** Record a timestamped sub-step — a phase starting, a slow request, etc. */
  event(name: string, meta?: Record<string, unknown>): void;
  /** Close the log with a final status. Safe to call at most once. */
  finish(status: string, meta?: Record<string, unknown>): void;
}

function repoName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name) return pkg.name.replace(/^@/, '').replace(/\//g, '-');
  } catch {
    // No readable package.json at this cwd — fall back to the directory name.
  }
  return basename(cwd) || 'repo';
}

function timestampForFilename(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Start a new run log, replacing whatever the previous run left behind. */
export function startRunLog(task: string, cwd: string = process.cwd()): RunLogHandle {
  const dir = join(cwd, '.drift', 'logs');
  const start = Date.now();
  let path: string | null = null;

  try {
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { force: true });
    path = join(dir, `${repoName(cwd)}-${timestampForFilename(new Date(start))}.log`);
    writeFileSync(
      path,
      `task: ${task}\nstarted: ${new Date(start).toISOString()}\n\n`,
      'utf8',
    );
  } catch {
    // A run log is a diagnostic nicety, not something a scan should fail
    // over — an unwritable .drift/logs/ (read-only checkout, permissions)
    // just means no log this time.
    path = null;
  }

  let finished = false;

  const write = (line: string) => {
    if (!path) return;
    try {
      appendFileSync(path, line, 'utf8');
    } catch {
      path = null;
    }
  };

  return {
    event(name, meta) {
      const elapsedMs = Date.now() - start;
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      write(`[+${elapsedMs}ms] ${name}${suffix}\n`);
    },
    finish(status, meta) {
      if (finished) return;
      finished = true;
      const end = Date.now();
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      write(
        `\nstatus: ${status}${suffix}\nended: ${new Date(end).toISOString()}\ndurationMs: ${end - start}\n`,
      );
    },
  };
}
