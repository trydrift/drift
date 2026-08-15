import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import type { DispatchResult, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { GitHubClient } from '../github/client.js';
import { runPipeline } from '../pipeline.js';
import { DRIFT_LABEL } from '../dispatch/index.js';
import { renderPullRequestBody } from '../report/markdown.js';
import {
  buildSarifLog,
  DEPENDENCY_KIND_LABELS,
  findingsFromCandidates,
  findingsFromPlan,
  type AlertGranularity,
  type SarifFinding,
} from '../report/sarif.js';
import { scanUpgrades, type UpgradeCandidate } from '../upgrade/scan.js';
import { createLogger, type Logger, type LogLevel } from '../util/logger.js';
import { matchesAny } from '../util/glob.js';
import { applyApproval } from '../approval/apply.js';
import { awaitTerminalState, isTerminalState } from '../dispatch/copilot.js';

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
  /** `diff` (default) analyses the push; `outdated` scans every installed dependency instead. */
  scanMode?: 'diff' | 'outdated';
  /** Overrides `codeScanning.granularity` in drift.yml. */
  alertGranularity?: AlertGranularity;
}

export async function runAction(): Promise<number> {
  const inputs = readInputs();
  const logger = createLogger(inputs.logLevel);

  // Fail fast rather than running the whole pipeline and dying on a 401 at the
  // very end, after the user has waited through evidence gathering.
  if (!inputs.repoToken) {
    logger.error(
      'No repository token available. Pass `repo-token: ${{ secrets.GITHUB_TOKEN }}` to the action, or set GITHUB_TOKEN.',
    );
    return 1;
  }

  const event = await readEventPayload();
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';

  const github = new GitHubClient({ repoToken: inputs.repoToken, logger });

  // An approval runs against the commit recorded on the issue, which is not the
  // commit this workflow is checked out at. `issue_comment` sets GITHUB_SHA to
  // the default branch tip, so deriving the range from the event here would
  // analyse — and then modify — whatever happens to be on the branch now rather
  // than the plan a human actually read. It is handled entirely separately.
  if (eventName === 'issue_comment') {
    return runApproval(event, inputs, github, logger);
  }

  const repo = resolveRepoContext(event, inputs.workspace);

  if (!repo) {
    logger.error(
      'Could not determine the repository and commit range from the event payload. Drift supports `push`, `workflow_dispatch`, `schedule`, and `issue_comment` events.',
    );
    return 1;
  }

  const { config, path, problems } = await loadConfig(async (candidate) =>
    readWorkspaceFile(inputs.workspace, inputs.configPath ?? candidate),
  );
  for (const problem of problems) logger.warn(problem);
  logger.info(path ? `Loaded config from ${path}` : 'No drift.yml found; using defaults (mode: approve)');

  // A workflow input overrides the committed config, so a team can trial
  // `auto` from a manual run without editing a file in their repo.
  let effectiveConfig = inputs.mode ? { ...config, mode: inputs.mode } : config;
  if (inputs.alertGranularity) {
    effectiveConfig = {
      ...effectiveConfig,
      codeScanning: { ...effectiveConfig.codeScanning, granularity: inputs.alertGranularity },
    };
  }

  // A `schedule` trigger, or an explicit `scan-mode: outdated` on a manual
  // dispatch, means "check every installed dependency against its registry"
  // rather than "what changed in this push" — a different question with no
  // commit range to diff, so it branches off before any of the range/
  // watchBranches logic below, which does not apply to it.
  if (eventName === 'schedule' || inputs.scanMode === 'outdated') {
    return runOutdatedScan(repo, effectiveConfig, github, inputs, logger);
  }

  if (!matchesAny(effectiveConfig.watchBranches, repo.baseBranch)) {
    logger.info(
      `Branch \`${repo.baseBranch}\` is not in \`watchBranches\` (${effectiveConfig.watchBranches.join(', ')}); nothing to do.`,
    );
    return 0;
  }

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
      githubToken: inputs.repoToken,
      dryRun: inputs.dryRun,
      // Never approved on this path. Approval arrives only through
      // `issue_comment`, and only after `applyApproval` has verified it.
      approved: false,
      workspace: inputs.workspace,
    });

    await writeOutputs(result.dispatch, result.summary);
    if (result.plan) {
      await writeJobSummary(renderPullRequestBody(result.plan, effectiveConfig));
      const findings = await findingsFromPlan(result.plan, {
        includeInformational: effectiveConfig.codeScanning.includeInformational,
        granularity: effectiveConfig.codeScanning.granularity,
        repoBlobUrl: `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.afterSha}`,
        githubToken: inputs.repoToken,
      });
      await uploadCodeScanning({ repo, config: effectiveConfig, github, logger, findings, category: 'drift/diff' });
      await createIssuesForFindings({ repo, config: effectiveConfig, github, logger, findings, category: 'drift/diff' });
    }

    if (result.dispatch.status === 'dispatched') {
      await maybeAwaitCopilotCompletion({
        config: effectiveConfig,
        repo,
        dispatchResult: result.dispatch,
        github,
        copilotToken: inputs.copilotToken,
        logger,
      });
    }

    // A blocked plan is a successful run: Drift did its job and correctly
    // asked a human. Failing the workflow here would train people to ignore it.
    return result.dispatch.status === 'failed' ? 1 : 0;
  } catch (err) {
    logger.error(`Drift failed: ${(err as Error).message}`);
    logger.debug((err as Error).stack ?? '');
    return 1;
  }
}

