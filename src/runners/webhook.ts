import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DispatchResult, RemediationPlan, RepoContext } from '../types.js';
import { loadConfig } from '../config/load.js';
import { DEFAULT_CONFIG, type DriftConfig } from '../config/schema.js';
import { GitHubClient } from '../github/client.js';
import { runPipeline } from '../pipeline.js';
import { createLogger, type Logger, type LogLevel } from '../util/logger.js';
import { matchesAny } from '../util/glob.js';
import { applyApproval } from '../approval/apply.js';
import type { JobQueue } from '../queue/types.js';
import { QueueWorker } from '../queue/worker.js';
import { MemoryJobQueue } from '../queue/memory.js';
import { SqliteJobQueue } from '../queue/sqlite.js';
import { reconcileCloudTask } from '../remediation/cloud-lifecycle.js';
import { credentialsWithLegacyCopilot, agentConfigWithLegacyCopilot } from '../agents/compat.js';
import { defaultAgentProviderRegistry, isCloudFixAgent, type AgentProviderRegistry } from '../agents/registry.js';
import { resolveAgentSelection } from '../agents/selection.js';
import type { AgentCredentialSet } from '../agents/selection.js';
import type { FixAgent } from '../agents/types.js';

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
  credentials?: AgentCredentialSet;
  agentRegistry?: AgentProviderRegistry;
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
  const agentResolution = await resolveWebhookAgent({ repo, config, options, logger });

  const result = await runPipeline({
    repo,
    config: agentResolution.config,
    logger,
    github,
    agent: agentResolution.agent,
    githubToken: options.repoToken,
    dryRun: options.dryRun,
    // No workspace: localization is unavailable here, and the pipeline warns.
    workspace: undefined,
  });

  logger.info(`${repo.owner}/${repo.repo}: ${result.summary}`);

  // The check run posted during dispatch says "Copilot is fixing…" — it never
  // learns whether that turned out true unless something asks GitHub later.
  // Recording the task here is what lets `reconcilePendingCloudTasks` find
  // it after this delivery has long since been acknowledged.
  //
  // Caught rather than left to propagate: the task is already dispatched, so
  // letting this failure fail the job would have the worker retry the whole
  // delivery — re-running the pipeline and dispatching a second task for the
  // same push. Losing the reconciliation record instead of duplicating the
  // dispatch is the safer failure, but it must not be a silent one.
  try {
    await recordDispatchedTask(options.queue, repo, result.dispatch, result.plan);
  } catch (err) {
    logger.error(`Failed to record dispatched task for reconciliation: ${(err as Error).message}`);
    if (result.dispatch.status === 'dispatched') {
      await github.createCheckRun(repo, {
        name: 'Drift',
        conclusion: 'action_required',
        title: 'Copilot task dispatched, but not tracked',
        summary:
          `Copilot task ${result.dispatch.taskId ?? '(unknown id)'} was dispatched for this push, but Drift ` +
          `could not record it for status tracking (${(err as Error).message}). It will not automatically ` +
          `receive a pass/fail update when it finishes — check ${result.dispatch.pullRequestUrl ?? 'the branch'} manually.`,
      });
    }
  }
}

/**
 * Record a successful dispatch so `reconcilePendingCloudTasks` can find it
 * later. Shared by the push path above and `/drift apply` below — both
 * dispatch through the same `dispatch()` call and need the same follow-up.
 */
async function recordDispatchedTask(
  queue: JobQueue,
  repo: RepoContext,
  result: DispatchResult,
  plan?: RemediationPlan | null,
): Promise<void> {
  if (result.status !== 'dispatched' || !result.taskId) return;
  await queue.recordPendingCloudTask({
    provider: result.taskProvider ?? '',
    owner: repo.owner,
    repo: repo.repo,
    taskId: result.taskId,
    headSha: repo.afterSha,
    branchName: result.branchName ?? '',
    prNumber: result.pullRequestNumber ?? null,
    prUrl: result.pullRequestUrl ?? null,
    planJson: plan ? JSON.stringify(plan) : null,
  });
}

async function resolveWebhookAgent(args: {
  repo: RepoContext;
  config: DriftConfig;
  options: WebhookServerOptions;
  logger: Logger;
}): Promise<{ config: DriftConfig; agent?: FixAgent }> {
  const registry = args.options.agentRegistry ?? defaultAgentProviderRegistry;
  const credentials = credentialsWithLegacyCopilot(args.options.credentials, args.options.copilotToken);
  const agentConfig = agentConfigWithLegacyCopilot(args.config.remediation.agent, {
    token: args.options.copilotToken,
    model: args.config.remediation.model,
  });
  const config: DriftConfig = {
    ...args.config,
    remediation: { ...args.config.remediation, agent: agentConfig },
  };
  const available = await registry.available({
    repo: args.repo,
    config,
    logger: args.logger,
    credentials,
    dryRun: args.options.dryRun,
    surface: 'webhook',
  });
  const selection = resolveAgentSelection({
    config: config.remediation.agent,
    runtime: {
      surface: 'webhook',
      interactive: false,
      eligibleProviders: [...available.keys()],
      credentials,
    },
  });

  if (selection.source === 'unresolved') {
    args.logger.warn(selection.reason);
    return { config };
  }

  const agent = await registry.create(selection.provider, {
    repo: args.repo,
    config,
    logger: args.logger,
    credentials,
    dryRun: args.options.dryRun,
    surface: 'webhook',
  });
  if (!agent) {
    args.logger.warn(`${selection.provider} was selected, but no provider adapter could create an agent.`);
    return { config };
  }
  return { config, agent };
}

