import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { SessionEffort } from '../session.js';
import {
  buildFixPrompt,
  type AgentAvailability,
  type AgentContext,
  type AgentModel,
  type EffortStop,
  type FixAgent,
  type FixOutcome,
  type FixTask,
} from './types.js';
import { envWithShellPath } from '../shell-path.js';

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
  /**
   * The models this subscription offers, best first.
   *
   * Deliberately aliases rather than dated ids where the CLI accepts them:
   * `--model opus` keeps working when Anthropic ships the next Opus, whereas a
   * pinned id silently becomes "unknown model" months later.
   */
  models?: readonly AgentModel[];
  /** How this CLI takes a model id. */
  modelArgs?: (model: string) => string[];
  /**
   * This CLI's reasoning budget, named the way its vendor names it.
   *
   * Absent means the agent has no such control, and the composer hides the dial
   * rather than offering a setting that changes nothing.
   */
  efforts?: readonly EffortStop[];
  /** How this CLI takes a reasoning budget on the command line. */
  effortArgs?: (effort: SessionEffort) => string[];
  /**
   * How this CLI takes a reasoning budget in the prompt.
   *
   * Claude Code has no flag for it — the depth of thinking is asked for in
   * words, and the words are load-bearing. Returning an empty string asks for
   * nothing, which is what the lowest stop means.
   */
  effortPrompt?: (effort: SessionEffort) => string;
  versionArgs?: string[];
  /** VS Code chat extensions that can bundle or configure this agent. */
  extensionIds?: string[];
  /** Candidate executable paths inside installed VS Code extensions. */
  extensionBinaryPaths?: string[];
  /** Optional local auth/subscription probe. Must not prompt. */
  detectAuth?: (command: string) => Promise<string | null>;
  docsUrl: string;
}

/**
 * Claude's effort scale, in Anthropic's words.
 *
 * Claude Code takes its thinking budget in the prompt rather than on the
 * command line, and the keywords are the documented interface: `think`,
 * `think harder`, `ultrathink`. The lowest stop asks for nothing at all, which
 * is the fastest the CLI goes.
 */
const CLAUDE_EFFORTS: readonly EffortStop[] = [
  { value: 'low', label: 'Low', detail: 'Edits directly, without extended thinking. Fastest.' },
  { value: 'medium', label: 'Medium', detail: 'Thinks through each change before making it.' },
  { value: 'high', label: 'High', detail: 'Thinks harder — worth it on tangled migrations.' },
  { value: 'xhigh', label: 'Ultracode', detail: 'Ultrathink: the deepest reasoning Claude Code offers.' },
];

const CLAUDE_THINKING: Record<SessionEffort, string> = {
  low: '',
  medium: 'think',
  high: 'think harder',
  xhigh: 'ultrathink',
};

/** Codex's scale. `model_reasoning_effort` takes these verbatim. */
const CODEX_EFFORTS: readonly EffortStop[] = [
  { value: 'low', label: 'Low', detail: 'Minimal reasoning. Fastest.' },
  { value: 'medium', label: 'Medium', detail: 'The default reasoning budget.' },
  { value: 'high', label: 'High', detail: 'More reasoning per edit.' },
  { value: 'xhigh', label: 'Extra High', detail: 'The largest reasoning budget Codex accepts.' },
];

