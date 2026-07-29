import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RepoContext } from '../types.js';
import { loadConfig } from '../config/load.js';
import { GitHubClient } from '../github/client.js';
import { runPipeline } from '../pipeline.js';
import { createLogger, type Logger, type LogLevel } from '../util/logger.js';
import { matchesAny } from '../util/glob.js';

/**
 * Stateless GitHub App webhook runner — the secondary deployment.
 *
 * This is the "GitHub App that listens to your repos" experience, and it is
 * genuinely stateless: no database, no session store, no queue. Every piece of
 * durable state Drift needs already lives in GitHub — plans are filed as
 * issues, approvals are comments on those issues, and plan IDs are derived
 * from content so a re-run finds its own prior work.
 *
 * ## Two honest limitations
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
 * Both limitations are properties of the deployment model, not bugs. The
 * Action has neither.
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
}

export function createWebhookServer(options: WebhookServerOptions) {
  const logger = options.logger ?? createLogger((process.env.DRIFT_LOG_LEVEL as LogLevel) ?? 'info');

  return createServer((req, res) => {
    void handleRequest(req, res, options, logger).catch((err) => {
      logger.error(`Unhandled error: ${(err as Error).message}`);
      if (!res.headersSent) respond(res, 500, { error: 'internal error' });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebhookServerOptions,
  logger: Logger,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    respond(res, 200, { status: 'ok', stateless: true });
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
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    respond(res, 400, { error: 'invalid JSON' });
    return;
  }

  // GitHub expects a fast acknowledgement; the pipeline makes many network
  // calls and would blow the delivery timeout if awaited here.
  respond(res, 202, { accepted: true, event: eventName });

  void processEvent(eventName, payload, options, logger).catch((err) => {
    logger.error(`Processing ${eventName} failed: ${(err as Error).message}`);
  });
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
}

/**
 * `/drift apply` on an approval issue.
 *
 * This is the whole approval mechanism. The issue body holds the plan, the
 * comment is the approval, and GitHub stores both — so re-analysing from the
 * recorded commit reproduces the identical plan (IDs are content-derived) and
 * dispatches it.
 */
async function handleIssueComment(
  payload: Record<string, unknown>,
  options: WebhookServerOptions,
  logger: Logger,
): Promise<void> {
  const action = payload.action as string | undefined;
  if (action !== 'created') return;

  const comment = payload.comment as { body?: string } | undefined;
  const issue = payload.issue as { number?: number; body?: string; pull_request?: unknown } | undefined;
  const repository = payload.repository as
    | { full_name?: string; default_branch?: string }
    | undefined;

  if (!comment?.body || !issue?.number || !repository?.full_name) return;
  if (issue.pull_request) return; // Comments on PRs are not approvals.
  if (!/^\s*\/drift\s+apply\b/im.test(comment.body)) return;

  const [owner, repoName] = repository.full_name.split('/');
  if (!owner || !repoName) return;

  const sha = extractAnalysedSha(issue.body ?? '');
  if (!sha) {
    logger.warn(`Issue #${issue.number} has no recorded commit; cannot reproduce the plan.`);
    return;
  }

  const repo: RepoContext = {
    owner,
    repo: repoName,
    baseBranch: repository.default_branch ?? 'main',
    beforeSha: `${sha}^`,
    afterSha: sha,
  };

  const github = new GitHubClient({ repoToken: options.repoToken, logger });
  const { config } = await loadConfig((path) => github.readFile(repo, path, sha));

  logger.info(`Applying approved plan from #${issue.number} in ${repository.full_name}`);

  const result = await runPipeline({
    repo,
    config,
    logger,
    github,
    copilotToken: options.copilotToken,
    dryRun: options.dryRun,
    approved: true,
    workspace: undefined,
  });

  await github.commentOnIssue(repo, issue.number, result.summary);
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

/** Recover the analysed commit from a Drift issue body's footer. */
function extractAnalysedSha(body: string): string | null {
  return /drift-commit:\s*([0-9a-f]{7,40})/i.exec(body)?.[1] ?? null;
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

/** Entry point for `npm run serve`. */
export function main(): void {
  const logger = createLogger((process.env.DRIFT_LOG_LEVEL as LogLevel) ?? 'info');

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  const repoToken = process.env.GITHUB_TOKEN ?? '';

  if (!webhookSecret || !repoToken) {
    logger.error(
      'GITHUB_WEBHOOK_SECRET and GITHUB_TOKEN must both be set. Drift refuses to run a webhook server that cannot verify signatures.',
    );
    process.exitCode = 1;
    return;
  }

  const port = Number(process.env.PORT ?? 3000);
  const server = createWebhookServer({
    port,
    webhookSecret,
    repoToken,
    copilotToken: process.env.DRIFT_COPILOT_TOKEN,
    logger,
    dryRun: process.env.DRIFT_DRY_RUN === 'true',
  });

  server.listen(port, () => {
    logger.info(`Drift webhook server listening on :${port}`);
    if (!process.env.DRIFT_COPILOT_TOKEN) {
      logger.warn(
        'DRIFT_COPILOT_TOKEN is not set. Drift will analyse and file approval issues, but cannot dispatch fixes.',
      );
    }
  });
}

// Run when invoked directly rather than imported.
if (process.argv[1]?.endsWith('webhook.js')) main();
