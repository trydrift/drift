import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EnqueueRequest, EnqueueResult, Job, JobQueue, PendingCopilotTask, QueueStats } from './types.js';

/**
 * SQLite-backed durable queue.
 *
 * Uses `node:sqlite` from the standard library rather than a native module.
 * That choice is deliberate: the webhook runner is self-hosted software other
 * people deploy, and `better-sqlite3` would put a compiler toolchain and a
 * post-install build step between them and a working server. The cost is a
 * floor of Node 22.5, which the runner checks for and reports at startup
 * instead of failing later with a module-resolution error.
 *
 * Durability settings are chosen for the one guarantee that matters here: when
 * the HTTP handler returns 202, the row is on disk. WAL keeps reads from
 * blocking the worker, and `synchronous = FULL` makes the commit survive an
 * abrupt power loss rather than only a process crash. A queue that loses work
 * on restart would be the same bug this replaces, with more code.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id     TEXT    NOT NULL UNIQUE,
  event           TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);

-- The worker's hot path is "oldest due queued job".
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_copilot_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT    NOT NULL,
  repo        TEXT    NOT NULL,
  task_id     TEXT    NOT NULL,
  head_sha    TEXT    NOT NULL,
  branch_name TEXT    NOT NULL,
  pr_number   INTEGER,
  pr_url      TEXT,
  created_at  TEXT    NOT NULL
);
`;

/** Bump alongside any migration to `SCHEMA`. */
export const QUEUE_SCHEMA_VERSION = 2;

interface JobRow {
  id: number;
  delivery_id: string;
  event: string;
  payload: string;
  status: Job['status'];
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  next_attempt_at: number;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    event: row.event,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
  };
}

export class SqliteJobQueue implements JobQueue {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Open (creating if needed) the queue database.
   *
   * Async only because `node:sqlite` is imported dynamically — a static import
   * would throw at module load on Node 20, taking down the whole runner even
   * for deployments that never touch the queue.
   */
  static async open(path: string): Promise<SqliteJobQueue> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
    } catch (err) {
      throw new Error(
        `Drift's durable webhook queue needs \`node:sqlite\`, which this Node build does not provide ` +
          `(running ${process.version}; Node 22.5 or newer is required). ` +
          `Upgrade Node, or set DRIFT_QUEUE=memory to run without durability — see docs/deployment.md. ` +
          `Underlying error: ${(err as Error).message}`,
      );
    }

    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

    const db = new DatabaseSyncCtor(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    // A queued job is worthless if the process is gone; waiting briefly for a
    // concurrent writer beats failing an enqueue that GitHub will not resend.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);

    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(
      'version',
      String(QUEUE_SCHEMA_VERSION),
    );

    return new SqliteJobQueue(db);
  }

  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const now = new Date().toISOString();

    // The UNIQUE constraint on delivery_id is the replay guard, and it is
    // enforced by the database rather than by a prior SELECT — a check-then-act
    // would leave a window in which GitHub's retry could be accepted twice.
    const inserted = this.db
      .prepare(
        `INSERT INTO jobs (delivery_id, event, payload, status, attempts, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, 0)
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING id`,
      )
      .get(request.deliveryId, request.event, request.payload, now, now) as { id: number } | undefined;

    if (inserted) return { status: 'queued', id: inserted.id };

    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE delivery_id = ?')
      .get(request.deliveryId) as { id: number } | undefined;

    // Only reachable if the row vanished between the two statements, which
    // means someone is deleting rows underneath the runner.
    if (!existing) throw new Error(`Could not record delivery ${request.deliveryId}`);
    return { status: 'duplicate', id: existing.id };
  }

  async claim(now = Date.now()): Promise<Job | null> {
    // Single statement, so the select and the state change cannot interleave
    // with another claimer.
    const row = this.db
      .prepare(
        `UPDATE jobs
            SET status = 'running', attempts = attempts + 1, updated_at = ?
          WHERE id = (
            SELECT id FROM jobs
             WHERE status = 'queued' AND next_attempt_at <= ?
             ORDER BY id
             LIMIT 1
          )
        RETURNING *`,
      )
      .get(new Date().toISOString(), now) as JobRow | undefined;

    return row ? toJob(row) : null;
  }

  async complete(id: number): Promise<void> {
    this.db
      .prepare(`UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  async fail(id: number, error: string, retryAt?: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE jobs
            SET status = ?, error = ?, updated_at = ?, next_attempt_at = ?
          WHERE id = ?`,
      )
      .run(
        retryAt === undefined ? 'failed' : 'queued',
        // Bounded: a stack trace or an API body could be enormous, and the
        // queue is not a log.
        error.slice(0, 2000),
        new Date().toISOString(),
        retryAt ?? 0,
        id,
      );
  }

  async recover(): Promise<number> {
    const result = this.db
      .prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'`)
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  async stats(): Promise<QueueStats> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as {
      status: Job['status'];
      n: number;
    }[];

    const stats: QueueStats = { queued: 0, running: 0, failed: 0, done: 0, oldestPendingAgeMs: null };
    for (const row of rows) stats[row.status] = Number(row.n);

    const oldest = this.db
      .prepare(`SELECT MIN(created_at) AS oldest FROM jobs WHERE status IN ('queued','running')`)
      .get() as { oldest: string | null } | undefined;

    stats.oldestPendingAgeMs = oldest?.oldest ? Math.max(0, Date.now() - Date.parse(oldest.oldest)) : null;
    return stats;
  }

  /**
   * Drop finished jobs older than `olderThanMs`.
   *
   * Completed rows are kept for a while on purpose: they are the record that
   * answers "did Drift see that delivery?", which is the first question anyone
   * asks when a push seems to have been ignored.
   */
  async prune(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db
      .prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`)
      .run(cutoff);
    return Number(result.changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async recordPendingCopilotTask(task: Omit<PendingCopilotTask, 'id' | 'createdAt'>): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pending_copilot_tasks (owner, repo, task_id, head_sha, branch_name, pr_number, pr_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.owner,
        task.repo,
        task.taskId,
        task.headSha,
        task.branchName,
        task.prNumber,
        task.prUrl,
        new Date().toISOString(),
      );
  }

  async listPendingCopilotTasks(): Promise<PendingCopilotTask[]> {
    const rows = this.db
      .prepare('SELECT * FROM pending_copilot_tasks ORDER BY id')
      .all() as unknown as PendingCopilotTaskRow[];
    return rows.map(toPendingCopilotTask);
  }

  async resolvePendingCopilotTask(id: number): Promise<void> {
    this.db.prepare('DELETE FROM pending_copilot_tasks WHERE id = ?').run(id);
  }
}

interface PendingCopilotTaskRow {
  id: number;
  owner: string;
  repo: string;
  task_id: string;
  head_sha: string;
  branch_name: string;
  pr_number: number | null;
  pr_url: string | null;
  created_at: string;
}

function toPendingCopilotTask(row: PendingCopilotTaskRow): PendingCopilotTask {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    taskId: row.task_id,
    headSha: row.head_sha,
    branchName: row.branch_name,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    createdAt: row.created_at,
  };
}