export const CLI_AGENT_SPECS: readonly CliAgentSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    description: "Anthropic's agentic CLI. Edits files directly.",
    command: 'claude',
    buildArgs: () => ['-p', '--permission-mode', 'acceptEdits'],
    promptOnStdin: true,
    models: [
      { id: 'opus', label: 'Claude Opus', detail: 'Deepest reasoning. Best on large migrations.' },
      { id: 'sonnet', label: 'Claude Sonnet', detail: 'The balanced default.' },
      {
        id: 'haiku',
        label: 'Claude Haiku',
        detail: 'Fastest and cheapest. Fine for mechanical renames.',
        // Haiku has no ultrathink budget to spend, so its dial stops at High.
        efforts: CLAUDE_EFFORTS.slice(0, 3),
      },
    ],
    modelArgs: (model) => ['--model', model],
    efforts: CLAUDE_EFFORTS,
    effortPrompt: (effort) => CLAUDE_THINKING[effort],
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
    label: 'Codex',
    description: "OpenAI's coding agent.",
    command: 'codex',
    buildArgs: () => ['exec', '--full-auto'],
    promptOnStdin: true,
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex', detail: 'Tuned for editing code.' },
      { id: 'gpt-5', label: 'GPT-5', detail: 'The general model.' },
    ],
    modelArgs: (model) => ['--model', model],
    efforts: CODEX_EFFORTS,
    effortArgs: (effort) => ['-c', `model_reasoning_effort="${effort}"`],
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
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', detail: 'The reasoning model.' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', detail: 'Faster, cheaper, shallower.' },
    ],
    modelArgs: (model) => ['-m', model],
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'aider',
    label: 'Aider',
    description: 'Open-source pair programmer. Uses your configured model.',
    command: 'aider',
    buildArgs: (prompt) => ['--yes', '--no-auto-commits', '--message', prompt],
    versionArgs: ['--version'],
    // Aider drives whatever model the user configured, and that can be any
    // provider at all — so there is no list to offer, only a box to type in.
    modelArgs: (model) => ['--model', model],
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
    modelArgs: (model) => ['--model', model],
    docsUrl: 'https://opencode.ai',
  },
];

export class CliFixAgent implements FixAgent {
  readonly kind = 'cli' as const;
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly acceptsCustomModel: boolean;
  readonly efforts: readonly EffortStop[] | undefined;
  private executable: string | null = null;

  constructor(
    private readonly spec: CliAgentSpec,
    private readonly timeoutMs: number,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.description = spec.description;
    this.acceptsCustomModel = Boolean(spec.modelArgs);
    this.efforts = spec.efforts;
  }

  async listModels(): Promise<AgentModel[]> {
    return [...(this.spec.models ?? [])];
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
    // Effort changes how hard this agent thinks about the task — never which
    // parts of it to attempt. Every impact site above is still in scope.
    const thinking = this.thinking(task);
    const prompt = [
      buildFixPrompt(task),
      '',
      '## Your task',
      '',
      task.commit.instructions,
      ...(thinking ? ['', thinking] : []),
    ].join('\n');

    const args = [...this.spec.buildArgs(prompt), ...this.selection(task)];
    const command = this.executable ?? (await resolveCommand(this.spec))?.path ?? this.spec.command;
    ctx.report(`Running ${this.spec.command}${task.model ? ` with ${task.model}` : ''} in ${task.workspaceRoot}…`);

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

  /**
   * The flags that carry the developer's model and effort choice.
   *
   * Only ever added when the spec knows how this CLI spells them. Guessing a
   * flag is worse than not passing one: an unknown flag makes the agent exit
   * before it has read the task at all.
   */
  private selection(task: FixTask): string[] {
    const args: string[] = [];
    if (task.model && this.spec.modelArgs) args.push(...this.spec.modelArgs(task.model));
    if (task.effort && this.spec.effortArgs) args.push(...this.spec.effortArgs(task.effort));
    return args;
  }

  /**
   * The sentence that carries the reasoning budget, for CLIs that take it in
   * words rather than in flags.
   */
  private thinking(task: FixTask): string {
    const keyword = task.effort && this.spec.effortPrompt ? this.spec.effortPrompt(task.effort) : '';
    return keyword ? `Before editing anything, ${keyword} about how these changes fit together.` : '';
  }

  private async exec(
    command: string,
    args: string[],
    prompt: string,
    cwd: string,
    ctx: AgentContext,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const shellEnv = await envWithShellPath();
    const path = withCommandDir(command, shellEnv.PATH ?? '');
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...shellEnv, PATH: path, DRIFT: '1' },
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
    // A GUI-launched VS Code does not see the PATH a terminal sees — nvm,
    // volta, fnm, and asdf all add to PATH from shell profile scripts that
    // only run for interactive shells. Resolve against the same PATH the
    // user's own terminal would use, or `which` reliably misses anything
    // installed that way.
    const { stdout } = await run(probe, [command], { timeout: 5000, windowsHide: true, env: await envWithShellPath() });
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

function withCommandDir(command: string, current: string): string {
  const dir = dirname(command);
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
