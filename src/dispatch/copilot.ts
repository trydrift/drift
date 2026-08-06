import type { RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';

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
    // Copilot works on the branch Drift already created, so its commits land
    // where the plan expects and the eventual PR targets the right base.
    base_ref: plan.branchName,
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
  const sections: string[] = [];

  sections.push(
    [
      '# Dependency compatibility fix',
      '',
      'A dependency in this repository was upgraded and the upgrade contains breaking',
      'changes. Your job is to update this repository’s code so it works with the new',
      'version. The dependency versions themselves are already updated — do not change',
      'them back, and do not change them further.',
      '',
      `You are working on branch \`${plan.branchName}\`, which is already checked out at`,
      `the commit containing the dependency update.`,
    ].join('\n'),
  );

  sections.push(
    [
      '## Dependency changes',
      '',
      ...plan.changes.map(
        (c) => `- \`${c.name}\` (${c.ecosystem}): ${c.from ?? '—'} → ${c.to ?? '—'} [${c.bump}]`,
      ),
    ].join('\n'),
  );

  sections.push(renderPromptFindings(plan));
  sections.push(renderPromptCommitPlan(plan));
  sections.push(renderPromptRules(plan, config));

  if (config.remediation.customInstructions.trim()) {
    sections.push(
      ['## Repository-specific instructions', '', config.remediation.customInstructions.trim()].join('\n'),
    );
  }

  sections.push(renderPromptCompletion(plan));

  return sections.join('\n\n');
}

function renderPromptFindings(plan: RemediationPlan): string {
  const evidenceById = new Map(plan.evidence.map((e) => [e.id, e]));
  const lines: string[] = ['## What broke, and why we know'];
  lines.push('');
  lines.push(
    'Each finding below was derived from upstream evidence, quoted so you can verify it',
    'rather than relying on recollection of this package’s API.',
  );
  lines.push('');

  for (const change of plan.breakingChanges) {
    const sites = plan.impactSites.filter((s) => s.breakingChangeId === change.id);
    if (sites.length === 0) continue;

    lines.push(`### ${change.summary}`);
    lines.push('');
    lines.push(`- Dependency: \`${change.dependency}\``);
    lines.push(`- Kind: ${change.kind}`);
    lines.push(`- Confidence: ${change.confidence}`);
    if (change.symbols.length) {
      lines.push(`- Affected symbols: ${change.symbols.map((s) => `\`${s}\``).join(', ')}`);
    }
    lines.push('');
    lines.push(`**Required fix:** ${change.remediation}`);
    lines.push('');

    for (const id of change.citations) {
      const evidence = evidenceById.get(id);
      if (!evidence) continue;
      lines.push(`<details><summary>Evidence: ${evidence.title}</summary>`);
      lines.push('');
      lines.push('```');
      lines.push(truncate(evidence.content, 1500));
      lines.push('```');
      if (evidence.url) lines.push(`Source: ${evidence.url}`);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function renderPromptCommitPlan(plan: RemediationPlan): string {
  const lines: string[] = [
    '## Commit plan — follow this exactly',
    '',
    'Make these commits by execution layer. Commits in the same layer are independent;',
    'a later layer must wait for every dependency listed on its units. Each one addresses',
    'a single concern so a human can review, approve, or revert it independently.',
    '**Do not squash them, do not reorder dependency edges, and do not combine unrelated edits into one commit.**',
    '',
  ];

  for (const commit of plan.commits) {
    lines.push(`---`);
    lines.push('');
    lines.push(`### Commit ${commit.order}: \`${commit.message}\``);
    lines.push('');
    lines.push(`- Unit id: \`${commit.id}\``);
    lines.push(`- Execution layer: ${commit.executionLayer}`);
    if (commit.dependsOn.length > 0) {
      lines.push(`- Depends on: ${commit.dependsOn.map((id) => `\`${id}\``).join(', ')}`);
      lines.push(
        `- Dependency reasons: ${commit.dependencyReasons
          .map((edge) => `${edge.reason} (${edge.evidence.slice(0, 3).join('; ')})`)
          .join('; ')}`,
      );
    }
    if (commit.expectedChecks.length > 0) {
      lines.push(`- Expected checks: ${commit.expectedChecks.map((check) => check.kind).join(', ')}`);
    }
    lines.push('');
    lines.push('Commit message body:');
    lines.push('');
    lines.push('```');
    lines.push(commit.body);
    lines.push('```');
    lines.push('');
    lines.push(`Files this commit may touch: ${commit.allowedFiles.map((f) => `\`${f}\``).join(', ')}`);
    lines.push('');
    lines.push(commit.instructions);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function renderPromptRules(plan: RemediationPlan, config: DriftConfig): string {
  const rules: string[] = [
    'Change only what is required to make this repository work with the new dependency version. No refactoring, renaming, reformatting, or tidying of code you happen to pass by.',
    'Do not modify dependency versions in any manifest or lockfile. The upgrade is the input to this task, not part of it.',
    'Verify each fix against the evidence quoted above and against the installed version of the package in this repository. If the evidence does not name a replacement API, look it up in the installed package rather than inventing one.',
    'If you cannot determine the correct fix for a location, leave the code as it is, add a clearly-marked `TODO(drift):` comment explaining what is unresolved, and say so in the pull request description. A flagged unknown is useful; a confident guess is not.',
    'Run the repository’s existing tests and build after each commit where that is possible.',
  ];

  if (config.guardrails.forbidTestWeakening) {
    rules.push(
      'Do not weaken, skip, or delete tests to make them pass. If a test fails because the API changed, update the test to exercise the new API while asserting the same behaviour. If a test fails for a reason you cannot resolve that way, leave it failing and explain why.',
    );
  }

  const protectedPaths = config.guardrails.protectedPaths;
  if (protectedPaths.length > 0) {
    rules.push(
      `Do not modify files matching any of these patterns: ${protectedPaths.map((p) => `\`${p}\``).join(', ')}.`,
    );
  }

  if (plan.warnings.length > 0) {
    rules.push(
      `Drift flagged the following for human attention; be conservative around them: ${plan.warnings.join(' ')}`,
    );
  }

  return ['## Rules', '', ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n');
}

function renderPromptCompletion(plan: RemediationPlan): string {
  return [
    '## When you are done',
    '',
    'Open a pull request into `' + plan.baseBranch + '`. In the description, include:',
    '',
    '- A short summary of what changed and why.',
    '- One line per commit, mapping it to the breaking change it addresses.',
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
      return `Copilot denied the request (403). The most common causes are: the token is a GitHub App installation token (the agent API requires a user-scoped token), the account has no Copilot seat, or the coding agent is disabled for this repository. Detail: ${detail}`;
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}
