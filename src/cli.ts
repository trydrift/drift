#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { RepoContext } from './types.js';
import { loadConfig } from './config/load.js';
import { GitHubClient } from './github/client.js';
import {
  LocalGitProvider,
  WORKING_TREE,
  chooseManifestRange,
  commitWorkingTreeManifests,
  inspectLocalRepo,
} from './repo/local-git.js';
import { runPipeline } from './pipeline.js';
import { resolveBaseBranch, titleFor } from './plan/pull-request.js';
import { renderPullRequestBody } from './report/markdown.js';
import { runAction } from './runners/action.js';
import { main as serveWebhook } from './runners/webhook.js';
import { sampleTelemetryEvent } from './telemetry.js';
import { createLogger, type LogLevel, type Logger } from './util/logger.js';
import { countWork, redactCommand, redactText, startRunLog, startSpan, withSpan } from './util/diagnostics.js';
import { paletteFor, supportsRedraw } from './util/terminal.js';
import { createStatusLine } from './util/status-line.js';
import { createOutdatedView } from './report/terminal-outdated.js';
import { configureHttpDiskCache } from './util/http.js';
import { createBaselineCache } from './verification/baseline-cache.js';
import { execCommand } from './util/exec.js';
import { fetchVersionDiff, unifiedDiffText } from './evidence/version-diff.js';
import { runFix } from './remediation/cli-runner.js';
import { runAgentCommitsInWorktree } from './remediation/worktree-runner.js';
import { credentialsWithLegacyCopilot, agentConfigWithLegacyCopilot } from './agents/compat.js';
import { defaultAgentProviderRegistry, isCloudFixAgent, type AgentProviderRegistry } from './agents/registry.js';
import { resolveAgentSelection, type AgentSelection } from './agents/selection.js';
import type { FixAgent } from './agents/types.js';
import { planForCommits } from './remediation/partition.js';
import {
  installUpgrade,
  installUpgrades,
  reanalyzeUpgrade,
  scanUpgrades,
  upgradeCommandFor,
  type UpgradeCandidate,
  type UpgradeScanResult,
} from './upgrade/scan.js';
import { opensPullRequestAsDraft, type DriftConfig, type ExplicitAgentProvider } from './config/schema.js';
import { describeSeverity, scanTitle, severityOf } from './upgrade/severity.js';
import { ask } from './util/prompt.js';
import { createBranchForTarget, createIssueAndBranchForTarget, createIssueForTarget } from './actions/cli-actions.js';
import { groupForAction, type IssueBranchAction, type IssueBranchOutcome } from './actions/issue-branch.js';
import type { RemediationPlan } from './types.js';

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
  drift upgrade [options]     Install every upgrade proven safe for this code
  drift fix [options]         Analyse, then apply the fixes and push a branch
  drift pr [options]          Push the current branch and open a pull request
  drift diff <eco> <pkg> <from> <to>
                              Print a real \`git diff\` between two published
                              versions of a package's source. eco is one of:
                              npm, cargo, pypi, go, pub, hex, maven (best-
                              effort: only when Central has a sources jar).
                              Not nuget or a C/C++ ecosystem — neither has a
                              single fetchable archive of actual source
  drift action                Run as a GitHub Action (reads INPUT_* env vars)
  drift serve                 Run the self-hosted webhook server
  drift telemetry print       Print the exact telemetry event shape
  drift --version             Print the version

Options for \`outdated\` and \`upgrade\`:
  --repo <owner/name>         Repository label for output. Default: git remote
  --dir <path>                Local checkout to scan.    Default: cwd
  --no-dev                    Skip dev/optional/peer dependencies (checked by
                              default alongside runtime ones)
  --upgrade <selector>        Install the recommended version for one package
                              found by the scan (writes the manifest/lockfile
                              locally — run \`drift fix\` afterwards). The
                              selector is the package name, or \`dir:name\`
                              when a name is declared in more than one
                              workspace member
  --latest                    With --upgrade, install the true latest instead
                              of the newest version your declared range allows.
                              Re-runs the breaking-change analysis first, since
                              that is a different version from the one scanned
  --force-install             With --upgrade, pass the package manager's own
                              force flag (\`npm install --force\`). This does
                              NOT change which version is installed; only
                              --latest does that. Alias: --force
  --token <token>             Optional, only to raise the public API rate
                              limit. Default: $GITHUB_TOKEN, then \`gh auth token\`
  --config <path>             Config file. Default: .github/drift.yml
  --json                      Emit the full scan result as JSON
  --verify                    Deep Verification: after the static (Quick
                              Scan) report, install each candidate in a
                              throwaway worktree and run this project's own
                              checks before reporting it. Off by default —
                              a scan without it reports static predictions
                              only, clearly labelled as not deeply verified.
                              Requires verify.enabled: true in drift.yml
                              (the default)
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
  --verify                    Deep Verification: after the static (Quick
                              Scan) report, install this change in a
                              throwaway worktree and run this project's own
                              checks before reporting it. Off by default —
                              a run without it reports static predictions
                              only, clearly labelled as not deeply verified.
                              Requires verify.enabled: true in drift.yml
                              (the default)
  --log-level <level>         debug | info | warn | error. Default: info

Options for \`fix\` (accepts every \`analyze\` option too):
  --plan                      Print every deterministic fix plan and stop.
                              Writes nothing: no worktree edit, no commit, no
                              branch, no agent. This is the review step — each
                              plan states the rule, the evidence attesting it,
                              every call site it would change (before → after),
                              and every call site it would decline and why
  --non-interactive           Never prompt. Applies only the fix plans
                              \`remediation.fixPlans.autoApply\` clears for
                              unattended use and leaves the rest to an agent —
                              the same decision the GitHub Action makes for the
                              same config (this is the default outside a TTY)
  --copilot-token <token>     User-scoped token for commits that need an
                              agent. Default: $DRIFT_COPILOT_TOKEN
  --agent <provider>          Registered agent provider for unresolved edits.
                              In non-interactive auto mode Drift only chooses
                              automatically when exactly one provider is usable
  --agent-model <model>       Model id to pass to the selected agent
  --agent-effort <effort>     low | medium | high | xhigh, where supported
  --agent-timeout-seconds <n> Local agent timeout. Default: drift.yml
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
given --upgrade, and even then only a local manifest/lockfile edit. \`upgrade\`
does the same scan, then makes those local edits for every upgrade Drift proved
safe for this repository; it leaves affected and unchecked packages alone.
\`fix\` applies the plan in an isolated git worktree — your working tree is
never touched — using, per commit, Drift's own deterministic codemod, then a
validated fix plan, then an AI agent, in that order; it pushes a branch and
opens a pull request. It never merges, never force-pushes, and never touches
the base branch.

A fix plan is a migration described once, as a rule, and applied by Drift to
every call site at once. Whatever proposed it — a cached plan, a community
recipe's observed edits, or one model call for the whole finding — it is only
used after Drift has checked that it is grounded in the finding, that every
name it introduces appears in cited evidence, and that it converges and
preserves lines. Community recipes are a proposal source, not an execution
path: a recipe's own edits are never committed. Run \`drift fix --plan\` to
read every plan before any of it happens.
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

/**
 * Where fetched registry metadata, changelogs, release notes, and downloaded
 * `.d.ts`/module-map artifacts are kept between runs.
 *
 * These are keyed by URL, and the URLs Drift fetches already name an exact
 * version — `zod 3.25.76`'s registry entry and changelog are the same bytes
 * on every scan that asks for them, on every machine that asks. Reusing
 * them turns a re-scan of an unchanged dependency into a filesystem read
 * instead of a network round trip, without changing what the scan finds:
 * `util/http.ts` still revalidates via ETag past its TTL rather than
 * trusting a stale entry forever.
 *
 * `DRIFT_CACHE_DIR` overrides the location — set it to a directory an
 * `actions/cache` step restores to get this across separate CI runs, not
 * just within one. `DRIFT_NO_CACHE=1` disables the disk cache entirely
 * (the in-process cache for one run's own duplicate requests still applies).
 */
function defaultHttpCacheDir(): string | null {
  if (process.env.DRIFT_NO_CACHE === '1') return null;
  return process.env.DRIFT_CACHE_DIR || join(homedir(), '.drift', 'cache', 'http');
}

/**
 * Where measured baselines are remembered between runs.
 *
 * Beside the HTTP cache and governed by the same switches, because it is the
 * same bargain: both trade a little disk for not re-deriving a fact that has
 * not changed. `DRIFT_NO_CACHE=1` turns off both.
 */
function defaultBaselineCacheDir(): string | null {
  if (process.env.DRIFT_NO_CACHE === '1') return null;
  return process.env.DRIFT_CACHE_DIR
    ? join(process.env.DRIFT_CACHE_DIR, 'baseline')
    : join(homedir(), '.drift', 'cache', 'baseline');
}

/** Commands that operate on a repository, and so get a repo-local run log. */
const REPO_COMMANDS = new Set(['analyze', 'analyse', 'outdated', 'upgrade', 'fix', 'pr']);

async function gitHeadShort(repoRoot: string): Promise<string> {
  const result = await execCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, timeoutMs: 5000 });
  return result.code === 0 ? result.stdout.trim() : 'unknown';
}

export async function main(argv: string[]): Promise<number> {
  configureHttpDiskCache(defaultHttpCacheDir());
  const [command, ...rest] = argv;

  // Flags — in particular `--dir` — must be resolved before the run log is
  // opened, so `cd /tmp && drift analyze --dir ~/code/my-project` writes to
  // that project's git dir, not to a stray `.drift/` under `/tmp`.
  const flags = parseFlags(rest);
  const repoRoot = command && REPO_COMMANDS.has(command) ? resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd()) : null;

  const runLog = repoRoot
    ? startRunLog({
        command: redactCommand(argv),
        mode: flags.verify ? 'deep' : 'quick',
        repoRoot,
        gitHead: await gitHeadShort(repoRoot),
        driftVersion: await packageVersion(),
      })
    : null;

  try {
    const code = runLog ? await runLog.run(() => runCommand(command, rest)) : await runCommand(command, rest);
    runLog?.finish(code === 0 ? 'ok' : 'error', { exitCode: code });
    return code;
  } catch (err) {
    runLog?.finish('threw', { message: redactText((err as Error).message) });
    throw err;
  }
}

async function runCommand(command: string | undefined, rest: string[]): Promise<number> {
  switch (command) {
    case 'analyze':
    case 'analyse':
      return analyzeCommand(parseFlags(rest));
    case 'outdated':
      return outdatedCommand(parseFlags(rest));
    case 'upgrade':
      return upgradeCommand(parseFlags(rest));
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
    case 'diff':
      return diffCommand(rest);
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

/**
 * A real diff between two published versions, for the one evidence source
 * that is a claim rather than an observation — the semver heuristic. Prints
 * exactly what `git diff` prints, because it is one, run `--no-index` across
 * the two extracted archives rather than against a repository's history.
 */
async function diffCommand(args: readonly string[]): Promise<number> {
  const [ecosystem, name, from, to] = args;
  if (!ecosystem || !name || !from || !to) {
    console.error('Usage: drift diff <ecosystem> <package> <from-version> <to-version>');
    return 1;
  }

  const result = await fetchVersionDiff({ ecosystem, name, from, to, exec: execCommand });
  if (!result.available) {
    console.error(result.reason);
    return 1;
  }

  const diff = await unifiedDiffText(result.beforeDir, result.afterDir, execCommand);
  if (diff) {
    process.stdout.write(diff.endsWith('\n') ? diff : `${diff}\n`);
  } else {
    console.log(`${name} ${from} → ${to}: no textual difference.`);
  }
  return 0;
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

  // Quick Scan by default — `--verify` is the explicit opt-in into Deep
  // Verification (install the change in a throwaway worktree, run this
  // project's own typecheck/build/test). `config.verify.enabled` stays a
  // hard ceiling above that: a repository with verification switched off in
  // drift.yml stays off regardless of the flag.
  const deepVerifyRequested = Boolean(flags.verify) && config.verify.enabled;

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
    verify: { enabled: deepVerifyRequested },
  });

  if (!result.plan) {
    if (flags.json) {
      console.log(JSON.stringify({ plan: null, summary: result.summary }, null, 2));
      return 0;
    }

    console.log(`\n${result.summary}\n`);
    return 0;
  }

  if (flags.json) {
    console.log(JSON.stringify(result.plan, null, 2));
    return 0;
  }

  console.log(`\n${renderPullRequestBody(result.plan, config)}\n`);

  if (!deepVerifyRequested) {
    console.log(
      config.verify.enabled
        ? "Static analysis only — not deeply verified. Re-run with --verify to install this change and run this project's own checks.\n"
        : 'Deep verification is disabled (verify.enabled: false in drift.yml).\n',
    );
  }

  if (process.stdin.isTTY && result.plan.breakingChanges.length > 0) {
    await offerIssueBranchActions({ plan: result.plan, config, repo, github, workspace, logger, flags });
  }

  return 0;
}

const ACTION_LABEL: Record<IssueBranchAction, string> = {
  issue: 'File a GitHub issue',
  branch: 'Create a local branch',
  both: 'File an issue and a branch',
};

/**
 * The interactive side of the one-click issue/branch action: offered once
 * per group (per package or per breaking change, per `issueCreation.
 * granularity`) right after `analyze` prints its report, so filing a
 * finding needs no second command. TTY-gated by the caller, and every
 * outcome — including "no git repo here" or "no GitHub token" — is reported
 * as a log line, never a thrown error, since a piped or scripted run must
 * never see this prompt at all and an interactive one must never crash over
 * a missing credential.
 */
async function offerIssueBranchActions(args: {
  plan: RemediationPlan;
  config: DriftConfig;
  repo: RepoContext;
  github: GitHubClient;
  workspace: string;
  logger: Logger;
  flags: Flags;
}): Promise<void> {
  const { plan, config, repo, github, workspace, logger, flags } = args;
  const repoBlobUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.afterSha}`;
  const targets = groupForAction(plan.breakingChanges, config.issueCreation.granularity, plan.impactSites).map(
    (target) => ({ ...target, repoBlobUrl }),
  );
  const order: IssueBranchAction[] = [
    config.issueCreation.default,
    ...(['issue', 'branch', 'both'] as const).filter((action) => action !== config.issueCreation.default),
  ];
  const options = [...order.map((action) => ACTION_LABEL[action]), 'Skip'];

  let filedSomething = false;

  for (const target of targets) {
    const label =
      target.changes.length === 1
        ? `${target.dependency}: ${target.changes[0]!.summary}`
        : `${target.dependency} (${target.changes.length} breaking changes)`;
    const answer = await ask(label, options, 'Skip');
    const chosen = order.find((action) => ACTION_LABEL[action] === answer);
    if (!chosen) continue;
    filedSomething = true;

    if (chosen === 'issue') {
      reportIssueBranchOutcome(await createIssueForTarget(github, repo, target, logger), logger);
    } else if (chosen === 'branch') {
      reportIssueBranchOutcome(await createBranchForTarget(workspace, target, logger), logger);
    } else {
      const outcome = await createIssueAndBranchForTarget(github, repo, workspace, target, logger);
      reportIssueBranchOutcome(outcome.branch, logger);
      reportIssueBranchOutcome(outcome.issue, logger);
    }
  }

  if (filedSomething) await offerToStartFixing({ plan, config, repo, workspace, logger, flags });
}

