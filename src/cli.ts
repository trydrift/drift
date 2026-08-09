#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { RepoContext } from './types.js';
import { loadConfig } from './config/load.js';
import { GitHubClient } from './github/client.js';
import { LocalGitProvider, WORKING_TREE, chooseManifestRange, inspectLocalRepo } from './repo/local-git.js';
import { runPipeline } from './pipeline.js';
import { resolveBaseBranch, titleFor } from './plan/pull-request.js';
import { renderPullRequestBody } from './report/markdown.js';
import { renderAudit } from './report/audit.js';
import { auditCurrentUsage, summarizeAudit } from './audit/index.js';
import { runAction } from './runners/action.js';
import { main as serveWebhook } from './runners/webhook.js';
import { sampleTelemetryEvent } from './telemetry.js';
import { createLogger, type LogLevel, type Logger } from './util/logger.js';
import { dispatchRemainingToCopilot, runFix } from './remediation/cli-runner.js';
import { installUpgrade, scanUpgrades, upgradeCommandFor } from './upgrade/scan.js';
import { describeSeverity, scanTitle, severityOf } from './upgrade/severity.js';
import { ask } from './util/prompt.js';

const run = promisify(execFile);

/** Where to create a token with the scope Drift's write commands need. */
const CREATE_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=drift-cli';

/**
 * A token for reads/writes against the GitHub API, in priority order:
 * `--token`, `GITHUB_TOKEN`, then whatever the GitHub CLI already has signed
 * in. That last fallback is what makes `fix`/`pr` feel like the rest of the
 * `gh`-based toolchain — most people who need this already ran `gh auth
 * login` for something else and should not have to mint and paste a second
 * credential to get the same access here.
 */
