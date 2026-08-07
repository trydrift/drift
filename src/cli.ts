#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { RepoContext } from './types.js';
import { loadConfig } from './config/load.js';
import { GitHubClient } from './github/client.js';
import { runPipeline } from './pipeline.js';
import { resolveBaseBranch, titleFor } from './plan/pull-request.js';
import { renderPullRequestBody } from './report/markdown.js';
import { runAction } from './runners/action.js';
import { main as serveWebhook } from './runners/webhook.js';
import { sampleTelemetryEvent } from './telemetry.js';
import { createLogger, type LogLevel } from './util/logger.js';
import { dispatchRemainingToCopilot, runFix } from './remediation/cli-runner.js';

const run = promisify(execFile);

/**
 * Drift CLI.
 *
 * The `analyze` command exists so a team can see exactly what Drift would do
 * to their repository before granting it any write access at all. Being able
 * to evaluate the tool with zero permissions is the single best answer to
 * "why should I trust this with my codebase?" — so it is a first-class
 * command, not a debugging afterthought.
 */

const USAGE = `
drift — dependency changes, proven and fixed

Usage:
  drift analyze [options]     Analyse a local repository and print the report
  drift fix [options]         Analyse, then apply the fixes and push a branch
  drift pr [options]          Push the current branch and open a pull request
  drift action                Run as a GitHub Action (reads INPUT_* env vars)
  drift serve                 Run the self-hosted webhook server
  drift telemetry print       Print the exact telemetry event shape
  drift --version             Print the version

Options for \`analyze\`:
  --repo <owner/name>         Repository to analyse. Default: the git remote
  --before <sha>              Commit before the change. Default: HEAD^
  --after <sha>               Commit after the change.  Default: HEAD
  --dir <path>                Local checkout to index.  Default: cwd
  --token <token>             GitHub token for reads. Default: $GITHUB_TOKEN
  --config <path>             Config file. Default: .github/drift.yml
  --json                      Emit the plan as JSON instead of markdown
  --log-level <level>         debug | info | warn | error. Default: info

Options for \`fix\` (accepts every \`analyze\` option too):
  --community-recipes         Use a matching community recipe when Drift's own
                              codemod can't resolve a commit, without asking
  --no-community-recipes      Never use a community recipe; go straight to AI
  --non-interactive           Never prompt; decide from --community-recipes /
                              drift.yml's \`remediation.communityRecipes\`
                              (this is the default when not run in a TTY)
  --copilot-token <token>     User-scoped token for commits that need an
                              agent. Default: $DRIFT_COPILOT_TOKEN
  --draft                     Open the pull request as a draft

Options for \`pr\`:
  --dir <path>                Repository to act on.     Default: cwd
  --base <branch>             Merge into this branch.   Default: what this
                              branch was created from, per drift.yml
  --title <text>              Pull request title.       Default: proposed
  --draft                     Open as a draft
  --yes                       Do not ask; use the proposed title as-is
  --token <token>             GitHub token. Default: $GITHUB_TOKEN

\`analyze\` never writes anything: no branches, no issues, no agent tasks.
\`fix\` applies the plan in an isolated git worktree — your working tree is
never touched — using, per commit, Drift's own deterministic fix, then (if
enabled) a community recipe, then an AI agent, in that order; it pushes a
branch and opens a pull request. It never merges, never force-pushes, and
never touches the base branch. A community recipe is never used without an
explicit choice, in this run or in \`remediation.communityRecipes\`.
\`pr\` pushes the current branch and opens a pull request. It never merges,
never force-pushes, and never touches the base branch.

Environment:
  GITHUB_TOKEN                Token used for repository reads
  DRIFT_COPILOT_TOKEN         User-scoped token for the Copilot agent API
  DRIFT_TELEMETRY_DISABLED    1/true disables telemetry even if configured
  DO_NOT_TRACK                1 disables telemetry
  ANTHROPIC_API_KEY           Only if llm.enabled is true in drift.yml
`.trim();

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'analyze':
    case 'analyse':
      return analyzeCommand(parseFlags(rest));
    case 'fix':
      return fixCommand(parseFlags(rest));
    case 'pr':
      return prCommand(parseFlags(rest));
    case 'action':
      return runAction();
    case 'serve':
      // Awaited: the queue is opened asynchronously, and a failure there must
      // surface as an exit code rather than an unhandled rejection.
      return await serveWebhook();
    case 'telemetry':
      return telemetryCommand(rest);
    case '--version':
    case '-v':
      console.log(await packageVersion());
      return 0;
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      return 1;
  }
}