/**
 * Asked once, right after the filing loop above — the same follow-up the VS
 * Code extension's `offerBranchForIssue` asks after linking a branch. Runs
 * the exact pipeline `drift fix` does (`fixPlanAndOpenPR`): every commit in
 * this plan, not just the target(s) just filed, since Drift plans and
 * dispatches fixes for the whole batch together rather than one dependency
 * at a time.
 */
async function offerToStartFixing(args: {
  plan: RemediationPlan;
  config: DriftConfig;
  repo: RepoContext;
  workspace: string;
  logger: Logger;
  flags: Flags;
}): Promise<void> {
  const { plan, config, repo, workspace, logger, flags } = args;
  const answer = await ask(
    `Start fixing now? Drift will work through all ${plan.commits.length} commit(s) it planned, push a branch, and open a pull request.`,
    ['Yes, start fixing', 'Not now'],
    'Not now',
  );
  if (answer !== 'Yes, start fixing') return;

  const token = await resolveGitHubToken(flags);
  const ghSignedIn = token ? false : (await hasGitHubCli()) || (await tryBrowserSignIn(logger));
  if (!token && !ghSignedIn) {
    logger.error(
      `Signing in to GitHub is required to push a branch and open a pull request. Run \`gh auth login\`, or set ` +
        `GITHUB_TOKEN / pass --token. Create a token at ${CREATE_TOKEN_URL} (the "repo" scope is enough). Run ` +
        `\`drift fix\` once you have.`,
    );
    return;
  }

  const code = await fixPlanAndOpenPR({ repo, plan, config, workspace, logger, flags, token });
  if (code !== 0) logger.warn('Fixing finished with problems — see above.');
}