async function resolveGitHubToken(flags: Flags): Promise<string> {
  if (typeof flags.token === 'string') return flags.token;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await run('gh', ['auth', 'token']);
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Whether the GitHub CLI is on PATH and signed in. */
async function hasGitHubCli(): Promise<boolean> {
  try {
    await run('gh', ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

/** Whether the `gh` binary is on PATH at all, signed in or not. */
async function isGhInstalled(): Promise<boolean> {
  try {
    await run('gh', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Offer a browser sign-in via `gh auth login --web` before falling back to a
 * manually pasted token — signing in with a click beats minting and copying
 * a personal access token whenever there's a terminal to run it in.
 *
 * Silently declines (returns `false`, no prompt shown) when `gh` isn't
 * installed or this isn't an interactive terminal — a script piping into
 * `drift fix` must never block on a browser flow nobody is there to complete.
 */
async function tryBrowserSignIn(logger: Logger): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (!(await isGhInstalled())) return false;

  logger.info('No GitHub token found. Opening a browser to sign in (`gh auth login`)...');
  const loggedIn = await new Promise<boolean>((resolvePromise) => {
    const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], {
      stdio: 'inherit',
    });
    child.on('close', (code) => resolvePromise(code === 0));
    child.on('error', () => resolvePromise(false));
  });

  return loggedIn && (await hasGitHubCli());
}

interface OpenPrParams {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: readonly string[];
  reviewers?: readonly string[];
}

/**
 * Open (or find) a pull request via `gh pr create`.
 *
 * `gh` already owns its own credential (from `gh auth login`), so this path
 * never needs `repoToken` at all — it is what lets `fix`/`pr` work with zero
 * token configuration for the many developers who already have the GitHub CLI
 * signed in for other things.
 */
async function openPullRequestViaGh(
  workspace: string,
  params: OpenPrParams,
  logger: Logger,
): Promise<{ url: string; existing: boolean } | null> {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'drift-pr-'));
  try {
    const bodyPath = join(dir, 'body.md');
    await writeFile(bodyPath, params.body, 'utf8');

    const args = [
      'pr',
      'create',
      '--head',
      params.head,
      '--base',
      params.base,
      '--title',
      params.title,
      '--body-file',
      bodyPath,
    ];
    if (params.draft) args.push('--draft');
    for (const label of params.labels ?? []) args.push('--label', label);
    for (const reviewer of params.reviewers ?? []) args.push('--reviewer', reviewer);

    try {
      const { stdout } = await run('gh', args, { cwd: workspace });
      const url = stdout.trim().split('\n').pop()?.trim();
      return url ? { url, existing: false } : null;
    } catch (err) {
      // `gh` exits non-zero when a pull request already exists for this
      // branch (among other reasons) — ask it directly rather than guessing
      // from stderr text, which differs across `gh` versions.
      try {
        const { stdout } = await run('gh', ['pr', 'view', params.head, '--json', 'url'], { cwd: workspace });
        const url = (JSON.parse(stdout) as { url?: string }).url;
        if (url) return { url, existing: true };
      } catch {
        // Not an "already exists" case; fall through to reporting failure.
      }
      logger.debug(`gh pr create failed: ${(err as Error).message}`);
      return null;
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Open a pull request, preferring the GitHub CLI (no token needed) and
 * falling back to the GitHub API with `token` when `gh` isn't signed in.
 */
async function openPullRequest(
  workspace: string,
  token: string,
  logger: Logger,
  repo: RepoContext,
  params: OpenPrParams,
): Promise<{ url: string; existing: boolean } | null> {
  if (await hasGitHubCli()) {
    const viaGh = await openPullRequestViaGh(workspace, params, logger);
    if (viaGh) return viaGh;
    logger.debug('Falling back to the GitHub API for pull request creation.');
  }
  if (!token) return null;
  const github = new GitHubClient({ repoToken: token, logger });
  return github.createPullRequest(repo, params);
}

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
  drift outdated [options]    Scan for available upgrades, not just past ones
  drift audit [options]       Check this code against the versions installed now
  drift fix [options]         Analyse, then apply the fixes and push a branch
  drift pr [options]          Push the current branch and open a pull request
  drift action                Run as a GitHub Action (reads INPUT_* env vars)
  drift serve                 Run the self-hosted webhook server
  drift telemetry print       Print the exact telemetry event shape
  drift --version             Print the version

Options for \`outdated\`:
  --repo <owner/name>         Repository label for output. Default: git remote
  --dir <path>                Local checkout to scan.    Default: cwd
  --dev                       Also check dev/optional/peer dependencies
  --upgrade <name>             Install the recommended version for one
                              package found by the scan (writes the
                              manifest/lockfile locally — run \`drift
                              analyze\`/\`fix\` afterwards)
  --force                     With --upgrade, ignore the declared range and
                              take the true latest, not just the safe one
  --token <token>             Optional, only to raise the public API rate
                              limit. Default: $GITHUB_TOKEN, then \`gh auth token\`
  --config <path>             Config file. Default: .github/drift.yml
  --json                      Emit the full scan result as JSON
  --log-level <level>         debug | info | warn | error. Default: info

Options for \`audit\`:
  --repo <owner/name>         Repository label for output. Default: git remote
  --dir <path>                Local checkout to audit.  Default: cwd
  --dev                       Also audit dev/optional/peer dependencies
  --token <token>             Optional, only to raise the public API rate
                              limit. Default: $GITHUB_TOKEN, then \`gh auth token\`
  --config <path>             Config file. Default: .github/drift.yml
  --json                      Emit the findings as JSON
  --log-level <level>         debug | info | warn | error. Default: info

Options for \`analyze\`:
  --repo <owner/name>         Repository to analyse. Default: the git remote
  --before <sha>              Commit before the change. Default: auto-detected
  --after <sha>               Commit after the change.  Default: auto-detected
                              — an uncommitted manifest edit, else the most
                              recent commit that touched one
  --dir <path>                Local checkout to index.  Default: cwd
  --token <token>             GitHub token, only to raise the public API rate
                              limit for release notes/changelogs. Optional —
                              default: $GITHUB_TOKEN, then \`gh auth token\`
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
  --token <token>             GitHub token, only needed if signing in isn't
                              possible. Default: $GITHUB_TOKEN, then
                              \`gh auth token\`, then an interactive
                              \`gh auth login\` browser sign-in

\`analyze\` never writes anything: no branches, no issues, no agent tasks — and
reads the local checkout directly, like the VS Code extension, so it never
needs a token. \`outdated\` is the same idea aimed the other direction: instead
of a commit range that already changed a manifest, it checks every direct
dependency against its registry for a version that could — the same "Scan
Dependencies" check the extension runs. It never writes either, except when
given --upgrade, and even then only a local manifest/lockfile edit.
\`audit\` asks the third question, the one about the present: a range like
\`^4.0.0\` lets a resolver move you to 4.9.0 without anyone reading what
changed, so it analyses that window — declared floor to what is actually
installed — and reports the code that no longer matches the dependency already
on disk. Those findings do not go away by upgrading; they are true today.
\`analyze\` runs the same audit and includes it in its report.
\`fix\` applies the plan in an isolated git worktree — your working tree is
never touched — using, per commit, Drift's own deterministic fix, then (if
enabled) a community recipe, then an AI agent, in that order; it pushes a
branch and opens a pull request. It never merges, never force-pushes, and
never touches the base branch. A community recipe is never used without an
explicit choice, in this run or in \`remediation.communityRecipes\`.
\`pr\` pushes the current branch and opens a pull request. It never merges,
never force-pushes, and never touches the base branch.

\`fix\` and \`pr\` need write access to open a pull request. In order of
preference: $GITHUB_TOKEN or --token, then \`gh auth token\` if the GitHub CLI
is already signed in, then — in an interactive terminal, with \`gh\` installed
but not yet signed in — a browser-based \`gh auth login\`. Pasting a token is
the last resort, not the first.

Environment:
  GITHUB_TOKEN                Token for repository reads/writes. \`fix\` and
                              \`pr\` need write access from somewhere; \`analyze\`
                              never does. Prefer signing in with \`gh auth
                              login\` over minting one of these. Create one at
                              ${CREATE_TOKEN_URL}
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
    case 'outdated':
      return outdatedCommand(parseFlags(rest));
    case 'audit':
      return auditCommand(parseFlags(rest));
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

  // `analyze` reads the checkout that's already on disk — `git diff` locally,
  // the same way the VS Code extension does — so it never needs a token.
  // A token here only raises the public rate limit for evidence gathering
  // (release notes, changelogs); read that off `gh` if it's around, but never
  // block on it.
  const token = await resolveGitHubToken(flags);

  const slug = typeof flags.repo === 'string' ? flags.repo : await detectRepoSlug(workspace);
  const [owner, repoName] = slug ? slug.split('/') : ['local', 'workspace'];
  if (slug && (!owner || !repoName)) {
    logger.error(`Invalid repository "${slug}". Expected owner/name.`);
    return 1;
  }
  if (!slug) {
    logger.info('No GitHub remote found; analysing the local checkout only. Pass --repo owner/name to name one.');
  }

  const { before, after } = await resolveRange(workspace, flags);
  const branch = (await gitRev(workspace, '--abbrev-ref HEAD')) ?? 'main';

  const repo: RepoContext = {
    owner: owner!,
    repo: repoName!,
    baseBranch: branch,
    beforeSha: before,
    afterSha: after,
    workspace,
  };

  logger.info(`Analysing ${owner}/${repoName} ${before.slice(0, 7)}..${describeRef(after)}`);

  // Never used for a network call in this command (dryRun forced below), but
  // still required to construct the pipeline's dispatch stage.
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
    provider: new LocalGitProvider(workspace, { before, after }),
    githubToken: token || undefined,
    // `analyze` is read-only by construction: no token is passed through and
    // dryRun is forced, so there is no code path here that mutates anything.
    dryRun: true,
    workspace,
  });

  // A null plan means nothing moved in this range. It has never meant the
  // repository is fine, and now there is something to say about that: the audit
  // runs regardless of whether a manifest changed, so print it rather than
  // letting "no dependency manifest changed" stand as the whole answer.
  if (!result.plan) {
    if (flags.json) {
      console.log(JSON.stringify({ plan: null, summary: result.summary, audit: result.audit ?? null }, null, 2));
      return 0;
    }

    console.log(`\n${result.summary}\n`);
    const section = renderAudit(result.audit);
    if (section) console.log(`${section}\n`);
    return 0;
  }

  if (flags.json) {
    console.log(JSON.stringify({ ...result.plan, audit: result.audit ?? null }, null, 2));
  } else {
    console.log(`\n${renderPullRequestBody(result.plan, config, result.audit)}\n`);
  }

  return 0;
}

/**
 * `drift audit` — the present tense.
 *
 * `analyze` looks at a version move that already happened and `outdated` at one
 * that could; both are about a version this repository is not running. This
 * command asks the question neither of them can: given the dependency tree
 * actually on disk, is the code in this repository correct against it?
 *
 * Usually there is a gap, and it is not anyone's fault. A range like `^4.0.0`
 * is a standing instruction to install anything on 4.x, so the resolver does,
 * during an unrelated lockfile refresh nobody read. The code still assumes the
 * 4.x of the day it was written. Everything removed or re-specified in between
 * is live right now — no upgrade required, and no upgrade will fix it.
 *
 * Read-only, and needs no token: the versions come from the manifest and
 * lockfile already in the checkout.
 */
async function auditCommand(flags: Flags): Promise<number> {
  const logLevel = (typeof flags['log-level'] === 'string' ? flags['log-level'] : 'info') as LogLevel;
  const logger = createLogger(logLevel);

  const workspace = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());
  const token = await resolveGitHubToken(flags);

  const slug = typeof flags.repo === 'string' ? flags.repo : await detectRepoSlug(workspace);
  const [owner, repoName] = slug ? slug.split('/') : ['local', 'workspace'];
  if (slug && (!owner || !repoName)) {
    logger.error(`Invalid repository "${slug}". Expected owner/name.`);
    return 1;
  }

  const head = (await gitRev(workspace, 'HEAD')) ?? 'HEAD';
  const branch = (await gitRev(workspace, '--abbrev-ref HEAD')) ?? 'main';
  const repo: RepoContext = {
    owner: owner!,
    repo: repoName!,
    baseBranch: branch,
    beforeSha: head,
    afterSha: head,
    workspace,
  };

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

  logger.info(`Auditing ${owner}/${repoName} against the versions installed in this checkout`);

  const result = await auditCurrentUsage({
    root: workspace,
    repo,
    config,
    logger,
    githubToken: token || undefined,
    includeDev: Boolean(flags.dev) || config.audit.includeDev,
    maxSites: config.audit.maxSites,
    maxPackages: config.audit.maxPackages,
    onProgress: (phase, detail, done, total) =>
      logger.debug(`${phase}: ${detail}${total > 0 ? ` (${done}/${total})` : ''}`),
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const section = renderAudit(result);
  console.log(section ? `\n${section}\n` : `\n${summarizeAudit(result)}\n`);

  for (const gap of result.gaps) logger.warn(gap.reason);

  // A non-zero exit would be wrong here: these findings are pre-existing by
  // definition, so failing a build on them would fail every build from the
  // moment the command is added to CI, on code nobody touched in that commit.
  // Callers that want a gate can read --json and decide their own threshold.
  return 0;
}

/**
 * Scan every direct dependency for a newer published version — not "what
 * changed", which `analyze` answers for a specific commit range, but "what
 * *could* change": the same check the VS Code extension's "Scan Dependencies"
 * runs, over `src/upgrade/scan.ts`, shared so both surfaces find the same
 * upgrades and reach the same verdict on each one.
 *
 * Read-only, like `analyze`: nothing here edits a manifest or installs
 * anything. `drift outdated --upgrade <name>` is the one exception, and even
 * that only writes the manifest/lockfile locally — the same uncommitted edit
 * `npm install <pkg>@<version>` would leave, which `analyze`/`fix` already
 * know how to pick up via their own working-tree detection.
 */
async function outdatedCommand(flags: Flags): Promise<number> {
  const logLevel = (typeof flags['log-level'] === 'string' ? flags['log-level'] : 'info') as LogLevel;
  const logger = createLogger(logLevel);

  const workspace = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());
  const token = await resolveGitHubToken(flags);

  const slug = typeof flags.repo === 'string' ? flags.repo : await detectRepoSlug(workspace);
  const [owner, repoName] = slug ? slug.split('/') : ['local', 'workspace'];
  if (slug && (!owner || !repoName)) {
    logger.error(`Invalid repository "${slug}". Expected owner/name.`);
    return 1;
  }

  const head = (await gitRev(workspace, 'HEAD')) ?? 'HEAD';
  const branch = (await gitRev(workspace, '--abbrev-ref HEAD')) ?? 'main';
  const repo: RepoContext = {
    owner: owner!,
    repo: repoName!,
    baseBranch: branch,
    beforeSha: head,
    afterSha: head,
    workspace,
  };

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

  logger.info(`Scanning ${owner}/${repoName} for available upgrades`);

  const result = await scanUpgrades({
    root: workspace,
    repo,
    config,
    logger,
    githubToken: token || undefined,
    breadth: { includeDev: Boolean(flags.dev), maxSites: 40, maxPackages: 0 },
    onProgress: (progress) => logger.debug(`${progress.phase}: ${progress.detail}`),
  });

  for (const ambiguity of result.ambiguities) {
    logger.warn(
      `${ambiguity.dir || '.'}: multiple package managers claim ${ambiguity.ecosystem} ` +
        `(${ambiguity.candidates.map((c) => c.manager.id).join(', ')}); using ${ambiguity.candidates[0]!.manager.id}`,
    );
  }

  if (typeof flags.upgrade === 'string') {
    const candidate = result.candidates.find((c) => c.name === flags.upgrade);
    if (!candidate) {
      logger.error(`${flags.upgrade} is not an outdated direct dependency in this repository.`);
      return 1;
    }
    const command = upgradeCommandFor(candidate, flags.force ? 'force' : 'safe');
    if (!command) {
      logger.error(
        `${candidate.packageManager} cannot pin a version from the command line. Edit ${candidate.manifestPath} ` +
          `to require ${candidate.name} ${candidate.selected} by hand.`,
      );
      return 1;
    }
    logger.info(`Running: ${command}`);
    await installUpgrade(workspace, candidate, flags.force ? 'force' : 'safe');
    console.log(
      `\nUpgraded ${candidate.name} to ${candidate.selected}. The manifest/lockfile edit is uncommitted — ` +
        `run \`drift analyze\` or \`drift fix\` to check it for breaking changes and open a pull request.\n`,
    );
    return 0;
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.candidates.some((c) => severityOf(c) === 'affected') ? 1 : 0;
  }

  if (result.checked === 0) {
    console.log('\nNo direct dependencies found to check.\n');
    return 0;
  }

  console.log(`\n${scanTitle(result.candidates, result.checked)}\n`);

  for (const candidate of result.candidates) {
    const versionLabel =
      candidate.selected === candidate.latest
        ? `${candidate.current} → ${candidate.selected}`
        : `${candidate.current} → ${candidate.selected} (latest ${candidate.latest})`;
    console.log(`${candidate.name} ${versionLabel}`);
    console.log(`  ${describeSeverity(candidate)}`);
    if (candidate.summary) console.log(`  ${candidate.summary}`);
    if (!process.stdin.isTTY) console.log(`  Run: drift outdated --upgrade ${candidate.name}`);
    console.log();
  }

  if (result.candidates.length > 0 && process.stdin.isTTY) {
    const choice = await ask(
      'Upgrade one of these now?',
      [...result.candidates.map((c) => c.name), 'Skip'],
      'Skip',
    );
    const picked = result.candidates.find((c) => c.name === choice);
    if (picked) {
      const command = upgradeCommandFor(picked, 'safe');
      if (!command) {
        logger.error(
          `${picked.packageManager} cannot pin a version from the command line. Edit ${picked.manifestPath} ` +
            `to require ${picked.name} ${picked.selected} by hand.`,
        );
        return 1;
      }
      logger.info(`Running: ${command}`);
      await installUpgrade(workspace, picked, 'safe');
      console.log(
        `\nUpgraded ${picked.name} to ${picked.selected}. The manifest/lockfile edit is uncommitted — ` +
          `run \`drift analyze\` or \`drift fix\` to check it for breaking changes and open a pull request.\n`,
      );
    }
  }

  const affected = result.candidates.filter((c) => severityOf(c) === 'affected').length;
  return affected > 0 ? 1 : 0;
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
  const token = await resolveGitHubToken(flags);
  const ghSignedIn = token ? false : (await hasGitHubCli()) || (await tryBrowserSignIn(logger));

  if (!token && !ghSignedIn) {
    logger.error(
      `Signing in to GitHub is required to push a branch and open a pull request. Run \`gh auth login\` if you ` +
        `have the GitHub CLI installed, or set GITHUB_TOKEN / pass --token. Create a token at ` +
        `${CREATE_TOKEN_URL} (the "repo" scope is enough).`,
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

  const { before, after } = await resolveRange(workspace, flags, { includeWorkingTree: false });
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

  logger.info(`Analysing ${owner}/${repoName} ${before.slice(0, 7)}..${describeRef(after)}`);

  const result = await runPipeline({
    repo,
    config,
    logger,
    github,
    provider: new LocalGitProvider(workspace, { before, after }),
    dryRun: true,
    workspace,
  });
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

  // Tracks whether any commit that needed an agent is left unresolved —
  // missing Copilot token, a failed dispatch, or (after the agent-fallback
  // fix in `cli-runner.ts`) a codemod that failed to commit. When true, the
  // run must not report a clean success even if a pull request gets opened:
  // the PR would be missing fixes the run itself knows are outstanding.
  let unresolvedAgentWork = false;

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
        unresolvedAgentWork = true;
      } else {
        if (!fix.pushed) {
          // Copilot works from the remote branch, which nothing has created
          // yet if every commit needed an agent. A plain push of the
          // analysed commit under the new branch name does this without
          // touching the GitHub API — no token needed for this step.
          try {
            await run('git', ['push', 'origin', `${repo.afterSha}:refs/heads/${fix.branch}`], { cwd: workspace });
          } catch (err) {
            logger.error(`Could not create branch \`${fix.branch}\`: ${(err as Error).message}`);
          }
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
          unresolvedAgentWork = true;
        } else {
          logger.info(`Dispatched ${fix.needsAgent.length} commit(s) needing an agent to Copilot.`);
        }
      }
    }

    if (!fix.pushed && fix.needsAgent.length === 0) {
      logger.info('Nothing to fix.');
      return 0;
    }

    const body = unresolvedAgentWork
      ? `> **Incomplete:** ${fix.needsAgent.length} commit(s) still need an AI agent and could not be dispatched. This pull request does not yet contain a fix for them.\n\n${renderPullRequestBody(plan, config)}`
      : renderPullRequestBody(plan, config);

    const pr = await openPullRequest(workspace, token, logger, repo, {
      head: fix.branch,
      base: plan.baseBranch,
      title: titleFor({ changes: plan.changes }, { title: config.pullRequest.titleTemplate, prefix: config.remediation.branchPrefix }),
      body,
      draft: Boolean(flags.draft) || config.pullRequest.draft || config.remediation.draftPr,
      labels: config.pullRequest.labels,
      reviewers: config.pullRequest.reviewers,
    });

    if (pr) {
      console.log(pr.existing ? `Already open: ${pr.url}` : `Opened ${pr.url}`);
    } else if (fix.pushed) {
      console.log(`Pushed \`${fix.branch}\`, but could not open a pull request.`);
    }

    if (unresolvedAgentWork) {
      logger.warn('Exiting non-zero: unresolved agent work remains (see above).');
      return 1;
    }

    // `drift fix` promises push-and-open-PR; a push with no PR is a failure
    // of that promise even when every commit resolved cleanly, not a clean
    // success that merely skipped a nice-to-have step.
    if (!pr) {
      logger.warn('Exiting non-zero: the branch was pushed but no pull request was opened.');
      return 1;
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

  const token = await resolveGitHubToken(flags);
  const ghSignedIn = token ? false : (await hasGitHubCli()) || (await tryBrowserSignIn(logger));

  if (!token && !ghSignedIn) {
    logger.error(
      `Signing in to GitHub is required to open a pull request. Run \`gh auth login\` if you have the GitHub ` +
        `CLI installed, or set GITHUB_TOKEN / pass --token. Create a token at ${CREATE_TOKEN_URL} ` +
        '(the "repo" scope is enough).',
    );
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

  const repo: RepoContext = {
    owner,
    repo: repoName,
    baseBranch: base.branch,
    beforeSha: '',
    afterSha: '',
    workspace,
  };

  const pr = await openPullRequest(workspace, token, logger, repo, {
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

/**
 * Which commits to analyse, for `analyze` and `fix`.
 *
 * `--before`/`--after` win outright when either is given. Otherwise this
 * finds the dependency change itself — an uncommitted manifest edit, else the
 * most recent commit that touched a manifest — rather than blindly diffing
 * `HEAD^..HEAD`, which is usually unrelated work and is why the CLI used to
 * report "nothing changed" on ranges the VS Code extension flagged correctly.
 * `fix` passes `includeWorkingTree: false` since it checks `after` out into a
 * worktree and needs a real commit, not the sentinel for "the working tree".
 */
async function resolveRange(
  workspace: string,
  flags: Flags,
  opts: { includeWorkingTree?: boolean } = {},
): Promise<{ before: string; after: string }> {
  if (typeof flags.before === 'string' || typeof flags.after === 'string') {
    const after = (typeof flags.after === 'string' ? flags.after : await gitRev(workspace, 'HEAD')) ?? 'HEAD';
    const before =
      (typeof flags.before === 'string' ? flags.before : await gitRev(workspace, 'HEAD^')) ?? `${after}^`;
    return { before, after };
  }

  const info = await inspectLocalRepo(workspace);
  const chosen = info ? await chooseManifestRange(workspace, info, opts) : null;
  if (chosen) return chosen;

  const after = (await gitRev(workspace, 'HEAD')) ?? 'HEAD';
  const before = (await gitRev(workspace, 'HEAD^')) ?? `${after}^`;
  return { before, after };
}

/** Short label for a ref in log output — `WORKING_TREE` has no SHA to slice. */
function describeRef(ref: string): string {
  return ref === WORKING_TREE ? 'working tree' : ref.slice(0, 7);
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
