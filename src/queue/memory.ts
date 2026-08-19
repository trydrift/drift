import type {
  DispatchRecord,
  EnqueueRequest,
  EnqueueResult,
  Job,
  JobQueue,
  PendingCloudTask,
  QueueStats,
} from './types.js';

/**
 * In-memory queue.
 *
 * For tests, and for `DRIFT_QUEUE=memory` when someone deliberately wants the
 * old fire-and-forget behaviour back. It is *not* durable, and the runner logs
 * that plainly at startup rather than letting a deployment discover it during
 * an incident.
 *
 * It exists mainly so the worker, the retry policy, and the webhook handler can
 * be tested without touching a filesystem — the queue implementation is then
 * the only thing SQLite tests need to cover.
 */
export class MemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<number, Job>();
  private readonly byDelivery = new Map<string, number>();
  private nextId = 1;
  private readonly pendingCloudTasks = new Map<number, PendingCloudTask>();
  private nextCloudTaskId = 1;
  private readonly dispatchedPlans = new Map<string, DispatchRecord>();

  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const existing = this.byDelivery.get(request.deliveryId);
    if (existing !== undefined) return { status: 'duplicate', id: existing };

    const id = this.nextId++;
    const now = new Date().toISOString();
    this.jobs.set(id, {
      id,
      deliveryId: request.deliveryId,
      event: request.event,
      payload: request.payload,
      status: 'queued',
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: 0,
    });
    this.byDelivery.set(request.deliveryId, id);
    return { status: 'queued', id };
  }

  async claim(now = Date.now()): Promise<Job | null> {
    // Single-threaded by virtue of the event loop: nothing yields between
    // finding the job and marking it running.
    for (const job of [...this.jobs.values()].sort((a, b) => a.id - b.id)) {
      if (job.status !== 'queued' || job.nextAttemptAt > now) continue;
      job.status = 'running';
      job.attempts += 1;
      job.updatedAt = new Date().toISOString();
      return { ...job };
    }
    return null;
  }

  async complete(id: number): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.error = null;
    job.updatedAt = new Date().toISOString();
  }

  async fail(id: number, error: string, retryAt?: number): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = retryAt === undefined ? 'failed' : 'queued';
    job.error = error;
    job.nextAttemptAt = retryAt ?? job.nextAttemptAt;
    job.updatedAt = new Date().toISOString();
  }

  async recover(): Promise<number> {
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue;
      job.status = 'queued';
      job.updatedAt = new Date().toISOString();
      recovered += 1;
    }
    return recovered;
  }

  async stats(): Promise<QueueStats> {
    const counts: QueueStats = {
      queued: 0,
      running: 0,
      failed: 0,
      done: 0,
      oldestPendingAgeMs: null,
    };
    let oldest: number | null = null;

    for (const job of this.jobs.values()) {
      counts[job.status] += 1;
      if (job.status === 'queued' || job.status === 'running') {
        const created = Date.parse(job.createdAt);
        if (oldest === null || created < oldest) oldest = created;
      }
    }

    counts.oldestPendingAgeMs = oldest === null ? null : Math.max(0, Date.now() - oldest);
    return counts;
  }

  async close(): Promise<void> {
    this.jobs.clear();
    this.byDelivery.clear();
  }

  async recordPendingCloudTask(task: Omit<PendingCloudTask, 'id' | 'createdAt'>): Promise<void> {
    const id = this.nextCloudTaskId++;
    this.pendingCloudTasks.set(id, { ...task, id, createdAt: new Date().toISOString() });
  }

  async listPendingCloudTasks(): Promise<PendingCloudTask[]> {
    return [...this.pendingCloudTasks.values()];
  }

  async resolvePendingCloudTask(id: number): Promise<void> {
    this.pendingCloudTasks.delete(id);
  }

  async recordDispatchedPlan(record: {
    owner: string;
    repo: string;
    planDigest: string;
    taskId?: string;
    branchName?: string;
    prNumber?: number | null;
    prUrl?: string | null;
  }): Promise<void> {
    const key = dispatchKey(record.owner, record.repo, record.planDigest);
    if (this.dispatchedPlans.has(key)) return;
    this.dispatchedPlans.set(key, {
      owner: record.owner,
      repo: record.repo,
      planDigest: record.planDigest,
      taskId: record.taskId ?? null,
      branchName: record.branchName ?? null,
      prNumber: record.prNumber ?? null,
      prUrl: record.prUrl ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async findDispatchedPlan(owner: string, repo: string, planDigest: string): Promise<DispatchRecord | null> {
    return this.dispatchedPlans.get(dispatchKey(owner, repo, planDigest)) ?? null;
  }
}

function dispatchKey(owner: string, repo: string, planDigest: string): string {
  return `${owner}/${repo}/${planDigest}`;
}