function reportIssueBranchOutcome(outcome: IssueBranchOutcome, logger: Logger): void {
  switch (outcome.kind) {
    case 'issue':
      logger.info(
        outcome.status === 'created' ? `Filed issue ${outcome.url}` : `Already filed as issue ${outcome.url}`,
      );
      return;
    case 'branch':
      logger.info(outcome.status === 'created' ? `Created branch ${outcome.name}` : `Switched to branch ${outcome.name}`);
      return;
    case 'unavailable':
      logger.warn(`Skipped — ${describeUnavailable(outcome.reason)}.`);
      return;
    case 'failed':
      logger.warn(`Skipped — ${outcome.message}`);
      return;
  }
}

function describeUnavailable(reason: Extract<IssueBranchOutcome, { kind: 'unavailable' }>['reason']): string {
  switch (reason) {
    case 'no-git-repo':
      return 'not a git repository';
    case 'no-remote':
      return 'no git remote configured';
    case 'gh-not-installed':
      return 'the GitHub CLI is not installed';
    case 'gh-not-authenticated':
      return 'the GitHub CLI is not signed in';
    case 'no-token':
      return 'no GitHub token available (pass --token, set GITHUB_TOKEN, or run `gh auth login`)';
  }
}

/**
 * Scan every direct dependency for a newer published version — not "what
 * changed", which `analyze` answers for a specific commit range, but "what
 * *could* change": the same check the VS Code extension's "Scan Dependencies"
 * runs, over `src/upgrade/scan.ts`, shared so both surfaces find the same
 * upgrades and reach the same verdict on each one.
 *
 * Read-only against *this* working tree, like `analyze`: nothing here edits
 * a manifest or installs anything in the checkout the developer is looking
 * at. `drift outdated --upgrade <name>` is the one exception, and even that
 * only writes the manifest/lockfile locally — the same uncommitted edit
 * `npm install <pkg>@<version>` would leave, which `analyze`/`fix` already
 * know how to pick up via their own working-tree detection.
 *
 * That is no longer the whole story, though: verification is on by default
 * (`verify.enabled`), and it installs each candidate — and runs the
 * project's own build/typecheck/test — in a disposable git worktree, never
 * in this one. A scan is still safe to run without asking, but it is not
 * side-effect-free on the machine: it does execute code the developer has
 * not chosen to install yet. See `verification/upgrade-probe.ts` for what
 * that worktree does and does not have access to.
 */
