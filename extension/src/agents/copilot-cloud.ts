import * as vscode from 'vscode';
import { buildTaskPrompt } from '../../../src/dispatch/copilot.js';
import { DriftConfigSchema } from '../../../src/config/schema.js';
import type { AgentAvailability, AgentContext, FixAgent, FixOutcome, FixTask } from './types.js';
import { getGitHubSession, GITHUB_SCOPES } from '../github-auth.js';

/**
 * GitHub's Copilot coding agent — the work happens on GitHub, you get a PR.
 *
 * This is the path that removes the personal access token entirely.
 *
 * The Copilot agent API requires a *user-to-server* token, because Copilot is
 * billed per seat and GitHub must know whose seat is being spent. That is why
 * the GitHub Action needs a PAT in a repository secret: a workflow has no user
 * to act as.
 *
 * An editor does. `vscode.authentication.getSession('github', …)` returns a
 * user-to-server OAuth token, which is exactly the credential the agent API
 * wants — obtained with one click, managed by VS Code, revocable from GitHub's
 * settings, and never seen by Drift or written to disk.
 *
 * Same GitHub workflow as the Action. No token to create, paste, or remember.
 */
export class CopilotCloudAgent implements FixAgent {
  readonly id = 'copilot-cloud';
  readonly label = 'Copilot Cloud';
  readonly description = 'Runs on GitHub and opens a pull request. Signs in with one click.';
  readonly kind = 'cloud' as const;

  constructor(
    private readonly slug: string | null,
    private readonly baseBranch: string,
  ) {}

  async detect(): Promise<AgentAvailability> {
    if (!this.slug) {
      return {
        available: false,
        reason: 'This workspace has no GitHub remote, so there is nowhere to open a pull request.',
      };
    }

    // Silent check only: probing availability must never trigger a sign-in
    // prompt the user did not ask for.
    const session = await getGitHubSession({ createIfNone: false });
    if (!session) {
      return {
        available: true,
        detail: `${this.slug} — will sign in to GitHub when first used`,
      };
    }

    return { available: true, detail: `${this.slug} as ${session.account.label}` };
  }

  async run(task: FixTask, ctx: AgentContext): Promise<FixOutcome> {
    if (!this.slug) {
      return { status: 'failed', message: 'No GitHub remote found for this workspace.' };
    }

    ctx.report('Signing in to GitHub…');
    const session = await getGitHubSession({ createIfNone: true });
    if (!session) {
      return {
        status: 'failed',
        message: `GitHub sign-in was cancelled. The cloud agent needs ${GITHUB_SCOPES.join(', ')} access.`,
      };
    }

    const [owner, repo] = this.slug.split('/');
    if (!owner || !repo) {
      return { status: 'failed', message: `Could not parse the repository from "${this.slug}".` };
    }

    // The cloud agent works on the whole plan in one session, not one commit at
    // a time: each API task is an independent session with its own branch and
    // PR, so per-commit dispatch would produce disconnected pull requests that
    // cannot build on each other.
    const config = DriftConfigSchema.parse({
      remediation: { customInstructions: task.customInstructions ?? '' },
    });
    const prompt = buildTaskPrompt(task.plan, config);

    ctx.report('Handing the plan to the GitHub Copilot coding agent…');

    try {
      const response = await fetch(
        `https://api.github.com/agents/repos/${owner}/${repo}/tasks`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${session.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'drift-vscode/0.1',
          },
          body: JSON.stringify({
            prompt,
            base_ref: this.baseBranch,
            create_pull_request: true,
          }),
          signal: ctx.signal,
        },
      );

      if (!response.ok) {
        return { status: 'failed', message: await explainFailure(response) };
      }

      const body = (await response.json()) as {
        id?: string;
        state?: string;
        pull_request?: { html_url?: string; number?: number };
      };

      const url = body.pull_request?.html_url;

      return {
        status: 'delegated',
        url,
        message: url
          ? `Copilot is working on GitHub. Pull request: ${url}`
          : `Copilot task ${body.id ?? ''} started on GitHub (${body.state ?? 'queued'}). A pull request will appear shortly.`,
      };
    } catch (err) {
      if (ctx.signal.aborted) return { status: 'failed', message: 'Cancelled.' };
      return { status: 'failed', message: `Could not reach GitHub: ${(err as Error).message}` };
    }
  }
}

async function explainFailure(response: Response): Promise<string> {
  const detail = await response
    .text()
    .then((t) => t.slice(0, 300))
    .catch(() => '');

  switch (response.status) {
    case 401:
      return 'GitHub rejected the session. Sign out and back in from the Accounts menu.';
    case 403:
      return `GitHub denied the request. Usually this means the account has no Copilot seat, or the coding agent is disabled for this repository. ${detail}`;
    case 404:
      return 'The Copilot coding agent is not enabled for this repository, or your account cannot access it.';
    case 422:
      return `GitHub rejected the request as invalid: ${detail}`;
    case 429:
      return 'GitHub rate-limited the request. Try again shortly.';
    default:
      return `GitHub returned ${response.status}: ${detail}`;
  }
}

/** Best-effort check that this account can actually use the coding agent. */
export async function isCloudAgentEnabled(slug: string): Promise<boolean | null> {
  const session = await getGitHubSession({ createIfNone: false });
  if (!session) return null;

  const [owner, repo] = slug.split('/');
  if (!owner || !repo) return null;

  try {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'GraphQL-Features': 'issues_copilot_assignment_api_support',
      },
      body: JSON.stringify({
        query: `query($owner:String!,$repo:String!){
          repository(owner:$owner,name:$repo){
            suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:20){ nodes { login } }
          }
        }`,
        variables: { owner, repo },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as {
      data?: { repository?: { suggestedActors?: { nodes?: { login: string }[] } } };
    };

    const logins = body.data?.repository?.suggestedActors?.nodes?.map((n) => n.login) ?? [];
    return logins.includes('copilot-swe-agent');
  } catch {
    return null;
  }
}