async function telemetryCommand(args: readonly string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand !== 'print') {
    console.error('Usage: drift telemetry print');
    return 1;
  }

  console.log(JSON.stringify(sampleTelemetryEvent(), null, 2));
  return 0;
}

interface Flags {
  [key: string]: string | boolean;
}

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function analyzeCommand(flags: Flags): Promise<number> {
  const logLevel = (typeof flags['log-level'] === 'string' ? flags['log-level'] : 'info') as LogLevel;
  const logger = createLogger(logLevel);

  const workspace = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());
  const token = (typeof flags.token === 'string' ? flags.token : process.env.GITHUB_TOKEN) ?? '';

  if (!token) {
    logger.error(
      'A GitHub token is required to read commit history. Set GITHUB_TOKEN or pass --token. A token with public read access is enough for public repositories.',
    );
    return 1;
  }

  const slug = typeof flags.repo === 'string' ? flags.repo : await detectRepoSlug(workspace);
  if (!slug) {
    logger.error('Could not determine the repository. Pass --repo owner/name.');
    return 1;
  }

  const [owner, repoName] = slug.split('/');
  if (!owner || !repoName) {
    logger.error(`Invalid repository "${slug}". Expected owner/name.`);
    return 1;
  }

  const after = (typeof flags.after === 'string' ? flags.after : await gitRev(workspace, 'HEAD')) ?? 'HEAD';
  const before =
    (typeof flags.before === 'string' ? flags.before : await gitRev(workspace, 'HEAD^')) ?? `${after}^`;
  const branch = (await gitRev(workspace, '--abbrev-ref HEAD')) ?? 'main';

  const repo: RepoContext = {
    owner,
    repo: repoName,
    baseBranch: branch,
    beforeSha: before,
    afterSha: after,
    workspace,
  };

  logger.info(`Analysing ${owner}/${repoName} ${before.slice(0, 7)}..${after.slice(0, 7)}`);

  const github = new GitHubClient({ repoToken: token, logger });

  const { config, path, problems } = await loadConfig(async (candidate) => {
    const target = typeof flags.config === 'string' ? flags.config : candidate;
    try {
      return await readFile(resolve(workspace, target), 'utf8');
    } catch {
      return null;
    }
  });
  for (const problem of problems) logger.warn(problem);
  if (path) logger.info(`Using config from ${path}`);

  const result = await runPipeline({
    repo,
    config,
    logger,
    github,
    // `analyze` is read-only by construction: no token is passed through and
    // dryRun is forced, so there is no code path here that mutates anything.
    dryRun: true,
    workspace,
  });

  if (!result.plan) {
    console.log(`\n${result.summary}\n`);
    return 0;
  }

  if (flags.json) {
    console.log(JSON.stringify(result.plan, null, 2));
  } else {
    console.log(`\n${renderPullRequestBody(result.plan, config)}\n`);
  }

  return 0;
}

/**
 * Analyse, then apply the resulting plan: Drift's own codemod first, a
 * community recipe second (only when enabled), an AI agent last — the same
 * priority every surface shares (`src/remediation/partition.ts`).
 *
 * Runs entirely in an isolated git worktree via `runFix`, so nothing here
 * ever touches the caller's working tree, and pushes only a branch it built
 * itself. Like \`pr\`, this never merges and never force-pushes.
 */