async function outdatedCommand(flags: Flags, options: { installSafe?: boolean } = {}): Promise<number> {
  const logLevel = (typeof flags['log-level'] === 'string' ? flags['log-level'] : 'info') as LogLevel;
  const logger = createLogger(logLevel);

  const workspace = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());
  const repoDiscovery = startSpan('repository.discovery');
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
  repoDiscovery.end({ repo: slug ?? 'local' });

  // Everything the command *produces* goes to stdout; everything about how it
  // is going goes to stderr through the status line. That is what makes
  // `drift outdated > report.txt` a clean report and `drift outdated | grep`
  // work at all, and it is why the palette is read from stdout rather than
  // from whichever stream happens to be in hand.
  const palette = paletteFor(process.stdout);
  const status = createStatusLine({ palette, live: supportsRedraw(process.stderr) && !flags.json });
  const view = createOutdatedView({
    palette,
    status,
    interactive: Boolean(process.stdin.isTTY),
  });

  // Announced up front, before the first registry request, so the command has
  // said what it is doing before it starts taking time over it.
  if (!flags.json) view.start(slug ? `${owner}/${repoName}` : 'this workspace', workspace);

  // Quick Scan by default — `--verify` is the explicit opt-in into Deep
  // Verification (install the change in a throwaway worktree, run this
  // project's own typecheck/build/test). `config.verify.enabled` stays a
  // hard ceiling above that: a repository with verification switched off in
  // drift.yml stays off regardless of the flag.
  const deepVerifyRequested = Boolean(flags.verify) && config.verify.enabled;

  let settledCount = 0;
  let toAnalyse = 0;
  const result = await withSpan('upgrade.scan', undefined, () => scanUpgrades({
    root: workspace,
    repo,
    config,
    logger,
    githubToken: token || undefined,
    breadth: { includeDev: flags['no-dev'] !== true, maxSites: 40, maxPackages: 0 },
    // Running `drift outdated` twice against the same commit used to pay for
    // the same baseline typecheck, build and test suite both times.
    verify: { enabled: deepVerifyRequested, baselineCache: createBaselineCache(defaultBaselineCacheDir()) },
    onProgress: (progress) => {
      logger.debug(`${progress.phase}: ${progress.detail}`);
      if (flags.json || !progress.phase) return;
      const counted = progress.total > 0 ? ` (${progress.done}/${progress.total})` : '';
      status.update(`${progress.phase}${progress.detail ? ` ${palette.glyph('dot')} ${progress.detail}` : ''}${counted}`);
    },
    // The whole reason the scan has two phases: the table is printable here,
    // seconds in, and everything below it takes minutes.
    onOutdated: (summary) => {
      if (flags.json) return;
      toAnalyse = summary.outdated.length;
      if (summary.outdated.length === 0) {
        view.allCurrent(summary.checked);
        view.unchecked(summary.unchecked);
        return;
      }
      view.table(summary.outdated, summary.checked, summary.upToDate);
      view.unchecked(summary.unchecked);
      view.analysing(summary.outdated.length);
    },
    // One line per package, the moment it is settled rather than at the end.
    // `onCandidate` fires several times per package as it moves through its
    // phases; only the final verdict is worth a line, and `verification` is
    // what marks it — every candidate gets one, even when it is `skipped`.
    onCandidate: (candidate) => {
      if (flags.json) return;
      if (candidate.status === 'pending' || candidate.status === 'checking') return;
      if (deepVerifyRequested && !candidate.verification) return;
      settledCount += 1;
      view.settled(candidate);
      status.update(`Checked ${settledCount} of ${toAnalyse}`);
    },
  }));
  countWork('packages_considered', result.checked);
  countWork('packages_analyzed', result.candidates.length);
  countWork('packages_skipped', result.unchecked.length);
  status.stop();

  // A read-only scan may guess which manager owns an ambiguous directory and
  // say so. `performUpgrade` refuses to guess, because that guess writes.
  for (const ambiguity of result.ambiguities) {
    logger.warn(
      `${ambiguity.dir || '.'}: multiple package managers claim ${ambiguity.ecosystem} ` +
        `(${ambiguity.candidates.map((c) => c.manager.id).join(', ')}); reading as ` +
        `${ambiguity.candidates[0]!.manager.id}. Drift will ask before writing anything here.`,
    );
  }

  if (typeof flags.upgrade === 'string') {
    const candidate = selectCandidate(result.candidates, flags.upgrade, logger);
    if (!candidate) return 1;
    return performUpgrade({
      workspace,
      candidate,
      result,
      logger,
      forceInstall: Boolean(flags['force-install'] ?? flags.force),
      wantLatest: Boolean(flags.latest),
      repo,
      config,
      githubToken: token || undefined,
    });
  }

  if (options.installSafe) {
    return performSafeUpgrades({ workspace, candidates: result.candidates, result, logger });
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.candidates.some((c) => severityOf(c) === 'affected' || severityOf(c) === 'verification-failed')
      ? 1
      : 0;
  }

  if (result.checked === 0) {
    console.log(`\n${palette('gray', 'No direct dependencies found to check.')}\n`);
    return 0;
  }

  // The table, the verdicts and the unchecked list are already on screen — each
  // printed at the moment it was known rather than held back to here. What is
  // left is the part that could only be written once every verdict was in:
  // the same packages grouped by how much a developer has to care, which is
  // the question the whole command exists to answer.
  console.log(`\n${palette('bold', scanTitle(result.candidates, result.checked, result.unchecked.length))}`);
  view.report(result.candidates, (candidate) => selectorFor(candidate, result.candidates));

  if (result.candidates.length > 0 && !deepVerifyRequested) {
    console.log(
      `\n${palette(
        'gray',
        config.verify.enabled
          ? 'Static analysis only — not deeply verified. Re-run with --verify to install each candidate and run this project\'s own checks.'
          : 'Deep verification is disabled (verify.enabled: false in drift.yml).',
      )}`,
    );
  }

  if (result.candidates.length > 0 && process.stdin.isTTY) {
    // Labelled, not bare names: two workspace members can both depend on
    // `react`, and a menu with `react` twice offers no way to say which.
    const labels = result.candidates.map((c) => candidateLabel(c, result.candidates));
    const choice = await ask('Upgrade one of these now?', [...labels, 'Skip'], 'Skip');
    const picked = result.candidates[labels.indexOf(choice)];
    if (picked) {
      return performUpgrade({
        workspace,
        candidate: picked,
        result,
        logger,
        forceInstall: false,
        wantLatest: false,
        repo,
        config,
        githubToken: token || undefined,
      });
    }
  }

  const affected = result.candidates.filter(
    (c) => severityOf(c) === 'affected' || severityOf(c) === 'verification-failed',
  ).length;
  return affected > 0 ? 1 : 0;
}