/**
 * Upload every finding to the repository's code scanning dashboard. Shared
 * by the push-triggered pipeline and the scheduled outdated-dependency scan,
 * since both ultimately produce the same `SarifFinding[]` shape — see
 * `report/sarif.ts`.
 *
 * `category` separates the two result sets (`drift/diff` vs `drift/outdated`)
 * in GitHub's `runAutomationDetails.id`. Without it, the newest upload from
 * either mode would be treated as the authoritative replacement for the
 * other's findings too, incorrectly marking them fixed.
 */
async function uploadCodeScanning(args: {
  repo: RepoContext;
  config: DriftConfig;
  github: GitHubClient;
  logger: Logger;
  findings: SarifFinding[];
  category: 'drift/diff' | 'drift/outdated';
}): Promise<void> {
  const { repo, config, github, logger, findings, category } = args;
  if (!config.codeScanning.enabled) return;

  // An empty result is still uploaded. GitHub treats each `category` as a
  // replacement set for the same tool: a prior run that found `zod` and a
  // later one that finds nothing are two different analyses, and only
  // uploading the second one tells Code Scanning the earlier alert is gone.
  // Skipping the upload here left last week's finding sitting open forever —
  // exactly the "rescanning retires findings that stop reappearing" claim the
  // README makes, silently not happening on the one run where it mattered.
  logger.info(
    findings.length > 0
      ? `Uploading ${findings.length} code scanning finding(s).`
      : 'Uploading an empty code scanning result to retire any alerts that no longer reproduce.',
  );
  await github.uploadSarif(repo, {
    sarif: buildSarifLog(findings, category),
    commitSha: repo.afterSha,
    ref: `refs/heads/${repo.baseBranch}`,
  });
}

/**
 * Open a GitHub issue for every finding, in addition to the code scanning
 * upload — opt-in via `codeScanning.createIssuesPerAlert`, for teams that
 * want alerts triaged and assigned the way any other issue is rather than
 * only through the Security tab.
 *
 * Each issue embeds the finding's `ruleId` as a hidden marker and a rescan
 * looks that marker up before filing — the same statelessness
 * `requestApproval` already relies on for the plan-approval issue (see
 * `dispatch/index.ts`) — so a rescan finds the existing issue rather than
 * piling up duplicates. A rescan also reconciles what it finds against what
 * is already open: an existing issue whose body no longer matches the
 * current finding (new evidence, a moved location, a changed severity label)
 * is brought up to date rather than left stating what a previous run saw,
 * and an issue whose marker no longer appears among this run's findings is
 * closed with a note — the same "stops reappearing, gets retired" guarantee
 * the SARIF upload gives the Security tab, extended to the Issues view.
 *
 * `category` scopes both the marker and the reconciliation to one caller:
 * the push-triggered pipeline and the scheduled outdated scan can flag the
 * same package (`ruleId` is `drift/<ecosystem>/<name>`, independent of which
 * mode found it) for two different reasons — "this landed and broke code"
 * versus "this is available and would". Without the category in the marker,
 * running one mode's reconciliation would close an issue the other mode
 * opened, because its own smaller finding set would not contain a marker
 * that was never its own to begin with.
 */