async function fixCommand(flags: Flags): Promise<number> {
  const logLevel = (typeof flags['log-level'] === 'string' ? flags['log-level'] : 'info') as LogLevel;
  const logger = createLogger(logLevel);

  const workspace = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());
  const token = (typeof flags.token === 'string' ? flags.token : process.env.GITHUB_TOKEN) ?? '';

  if (!token) {
    logger.error('A GitHub token is required. Set GITHUB_TOKEN or pass --token.');
    return 1;
  }

  const slug = typeof flags.repo === 'string' ? flags.repo : await detectRepoSlug(workspace);
  if (!slug) {
    logger.error('Could not determine the repository. Pass --repo owner/name.');
    return 1;
  }
  const [owner, repoName] = slug.split('/');
  if (!owner || !repoName) {
    logger.error(`Invalid repository "${slug}". Expected owner/name.`);
    return 1;
  }

  const after = (typeof flags.after === 'string' ? flags.after : await gitRev(workspace, 'HEAD')) ?? 'HEAD';
  const before =
    (typeof flags.before === 'string' ? flags.before : await gitRev(workspace, 'HEAD^')) ?? `${after}^`;
  const branch = (await gitRev(workspace, '--abbrev-ref HEAD')) ?? 'main';

  const repo: RepoContext = { owner, repo: repoName, baseBranch: branch, beforeSha: before, afterSha: after, workspace };

  const github = new GitHubClient({ repoToken: token, logger });

  const { config, path, problems } = await loadConfig(async (candidate) => {
    const target = typeof flags.config === 'string' ? flags.config : candidate;
    try {
      return await readFile(resolve(workspace, target), 'utf8');
    } catch {
      return null;
    }
  });
  for (const problem of problems) logger.warn(problem);
  if (path) logger.info(`Using config from ${path}`);

  logger.info(`Analysing ${owner}/${repoName} ${before.slice(0, 7)}..${after.slice(0, 7)}`);

  const result = await runPipeline({ repo, config, logger, github, dryRun: true, workspace });
  if (!result.plan || result.plan.commits.length === 0) {
    console.log(`\n${result.summary}\n`);
    return 0;
  }

  const plan = result.plan;
  const allowCommunityRecipes = flags['community-recipes']
    ? true
    : flags['no-community-recipes']
      ? false
      : undefined;

  logger.info(`Fixing ${plan.commits.length} commit(s) on \`${plan.branchName}\` in an isolated worktree`);

  const fix = await runFix({
    repo,
    plan,
    config,
    logger,
    workspace,
    allowCommunityRecipes,
    nonInteractive: Boolean(flags['non-interactive']),
  });

  try {
    if (fix.pushed) {
      await run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${fix.branch}`], { cwd: fix.worktree });
      logger.info(
        `Resolved ${fix.builtinResolved} commit(s) deterministically` +
          (fix.recipeResolved > 0 ? ` and ${fix.recipeResolved} via community recipe` : '') +
          ` on \`${fix.branch}\`.`,
      );
    }

    if (fix.needsAgent.length > 0) {
      const copilotToken =
        (typeof flags['copilot-token'] === 'string' ? flags['copilot-token'] : undefined) ??
        process.env.DRIFT_COPILOT_TOKEN;

      if (!copilotToken) {
        logger.warn(
          `${fix.needsAgent.length} commit(s) need an AI agent, but no Copilot token is available. ` +
            'Set DRIFT_COPILOT_TOKEN or pass --copilot-token. Skipping them for now.',
        );
      } else {
        if (!fix.pushed) {
          // Copilot works from the remote branch, which nothing has created
          // yet if every commit needed an agent — same branch creation the
          // Action performs before dispatch.
          await github.createBranch(repo, fix.branch, repo.afterSha);
        }
        const dispatched = await dispatchRemainingToCopilot({
          copilotToken,
          repo,
          plan,
          commits: fix.needsAgent,
          config,
          logger,
        });
        if (!dispatched.ok) {
          logger.error(`Copilot dispatch failed: ${dispatched.error}`);
        } else {
          logger.info(`Dispatched ${fix.needsAgent.length} commit(s) needing an agent to Copilot.`);
        }
      }
    }

    if (!fix.pushed && fix.needsAgent.length === 0) {
      logger.info('Nothing to fix.');
      return 0;
    }

    const pr = await github.createPullRequest(repo, {
      head: fix.branch,
      base: plan.baseBranch,
      title: titleFor({ changes: plan.changes }, { title: config.pullRequest.titleTemplate, prefix: config.remediation.branchPrefix }),
      body: renderPullRequestBody(plan, config),
      draft: Boolean(flags.draft) || config.pullRequest.draft || config.remediation.draftPr,
      labels: config.pullRequest.labels,
      reviewers: config.pullRequest.reviewers,
    });

    if (pr) {
      console.log(pr.existing ? `Already open: ${pr.url}` : `Opened ${pr.url}`);
    } else if (fix.pushed) {
      console.log(`Pushed \`${fix.branch}\`, but could not open a pull request.`);
    }

    return 0;
  } finally {
    await fix.teardown();
  }
}

