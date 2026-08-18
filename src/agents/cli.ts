import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildFixPrompt,
  type AgentAvailability,
  type AgentContext,
  type AgentModel,
  type EffortStop,
  type FixAgent,
  type FixOutcome,
  type FixTask,
  type SessionEffort,
} from './types.js';

const run = promisify(execFile);

async function envWithShellPath(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: process.env.PATH ?? '' };
}

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
   *
   * A fallback only, where `discoverModels` exists: a list written here is a
   * snapshot of what was true the day it was written.
   */
  models?: readonly AgentModel[];
  /**
   * Ask the installed CLI which models it currently offers.
   *
   * Nothing in this file can know what a subscription includes this month.
   * Drift offered `gpt-5-codex` long after ChatGPT accounts stopped being able
   * to use it, and picking it produced a fix run that died on a 400 from the
   * API — the developer's read of that was that Drift is broken, and they were
   * right. Where a CLI records its own model list, that is the list.
   */
  discoverModels?: () => Promise<AgentModel[]>;
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
   * The flag `effortArgs` produces, when it is new enough that an older install
   * of the same CLI may not have it.
   *
   * Set this and `effortArgs` is used only once the installed binary's own
   * `--help` has been seen to mention the flag; otherwise `effortPrompt` is
   * used instead. Passing a flag a CLI does not recognise is not a degraded
   * result, it is a run that dies before reading the task, so a capability that
   * arrived in a recent version is checked rather than assumed.
   */
  effortArgsFlag?: string;
  /**
   * How this CLI is asked to trade tokens for latency.
   *
   * Codex calls it fast mode and exposes it as a feature flag; Claude Code has
   * one too, but only as an interactive `/fast` toggle that persists in its own
   * settings, with no way to ask for it per run — so Drift inherits whatever
   * was set there rather than pretending to a control it does not have.
   *
   * Absent means no toggle is drawn. A switch that silently does nothing is
   * worse than no switch.
   */
  fastArgs?: () => string[];
  /** The flag `fastArgs` produces, probed the same way `effortArgsFlag` is. */
  fastArgsFlag?: string;
  /**
   * How this CLI takes a reasoning budget in the prompt.
   *
   * Claude Code has no flag for it — the depth of thinking is asked for in
   * words, and the words are load-bearing. Returning an empty string asks for
   * nothing, which is what the lowest stop means.
   */
  effortPrompt?: (effort: SessionEffort) => string;
  versionArgs?: string[];
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
    // Aliases, not dated ids: `--model opus` still means the current Opus a
    // year from now. Claude Code publishes no roster file to read, so this list
    // is the interface Anthropic documents rather than a snapshot of a catalogue.
    models: [
      { id: 'opus', label: 'Claude Opus', detail: 'Deepest reasoning. Best on large migrations.' },
      { id: 'sonnet', label: 'Claude Sonnet', detail: 'The balanced default.' },
      { id: 'fable', label: 'Claude Fable', detail: 'Tuned for speed on well-specified work.' },
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
    // Claude Code grew a real `--effort` flag, so the reasoning budget can be
    // set directly instead of asked for in words. The prompt keywords stay as
    // the fallback: an older install has no such flag, and passing one it does
    // not know makes it exit before it has read the task at all — which is why
    // this is probed rather than assumed. See `supportsFlag`.
    effortArgs: (effort) => ['--effort', effort],
    effortArgsFlag: '--effort',
    effortPrompt: (effort) => CLAUDE_THINKING[effort],
    versionArgs: ['--version'],
    detectAuth: detectClaudeAuth,
    docsUrl: 'https://claude.com/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex',
    description: "OpenAI's coding agent.",
    command: 'codex',
    // `--full-auto` is deprecated and prints a warning that then masks the real
    // failure in every error message Drift shows. `--sandbox workspace-write`
    // is the same permission, spelled the way current Codex spells it.
    buildArgs: () => ['exec', '--sandbox', 'workspace-write'],
    promptOnStdin: true,
    discoverModels: discoverCodexModels,
    modelArgs: (model) => ['--model', model],
    efforts: CODEX_EFFORTS,
    effortArgs: (effort) => ['-c', `model_reasoning_effort="${effort}"`],
    // `--enable <feature>` is Codex's own spelling of `-c features.<name>=true`,
    // and `fast_mode` is in its feature registry. Same model, more tokens spent
    // for a faster answer.
    fastArgs: () => ['--enable', 'fast_mode'],
    fastArgsFlag: '--enable',
    versionArgs: ['--version'],
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
  /** Set once `listModels` has answered from the install rather than from the spec. */
  rosterIsAuthoritative = false;
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
    // What the install says it has beats what this file was written believing.
    const discovered = this.spec.discoverModels ? await this.spec.discoverModels().catch(() => []) : [];
    this.rosterIsAuthoritative = discovered.length > 0;
    return discovered.length > 0 ? discovered : [...(this.spec.models ?? [])];
  }

  async detect(): Promise<AgentAvailability> {
    const found = await resolveCommand(this.spec);
    if (!found) {
      return {
        available: false,
        reason: `\`${this.spec.command}\` is not on your PATH. See ${this.spec.docsUrl}`,
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
    const command = this.executable ?? (await resolveCommand(this.spec))?.path ?? this.spec.command;

    // Effort changes how hard this agent thinks about the task — never which
    // parts of it to attempt. Every impact site above is still in scope.
    const thinking = await this.thinking(task, command);
    const prompt = [
      buildFixPrompt(task),
      '',
      '## Your task',
      '',
      task.commit.instructions,
      ...(thinking ? ['', thinking] : []),
    ].join('\n');

    const args = [...this.spec.buildArgs(prompt), ...(await this.selection(task, command))];
    ctx.report(`$ ${displayCommand(command, args)}\n# cwd: ${task.workspaceRoot}`);

    try {
      const { code, stdout, stderr, spoken } = await this.exec(command, args, prompt, task.workspaceRoot, ctx);

      if (ctx.signal.aborted) return { status: 'failed', message: 'Cancelled.' };

      if (code !== 0) {
        return {
          status: 'failed',
          message: `${this.spec.label} exited with code ${code}. ${failureReason(stderr, stdout)}`,
        };
      }

      // The agent edited the tree in place. The caller diffs git to find out
      // what actually changed — more reliable than parsing agent chatter.
      //
      // What it *said* is a different question, and the one the panel was
      // failing to answer. A run that ends "No change needed" with no reason
      // is worse than no result: the developer cannot tell a correct verdict
      // from a lazy one, and Drift has just claimed a breakage it now appears
      // to be walking back. The agent almost always explained itself — Codex
      // wrote three sentences about checking the installed exports — and that
      // explanation was being dropped on the floor in favour of "Codex
      // finished.", which tells nobody anything.
      return {
        status: 'applied',
        message: agentConclusion(stdout, spoken) ?? `${this.spec.label} finished.`,
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
  private async selection(task: FixTask, command: string): Promise<string[]> {
    const args: string[] = [];
    if (task.model && this.spec.modelArgs) args.push(...this.spec.modelArgs(task.model));

    if (task.effort && this.spec.effortArgs) {
      const gated = this.spec.effortArgsFlag;
      if (!gated || (await supportsFlag(command, gated))) {
        args.push(...this.spec.effortArgs(task.effort));
      }
    }

    if (task.fast && this.spec.fastArgs) {
      const gated = this.spec.fastArgsFlag;
      if (!gated || (await supportsFlag(command, gated))) {
        args.push(...this.spec.fastArgs());
      }
    }

    return args;
  }

  /**
   * The sentence that carries the reasoning budget, for CLIs that take it in
   * words rather than in flags.
   */
  private async thinking(task: FixTask, command: string): Promise<string> {
    if (!task.effort || !this.spec.effortPrompt) return '';

    // Said in words only when it cannot be said in a flag. Doing both asks for
    // the same budget twice in two vocabularies, and the prompt version costs
    // tokens in every request.
    const gated = this.spec.effortArgsFlag;
    if (this.spec.effortArgs && (!gated || (await supportsFlag(command, gated)))) return '';

    const keyword = this.spec.effortPrompt(task.effort);
    return keyword ? `Before editing anything, ${keyword} about how these changes fit together.` : '';
  }

  private async exec(
    command: string,
    args: string[],
    prompt: string,
    cwd: string,
    ctx: AgentContext,
  ): Promise<{ code: number; stdout: string; stderr: string; spoken?: string }> {
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
      const started = Date.now();
      let lastOutput = Date.now();

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`timed out after ${Math.round(this.timeoutMs / 1000)}s`));
      }, this.timeoutMs);
      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - started) / 1000);
        const quiet = Math.round((Date.now() - lastOutput) / 1000);
        if (quiet < 15) return;
        ctx.report(
          `Still waiting for ${this.spec.label}… ${elapsed}s elapsed; ${
            stdout || stderr ? `no new output for ${quiet}s` : 'no output yet'
          }.`,
        );
      }, 15_000);

      // SIGTERM asks; it does not compel. A CLI mid-cleanup (or one that
      // simply ignores the signal) can sit past it indefinitely, which is
      // what turned "stop" into a button that looked broken — escalating to
      // SIGKILL after a short grace period bounds the wait instead of
      // leaving it open-ended.
      let killTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const surface = (chunk: Buffer, into: 'out' | 'err') => {
        const text = chunk.toString();
        if (into === 'out') stdout += text;
        else stderr += text;
        lastOutput = Date.now();
        for (const line of text.split('\n')) {
          const cleaned = line.trim();
          if (!isNoise(cleaned)) ctx.report(cleaned.slice(0, 400));
        }
      };

      child.stdout.on('data', (chunk: Buffer) => surface(chunk, 'out'));
      child.stderr.on('data', (chunk: Buffer) => surface(chunk, 'err'));

      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearInterval(heartbeat);
        ctx.signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearInterval(heartbeat);
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

