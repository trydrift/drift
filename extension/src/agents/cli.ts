import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { buildFixPrompt, type AgentAvailability, type AgentContext, type FixAgent, type FixOutcome, type FixTask } from './types.js';

const run = promisify(execFile);

/**
 * Local coding-agent CLIs — Claude Code, Codex, Gemini, Aider, and friends.
 *
 * These agents edit the working tree themselves, which is the whole point:
 * they already have their own auth, their own context handling, and their own
 * tool loops. Drift's job is to hand over a well-specified task and stay out
 * of the way, then read the result back out of git.
 *
 * Drift never sees the user's API key for any of these. The binary is already
 * authenticated on their machine.
 */

export interface CliAgentSpec {
  id: string;
  label: string;
  description: string;
  /** Executable name, resolved on PATH. */
  command: string;
  /**
   * Build argv for a non-interactive run.
   *
   * Every one of these agents has a "print" / headless mode; using it is what
   * keeps Drift from hijacking the user's terminal.
   */
  buildArgs: (prompt: string) => string[];
  /** Passed on stdin instead of argv when the prompt is large. */
  promptOnStdin?: boolean;
  versionArgs?: string[];
  docsUrl: string;
}

export const CLI_AGENT_SPECS: readonly CliAgentSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    description: "Anthropic's agentic CLI. Edits files directly.",
    command: 'claude',
    buildArgs: () => ['-p', '--permission-mode', 'acceptEdits'],
    promptOnStdin: true,
    versionArgs: ['--version'],
    docsUrl: 'https://claude.com/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    description: "OpenAI's coding agent.",
    command: 'codex',
    buildArgs: () => ['exec', '--full-auto'],
    promptOnStdin: true,
    versionArgs: ['--version'],
    docsUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    description: "Google's coding agent.",
    command: 'gemini',
    buildArgs: () => ['--yolo'],
    promptOnStdin: true,
    versionArgs: ['--version'],
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'aider',
    label: 'Aider',
    description: 'Open-source pair programmer. Uses your configured model.',
    command: 'aider',
    buildArgs: (prompt) => ['--yes', '--no-auto-commits', '--message', prompt],
    versionArgs: ['--version'],
    docsUrl: 'https://aider.chat',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'Open-source terminal coding agent.',
    command: 'opencode',
    buildArgs: () => ['run'],
    promptOnStdin: true,
    versionArgs: ['--version'],
    docsUrl: 'https://opencode.ai',
  },
];

export class CliFixAgent implements FixAgent {
  readonly kind = 'cli' as const;
  readonly id: string;
  readonly label: string;
  readonly description: string;

  constructor(
    private readonly spec: CliAgentSpec,
    private readonly timeoutMs: number,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.description = spec.description;
  }

  async detect(): Promise<AgentAvailability> {
    const found = await which(this.spec.command);
    if (!found) {
      return {
        available: false,
        reason: `\`${this.spec.command}\` is not on your PATH. See ${this.spec.docsUrl}`,
      };
    }

    if (this.spec.versionArgs) {
      try {
        const { stdout } = await run(this.spec.command, this.spec.versionArgs, { timeout: 10_000 });
        return { available: true, detail: stdout.trim().split('\n')[0] };
      } catch {
        // On PATH but not answering `--version` is still probably usable.
        return { available: true, detail: found };
      }
    }

    return { available: true, detail: found };
  }

  async run(task: FixTask, ctx: AgentContext): Promise<FixOutcome> {
    const prompt = [buildFixPrompt(task), '', '## Your task', '', task.commit.instructions].join('\n');

    const args = this.spec.buildArgs(prompt);
    ctx.report(`Running ${this.spec.command} in ${task.workspaceRoot}…`);

    try {
      const { code, stdout, stderr } = await this.exec(args, prompt, task.workspaceRoot, ctx);

      if (ctx.signal.aborted) return { status: 'failed', message: 'Cancelled.' };

      if (code !== 0) {
        return {
          status: 'failed',
          message: `${this.spec.label} exited with code ${code}. ${firstLine(stderr || stdout)}`,
        };
      }

      // The agent edited the tree in place. The caller diffs git to find out
      // what actually changed — more reliable than parsing agent chatter.
      return {
        status: 'applied',
        message: `${this.spec.label} finished.`,
        warnings: extractAgentWarnings(stdout),
      };
    } catch (err) {
      return { status: 'failed', message: `${this.spec.label} failed: ${(err as Error).message}` };
    }
  }

  private exec(
    args: string[],
    prompt: string,
    cwd: string,
    ctx: AgentContext,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.spec.command, args, {
        cwd,
        env: { ...process.env, DRIFT: '1' },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`timed out after ${Math.round(this.timeoutMs / 1000)}s`));
      }, this.timeoutMs);

      const onAbort = () => child.kill('SIGTERM');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        // Surface the agent's own progress rather than an opaque spinner.
        const line = text.trim().split('\n').filter(Boolean).pop();
        if (line) ctx.report(line.slice(0, 160));
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({ code: code ?? 0, stdout, stderr });
      });

      if (this.spec.promptOnStdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}

/** Resolve a command on PATH, cross-platform. */
export async function which(command: string): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await run(probe, [command], { timeout: 5000, windowsHide: true });
    return stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Pull anything the agent flagged as unresolved out of its transcript. */
function extractAgentWarnings(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => /TODO\(drift\)|could not|unable to|unresolved|needs? (?:human|manual)/i.test(line))
    .map((line) => line.trim().slice(0, 200))
    .slice(0, 10);
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}