export async function createIssuesForFindings(args: {
  repo: RepoContext;
  config: DriftConfig;
  github: GitHubClient;
  logger: Logger;
  findings: SarifFinding[];
  category: 'drift/diff' | 'drift/outdated';
}): Promise<void> {
  const { repo, config, github, logger, findings, category } = args;
  if (!config.codeScanning.createIssuesPerAlert) return;

  const seenMarkers = new Set<string>();

  for (const finding of findings) {
    const marker = `drift-alert:${category}:${finding.ruleId}`;
    seenMarkers.add(marker);
    const body = `${finding.message}\n\n<!-- ${marker} -->`;
    const existing = await github.findOpenPlanIssue(repo, marker);

    if (existing !== null) {
      const current = await github.getIssue(repo, existing);
      if (current && current.body !== body) {
        await github.updateIssueBody(repo, existing, body);
        logger.info(`Updated issue #${existing} for ${finding.ruleId}: the finding's evidence changed`);
      } else {
        logger.debug(`${finding.ruleId} already filed as issue #${existing}; nothing changed`);
      }
      continue;
    }

    const issue = await github.createIssue(repo, {
      title: `Drift: ${finding.ruleName}`,
      body,
      labels: [DRIFT_LABEL, `drift:${finding.level}`],
      assignees: config.issueCreation.assignees,
    });
    if (!issue) {
      logger.warn(`Could not open an issue for ${finding.ruleId}. Check that the token has \`issues: write\`.`);
      continue;
    }
    logger.info(`Filed ${finding.ruleId} as issue #${issue.number}`);
  }

  const stillOpen = await github.findOpenAlertIssues(repo);
  const ownPrefix = `drift-alert:${category}:`;
  for (const { number, marker } of stillOpen) {
    if (!marker.startsWith(ownPrefix) || seenMarkers.has(marker)) continue;
    await github.closeIssue(repo, number, 'This finding no longer reproduces on the latest scan. Closing.');
    logger.info(`Closed issue #${number}: ${marker} no longer reproduces`);
  }
}

/**
 * The `schedule`-triggered path: check every installed dependency against
 * its registry, the same way `drift outdated` does locally, and alert on
 * whatever is outdated — safe upgrades and ones with real breaking changes
 * alike, each carrying its own evidence and fix.
 *
 * Deliberately does not dispatch a branch or a Copilot task the way the
 * push-triggered path does. A `RemediationPlan` from this scan describes
 * what fixing the code *would* look like if this upgrade were taken — it
 * does not, itself, bump the manifest, because that is not this scan's job:
 * Drift only ever edits code in response to a version change that has
 * actually landed somewhere. Dispatching a fix branch here would create one
 * for an upgrade nobody applied yet. The alert instead carries the exact
 * command (`drift outdated --upgrade <name>`, or the underlying package manager
 * command) to apply it — once that commit lands and is pushed, the ordinary
 * push-triggered pipeline above takes over exactly as it would for a human's
 * own dependency bump.
 */
