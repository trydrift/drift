import type { RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { upgradeFixProtectedPaths, wholeUpgradeUnit } from '../remediation/worktree-runner.js';
import { renderUpgradeAgentPrompt } from '../agents/types.js';

/**
 * GitHub Copilot coding agent dispatch.
 *
 * ## The token constraint that shapes Drift's architecture
 *
 * The Copilot agent API accepts **user-to-server tokens only** — personal
 * access tokens, OAuth app tokens, or GitHub App *user* tokens. Server-to-server
 * (App installation) tokens are rejected, because Copilot is billed per seat and
 * GitHub needs to know whose seat is being spent.
 *
 * That single fact is why Drift ships primarily as a GitHub Action rather than a
 * hosted backend. In the Action, the user's token lives in their own repository
 * secrets and is read from the environment at run time. Drift never receives,
 * transmits, or stores it — which is what lets this MVP have no database and no
 * authentication system of its own.
 *
 * A hosted multi-tenant backend would have to store user OAuth tokens, and that
 * *would* require a database. See docs/copilot-integration.md.
 *
 * ## Why one task, not one per commit
 *
 * Drift sends a single task carrying the ordered commit plan, rather than N
 * tasks. Each task is an independent agent session with its own branch and PR,
 * so N tasks would produce N pull requests that cannot see each other's work —
 * and commit 3 usually depends on commit 1 having landed. One session with an
 * explicit commit plan preserves both the separation of concerns and the
 * sequencing.
 */

const AGENT_API_VERSION = '2022-11-28';

export interface CopilotDispatchOptions {
  /** User-scoped token. Never an App installation token. */
  copilotToken: string;
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  logger: Logger;
  /** Skip the network call and return what would have been sent. */
  dryRun?: boolean;
  baseUrl?: string;
}

export interface CopilotTask {
  id: string;
  state: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}

export interface CopilotDispatchResult {
  ok: boolean;
  task?: CopilotTask;
  /** The prompt sent, always populated — this is what a dry run inspects. */
  prompt: string;
  error?: string;
}

export async function dispatchToCopilot(
  options: CopilotDispatchOptions,
): Promise<CopilotDispatchResult> {
  const { copilotToken, repo, plan, config, logger, dryRun = false, baseUrl } = options;

  const prompt = buildTaskPrompt(plan, config);

  if (dryRun) {
    logger.info('Dry run: not dispatching to Copilot. The prompt is in the run output.');
    return { ok: true, prompt };
  }

  const endpoint = `${baseUrl ?? 'https://api.github.com'}/agents/repos/${repo.owner}/${repo.repo}/tasks`;

  const body: Record<string, unknown> = {
    prompt,
    // The two refs mean different things, and swapping them is not a cosmetic
    // error. `head_ref` names an *existing* branch the agent commits into;
    // `base_ref` names the branch a *new* one would be cut from. Drift has
    // already created `plan.branchName` and pushed the dependency update to
    // it, so that is the head. Passing it as `base_ref` (as this once did)
    // told Copilot to branch *off* Drift's branch and work somewhere else —
    // so the agent's commits landed on a branch Drift never looked at, while
    // Drift opened its pull request from the branch the agent had abandoned.
    head_ref: plan.branchName,
    base_ref: plan.baseBranch,
    // Always false: Drift is the sole PR creator (see `ensurePullRequest` in
    // dispatch/index.ts), which is what lets `pullRequest.enabled` and the
    // rest of the `pullRequest` config (draft, title, labels, reviewers)
    // actually govern whether a PR appears and what it looks like. Letting
    // Copilot open its own PR here would race Drift's, ignore that config
    // entirely, and — when `pullRequest.enabled` is false — open a PR anyway.
    create_pull_request: false,
  };
  if (config.remediation.model) body.model = config.remediation.model;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': AGENT_API_VERSION,
        Authorization: `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'drift-bot/0.1',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      return { ok: false, prompt, error: explainFailure(response.status, detail) };
    }

    const task = (await response.json()) as {
      id?: string;
      state?: string;
      pull_request?: { number?: number; html_url?: string };
    };

    logger.info(`Copilot task ${task.id} created (state: ${task.state})`);

    return {
      ok: true,
      prompt,
      task: {
        id: task.id ?? 'unknown',
        state: task.state ?? 'queued',
        pullRequestNumber: task.pull_request?.number,
        pullRequestUrl: task.pull_request?.html_url,
      },
    };
  } catch (err) {
    return { ok: false, prompt, error: `Request to the Copilot agent API failed: ${(err as Error).message}` };
  }
}

/** Poll a task's state. Used by the verification stage. */
export async function getTaskStatus(
  options: { copilotToken: string; repo: RepoContext; taskId: string; baseUrl?: string },
): Promise<CopilotTask | null> {
  const { copilotToken, repo, taskId, baseUrl } = options;
  const endpoint = `${baseUrl ?? 'https://api.github.com'}/agents/repos/${repo.owner}/${repo.repo}/tasks/${taskId}`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': AGENT_API_VERSION,
        Authorization: `Bearer ${copilotToken}`,
        'User-Agent': 'drift-bot/0.1',
      },
    });
    if (!response.ok) return null;

    const task = (await response.json()) as {
      id?: string;
      state?: string;
      pull_request?: { number?: number; html_url?: string };
    };

    return {
      id: task.id ?? taskId,
      state: task.state ?? 'unknown',
      pullRequestNumber: task.pull_request?.number,
      pullRequestUrl: task.pull_request?.html_url,
    };
  } catch {
    return null;
  }
}

/** Terminal states, so callers know when to stop polling. */
export function isTerminalState(state: string): boolean {
  return ['completed', 'failed', 'timed_out', 'cancelled'].includes(state);
}

/**
 * Poll a task until it reaches a terminal state, or give up at `timeoutMs`.
 *
 * Built for a one-shot caller — the Action — that has no other opportunity to
 * learn how the task it just dispatched turned out. It is deliberately not
 * used by the shared `dispatch()` path: the webhook runner processes
 * deliveries one at a time (see `queue/worker.ts`), and blocking that loop for
 * however long an agent session takes would stall every other repository it
 * watches. Returns the last known task state, or `null` if the very first
 * lookup failed.
 */
export async function awaitTerminalState(options: {
  copilotToken: string;
  repo: RepoContext;
  taskId: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CopilotTask | null> {
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + options.timeoutMs;

  let task = await getTaskStatus(options);

  while ((!task || !isTerminalState(task.state)) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    task = await getTaskStatus(options);
  }

  return task;
}

/**
 * Build the agent prompt.
 *
 * The structure matters as much as the content. The agent is given:
 *   - the exact changes to make, with evidence, so it does not have to guess;
 *   - the commit boundaries, so separation of concerns survives;
 *   - explicit prohibitions, because the failure modes of an unsupervised
 *     coding agent are predictable — weakening tests to make them pass,
 *     "fixing" unrelated code it noticed, and inventing replacement APIs.
 */
export function buildTaskPrompt(plan: RemediationPlan, config: DriftConfig): string {
  // The same task a local Fix with AI session gets — see
  // `renderUpgradeAgentPrompt` for why it is the plain task and not Drift's
  // findings — plus what only a cloud agent needs: where it is working, and
  // how to hand the result back.
  const body = renderUpgradeAgentPrompt({
    plan,
    commit: wholeUpgradeUnit(plan),
    files: [],
    customInstructions: config.remediation.customInstructions,
    mode: 'upgrade',
    protectedPaths: upgradeFixProtectedPaths(config.guardrails.protectedPaths),
  });
  return [
    '# Dependency upgrade fix',
    '',
    `You are working on branch \`${plan.branchName}\`, which is already checked out at the commit containing the dependency update.`,
    '',
    body,
    '',
    renderPromptCompletion(plan),
  ].join('\n');
}