/**
 * Push the current branch and open a pull request for it.
 *
 * The step that finishes the job. Everything before this leaves a developer
 * with a branch and an instruction to go and do the last part by hand — which
 * is the part automation was supposed to remove.
 *
 * It stops firmly short of merging. Drift's output is always something a human
 * opens, never something that has already landed.
 */
async function prCommand(flags: Flags): Promise<number> {
  const logger = createLogger(
    (typeof flags['log-level'] === 'string' ? flags['log-level'] : 'info') as LogLevel,
  );
  const workspace = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());

  const token = (typeof flags.token === 'string' ? flags.token : process.env.GITHUB_TOKEN) ?? '';
  if (!token) {
    logger.error('A GitHub token is required to open a pull request. Set GITHUB_TOKEN or pass --token.');
    return 1;
  }

  const branch = await gitRev(workspace, '--abbrev-ref HEAD');
  if (!branch || branch === 'HEAD') {
    logger.error('You are on a detached HEAD. Check out a branch before opening a pull request.');
    return 1;
  }

  const slug = typeof flags.repo === 'string' ? flags.repo : await detectRepoSlug(workspace);
  if (!slug) {
    logger.error('Could not determine the repository. Pass --repo owner/name.');
    return 1;
  }
  const [owner, repoName] = slug.split('/');
  if (!owner || !repoName) {
    logger.error(`Invalid repository "${slug}". Expected owner/name.`);
    return 1;
  }

  const { config } = await loadConfig(async (candidate) => {
    try {
      return await readFile(resolve(workspace, candidate), 'utf8');
    } catch {
      return null;
    }
  });

  // The branch this work was started from, not the repository default. On a
  // team that develops on `develop`, targeting `main` proposes merging into the
  // wrong place and shows a diff full of other people's commits.
  const base =
    typeof flags.base === 'string'
      ? { branch: flags.base, reason: 'given with --base' }
      : resolveBaseBranch({
          policy: config.pullRequest.base,
          branchedFrom: await branchedFrom(workspace, branch),
          defaultBranch: await defaultBranch(workspace),
          currentBranch: branch,
        });

  if (!base) {
    logger.error(
      `\`${branch}\` is the branch a pull request would merge into. Create a branch for this work first.`,
    );
    return 1;
  }

  const changes = await uncommittedDependencyChanges(workspace, base.branch);
  const proposed =
    typeof flags.title === 'string'
      ? flags.title
      : titleFor({ changes }, { title: config.pullRequest.titleTemplate });

  logger.info(`${branch} → ${base.branch} (${base.reason})`);

  const title = flags.yes ? proposed : await promptForTitle(proposed);
  if (title === null) {
    logger.info('Nothing opened.');
    return 0;
  }

  try {
    await run('git', ['push', '-u', 'origin', branch], { cwd: workspace });
  } catch (err) {
    logger.error(`Could not push \`${branch}\`: ${(err as Error).message}`);
    return 1;
  }

  const github = new GitHubClient({ repoToken: token, logger });
  const repo: RepoContext = {
    owner,
    repo: repoName,
    baseBranch: base.branch,
    beforeSha: '',
    afterSha: '',
    workspace,
  };

  const pr = await github.createPullRequest(repo, {
    head: branch,
    base: base.branch,
    title,
    body: `Opened by \`drift pr\` from \`${branch}\`.`,
    draft: Boolean(flags.draft) || config.pullRequest.draft,
    labels: config.pullRequest.labels,
    reviewers: config.pullRequest.reviewers,
  });

  if (!pr) {
    logger.error('Could not open the pull request. The branch is pushed either way.');
    return 1;
  }

  console.log(pr.existing ? `Already open: ${pr.url}` : `Opened ${pr.url}`);
  return 0;
}