async function runOutdatedScan(
  repo: RepoContext,
  config: DriftConfig,
  github: GitHubClient,
  inputs: ActionInputs,
  logger: Logger,
): Promise<number> {
  if (!config.outdated.enabled) {
    logger.info('`outdated.enabled` is false in .github/drift.yml; skipping the scheduled outdated-dependency scan.');
    return 0;
  }

  logger.info('Scanning installed dependencies against their registries...');

  try {
    const scan = await scanUpgrades({
      root: inputs.workspace,
      repo,
      config,
      logger,
      githubToken: inputs.repoToken,
    });

    logger.info(
      `Checked ${scan.checked} dependenc${scan.checked === 1 ? 'y' : 'ies'}: ${scan.upToDate} up to date, ` +
        `${scan.candidates.length} outdated, ${scan.unchecked.length} could not be checked.`,
    );

    const findings = await findingsFromCandidates(scan.candidates, {
      includeInformational: config.codeScanning.includeInformational,
      granularity: config.codeScanning.granularity,
      repoBlobUrl: `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.afterSha}`,
      githubToken: inputs.repoToken,
    });

    await uploadCodeScanning({ repo, config, github, logger, findings, category: 'drift/outdated' });
    await createIssuesForFindings({ repo, config, github, logger, findings, category: 'drift/outdated' });

    const summary =
      `Checked ${scan.checked} dependenc${scan.checked === 1 ? 'y' : 'ies'}: ${scan.upToDate} up to date, ` +
      `${scan.candidates.length} outdated, ${scan.unchecked.length} could not be checked.`;

    // This mode never dispatches a branch or PR — see the function's doc
    // comment for why — so `skipped` is always the right status, whether or
    // not it found anything to alert on.
    await writeOutputs({ status: 'skipped' }, summary);
    await writeJobSummary(
      `### Drift: outdated dependency scan\n\n${summary}\n\n` +
        (findings.length > 0
          ? `${findings.length} package(s) uploaded to the Security tab, each alert listing its breaking changes, their locations, and a fix.\n\n`
          : 'Nothing rose to a Security tab alert.\n\n') +
        renderOutdatedTable(scan.candidates),
    );

    return 0;
  } catch (err) {
    logger.error(`Outdated-dependency scan failed: ${(err as Error).message}`);
    logger.debug((err as Error).stack ?? '');
    await writeOutputs({ status: 'failed' }, `Outdated-dependency scan failed: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * A per-dependency table for the job summary: what's outdated, what would
 * break, how much of it actually reaches this repository, and the risk.
 *
 * This is where the detail that `findingsFromCandidates` deliberately keeps
 * out of the Security tab belongs instead — the full upstream breaking-change
 * count for a package with nothing locally affected is useful context for a
 * human skimming the summary, not a reason to open an alert nobody can act
 * on. See `report/sarif.ts` for that split.
 */
function renderOutdatedTable(candidates: readonly UpgradeCandidate[]): string {
  if (candidates.length === 0) return '';

  const rows = candidates.map((c) => {
    const version = c.selected === c.latest ? `${c.current} → ${c.selected}` : `${c.current} → ${c.selected} (latest ${c.latest})`;
    const impact = c.breakingCount > 0 ? `${c.impactCount} site(s) in ${c.impactFiles} file(s)` : '—';
    return `| ${c.name} | ${DEPENDENCY_KIND_LABELS[c.kind]} | ${version} | ${c.breakingCount} | ${impact} | ${c.risk} |`;
  });

  return [
    '| Package | Kind | Version | Upstream breaking changes | Locally affected | Risk |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function readInputs(): ActionInputs {
  const mode = actionInput('mode');
  const scanMode = actionInput('scan-mode');
  const alertGranularity = actionInput('alert-granularity');
  return {
    repoToken: actionInput('repo-token') ?? process.env.GITHUB_TOKEN ?? '',
    copilotToken: actionInput('copilot-token') || process.env.DRIFT_COPILOT_TOKEN || undefined,
    mode: mode === 'auto' || mode === 'approve' ? mode : undefined,
    dryRun: (actionInput('dry-run') ?? '').toLowerCase() === 'true',
    logLevel: (actionInput('log-level') as LogLevel) || 'info',
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    configPath: actionInput('config-path') || undefined,
    scanMode: scanMode === 'outdated' ? 'outdated' : scanMode === 'diff' ? 'diff' : undefined,
    alertGranularity:
      alertGranularity === 'package' || alertGranularity === 'breakingChange' || alertGranularity === 'affectedSite'
        ? alertGranularity
        : undefined,
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

/**
 * Handle an `issue_comment` event.
 *
 * Every check that decides whether this is a real approval lives in
 * `approval/apply.ts`, shared with the webhook runner so the two cannot drift
 * apart on a security boundary. This function's only job is to supply the
 * repository coordinates and turn the outcome into an exit code.
 *
 * A refused approval exits 0. The workflow did what it should have — it
 * declined — and failing the run would put a red mark on a correct refusal,
 * which teaches people to stop reading them.
 */
async function runApproval(
  event: Record<string, unknown>,
  inputs: ActionInputs,
  github: GitHubClient,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  const repository = event.repository as { full_name?: string } | undefined;
  const fullName = repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  const [owner, repo] = (fullName ?? '').split('/');

  if (!owner || !repo) {
    logger.error('Could not determine the repository from the `issue_comment` event payload.');
    return 1;
  }

  const outcome = await applyApproval({
    payload: event,
    owner,
    repo,
    github,
    logger,
    ...(inputs.copilotToken ? { copilotToken: inputs.copilotToken } : {}),
    ...(inputs.dryRun ? { dryRun: true } : {}),
    // The Action has a checkout, so an approval gets real localization — the
    // one capability the webhook runner cannot offer.
    workspace: inputs.workspace,
    ...(inputs.mode ? { configOverride: { mode: inputs.mode } } : {}),
  });

  switch (outcome.status) {
    case 'ignored':
      logger.debug(`Not an approval: ${outcome.reason}`);
      return 0;

    case 'rejected':
      logger.warn(`Approval refused on #${outcome.issueNumber}: ${outcome.reason}`);
      await writeJobSummary(`### Drift did not apply this plan\n\n${outcome.reason}`);
      return 0;

    case 'already-applied':
      logger.info(outcome.message);
      await writeJobSummary(`### Drift\n\n${outcome.message}`);
      return 0;

    case 'applied':
      await writeOutputs(outcome.dispatch, outcome.dispatch.message);
      await writeJobSummary(outcome.dispatch.message);

      if (outcome.dispatch.status === 'dispatched') {
        await maybeAwaitCopilotCompletion({
          config: outcome.config,
          repo: { owner, repo, baseBranch: '', beforeSha: '', afterSha: outcome.plan.headSha },
          dispatchResult: outcome.dispatch,
          github,
          copilotToken: inputs.copilotToken,
          logger,
        });
      }

      return outcome.dispatch.status === 'failed' ? 1 : 0;
  }
}

async function readWorkspaceFile(workspace: string, path: string): Promise<string | null> {
  try {
    return await readFile(`${workspace}/${path}`, 'utf8');
  } catch {
    return null;
  }
}

/**
 * If `remediation.awaitCompletion` is on, block this run until the just-
 * dispatched Copilot task finishes, fails, or times out, then post a final
 * check run reflecting that.
 *
 * The Action is otherwise a fire-and-forget dispatch: it submits the task and
 * exits, and nothing else in this deployment ever asks GitHub how it went.
 * This is the opt-in way to close that loop without the durable queue and
 * background reconciler the self-hosted webhook runner uses instead (see
 * `reconcilePendingCopilotTasks` in `runners/webhook.ts`) — a one-shot Action
 * run has no "later" to reconcile in, only "now, before it exits".
 */
async function maybeAwaitCopilotCompletion(args: {
  config: DriftConfig;
  repo: RepoContext;
  dispatchResult: DispatchResult;
  github: GitHubClient;
  copilotToken?: string;
  logger: Logger;
}): Promise<void> {
  const { config, repo, dispatchResult, github, copilotToken, logger } = args;
  const settings = config.remediation.awaitCompletion;
  if (!settings.enabled || !copilotToken || !dispatchResult.taskId) return;

  logger.info(
    `Waiting up to ${settings.timeoutMinutes}m for Copilot task ${dispatchResult.taskId} to finish (remediation.awaitCompletion is on)`,
  );

  const task = await awaitTerminalState({
    copilotToken,
    repo,
    taskId: dispatchResult.taskId,
    timeoutMs: settings.timeoutMinutes * 60_000,
    pollIntervalMs: settings.pollIntervalSeconds * 1000,
  });

  if (!task || !isTerminalState(task.state)) {
    logger.warn(
      `Copilot task ${dispatchResult.taskId} had not reached a terminal state after ${settings.timeoutMinutes}m; posting a final check run and giving up.`,
    );
    const where = dispatchResult.pullRequestUrl;
    await github.createCheckRun(repo, {
      name: 'Drift',
      conclusion: 'action_required',
      title: 'Copilot status tracking timed out',
      summary: `Drift waited ${settings.timeoutMinutes}m for Copilot task ${dispatchResult.taskId} to reach a terminal state but it did not. ${
        where ? `See ${where} for its current state.` : 'A human needs to check the task manually.'
      }`,
    });
    return;
  }

  const succeeded = task.state === 'completed';
  const where = dispatchResult.pullRequestUrl ?? task.pullRequestUrl;

  await github.createCheckRun(repo, {
    name: 'Drift',
    conclusion: succeeded ? 'success' : 'failure',
    title: succeeded ? 'Copilot finished' : `Copilot did not finish (${task.state})`,
    summary: succeeded
      ? where
        ? `See ${where} for the result.`
        : 'The agent task completed.'
      : `The Copilot agent task ended in state \`${task.state}\` without finishing the fix. ${
          where ? `See ${where} for what it left behind.` : 'A human needs to look at this.'
        }`,
  });

  logger.info(`Copilot task ${dispatchResult.taskId} reached terminal state ${task.state}`);
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
