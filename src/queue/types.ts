/**
 * Durable webhook work.
 *
 * The webhook runner used to answer GitHub with 202 and then start an untracked
 * promise:
 *
 *     respond(res, 202, { accepted: true });
 *     void processEvent(...).catch(logAndForget);
 *
 * That is an acknowledgement Drift cannot honour. GitHub considers a delivery
 * complete once it sees the 202 and will not send it again, so any restart,
 * deploy, crash, or unhandled rejection between that line and the end of the
 * pipeline loses the work permanently — silently, and with the delivery marked
 * successful in GitHub's UI. For a push that changed a dependency, the visible
 * symptom is Drift simply never having noticed.
 *
 * A queue fixes the specific thing that was wrong: the 202 now means "recorded
 * on disk", which is a promise that survives the process.
 *
 * ## What this is and is not
 *
 * It is a single-node work queue durable across restarts of that node. It is
 * not a distributed queue: two runners pointed at one database file would need
 * cross-process locking this does not attempt. That matches the runner's
 * existing single-tenant design (see the header of `runners/webhook.ts`), and
 * the limit is documented rather than papered over.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: number;
  /** GitHub's `X-GitHub-Delivery`. Unique — this is what makes replay safe. */
  deliveryId: string;
  event: string;
  /** The verified raw payload, as delivered. */
  payload: string;
  status: JobStatus;
  attempts: number;
  /** Last failure message. Never contains payload data. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Epoch ms before which this job must not be claimed. Drives backoff. */
  nextAttemptAt: number;
}

export interface EnqueueRequest {
  deliveryId: string;
  event: string;
  payload: string;
}

export type EnqueueResult =
  | { status: 'queued'; id: number }
  /** This delivery is already recorded. GitHub retries; that must be a no-op. */
  | { status: 'duplicate'; id: number };

export interface QueueStats {
  queued: number;
  running: number;
  failed: number;
  done: number;
  /** Age in ms of the oldest unfinished job, or `null` when the queue is idle. */
  oldestPendingAgeMs: number | null;
}

/**
 * A cloud agent task dispatched by this runner, still awaiting a terminal
 * state.
 *
 * Dispatch happens inside one HTTP delivery, but a cloud task routinely
 * outlives it — the agent session runs for minutes, long after the webhook
 * handler has already responded. Without recording the task id somewhere
 * durable, nothing ever asks the provider how it turned out, and the check run
 * Drift posted at dispatch time (`neutral`, "agent is fixing…") is the last
 * thing anyone ever sees, even after the agent finishes, fails, or times out.
 */
export interface PendingCloudTask {
  id: number;
  provider: string;
  owner: string;
  repo: string;
  taskId: string;
  state?: string | null;
  /** The commit the check run should be posted against. */
  headSha: string;
  branchName: string;
  prNumber: number | null;
  prUrl: string | null;
  /** Serialized RemediationPlan, used for post-agent scope reconciliation. */
  planJson: string | null;
  createdAt: string;
}

/**
 * A permanent record that a plan was dispatched, keyed by the repository and
 * the exact plan digest.
 *
 * This is deliberately separate from `PendingCloudTask`: that table is
 * pruned the moment a task reaches a terminal state (see
 * `resolvePendingCloudTask`), so it cannot answer "was this plan already
 * dispatched?" once the task it recorded has finished — exactly the case a
 * retry arriving after completion needs answered. It also exists independently
 * of the GitHub comment marker (`renderDispatchMarker` /
 * `findPriorDispatch` in `approval/metadata.ts`): that marker is a
 * best-effort comment which can fail to post without the caller finding out
 * before this fix, so a second, durable source of the same fact is what makes
 * a retry after that kind of failure a no-op instead of a duplicate dispatch.
 */
export interface DispatchRecord {
  owner: string;
  repo: string;
  planDigest: string;
  taskId: string | null;
  branchName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
}

export interface JobQueue {
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;

  /**
   * Atomically take the next due job and mark it running.
   *
   * Must be atomic against concurrent callers: two workers claiming one job
   * would process a delivery twice, which for Drift means two branches and two
   * agent dispatches for the same push.
   */
  claim(now?: number): Promise<Job | null>;

  complete(id: number): Promise<void>;

  /**
   * Record a failure. `retryAt` schedules another attempt; omitting it marks
   * the job terminally failed.
   */
  fail(id: number, error: string, retryAt?: number): Promise<void>;

  /**
   * Return jobs left `running` by a previous process to `queued`.
   *
   * Called once at startup. A job that was mid-flight when the process died has
   * no one to finish it, and without this it would sit in `running` forever.
   */
  recover(): Promise<number>;

  stats(): Promise<QueueStats>;

  close(): Promise<void>;

  /** Record a freshly-dispatched cloud task so its outcome is reconciled later. */
  recordPendingCloudTask(task: Omit<PendingCloudTask, 'id' | 'createdAt'>): Promise<void>;

  /** Every dispatched task not yet resolved to a terminal state. */
  listPendingCloudTasks(): Promise<PendingCloudTask[]>;

  /** Stop tracking a task once it has reached a terminal state (or been resolved another way). */
  resolvePendingCloudTask(id: number): Promise<void>;

  /**
   * Record a dispatch, permanently. First write for a given
   * (owner, repo, planDigest) wins — a duplicate call for the same key (a
   * retry racing the original request) must not overwrite what actually
   * dispatched.
   */
  recordDispatchedPlan(record: {
    owner: string;
    repo: string;
    planDigest: string;
    taskId?: string;
    branchName?: string;
    prNumber?: number | null;
    prUrl?: string | null;
  }): Promise<void>;

  /** Look up a prior dispatch of this exact plan, or `null` if there is none. */
  findDispatchedPlan(owner: string, repo: string, planDigest: string): Promise<DispatchRecord | null>;
}

/**
 * Retry schedule.
 *
 * Bounded and exponential with a cap: the failures worth retrying are transient
 * (a 502 from the API, a rate limit), and those clear in seconds to minutes.
 * Retrying a genuine bug forever would just burn API quota while looking busy,
 * so attempts are capped and the job is marked failed for a human to see.
 */
export const MAX_ATTEMPTS = 5;

export function backoffMs(attempts: number): number {
  const base = 2_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 5 * 60_000);
}