/**
 * The proposed title, editable.
 *
 * A name a developer can change beats a good one they cannot. Reading from a
 * pipe or a non-interactive shell yields the proposal unchanged, so `drift pr`
 * in a script behaves like `--yes` rather than hanging on a prompt nobody will
 * ever answer.
 */
async function promptForTitle(proposed: string): Promise<string | null> {
  if (!process.stdin.isTTY) return proposed;

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Title [${proposed}]: `);
    return answer.trim() || proposed;
  } finally {
    rl.close();
  }
}

/**
 * The branch this one was created from, per git's own reflog.
 *
 * Creating a branch writes `branch: Created from <ref>` as the first reflog
 * entry. That is a fact about what happened, unlike merge-base arithmetic
 * against every branch — which guesses, and guesses wrong as soon as two
 * branches share history, which is always.
 */
async function branchedFrom(cwd: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['reflog', 'show', branch], { cwd });
    const lines = stdout.split('\n').filter((line) => line.trim());

    for (const line of lines.reverse()) {
      const created = /\bbranch: Created from (.+)$/.exec(line.trim());
      if (!created) continue;

      const ref = created[1]!.trim();
      // `Created from HEAD` names no branch — the commit is known but which
      // branch it belonged to was never recorded.
      if (!ref || ref === 'HEAD') return null;

      const name = ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^origin\//, '');
      return name === branch ? null : name;
    }
  } catch {
    // A pruned or absent reflog is ordinary, not an error.
  }
  return null;
}

async function defaultBranch(cwd: string): Promise<string | null> {
  const head = await gitRev(cwd, '--abbrev-ref origin/HEAD');
  if (head) return head.replace(/^origin\//, '');

  for (const candidate of ['main', 'master']) {
    if (await gitRev(cwd, `--verify refs/remotes/origin/${candidate}`)) return candidate;
  }
  return null;
}

/**
 * Which dependencies moved on this branch, for the proposed title.
 *
 * Best-effort: a title is a convenience, and a repository whose manifests could
 * not be diffed still gets a generic but accurate one rather than an error.
 */
async function uncommittedDependencyChanges(
  cwd: string,
  base: string,
): Promise<{ name: string; from: string | null; to: string | null }[]> {
  try {
    const { detectChanges, isManifestPath } = await import('./detect/index.js');
    const { stdout } = await run('git', ['diff', '--name-only', `${base}...HEAD`], { cwd });

    const manifests = stdout.split('\n').map((l) => l.trim()).filter((p) => p && isManifestPath(p));
    if (manifests.length === 0) return [];

    const snapshots = await Promise.all(
      manifests.map(async (path) => ({
        path,
        before: await showFile(cwd, base, path),
        after: await readFile(resolve(cwd, path), 'utf8').catch(() => null),
      })),
    );

    return detectChanges(snapshots);
  } catch {
    return [];
  }
}

async function showFile(cwd: string, ref: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['show', `${ref}:${path}`], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

async function detectRepoSlug(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd });
    const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(stdout.trim());
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

async function gitRev(cwd: string, rev: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', ...rev.split(' ')], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function packageVersion(): Promise<string> {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(await readFile(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Only self-execute when run as a binary, so tests can import `main` freely.
// Compared by realpath, not by `argv[1]`'s literal text: npm installs `drift`
// as a symlink at node_modules/.bin/drift, so a packed, globally-installed
// CLI is invoked with `argv[1]` ending in `.bin/drift`, not `cli.js` — a
// suffix check silently never runs `main()` for every real install.
function invokedAsScript(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`drift: ${(err as Error).message}`);
      process.exitCode = 1;
    },
  );
}
