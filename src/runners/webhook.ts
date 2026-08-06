import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RepoContext } from '../types.js';
import { loadConfig } from '../config/load.js';
import { GitHubClient } from '../github/client.js';
import { runPipeline } from '../pipeline.js';
import { createLogger, type Logger, type LogLevel } from '../util/logger.js';
import { matchesAny } from '../util/glob.js';
import { applyApproval } from '../approval/apply.js';
import type { JobQueue } from '../queue/types.js';
import { QueueWorker } from '../queue/worker.js';
import { MemoryJobQueue } from '../queue/memory.js';
import { SqliteJobQueue } from '../queue/sqlite.js';
import { getTaskStatus, isTerminalState } from '../dispatch/copilot.js';

/**
 * Self-hosted GitHub App webhook runner — the secondary deployment.
 *
 * This is the "GitHub App that listens to your repos" experience. Most of the
 * state Drift needs still lives in GitHub — plans are filed as issues and
 * approvals are comments on them — but *accepted work* cannot, which is what
 * the job queue is for. See `queue/types.ts` for why answering 202 and starting
 * an untracked promise was not a viable design.
 *
 * ## Three honest limitations
 *
 * 1. **No checkout, so no localization.** This server sees webhooks, not a
 *    working tree. It can detect changes and gather evidence, but it cannot
 *    search the repository for affected code without cloning it. Rather than
 *    silently produce empty impact sites, it says so and recommends the Action.
 *
 * 2. **One Copilot token per deployment.** The Copilot agent API needs a
 *    user-scoped token. A multi-tenant host would have to store one per
 *    installing user — which is exactly the database this MVP is designed not
 *    to need. So this runner is single-tenant: self-host it, set one token,
 *    point it at your own repos.
 *
 * 3. **Single node.** The queue is durable across restarts of one process, not
 *    shared between replicas. Two runners on one database file is not a
 *    supported configuration.
 *
 * All three are properties of the deployment model, not bugs. The Action has
 * none of them.
 */

export interface WebhookServerOptions {
  port: number;
  /** GitHub App webhook secret. Required — unsigned payloads are rejected. */
  webhookSecret: string;
  /** Token for repo operations. */
  repoToken: string;
  /** User-scoped Copilot token. Absent means approval-only operation. */
  copilotToken?: string;
  logger?: Logger;
  dryRun?: boolean;
  /**
   * Where accepted deliveries are recorded before being acknowledged.
   *
   * Required, because the alternative is losing work on restart. `main()`
   * builds the durable one; tests pass `MemoryJobQueue`.
   */
  queue: JobQueue;
}

export interface WebhookServer {
  server: Server;
  worker: QueueWorker;
  /** Stop accepting connections, then let the running job finish. */
  shutdown: () => Promise<void>;
}

export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
  const logger = options.logger ?? createLogger((process.env.DRIFT_LOG_LEVEL as LogLevel) ?? 'info');

  const worker = new QueueWorker({
    queue: options.queue,
    logger,
    handler: async (job) => {
      const payload = JSON.parse(job.payload) as Record<string, unknown>;
      await processEvent(job.event, payload, options, logger);
    },
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res, options, logger, worker).catch((err) => {
      logger.error(`Unhandled error: ${(err as Error).message}`);
      if (!res.headersSent) respond(res, 500, { error: 'internal error' });
    });
  });

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker.stop();
    await options.queue.close();
    logger.info('Drift webhook server stopped cleanly');
  };

  return { server, worker, shutdown };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebhookServerOptions,
  logger: Logger,
  worker: QueueWorker,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    // Counts only. Nothing here names a repository, an event payload, or an
    // error string — the endpoint is frequently public, and queue depth is
    // operational information while delivery contents are customer data.
    const stats = await options.queue.stats();
    respond(res, 200, {
      status: stats.failed > 0 ? 'degraded' : 'ok',
      queue: {
        queued: stats.queued,
        running: stats.running,
        failed: stats.failed,
        oldestPendingAgeMs: stats.oldestPendingAgeMs,
      },
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    respond(res, 404, { error: 'not found' });
    return;
  }

  const raw = await readBody(req);
  const signature = req.headers['x-hub-signature-256'];

  if (!verifySignature(raw, signature, options.webhookSecret)) {
    logger.warn('Rejected a webhook with an invalid signature');
    respond(res, 401, { error: 'invalid signature' });
    return;
  }

  const eventName = String(req.headers['x-github-event'] ?? '');

  // Only read after the signature check: an unverified delivery id is
  // attacker-controlled, and it is about to become a uniqueness key.
  const deliveryId = String(req.headers['x-github-delivery'] ?? '');
  if (!deliveryId) {
    // Every genuine GitHub delivery carries one, and without it replay
    // protection is impossible.
    respond(res, 400, { error: 'missing X-GitHub-Delivery' });
    return;
  }

  try {
    JSON.parse(raw.toString('utf8'));
  } catch {
    respond(res, 400, { error: 'invalid JSON' });
    return;
  }

  // Record before acknowledging. The 202 below is a promise that this delivery
  // will be processed, and it is only honest once the row is committed to disk.
  let result: Awaited<ReturnType<JobQueue['enqueue']>>;
  try {
    result = await options.queue.enqueue({
      deliveryId,
      event: eventName,
      payload: raw.toString('utf8'),
    });
  } catch (err) {
    // 500 rather than 202: GitHub retries a 5xx, and a delivery Drift failed to
    // record is exactly one it should be sent again.
    logger.error(`Could not record delivery ${deliveryId}: ${(err as Error).message}`);
    respond(res, 500, { error: 'could not record delivery' });
    return;
  }

  if (result.status === 'duplicate') {
    logger.debug(`Delivery ${deliveryId} already recorded; acknowledging without re-queueing`);
    respond(res, 202, { accepted: true, event: eventName, duplicate: true });
    return;
  }

  respond(res, 202, { accepted: true, event: eventName });
  // The worker polls anyway; this just skips the poll interval.
  worker.notify();
}