/**
 * Lines that are about the CLI rather than about the work.
 *
 * Deprecation warnings and ANSI cursor housekeeping are noise in a panel whose
 * job is to show what the agent is doing. Anything else gets through — a line
 * this cannot classify is still the agent's own account of its work, and
 * dropping it would put the spinner back.
 */
function isNoise(line: string): boolean {
  const text = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
  if (!text) return true;
  if (/^warning:\s*`?--full-auto`?\s+is deprecated/i.test(text)) return true;
  // Progress bars and spinner frames redrawn character by character.
  if (/^[\s.·•▪▫◦─━|/\\-]+$/.test(text)) return true;
  return false;
}

/**
 * Whether this exact binary advertises a flag, remembered for the session.
 *
 * Asked of the installed executable rather than inferred from a version string,
 * because the same CLI reaches a machine by several routes — npm, Homebrew, a
 * copy bundled inside a VS Code extension — and they do not move in step. The
 * answer is cached per path: `--help` on a large agent binary is not free, and
 * a fix run would otherwise ask once per commit unit.
 *
 * Any failure reads as "no". A flag that might not exist is not worth the run
 * that dies for it, and the prompt-worded fallback still works.
 */
const flagSupport = new Map<string, Promise<boolean>>();

/**
 * Whether this agent has a speed/cost control Drift can set per run.
 *
 * Read from the spec table rather than hardcoded at the call site, so adding
 * the flag for another CLI is a one-line change in one place and the composer
 * picks the control up on its own.
 */
