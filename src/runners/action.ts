import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import type { RepoContext } from '../types.js';
import { loadConfig } from '../config/load.js';
import { GitHubClient } from '../github/client.js';
import { runPipeline } from '../pipeline.js';
import { renderPullRequestBody } from '../report/markdown.js';
import { createLogger, type LogLevel } from '../util/logger.js';
import { matchesAny } from '../util/glob.js';

/**
 * GitHub Action entrypoint — Drift's primary runner.
 *
 * This is the recommended deployment because of what it does *not* require:
 * no backend to host, no database, no OAuth flow, and no custody of anyone's
 * credentials. The Copilot token lives in the customer's own repository
 * secrets, and the workflow's built-in GITHUB_TOKEN covers everything else.
 *
 * The whole product runs inside the customer's trust boundary.
 */

interface ActionInputs {
  repoToken: string;
  copilotToken?: string;
  mode?: 'auto' | 'approve';
  dryRun: boolean;
  logLevel: LogLevel;
  workspace: string;
  configPath?: string;
}

export async function runAction(): Promise<number> {
  const inputs = readInputs();
  const logger = createLogger(inputs.logLevel);

  const event = await readEventPayload();
  const repo = resolveRepoContext(event, inputs.workspace);

  if (!repo) {
    logger.error(
      'Could not determine the repository and commit range from the event payload. Drift supports `push`, `workflow_dispatch`, and `issue_comment` events.',
    );
    return 1;
  }

  const github = new GitHubClient({ repoToken: inputs.repoToken, logger });

  const { config, path, problems } = await loadConfig(async (candidate) =>
    readWorkspaceFile(inputs.workspace, inputs.configPath ?? candidate),
  );
  for (const problem of problems) logger.warn(problem);
  logger.info(path ? `Loaded config from ${path}` : 'No drift.yml found; using defaults (mode: approve)');

  // A workflow input overrides the committed config, so a team can trial
  // `auto` from a manual run without editing a file in their repo.
  const effectiveConfig = inputs.mode ? { ...config, mode: inputs.mode } : config;

  if (!matchesAny(effectiveConfig.watchBranches, repo.baseBranch)) {
    logger.info(
      `Branch \`${repo.baseBranch}\` is not in \`watchBranches\` (${effectiveConfig.watchBranches.join(', ')}); nothing to do.`,
    );
    return 0;
  }

  const approved = isApprovalComment(event);
  if (approved) logger.info('Running with human approval from a `/drift apply` comment.');

  if (effectiveConfig.mode === 'auto' && !inputs.copilotToken && !inputs.dryRun) {
    logger.warn(
      'mode is `auto` but no copilot-token input was supplied. Drift will analyse and file an approval issue instead of dispatching. See docs/copilot-integration.md.',
    );
  }

  try {
    const result = await runPipeline({
      repo,
      config: effectiveConfig,
      logger,
      github,
      copilotToken: inputs.copilotToken,
      dryRun: inputs.dryRun,
      approved,
      workspace: inputs.workspace,
    });

    await writeOutputs(result.dispatch, result.summary);
    if (result.plan) await writeJobSummary(renderPullRequestBody(result.plan, effectiveConfig));

    // A blocked plan is a successful run: Drift did its job and correctly
    // asked a human. Failing the workflow here would train people to ignore it.
    return result.dispatch.status === 'failed' ? 1 : 0;
  } catch (err) {
    logger.error(`Drift failed: ${(err as Error).message}`);
    logger.debug((err as Error).stack ?? '');
    return 1;
  }
}

function readInputs(): ActionInputs {
  const mode = actionInput('mode');
  return {
    repoToken: actionInput('repo-token') ?? process.env.GITHUB_TOKEN ?? '',
    copilotToken: actionInput('copilot-token') || process.env.DRIFT_COPILOT_TOKEN || undefined,
    mode: mode === 'auto' || mode === 'approve' ? mode : undefined,
    dryRun: (actionInput('dry-run') ?? '').toLowerCase() === 'true',
    logLevel: (actionInput('log-level') as LogLevel) || 'info',
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    configPath: actionInput('config-path') || undefined,
  };
}

/** Actions passes inputs as `INPUT_<NAME>` with spaces replaced by underscores. */
function actionInput(name: string): string | undefined {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const value = process.env[key];
  return value?.trim() || undefined;
}

async function readEventPayload(): Promise<Record<string, unknown>> {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Derive the repository and commit range from the event.
 *
 * The `before` SHA is the crux. On a normal push GitHub supplies it; on a
 * first push to a branch it is all zeroes, and on `workflow_dispatch` there is
 * none — in both cases Drift falls back to the commit's first parent, which is
 * the right comparison point for a dependency diff.
 */
function resolveRepoContext(
  event: Record<string, unknown>,
  workspace: string,
): RepoContext | null {
  const repository = event.repository as { full_name?: string; default_branch?: string } | undefined;
  const fullName = repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  if (!fullName) return null;

  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;

  const ref = (event.ref as string | undefined) ?? process.env.GITHUB_REF ?? '';
  const baseBranch =
    ref.replace('refs/heads/', '') ||
    repository?.default_branch ||
    process.env.GITHUB_REF_NAME ||
    'main';

  const afterSha = (event.after as string | undefined) ?? process.env.GITHUB_SHA ?? '';
  if (!afterSha) return null;

  const rawBefore = event.before as string | undefined;
  const beforeSha =
    rawBefore && !/^0+$/.test(rawBefore) ? rawBefore : `${afterSha}^`;

  return { owner, repo, baseBranch, beforeSha, afterSha, workspace };
}

/** True when this run was triggered by a `/drift apply` comment. */
function isApprovalComment(event: Record<string, unknown>): boolean {
  const comment = event.comment as { body?: string } | undefined;
  if (!comment?.body) return false;
  return /^\s*\/drift\s+apply\b/im.test(comment.body);
}

async function readWorkspaceFile(workspace: string, path: string): Promise<string | null> {
  try {
    return await readFile(`${workspace}/${path}`, 'utf8');
  } catch {
    return null;
  }
}

async function writeOutputs(
  result: { status: string; branchName?: string; pullRequestUrl?: string; approvalIssueNumber?: number },
  summary: string,
): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;

  const outputs: Record<string, string> = {
    status: result.status,
    summary,
    branch: result.branchName ?? '',
    'pull-request-url': result.pullRequestUrl ?? '',
    'approval-issue': result.approvalIssueNumber?.toString() ?? '',
  };

  const lines = Object.entries(outputs).map(([key, value]) =>
    // Multi-line values need heredoc syntax, and the delimiter must not appear
    // in the value itself.
    value.includes('\n') ? `${key}<<DRIFT_EOF\n${value}\nDRIFT_EOF` : `${key}=${value}`,
  );

  try {
    await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // Outputs are a convenience; losing them must not fail the run.
  }
}

async function writeJobSummary(markdown: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    await appendFile(path, `${markdown}\n`, 'utf8');
  } catch {
    // Non-fatal, same reasoning as outputs.
  }
}