async function processEvent(
  eventName: string,
  payload: Record<string, unknown>,
  options: WebhookServerOptions,
  logger: Logger,
): Promise<void> {
  switch (eventName) {
    case 'push':
      await handlePush(payload, options, logger);
      return;
    case 'issue_comment':
      await handleIssueComment(payload, options, logger);
      return;
    case 'ping':
      logger.info('Received ping from GitHub');
      return;
    default:
      logger.debug(`Ignoring ${eventName}`);
  }
}

async function handlePush(
  payload: Record<string, unknown>,
  options: WebhookServerOptions,
  logger: Logger,
): Promise<void> {
  const repo = repoContextFromPush(payload);
  if (!repo) return;

  // A branch deletion has an all-zero `after`; there is nothing to analyse.
  if (/^0+$/.test(repo.afterSha)) return;

  const github = new GitHubClient({ repoToken: options.repoToken, logger });

  const { config, problems } = await loadConfig((path) =>
    github.readFile(repo, path, repo.afterSha),
  );
  for (const problem of problems) logger.warn(problem);

  if (!matchesAny(config.watchBranches, repo.baseBranch)) {
    logger.debug(`${repo.owner}/${repo.repo}: ${repo.baseBranch} is not watched`);
    return;
  }

  logger.info(`Analysing push to ${repo.owner}/${repo.repo}@${repo.baseBranch}`);

  const result = await runPipeline({
    repo,
    config,
    logger,
    github,
    copilotToken: options.copilotToken,
    dryRun: options.dryRun,
    // No workspace: localization is unavailable here, and the pipeline warns.
    workspace: undefined,
  });

  logger.info(`${repo.owner}/${repo.repo}: ${result.summary}`);

  // The check run posted during dispatch says "Copilot is fixing…" — it never
  // learns whether that turned out true unless something asks GitHub later.
  // Recording the task here is what lets `reconcilePendingCopilotTasks` find
  // it after this delivery has long since been acknowledged.
  if (result.dispatch.status === 'dispatched' && result.dispatch.taskId) {
    await options.queue.recordPendingCopilotTask({
      owner: repo.owner,
      repo: repo.repo,
      taskId: result.dispatch.taskId,
      headSha: repo.afterSha,
      branchName: result.dispatch.branchName ?? '',
      prNumber: result.dispatch.pullRequestNumber ?? null,
      prUrl: result.dispatch.pullRequestUrl ?? null,
    });
  }
}

/**
 * Ask GitHub how each still-open Copilot task turned out, and post a final
 * check run when one reaches a terminal state.
 *
 * Dispatch posts a `neutral` check run the moment the task is created,
 * because nothing about completion, failure, or timeout is known yet. This is
 * the other half of that promise: without it, "Copilot is fixing…" is the
 * last word the check run ever has, whatever actually happened.
 */