export function agentSupportsFastMode(agentId: string): boolean {
  return CLI_AGENT_SPECS.some((spec) => spec.id === agentId && Boolean(spec.fastArgs));
}

export function supportsFlag(command: string, flag: string): Promise<boolean> {
  const key = `${command}\u0000${flag}`;
  let cached = flagSupport.get(key);
  if (!cached) {
    cached = probeFlag(command, flag);
    flagSupport.set(key, cached);
  }
  return cached;
}

async function probeFlag(command: string, flag: string): Promise<boolean> {
  try {
    const shellEnv = await envWithShellPath();
    const { stdout, stderr } = await run(command, ['--help'], {
      env: { ...shellEnv, PATH: withCommandDir(command, shellEnv.PATH ?? '') },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    // Word-boundary matched, so `--effort` is not satisfied by `--effortless`.
    const pattern = new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return pattern.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

/** Forget probe results, for tests and after an agent is reinstalled. */
export function clearFlagSupportCache(): void {
  flagSupport.clear();
}

function displayCommand(command: string, args: readonly string[]): string {
  const shown: string[] = [shellQuote(command)];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      shown.push('<prompt omitted>');
      redactNext = false;
      continue;
    }
    shown.push(shellQuote(arg.length > 180 ? '<long argument omitted>' : arg));
    if (arg === '--message') redactNext = true;
  }

  return shown.join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  if (onPath) {
    return { path: onPath, signals: ['Available on PATH'] };
  }

  const common = await commonInstallBinary(spec.command);
  if (common) return { path: common, signals: ['Found in a common local bin directory'] };

  return null;
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

/**
 * The models this Codex install can actually reach.
 *
 * Codex caches the roster it was served — slug, display name, and the reasoning
 * levels each model supports — in `$CODEX_HOME/models_cache.json`. Reading it
 * is the only way for Drift to offer what the developer's own subscription
 * offers, and it is the same file the Codex extension's picker reads, so the
 * two agree by construction rather than by luck.
 *
 * Returning an empty list is meaningful: the composer then offers "Default"
 * alone, and Codex picks the model its own config names. That is a better
 * failure than naming a model the account cannot use.
 */
export async function discoverCodexModels(): Promise<AgentModel[]> {
  const home = process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, '.codex') : null);
  if (!home) return [];

  try {
    const raw = await readFile(join(home, 'models_cache.json'), 'utf8');
    return parseCodexModels(raw);
  } catch {
    return [];
  }
}

interface CodexCachedModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  supported_reasoning_levels?: Array<{ effort?: string; description?: string }>;
}

