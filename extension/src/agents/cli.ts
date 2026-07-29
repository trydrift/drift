import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
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
  /** VS Code chat extensions that can bundle or configure this agent. */
  extensionIds?: string[];
  /** Candidate executable paths inside installed VS Code extensions. */
  extensionBinaryPaths?: string[];
  /** Optional local auth/subscription probe. Must not prompt. */
  detectAuth?: (command: string) => Promise<string | null>;
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
    extensionIds: ['anthropic.claude-code'],
    extensionBinaryPaths: [
      'resources/native-binary/claude',
      'resources/native-binary/claude.exe',
    ],
    detectAuth: detectClaudeAuth,
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
    extensionIds: ['openai.chatgpt'],
    extensionBinaryPaths: [
      'bin/macos-x86_64/codex',
      'bin/macos-aarch64/codex',
      'bin/linux-x64/codex',
      'bin/linux-arm64/codex',
      'bin/windows-x64/codex.exe',
    ],
    detectAuth: detectCodexAuth,
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
  private executable: string | null = null;

  constructor(
    private readonly spec: CliAgentSpec,
    private readonly timeoutMs: number,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.description = spec.description;
  }

  async detect(): Promise<AgentAvailability> {
    const found = await resolveCommand(this.spec);
    if (!found) {
      const extension = installedExtensionSummary(this.spec);
      return {
        available: false,
        reason: extension
          ? `${extension} is installed, but Drift could not find its \`${this.spec.command}\` binary. See ${this.spec.docsUrl}`
          : `\`${this.spec.command}\` is not on your PATH and no matching VS Code extension bundle was found. See ${this.spec.docsUrl}`,
        signals: extension ? [extension] : undefined,
      };
    }

    this.executable = found.path;
    const signals = [...found.signals];

    if (this.spec.versionArgs) {
      try {
        const { stdout } = await run(found.path, this.spec.versionArgs, { timeout: 10_000 });
        const auth = this.spec.detectAuth ? await this.spec.detectAuth(found.path) : null;
        if (auth) signals.push(auth);
        return { available: true, detail: stdout.trim().split('\n')[0] || found.path, signals };
      } catch {
        // On PATH but not answering `--version` is still probably usable.
        const auth = this.spec.detectAuth ? await this.spec.detectAuth(found.path) : null;
        if (auth) signals.push(auth);
        return { available: true, detail: found.path, signals };
      }
    }

    return { available: true, detail: found.path, signals };
  }

  async run(task: FixTask, ctx: AgentContext): Promise<FixOutcome> {
    const prompt = [buildFixPrompt(task), '', '## Your task', '', task.commit.instructions].join('\n');

    const args = this.spec.buildArgs(prompt);
    const command = this.executable ?? (await resolveCommand(this.spec))?.path ?? this.spec.command;
    ctx.report(`Running ${this.spec.command} in ${task.workspaceRoot}…`);

    try {
      const { code, stdout, stderr } = await this.exec(command, args, prompt, task.workspaceRoot, ctx);

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
    command: string,
    args: string[],
    prompt: string,
    cwd: string,
    ctx: AgentContext,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, PATH: withCommandDir(command), DRIFT: '1' },
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

async function resolveCommand(spec: CliAgentSpec): Promise<{ path: string; signals: string[] } | null> {
  const onPath = await which(spec.command);
  const extension = installedExtensionSummary(spec);
  if (onPath) {
    return { path: onPath, signals: extension ? [extension, 'Available on PATH'] : ['Available on PATH'] };
  }

  const bundled = await bundledExtensionBinary(spec);
  if (bundled) {
    return {
      path: bundled.path,
      signals: [`${bundled.displayName} extension installed`, 'Bundled binary found'],
    };
  }

  const common = await commonInstallBinary(spec.command);
  if (common) return { path: common, signals: ['Found in a common local bin directory'] };

  return null;
}

async function bundledExtensionBinary(
  spec: CliAgentSpec,
): Promise<{ path: string; displayName: string } | null> {
  for (const extension of installedExtensions(spec)) {
    const displayName = String(
      extension.packageJSON?.displayName ?? extension.packageJSON?.name ?? extension.id,
    );
    for (const relative of spec.extensionBinaryPaths ?? []) {
      const path = join(extension.extensionPath, relative);
      if (await canExecute(path)) return { path, displayName };
    }
  }
  return null;
}

function installedExtensionSummary(spec: CliAgentSpec): string | null {
  const extension = installedExtensions(spec)[0];
  if (!extension) return null;
  const name = String(extension.packageJSON?.displayName ?? extension.packageJSON?.name ?? extension.id);
  const version = String(extension.packageJSON?.version ?? '').trim();
  return `${name}${version ? ` ${version}` : ''} extension installed`;
}

function installedExtensions(spec: CliAgentSpec): readonly vscode.Extension<unknown>[] {
  const ids = new Set((spec.extensionIds ?? []).map((id) => id.toLowerCase()));
  if (ids.size === 0) return [];
  return vscode.extensions.all.filter((extension) => ids.has(extension.id.toLowerCase()));
}

async function commonInstallBinary(command: string): Promise<string | null> {
  const home = process.env.HOME;
  const suffix = process.platform === 'win32' ? `${command}.exe` : command;
  const dirs = [
    home ? join(home, '.local/bin') : '',
    home ? join(home, '.npm-global/bin') : '',
    home ? join(home, '.bun/bin') : '',
    home ? join(home, '.cargo/bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter(Boolean);

  for (const dir of dirs) {
    const candidate = join(dir, suffix);
    if (await canExecute(candidate)) return candidate;
  }

  return null;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function withCommandDir(command: string): string {
  const dir = dirname(command);
  const current = process.env.PATH ?? '';
  return command.includes('/') && !current.split(delimiter).includes(dir) ? `${dir}${delimiter}${current}` : current;
}

async function detectClaudeAuth(command: string): Promise<string | null> {
  try {
    const { stdout } = await run(command, ['auth', 'status'], { timeout: 5000 });
    const json = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
    return json.loggedIn
      ? `Claude signed in (${json.authMethod ?? json.apiProvider ?? 'auth active'})`
      : 'Claude not signed in';
  } catch (err) {
    const stdout = (err as { stdout?: string })?.stdout;
    if (stdout) {
      try {
        const json = JSON.parse(stdout) as { loggedIn?: boolean };
        if (json.loggedIn === false) return 'Claude not signed in';
      } catch {
        // Fall through to an unknown signal.
      }
    }
    return 'Claude auth status unknown';
  }
}

async function detectCodexAuth(command: string): Promise<string | null> {
  try {
    const { stdout } = await run(command, ['doctor', '--json', '--summary'], {
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return summarizeCodexDoctor(stdout);
  } catch (err) {
    const stdout = (err as { stdout?: string })?.stdout;
    return stdout ? summarizeCodexDoctor(stdout) : 'Codex auth status unknown';
  }
}

function summarizeCodexDoctor(text: string): string | null {
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return null;

  try {
    const body = JSON.parse(text.slice(jsonStart)) as {
      checks?: {
        'auth.credentials'?: {
          status?: string;
          summary?: string;
          details?: Record<string, string>;
        };
      };
    };
    const auth = body.checks?.['auth.credentials'];
    if (!auth) return null;
    const mode = auth.details?.['stored auth mode'];
    const hasChatGpt = auth.details?.['stored ChatGPT tokens'] === 'true';
    const hasApiKey = auth.details?.['stored API key'] === 'true';
    if (auth.status === 'ok') {
      if (mode === 'chatgpt' && hasChatGpt) return 'Codex ChatGPT auth configured';
      if (hasApiKey) return 'Codex API key auth configured';
      return `Codex ${auth.summary ?? 'auth configured'}`;
    }
    return `Codex ${auth.summary ?? 'auth not configured'}`;
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
