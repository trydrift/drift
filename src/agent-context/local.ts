import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../config/load.js';
import type { DriftConfig } from '../config/schema.js';
import { availableChecks } from '../verification/checks.js';
import { GitHubClient } from '../github/client.js';
import { runPipeline } from '../pipeline.js';
import { LocalGitProvider, WORKING_TREE, chooseManifestRange, inspectLocalRepo } from '../repo/local-git.js';
import type { RemediationPlan, RepoContext } from '../types.js';
import { createLogger } from '../util/logger.js';

/**
 * A plan for the dependency change already present in a local checkout.
 *
 * The same read-only path as `drift analyze`: the range is the one the CLI and
 * the editor pick (an uncommitted manifest edit, else the last commit that
 * touched a manifest), the pipeline runs with `dryRun`, and nothing is written.
 * Kept here rather than in the CLI so the MCP server and `drift analyze
 * --agent` answer the same question the same way.
 */

export interface LocalPlanRequest {
  directory: string;
  before?: string;
  after?: string;
  /** Install the change in a scratch worktree and run this project's checks. Still capped by `verify.enabled` in drift.yml. */
  verify: boolean;
}

export interface LocalPlanResult {
  plan: RemediationPlan | null;
  config: DriftConfig;
  range: { before: string; after: string } | null;
  summary: string;
  /** Checks this repository offers, for the brief to name when verification measured none. */
  checks: { label: string; kind: string }[];
}

export async function planLocalChange(request: LocalPlanRequest): Promise<LocalPlanResult> {
  const workspace = resolve(request.directory);
  const logger = createLogger('error');
  const { config } = await loadConfig(async (candidate) => {
    try {
      return await readFile(resolve(workspace, candidate), 'utf8');
    } catch {
      return null;
    }
  });
  const checks = (await availableChecks(workspace)).map((check) => ({ label: check.label, kind: check.kind }));

  const range = await resolveLocalRange(workspace, request);
  if (!range) {
    return {
      plan: null,
      config,
      range: null,
      summary:
        'No dependency change found in this checkout: no uncommitted manifest edit, and no commit that touched a manifest. Pass before/after to name the range.',
      checks,
    };
  }

  const repo: RepoContext = {
    owner: 'local',
    repo: 'workspace',
    baseBranch: 'HEAD',
    beforeSha: range.before,
    afterSha: range.after,
    workspace,
  };

  const result = await runPipeline({
    repo,
    config,
    logger,
    github: new GitHubClient({ repoToken: process.env.GITHUB_TOKEN ?? '', logger }),
    provider: new LocalGitProvider(workspace, range),
    ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
    dryRun: true,
    workspace,
    verify: { enabled: request.verify && config.verify.enabled },
  });

  return { plan: result.plan, config, range, summary: result.summary, checks };
}

async function resolveLocalRange(
  workspace: string,
  request: LocalPlanRequest,
): Promise<{ before: string; after: string } | null> {
  if (request.before || request.after) {
    const info = await inspectLocalRepo(workspace);
    const after = request.after ?? info?.headSha ?? 'HEAD';
    const before = request.before ?? info?.parentSha ?? `${after}^`;
    return { before, after };
  }
  const info = await inspectLocalRepo(workspace);
  if (!info) return null;
  return chooseManifestRange(workspace, info);
}

export { WORKING_TREE };