export async function reconcilePendingCopilotTasks(
  options: Pick<WebhookServerOptions, 'copilotToken' | 'repoToken' | 'queue'>,
  logger: Logger,
): Promise<void> {
  if (!options.copilotToken) return;

  const pending = await options.queue.listPendingCopilotTasks();
  if (pending.length === 0) return;

  const github = new GitHubClient({ repoToken: options.repoToken, logger });

  for (const pendingTask of pending) {
    const repo: RepoContext = {
      owner: pendingTask.owner,
      repo: pendingTask.repo,
      baseBranch: '',
      beforeSha: '',
      afterSha: pendingTask.headSha,
    };

    const task = await getTaskStatus({
      copilotToken: options.copilotToken,
      repo,
      taskId: pendingTask.taskId,
    });

    // `null` means the lookup itself failed (network, rate limit) — leave the
    // task pending and try again on the next tick, rather than treating an
    // unreachable API as a terminal state.
    if (!task || !isTerminalState(task.state)) continue;

    const succeeded = task.state === 'completed';
    await github.createCheckRun(repo, {
      name: 'Drift',
      conclusion: succeeded ? 'success' : 'failure',
      title: succeeded
        ? 'Copilot finished'
        : `Copilot did not finish (${task.state})`,
      summary: succeeded
        ? (pendingTask.prUrl ?? task.pullRequestUrl
            ? `See ${pendingTask.prUrl ?? task.pullRequestUrl} for the result.`
            : 'The agent task completed.')
        : `The Copilot agent task ended in state \`${task.state}\` without finishing the fix. ${
            pendingTask.prUrl ?? task.pullRequestUrl
              ? `See ${pendingTask.prUrl ?? task.pullRequestUrl} for what it left behind.`
              : 'A human needs to look at this.'
          }`,
    });

    logger.info(
      `Copilot task ${pendingTask.taskId} on ${pendingTask.owner}/${pendingTask.repo} reached terminal state ${task.state}`,
    );
    await options.queue.resolvePendingCopilotTask(pendingTask.id);
  }
}

/**
 * `/drift apply` on an approval issue.
 *
 * Every check lives in `approval/apply.ts`, shared with the Action so the two
 * runners cannot disagree about who may approve what. This function only
 * supplies the repository coordinates.
 *
 * What was here before accepted any comment matching the command, from anyone,
 * on any issue whose body contained a `drift-commit:` marker — a string the
 * commenter could type themselves. On a public repository that let an arbitrary
 * user dispatch a coding agent against a commit of their choosing.
 */