/**
 * Ask each cloud provider how its still-open task turned out, and post a final
 * check run when one reaches a terminal state.
 *
 * Dispatch posts a `neutral` check run the moment the task is created,
 * because nothing about completion, failure, or timeout is known yet. This is
 * the other half of that promise: without it, "Copilot is fixing…" is the
 * last word the check run ever has, whatever actually happened.
 */
export async function reconcilePendingCloudTasks(
  options: Pick<WebhookServerOptions, 'copilotToken' | 'repoToken' | 'queue' | 'credentials' | 'agentRegistry'>,
  logger: Logger,
): Promise<void> {
  const pending = await options.queue.listPendingCloudTasks();
  if (pending.length === 0) return;

  const github = new GitHubClient({ repoToken: options.repoToken, logger });
  const registry = options.agentRegistry ?? defaultAgentProviderRegistry;
  const credentials = credentialsWithLegacyCopilot(options.credentials, options.copilotToken);

  for (const pendingTask of pending) {
    const repo: RepoContext = {
      owner: pendingTask.owner,
      repo: pendingTask.repo,
      baseBranch: '',
      beforeSha: '',
      afterSha: pendingTask.headSha,
    };
    const agent = await registry.create(pendingTask.provider, {
      repo,
      config: DEFAULT_CONFIG,
      logger,
      credentials,
      surface: 'webhook',
    });
    if (!agent || !isCloudFixAgent(agent)) {
      logger.warn(`Cannot reconcile cloud task ${pendingTask.taskId}: provider \`${pendingTask.provider}\` is not available.`);
      continue;
    }

    const reconciliation = await reconcileCloudTask({ task: pendingTask, agent, github, logger });
    if (!reconciliation.terminal) continue;

    await github.createCheckRun(repo, {
      name: 'Drift',
      conclusion: reconciliation.conclusion ?? 'action_required',
      title: reconciliation.title ?? `${agent.label} reached ${reconciliation.state ?? 'terminal state'}`,
      summary: reconciliation.summary ?? `${agent.label} reached terminal state ${reconciliation.state ?? 'unknown'}.`,
    });

    logger.info(
      `${agent.label} task ${pendingTask.taskId} on ${pendingTask.owner}/${pendingTask.repo} reached terminal state ${reconciliation.state ?? 'unknown'}`,
    );
    await options.queue.resolvePendingCloudTask(pendingTask.id);
  }
}

/** @deprecated Use `reconcilePendingCloudTasks`. */
export const reconcilePendingCopilotTasks = reconcilePendingCloudTasks;

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
    credentials: credentialsWithLegacyCopilot(options.credentials, options.copilotToken),
    agentRegistry: options.agentRegistry,
    ...(options.dryRun ? { dryRun: true } : {}),
    // No checkout on this deployment, so no localization. The pipeline warns.
    // `/drift apply` dispatches a cloud task the same way the push path
    // does, and needs the same follow-up — without this, an approved plan's
    // task was recorded nowhere and `reconcilePendingCloudTasks` never saw
    // it.
    onDispatched: (result, dispatchRepo, plan) => recordDispatchedTask(options.queue, dispatchRepo, result, plan),
    // Durable idempotency, independent of the GitHub comment marker
    // `applyApproval` also posts. That comment is a plain API call which can
    // fail without `commentOnIssue` telling its caller — this is the second,
    // reliable source that a repeated `/drift apply` checks and writes to, so
    // a lost comment cannot lead to dispatching the same plan twice.
    dispatchStore: {
      find: (owner, dispatchRepoName, planDigest) =>
        options.queue.findDispatchedPlan(owner, dispatchRepoName, planDigest).then((record) =>
          record
            ? {
                ...(record.taskId ? { taskId: record.taskId } : {}),
                ...(record.branchName ? { branchName: record.branchName } : {}),
                ...(record.prNumber !== null ? { pullRequestNumber: record.prNumber } : {}),
              }
            : null,
        ),
      record: (dispatchOwner, dispatchRepoName, planDigest, result) =>
        options.queue.recordDispatchedPlan({
          owner: dispatchOwner,
          repo: dispatchRepoName,
          planDigest,
          ...(result.taskId ? { taskId: result.taskId } : {}),
          ...(result.branchName ? { branchName: result.branchName } : {}),
          prNumber: result.pullRequestNumber ?? null,
          prUrl: result.pullRequestUrl ?? null,
        }),
    },
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

/**
 * Bind the server and resolve once it is actually listening.
 *
 * The `error` listener is attached before `listen()` is called — attaching it
 * after would race a synchronous-ish bind failure (e.g. an already-in-use
 * port on some platforms) that fires before the handler is registered, which
 * is exactly the kind of gap that let a bad port surface as an unhandled
 * error instead of a clean non-zero exit.
 */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
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
    void reconcilePendingCloudTasks(
      { copilotToken: process.env.DRIFT_COPILOT_TOKEN, repoToken, queue },
      logger,
    ).catch((err: Error) => logger.warn(`Cloud task reconciliation failed: ${err.message}`));
  };
  runReconcile();
  setInterval(runReconcile, 60_000).unref();

  try {
    await listen(server, port);
  } catch (err) {
    // `server.listen` is asynchronous; without waiting on its outcome here,
    // a bind failure (EADDRINUSE, EACCES, …) would surface later as an
    // unhandled error, after this function had already returned 0 and told
    // the caller startup succeeded. The `error` listener is attached inside
    // `listen` before `listen()` is called, so a synchronous-ish failure
    // cannot fire it before anything is watching.
    logger.error(`Drift webhook server failed to start on :${port}: ${(err as Error).message}`);
    return 1;
  }

  logger.info(`Drift webhook server listening on :${port}`);
  if (!process.env.DRIFT_COPILOT_TOKEN) {
    logger.warn(
      'DRIFT_COPILOT_TOKEN is not set. Drift will analyse and file approval issues, but cannot dispatch fixes.',
    );
  }

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