/** Split out from the file read so the parsing has a test that needs no disk. */
export function parseCodexModels(raw: string): AgentModel[] {
  const parsed = JSON.parse(raw) as { models?: CodexCachedModel[] };
  const models = parsed.models ?? [];

  return models
    // `visibility` is how Codex marks a model as offerable rather than merely
    // known; hidden entries are aliases and retired slugs.
    .filter((model) => model.slug && (model.visibility ?? 'list') === 'list')
    // Codex's own ordering field: lower is more prominent, not more capable.
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((model) => {
      const efforts = codexEfforts(model.supported_reasoning_levels);
      return {
        id: model.slug!,
        label: model.display_name ?? model.slug!,
        detail: model.description,
        ...(efforts.length > 0 ? { efforts } : {}),
      };
    });
}

/** A model's own reasoning dial, in the words Codex ships with it. */
function codexEfforts(
  levels: CodexCachedModel['supported_reasoning_levels'],
): EffortStop[] {
  const known = new Map(CODEX_EFFORTS.map((stop) => [stop.value, stop]));
  const out: EffortStop[] = [];

  for (const level of levels ?? []) {
    const stop = known.get(level.effort as SessionEffort);
    if (!stop) continue;
    out.push(level.description ? { ...stop, detail: level.description } : stop);
  }

  return out;
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

/**
 * What the agent concluded, in its own words.
 *
 * Every one of these CLIs ends by printing its answer to stdout — Codex
 * repeats its last message there, Claude Code's `-p` mode prints only that —
 * so stdout is read first and the transcript on stderr is the fallback for a
 * CLI that keeps everything on one pipe.
 *
 * Trimmed to a few sentences because this becomes a line in the panel, not a
 * document: the reader wants the verdict and the reason for it, and can open
 * the drawer for the rest.
 */
export function agentConclusion(stdout: string, transcriptAnswer?: string): string | undefined {
  const spoken = stdout.trim() || (transcriptAnswer ?? '').trim();
  if (!spoken) return undefined;

  // A CLI that printed a JSON envelope, a stack trace or its own banner is not
  // speaking to the developer, and quoting it as the agent's conclusion would
  // be putting words in its mouth.
  if (/^[[{]/.test(spoken) || /^\s*at\s+\S+\s+\(/m.test(spoken)) return undefined;

  // Kept whole rather than cut at the first paragraph. The agent's verdict and
  // the checks it ran to reach it are usually separate paragraphs, and the
  // second is what makes the first worth believing — this is rendered as
  // markdown in its own block, so it has the room.
  const collapsed = spoken.replace(/\r/g, '').trim();
  return collapsed.length > 1200 ? `${collapsed.slice(0, 1197)}…` : collapsed || undefined;
}

/** Pull anything the agent flagged as unresolved out of its transcript. */
function extractAgentWarnings(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => /TODO\(drift\)|could not|unable to|unresolved|needs? (?:human|manual)/i.test(line))
    .map((line) => line.trim().slice(0, 200))
    .slice(0, 10);
}

/**
 * Why the agent actually failed, rather than whatever it printed first.
 *
 * Taking line one reported `warning: --full-auto is deprecated` as the cause of
 * a run that died two hundred lines later on "this model is not supported when
 * using Codex with a ChatGPT account". A developer given the deprecation
 * warning has no way to reach the real problem, and a wrong explanation is
 * worse than a vague one: it sends them somewhere there is nothing to fix.
 *
 * So the last line that reads like an error wins, deprecation and progress
 * chatter are skipped, and only if nothing looks like an error does the first
 * line stand in.
 */
export function failureReason(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const noise = /^(warning|note|info|deprecated)\b|is deprecated\b/i;
  const errorish = /\b(error|fatal|panic|not supported|unauthorized|forbidden|invalid|failed)\b/i;

  const meaningful = lines.filter((line) => !noise.test(line));
  const reason = [...meaningful].reverse().find((line) => errorish.test(line)) ?? meaningful[0];

  return summarizeError(reason ?? lines[0] ?? 'No output.');
}

/** Pull the human sentence out of a line that is really a JSON error envelope. */
function summarizeError(line: string): string {
  const start = line.indexOf('{');
  if (start !== -1) {
    try {
      const body = JSON.parse(line.slice(start)) as { error?: { message?: string }; message?: string };
      const message = body.error?.message ?? body.message;
      if (message) return message.slice(0, 300);
    } catch {
      // Not JSON after all; the raw line is still the best answer.
    }
  }
  return line.slice(0, 300);
}
