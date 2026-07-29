#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepoContext } from './types.js';
import { loadConfig } from './config/load.js';
import { GitHubClient } from './github/client.js';
import { runPipeline } from './pipeline.js';
import { renderPullRequestBody } from './report/markdown.js';
import { runAction } from './runners/action.js';
import { main as serveWebhook } from './runners/webhook.js';
import { createLogger, type LogLevel } from './util/logger.js';

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
  drift action                Run as a GitHub Action (reads INPUT_* env vars)
  drift serve                 Run the stateless webhook server
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

\`analyze\` never writes anything: no branches, no issues, no agent tasks.

Environment:
  GITHUB_TOKEN                Token used for repository reads
  DRIFT_COPILOT_TOKEN         User-scoped token for the Copilot agent API
  ANTHROPIC_API_KEY           Only if llm.enabled is true in drift.yml
`.trim();

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'analyze':
    case 'analyse':
      return analyzeCommand(parseFlags(rest));
    case 'action':
      return runAction();
    case 'serve':
      serveWebhook();
      return 0;
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
if (process.argv[1]?.endsWith('cli.js')) {
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