async function handleIssueComment(
  payload: Record<string, unknown>,
  options: WebhookServerOptions,
  logger: Logger,
): Promise<void> {
  const repository = payload.repository as { full_name?: string } | undefined;
  const [owner, repoName] = (repository?.full_name ?? '').split('/');
  if (!owner || !repoName) return;

  const github = new GitHubClient({ repoToken: options.repoToken, logger });

  await applyApproval({
    payload,
    owner,
    repo: repoName,
    github,
    logger,
    ...(options.copilotToken ? { copilotToken: options.copilotToken } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    // No checkout on this deployment, so no localization. The pipeline warns.
  });
}

function repoContextFromPush(payload: Record<string, unknown>): RepoContext | null {
  const repository = payload.repository as { full_name?: string; default_branch?: string } | undefined;
  const fullName = repository?.full_name;
  if (!fullName) return null;

  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;

  const ref = payload.ref as string | undefined;
  if (!ref?.startsWith('refs/heads/')) return null; // Tags are not branches.

  const afterSha = payload.after as string | undefined;
  if (!afterSha) return null;

  const before = payload.before as string | undefined;

  return {
    owner,
    repo,
    baseBranch: ref.replace('refs/heads/', ''),
    beforeSha: before && !/^0+$/.test(before) ? before : `${afterSha}^`,
    afterSha,
  };
}

/**
 * Verify the HMAC signature.
 *
 * Uses a constant-time comparison and rejects on any shape mismatch. An
 * unsigned or wrongly-signed payload is an attacker asking Drift to act on a
 * repository, so this fails closed.
 */
export function verifySignature(
  body: Buffer,
  signature: string | string[] | undefined,
  secret: string,
): boolean {
  if (!secret) return false;

  const provided = Array.isArray(signature) ? signature[0] : signature;
  if (!provided?.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // GitHub caps deliveries at 25 MB; anything larger is not from GitHub.
      if (size > 26_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Build the queue named by `DRIFT_QUEUE`.
 *
 * Durable by default. `memory` stays available because it is genuinely useful
 * for a smoke test, but it is announced loudly — a runner that quietly drops
 * work on restart is the failure this whole module exists to remove.
 */
export async function createQueueFromEnv(logger: Logger): Promise<JobQueue> {
  const kind = (process.env.DRIFT_QUEUE ?? 'sqlite').toLowerCase();

  if (kind === 'memory') {
    logger.warn(
      'DRIFT_QUEUE=memory: deliveries are held in memory only and will be lost on restart. Do not use this in production.',
    );
    return new MemoryJobQueue();
  }

  if (kind !== 'sqlite') {
    throw new Error(`Unknown DRIFT_QUEUE \`${kind}\`. Supported values: \`sqlite\` (default), \`memory\`.`);
  }

  const path = process.env.DRIFT_QUEUE_PATH ?? '.drift/queue.db';
  const queue = await SqliteJobQueue.open(path);
  logger.info(`Delivery queue: sqlite at ${path}`);
  return queue;
}

/**
 * Entry point for `npm run serve` and `drift serve`.
 *
 * Resolves once the server is listening, not when it stops — the caller keeps
 * the process alive through the open handle. Startup failures are returned as
 * an exit code rather than thrown, so a bad queue path produces one clear line
 * instead of an unhandled rejection.
 */
export async function main(): Promise<number> {
  const logger = createLogger((process.env.DRIFT_LOG_LEVEL as LogLevel) ?? 'info');

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  const repoToken = process.env.GITHUB_TOKEN ?? '';

  if (!webhookSecret || !repoToken) {
    logger.error(
      'GITHUB_WEBHOOK_SECRET and GITHUB_TOKEN must both be set. Drift refuses to run a webhook server that cannot verify signatures.',
    );
    return 1;
  }

  let queue: JobQueue;
  try {
    queue = await createQueueFromEnv(logger);
  } catch (err) {
    logger.error((err as Error).message);
    return 1;
  }

  // Anything left `running` belongs to a process that is no longer alive.
  const recovered = await queue.recover();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} delivery/deliveries left in flight by a previous run`);
  }

  const port = Number(process.env.PORT ?? 3000);
  const { server, worker, shutdown } = createWebhookServer({
    port,
    webhookSecret,
    repoToken,
    copilotToken: process.env.DRIFT_COPILOT_TOKEN,
    logger,
    dryRun: process.env.DRIFT_DRY_RUN === 'true',
    queue,
  });

  worker.start();

  // Completed deliveries otherwise accumulate forever — `prune` exists on the
  // SQLite queue (`MemoryJobQueue` has nothing to prune; it holds no state
  // across a restart) but nothing called it in production. A day is a
  // reasonable default: `stats()` and `/health` are the tools for "did Drift
  // see this delivery recently", and completed rows older than that are the
  // ones least likely anyone still needs.
  if ('prune' in queue && typeof queue.prune === 'function') {
    const retentionMs = Number(process.env.DRIFT_QUEUE_RETENTION_DAYS ?? 7) * 24 * 60 * 60 * 1000;
    const runPrune = (): void => {
      void (queue as JobQueue & { prune: (olderThanMs: number) => Promise<number> })
        .prune(retentionMs)
        .then((count) => {
          if (count > 0) logger.debug(`Pruned ${count} completed deliveries older than the retention window`);
        })
        .catch((err: Error) => logger.warn(`Queue prune failed: ${err.message}`));
    };
    runPrune();
    setInterval(runPrune, 24 * 60 * 60 * 1000).unref();
  }

  // Copilot tasks routinely outlive the delivery that dispatched them, so
  // nothing about their outcome is known until something checks back in.
  const runReconcile = (): void => {
    void reconcilePendingCopilotTasks(
      { copilotToken: process.env.DRIFT_COPILOT_TOKEN, repoToken, queue },
      logger,
    ).catch((err: Error) => logger.warn(`Copilot task reconciliation failed: ${err.message}`));
  };
  runReconcile();
  setInterval(runReconcile, 60_000).unref();

  server.listen(port, () => {
    logger.info(`Drift webhook server listening on :${port}`);
    if (!process.env.DRIFT_COPILOT_TOKEN) {
      logger.warn(
        'DRIFT_COPILOT_TOKEN is not set. Drift will analyse and file approval issues, but cannot dispatch fixes.',
      );
    }
  });

  // A deploy sends SIGTERM. Draining the job in flight is what keeps a restart
  // from turning into a duplicate analysis on the next startup.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${signal} received; finishing the delivery in flight before exiting`);
      void shutdown().then(
        () => process.exit(0),
        (err: Error) => {
          logger.error(`Shutdown failed: ${err.message}`);
          process.exit(1);
        },
      );
    });
  }

  return 0;
}

// Run when invoked directly rather than imported.
if (process.argv[1]?.endsWith('webhook.js')) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