/**
 * Scan, then install only the upgrades that carry the same verdict as the
 * extension's `/upgrade-all`: clean upstream changes, or upstream breaking
 * changes this repository does not use. An explicit package selection remains
 * `drift outdated --upgrade <selector>`; this command is deliberately not an
 * unrestricted alias for npm update.
 */
async function upgradeCommand(flags: Flags): Promise<number> {
  if (
    typeof flags.upgrade === 'string' ||
    flags.latest === true ||
    flags['force-install'] === true ||
    flags.force === true ||
    flags.json === true
  ) {
    console.error('`drift upgrade` installs the scan’s safe selected versions. Use `drift outdated --upgrade <selector>` for --latest, --force-install, or --json.');
    return 1;
  }
  return outdatedCommand(flags, { installSafe: true });
}

/** The candidates that bulk upgrade is entitled to change without another decision. */
export function safeUpgradeCandidates(candidates: readonly UpgradeCandidate[]): UpgradeCandidate[] {
  return candidates.filter((candidate) => {
    const severity = severityOf(candidate);
    return severity === 'clean' || severity === 'upstream-only';
  });
}

/** Keep scan order while giving each manifest/manager pair one batch attempt. */
export function groupUpgradeCandidates(candidates: readonly UpgradeCandidate[]): UpgradeCandidate[][] {
  const groups = new Map<string, UpgradeCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.manifestPath}\u0000${candidate.packageManager}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  return [...groups.values()];
}

export async function performSafeUpgrades(args: {
  workspace: string;
  candidates: readonly UpgradeCandidate[];
  result: UpgradeScanResult;
  logger: Logger;
  installMany?: (root: string, candidates: readonly UpgradeCandidate[]) => Promise<boolean>;
  installOne?: (root: string, candidate: UpgradeCandidate) => Promise<void>;
  resolveManager?: (
    candidate: UpgradeCandidate,
    result: UpgradeScanResult,
    logger: Logger,
  ) => Promise<UpgradeCandidate | null>;
}): Promise<number> {
  const safe = safeUpgradeCandidates(args.candidates);
  const skipped = args.candidates.filter((candidate) => !safe.includes(candidate));

  if (safe.length === 0) {
    console.log('\nNo upgrades were proven safe to install. Affected, unchecked, and failed candidates were left unchanged.\n');
    return 0;
  }

  const installed: UpgradeCandidate[] = [];
  const resolveManager = args.resolveManager ?? resolveManagerForWrite;
  const installMany = args.installMany ?? ((root, candidates) => installUpgrades(root, candidates));
  const installOne = args.installOne ?? ((root, candidate) => installUpgrade(root, candidate));
  for (const group of groupUpgradeCandidates(safe)) {
    const resolved: UpgradeCandidate[] = [];
    for (const candidate of group) {
      const choice = await resolveManager(candidate, args.result, args.logger);
      if (!choice) return 1;
      resolved.push(choice);
    }

    try {
      args.logger.info(`Upgrading ${resolved.map((candidate) => `${candidate.name}@${candidate.selected}`).join(', ')}`);
      const batched = await installMany(args.workspace, resolved);
      if (!batched) {
        for (const candidate of resolved) await installOne(args.workspace, candidate);
      }
      installed.push(...resolved);
    } catch (err) {
      args.logger.error(
        `Could not upgrade ${resolved.map((candidate) => candidate.name).join(', ')}: ` +
          `${err instanceof Error ? err.message : String(err)}. Later upgrades were not attempted.`,
      );
      return 1;
    }
  }

  const paths = [...new Set(installed.map((candidate) => candidate.manifestPath))];
  const skippedBySeverity = new Map<string, number>();
  for (const candidate of skipped) {
    const severity = severityOf(candidate);
    skippedBySeverity.set(severity, (skippedBySeverity.get(severity) ?? 0) + 1);
  }
  const skippedSummary = [...skippedBySeverity]
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ');
  console.log(
    `\nUpgraded ${installed.length} proven-safe package${installed.length === 1 ? '' : 's'} in ${paths.join(', ')}.` +
      (skippedSummary ? ` Left ${skipped.length} non-safe package${skipped.length === 1 ? '' : 's'} unchanged (${skippedSummary}).` : '') +
      ' The edits are uncommitted — run `drift fix` to analyse them, apply needed fixes, and open a pull request.\n',
  );
  return 0;
}

/**
 * How a candidate is named when more than one could answer to the same name.
 *
 * In a monorepo `react` is not a unique identifier: `packages/web` and
 * `packages/admin` can both declare it, at different versions, with different
 * impact. A bare name in that repository picks whichever the scan happened to
 * sort first, which is not a choice the developer made.
 */
function candidateLabel(
  candidate: UpgradeCandidate,
  all: readonly UpgradeCandidate[],
): string {
  return selectorFor(candidate, all);
}