function renderPromptCompletion(plan: RemediationPlan): string {
  return [
    '## When you are done',
    '',
    'Open a pull request into `' + plan.baseBranch + '`. In the description, include:',
    '',
    '- A short summary of what changed and why.',
    '- **Anything you could not fix, or fixed with low confidence.** This is the most',
    '  important part of the description: the reviewer needs to know where to look.',
    '- Any place where you had to choose between plausible interpretations, and which',
    '  one you chose.',
    '',
    'Do not merge the pull request.',
  ].join('\n');
}

/** Turn an HTTP failure into something the user can act on. */
function explainFailure(status: number, detail: string): string {
  switch (status) {
    case 401:
      return 'Copilot rejected the token (401). Check that DRIFT_COPILOT_TOKEN is set and has not expired.';
    case 403:
      return (
        `Copilot denied the request (403). The most common causes, in the order worth checking: the token lacks ` +
        `the "Agent tasks: read and write" permission (this is the only permission the endpoint checks, and it is ` +
        `not implied by contents/issues/pull-request access); the token is a GitHub App installation token, which ` +
        `is not supported at all; the account has no Copilot seat, or a plan that cannot call this endpoint — it ` +
        `is in public preview and GitHub decides which plans may (see ` +
        `https://docs.github.com/en/rest/agent-tasks/agent-tasks); or the coding agent is disabled for this ` +
        `repository. Detail: ${detail}`
      );
    case 404:
      return 'The Copilot agent API returned 404. Either the coding agent is not enabled for this repository, or the token lacks access to it.';
    case 422:
      return `Copilot rejected the request as invalid (422): ${detail}`;
    case 429:
      return 'Copilot rate-limited the request (429). Try again shortly.';
    default:
      return `Copilot agent API returned ${status}: ${detail}`;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '(no response body)';
  }
}