/** The `--upgrade` argument that unambiguously identifies this candidate. */
export function selectorFor(candidate: UpgradeCandidate, all: readonly UpgradeCandidate[]): string {
  const ambiguous = all.filter((c) => c.name === candidate.name).length > 1;
  if (!ambiguous) return candidate.name;
  const scope = candidate.workspace || dirOf(candidate.manifestPath) || '.';
  return `${scope}:${candidate.name}`;
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/**
 * Resolve `--upgrade <selector>` to exactly one candidate.
 *
 * Accepts a bare name, or `dir:name` / `workspace:name` when a bare name would
 * be ambiguous. Refuses to pick for the developer when it is: guessing which
 * of two workspaces they meant is a write to the wrong manifest.
 */
export function selectCandidate(
  candidates: readonly UpgradeCandidate[],
  selector: string,
  logger: Logger,
): UpgradeCandidate | null {
  const separator = selector.lastIndexOf(':');
  const scope = separator > 0 ? selector.slice(0, separator) : null;
  const name = separator > 0 ? selector.slice(separator + 1) : selector;

  const byName = candidates.filter((c) => c.name === name);
  if (byName.length === 0) {
    logger.error(`${name} is not an outdated direct dependency in this repository.`);
    return null;
  }

  const matches = scope
    ? byName.filter((c) => (c.workspace || dirOf(c.manifestPath) || '.') === scope)
    : byName;

  if (matches.length === 1) return matches[0]!;

  if (matches.length === 0) {
    logger.error(
      `${name} is not declared in ${scope}. It is declared in: ` +
        `${byName.map((c) => selectorFor(c, candidates)).join(', ')}.`,
    );
    return null;
  }

  logger.error(
    `${name} is declared in ${matches.length} places, so it is not clear which one to upgrade. ` +
      `Name one: ${matches.map((c) => `drift outdated --upgrade ${selectorFor(c, candidates)}`).join(' | ')}`,
  );
  return null;
}

/**
 * Install one candidate, having first established that Drift knows what it is
 * about to run and where.
 *
 * The two refusals here are the point. A scan that has to guess which package
 * manager owns a directory may guess, because reading is harmless. Writing is
 * not: running `npm install` in a pnpm repository generates a second lockfile
 * that nobody asked for and that CI will then disagree about. And `--latest`
 * installs a version the scan did not analyse, so the analysis is redone
 * rather than allowed to describe a different version than the one landing on
 * disk.
 */
async function performUpgrade(args: {
  workspace: string;
  candidate: UpgradeCandidate;
  result: UpgradeScanResult;
  logger: Logger;
  forceInstall: boolean;
  wantLatest: boolean;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
}): Promise<number> {
  const { workspace, result, logger } = args;
  let candidate = args.candidate;

  const resolved = await resolveManagerForWrite(candidate, result, logger);
  if (!resolved) return 1;
  candidate = resolved;

  if (args.wantLatest && candidate.selected !== candidate.latest) {
    logger.info(
      `--latest: re-checking ${candidate.name} ${candidate.current} → ${candidate.latest} ` +
        `(the scan analysed ${candidate.selected}).`,
    );
    candidate = await reanalyzeUpgrade({
      candidate,
      version: candidate.latest,
      root: workspace,
      repo: args.repo,
      config: args.config,
      logger,
      ...(args.githubToken ? { githubToken: args.githubToken } : {}),
    });
    console.log(`\n${describeSeverity(candidate)}`);
    if (candidate.summary) console.log(`${candidate.summary}\n`);
  }

  const mode = args.forceInstall ? 'force' : 'safe';
  const command = upgradeCommandFor(candidate, mode);
  if (!command) {
    logger.error(
      `${candidate.packageManager} cannot pin a version from the command line. Edit ${candidate.manifestPath} ` +
        `to require ${candidate.name} ${candidate.selected} by hand.`,
    );
    return 1;
  }

  logger.info(`Running: ${command}`);
  await installUpgrade(workspace, candidate, mode);
  console.log(
    `\nUpgraded ${candidate.name} to ${candidate.selected} in ${candidate.manifestPath}. The edit is ` +
      `uncommitted — run \`drift fix\` to check it for breaking changes, fix them, and open a pull ` +
      `request (it analyses the uncommitted change directly), or \`drift analyze\` to just read the report.\n`,
  );
  return 0;
}

/**
 * Confirm which package manager may write to this candidate's directory.
 *
 * Returns the candidate with `packageManager` set to a manager Drift is
 * entitled to run, or `null` when that could not be established. A warning was
 * never enough here: `drift outdated` warned about the ambiguity and then went
 * ahead and used the first candidate anyway, which is exactly the "npm in a
 * pnpm repo" failure the package-manager layer exists to prevent.
 */
async function resolveManagerForWrite(
  candidate: UpgradeCandidate,
  result: UpgradeScanResult,
  logger: Logger,
): Promise<UpgradeCandidate | null> {
  const dir = candidate.workspace || dirOf(candidate.manifestPath);
  const ambiguity = result.ambiguities.find(
    (a) => a.dir === dir && a.ecosystem === candidate.ecosystem,
  );
  if (!ambiguity) return candidate;

  const options = ambiguity.candidates.map((c) => c.manager.id);
  const where = dir || 'this repository';

  if (!process.stdin.isTTY) {
    logger.error(
      `More than one package manager claims ${candidate.ecosystem} in ${where} (${options.join(', ')}), ` +
        `so Drift will not guess which one may write here — the wrong choice generates a second lockfile. ` +
        `Remove the lockfile that is no longer real, or re-run interactively to choose.`,
    );
    return null;
  }

  const chosen = await ask(
    `More than one package manager claims ${candidate.ecosystem} in ${where}. Which one should Drift use?`,
    options,
    options[0]!,
  );
  logger.info(`Using ${chosen} for ${where}.`);
  return { ...candidate, packageManager: chosen as UpgradeCandidate['packageManager'] };
}

/**
 * Analyse, then apply the resulting plan: Drift's own codemod first, a
 * validated fix plan second, an AI agent last — the same priority every
 * surface shares (`src/remediation/partition.ts`).
 *
 * `--plan` stops after printing the fix plan documents, having written
 * nothing at all. That is the read-only half of this command and the reason
 * a plan is worth having as a document rather than only as a mechanism: a
 * developer can read exactly what would happen to every call site, and to
 * which call sites nothing would happen, before granting any of it.
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

  // `fix` needs a real commit: it checks `after` out into an isolated
  // worktree, and the working tree is not a ref. But refusing to look at the
  // working tree at all is what made `drift outdated --upgrade foo && drift
  // fix` analyse the *previous* dependency commit — the exact next command
  // Drift recommends, ignoring the upgrade the developer had just made.
  //
  // So uncommitted manifest edits are materialised into a commit object first,
  // using a scratch index that leaves the developer's tree and index untouched.
  // An explicit range is an explicit instruction; never second-guess it.
  const rangeGiven = typeof flags.before === 'string' || typeof flags.after === 'string';
  const upgradeCommit = rangeGiven
    ? null
    : await commitWorkingTreeManifests(workspace, 'chore(deps): dependency update analysed by drift fix');
  if (upgradeCommit) {
    logger.info(
      'Found uncommitted manifest changes. Analysing them as the dependency update — ' +
        'they are committed inside the isolated worktree only; your working tree is untouched.',
    );
  }

  const { before, after } = upgradeCommit
    ? { before: (await gitRev(workspace, 'HEAD')) ?? `${upgradeCommit}^`, after: upgradeCommit }
    : await resolveRange(workspace, flags, { includeWorkingTree: false });
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
    githubToken: token || undefined,
    dryRun: true,
    workspace,
  });
  if (!result.plan || result.plan.commits.length === 0) {
    console.log(`\n${result.summary}\n`);
    return 0;
  }

  const plan = result.plan;
  return await fixPlanAndOpenPR({ repo, plan, config, workspace, logger, flags, token });
}

/**
 * Resolve `plan` (deterministically, then via Copilot for whatever's left),
 * push the result, and open a pull request for it. The back half of `drift
 * fix`, factored out so `offerIssueBranchActions`'s "start fixing now?"
 * follow-up can run the exact same pipeline instead of re-deriving it.
 */
async function fixPlanAndOpenPR(args: {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  workspace: string;
  logger: Logger;
  flags: Flags;
  token: string;
}): Promise<number> {
  const { repo, plan, config, workspace, logger, flags, token } = args;

  const planOnly = Boolean(flags['plan']);

  logger.info(
    planOnly
      ? `Reviewing fix plans for ${plan.commits.length} commit(s) — nothing will be applied`
      : `Fixing ${plan.commits.length} commit(s) on \`${plan.branchName}\` in an isolated worktree`,
  );

  const fix = await runFix({
    repo,
    plan,
    config,
    logger,
    workspace,
    planOnly,
    nonInteractive: Boolean(flags['non-interactive']),
  });

  // `--plan` is read-only by construction: the worktree was created but
  // nothing was written to it, so print the documents and stop before any of
  // the push, dispatch, or pull-request machinery below.
  if (planOnly) {
    try {
      if (fix.documents.length === 0) {
        console.log('\nNo deterministic fix plan applies to this change. Every commit needs an agent.\n');
      } else {
        console.log(`\n${fix.documents.join('\n\n---\n\n')}\n`);
        console.log(
          `${fix.documents.length} fix plan(s). Run \`drift fix\` without --plan to apply them, or edit them first — see docs/fix-plans.md.\n`,
        );
      }
      if (fix.needsAgent.length > 0) {
        console.log(`${fix.needsAgent.length} commit(s) have call sites no plan covers; those would go to an agent.\n`);
      }
    } finally {
      await fix.teardown();
    }
    return 0;
  }

  // Tracks whether any commit that needed an agent is left unresolved —
  // missing Copilot token, a failed dispatch, or (after the agent-fallback
  // fix in `cli-runner.ts`) a codemod that failed to commit. When true, the
  // run must not report a clean success even if a pull request gets opened:
  // the PR would be missing fixes the run itself knows are outstanding.
  let unresolvedAgentWork = false;
  let unresolvedAgentCount = fix.needsAgent.length;
  let pushedBranch = false;

  const pushWorktreeHead = async () => {
    await run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${fix.branch}`], { cwd: fix.worktree });
    pushedBranch = true;
  };

  try {
    if (fix.pushed) {
      await pushWorktreeHead();
      logger.info(
        `Resolved ${fix.builtinResolved} commit(s) with a built-in codemod` +
          (fix.fixPlanResolved > 0 ? ` and ${fix.fixPlanResolved} with a validated fix plan` : '') +
          ` on \`${fix.branch}\`.`,
      );
      // The documents, not a count. What a deterministic fix actually did to
      // every call site is the thing worth printing, and it is what a
      // reviewer will be asked about on the pull request.
      for (const document of fix.documents) console.log(`\n${document}\n`);
    }

    if (fix.needsAgent.length > 0) {
      const copilotToken =
        (typeof flags['copilot-token'] === 'string' ? flags['copilot-token'] : undefined) ??
        process.env.DRIFT_COPILOT_TOKEN;
      const selection = await resolveCliAgentSelection({
        config,
        flags,
        copilotToken,
        logger,
        nonInteractive: Boolean(flags['non-interactive']),
      });

      if (!selection) {
        unresolvedAgentWork = true;
      } else {
        const agentConfig: DriftConfig = {
          ...config,
          remediation: { ...config.remediation, agent: selection.config },
        };
        const agent = await defaultAgentProviderRegistry.create(selection.provider, {
          repo,
          config: agentConfig,
          logger,
          credentials: selection.runtime.credentials,
          surface: 'cli',
        });
        const availability = agent ? await agent.detect().catch(() => ({ available: false })) : { available: false };
        if (!agent || !availability.available) {
          logger.warn(`${selection.provider} was selected, but that provider is not available in this CLI runtime.`);
          unresolvedAgentWork = true;
        } else if (agent.capabilities.execution === 'workspace') {
          const agentRun = await runAgentCommitsInWorktree({
            repo,
            plan,
            config: agentConfig,
            worktree: fix.worktree,
            commits: fix.needsAgent,
            agent,
            logger,
          });
          unresolvedAgentCount = agentRun.unresolved.length;
          if (agentRun.committed) {
            fix.pushed = true;
            await pushWorktreeHead();
          }
          if (agentRun.unresolved.length > 0) {
            for (const failure of agentRun.unresolved) {
              logger.warn(`Commit ${failure.commit.order} remains unresolved: ${failure.message}`);
            }
            unresolvedAgentWork = true;
          } else {
            logger.info(`Resolved ${agentRun.resolved.length} commit(s) with ${agent.label}.`);
          }
        } else if (isCloudFixAgent(agent)) {
          if (!pushedBranch && !fix.pushed) {
            // Cloud agents work from a remote branch. If every commit needed an
            // agent, create that branch at the analysed SHA first.
            try {
              await run('git', ['push', 'origin', `${repo.afterSha}:refs/heads/${fix.branch}`], { cwd: workspace });
              pushedBranch = true;
            } catch (err) {
              logger.error(`Could not create branch \`${fix.branch}\`: ${(err as Error).message}`);
            }
          }
          const dispatched = await dispatchRemainingToCloudAgent({
            agent,
            repo,
            plan,
            commits: fix.needsAgent,
            config: agentConfig,
            logger,
          });
          if (!dispatched.ok) {
            logger.error(`${agent.label} dispatch failed: ${dispatched.error}`);
            unresolvedAgentWork = true;
          } else {
            logger.info(`Dispatched ${fix.needsAgent.length} commit(s) needing an agent to ${agent.label}.`);
          }
        } else {
          logger.warn(`${agent.label} does not advertise a supported execution capability.`);
          unresolvedAgentWork = true;
        }
      }
    }

    if (!fix.pushed && fix.needsAgent.length === 0) {
      logger.info('Nothing to fix.');
      return 0;
    }

    const body = unresolvedAgentWork
      ? `> **Incomplete:** ${unresolvedAgentCount} commit(s) still need an AI agent and could not be dispatched. This pull request does not yet contain a fix for them.\n\n${renderPullRequestBody(plan, config)}`
      : renderPullRequestBody(plan, config);

    const pr = await openPullRequest(workspace, token, logger, repo, {
      head: fix.branch,
      base: plan.baseBranch,
      title: titleFor({ changes: plan.changes }, { title: config.pullRequest.titleTemplate, prefix: config.remediation.branchPrefix }),
      body,
      draft: Boolean(flags.draft) || opensPullRequestAsDraft(config),
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

async function resolveCliAgentSelection(args: {
  config: DriftConfig;
  flags: Flags;
  copilotToken?: string;
  logger: Logger;
  nonInteractive: boolean;
  registry?: AgentProviderRegistry;
}): Promise<AgentSelection | null> {
  const override = agentOverrideFromFlags(args.flags, args.logger);
  if (override === null) return null;

  const registry = args.registry ?? defaultAgentProviderRegistry;
  const credentials = credentialsWithLegacyCopilot(undefined, args.copilotToken);
  const selectionConfig = agentConfigWithLegacyCopilot(args.config.remediation.agent, {
    token: args.copilotToken,
    model: args.config.remediation.model,
  });
  const contextConfig: DriftConfig = {
    ...args.config,
    remediation: { ...args.config.remediation, agent: selectionConfig },
  };
  const available = await registry.available({
    config: contextConfig,
    logger: args.logger,
    credentials,
    surface: 'cli',
  });
  const eligibleProviders = [...available.keys()];

  const selection = resolveAgentSelection({
    config: selectionConfig,
    override,
    runtime: {
      surface: 'cli',
      interactive: !args.nonInteractive && process.stdin.isTTY,
      eligibleProviders,
      credentials,
    },
  });

  if (selection.source !== 'unresolved') return selection;

  if (!args.nonInteractive && process.stdin.isTTY && eligibleProviders.length > 1) {
    const labels = eligibleProviders.map((provider) => labelForAgentProvider(provider, registry));
    const answer = await ask('Choose the agent Drift should use for unresolved edits.', labels);
    const index = labels.indexOf(answer);
    const provider = eligibleProviders[index];
    if (provider) {
      return {
        provider,
        config: { ...selection.config, provider },
        source: 'override',
        runtime: selection.runtime,
      };
    }
  }

  args.logger.warn(selection.reason);
  return null;
}

function agentOverrideFromFlags(flags: Flags, logger: Logger): Partial<DriftConfig['remediation']['agent']> | null {
  const override: Partial<DriftConfig['remediation']['agent']> = {};

  if (typeof flags.agent === 'string') {
    if (!isExplicitAgentProvider(flags.agent)) {
      logger.warn(`Unknown agent provider \`${flags.agent}\`. Pass a registered provider id, or omit --agent for auto selection.`);
      return null;
    }
    override.provider = flags.agent;
  }
  if (typeof flags['agent-model'] === 'string') override.model = flags['agent-model'];
  if (typeof flags['agent-effort'] === 'string') {
    const effort = flags['agent-effort'];
    if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') override.effort = effort;
    else {
      logger.warn(`Unknown agent effort \`${effort}\`. Expected low, medium, high, or xhigh.`);
      return null;
    }
  }
  if (typeof flags['agent-timeout-seconds'] === 'string') {
    const timeoutSeconds = Number(flags['agent-timeout-seconds']);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30) {
      logger.warn('Agent timeout must be an integer number of seconds, at least 30.');
      return null;
    }
    override.timeoutSeconds = timeoutSeconds;
  }

  return override;
}

function isExplicitAgentProvider(value: string): value is ExplicitAgentProvider {
  return value.trim().length > 0 && value !== 'auto';
}

function labelForAgentProvider(provider: ExplicitAgentProvider, registry: AgentProviderRegistry): string {
  return registry.get(provider)?.label ?? provider;
}

async function dispatchRemainingToCloudAgent(options: {
  agent: FixAgent;
  repo: RepoContext;
  plan: RemediationPlan;
  commits: readonly RemediationPlan['commits'][number][];
  config: DriftConfig;
  logger: Logger;
}): Promise<{ ok: boolean; error?: string }> {
  if (options.commits.length === 0) return { ok: true };
  const agentPlan = planForCommits(options.plan, options.commits);
  const result = await options.agent.run(
    {
      plan: agentPlan,
      commit: agentPlan.commits[0]!,
      workspaceRoot: options.repo.workspace ?? '',
      files: [],
      customInstructions: options.config.remediation.customInstructions,
      model: options.config.remediation.agent.model ?? options.config.remediation.model,
      effort: options.config.remediation.agent.effort,
      fast: options.config.remediation.agent.fast,
    },
    { report: (message) => options.logger.info(message), signal: new AbortController().signal },
  );
  return result.status === 'failed' ? { ok: false, error: result.message } : { ok: true };
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
    draft: Boolean(flags.draft) || opensPullRequestAsDraft(config),
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
