import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DRIFT_CLI } from './drift-context.ts';
import { buildClaudeArgs, environmentProblems, parseClaudeStream, type CleanEnvironment, type SessionEnvironment } from './providers/claude-code.ts';
import { resultsRoot } from './store.ts';

const run = promisify(execFile);

/**
 * Proof, not assumption, that a benchmark session loads only what its
 * condition declares.
 *
 * Builds a throwaway repository planted with every kind of configuration
 * Claude Code can pick up from a project — CLAUDE.md in three places,
 * CLAUDE.local.md, AGENTS.md, project and local settings with env and
 * SessionStart hooks, a project skill, agent and command, and a project
 * `.mcp.json` whose server carries its own instructions — then starts sessions
 * with exactly the arguments and environment the harness uses and records:
 *
 *   - the session's init record (tools, MCP servers, skills, commands, agents,
 *     plugins, memory, output style) and its environment fingerprint;
 *   - which canary words the model could see in its context;
 *   - which settings env variables reached a shell it ran;
 *   - which hooks executed.
 *
 * Sessions run one at a time: hooks are detected by marker files, and a
 * parallel session's hook would be read as this one's.
 *
 * The model is a cheap one by default; what is being measured is what the CLI
 * loads, which does not depend on the model.
 */

const CANARY_PROMPT =
  'Use the Bash tool exactly once to run: echo "env:$CANARY_PROJECT_ENV:$CANARY_LOCAL_ENV". Then, without other tools, list every word ' +
  "beginning with 'tangerine-' that appears anywhere in your system prompt, instructions, memory, skills, agents, commands or MCP " +
  'server instructions (not in the Bash output). Answer exactly as: ENV=<bash output> WORDS=<comma list or NONE>.';

export interface ProbeSession {
  label: string;
  cleanEnvironment: CleanEnvironment;
  mcpServers: string[];
  argv: string[];
  environment: SessionEnvironment | null;
  environmentProblems: string[];
  canaryWordsSeen: string[];
  settingsEnvSeen: string[];
  hooksRan: string[];
  answer: string;
}

export interface IsolationProbeReport {
  generatedAt: string;
  claudeCodeVersion: string;
  model: string;
  canaries: string[];
  sessions: ProbeSession[];
  conclusions: string[];
}

async function plantCanaries(repo: string, mcpServerScript: string): Promise<string[]> {
  await mkdir(join(repo, '.claude', 'skills', 'canary-skill'), { recursive: true });
  await mkdir(join(repo, '.claude', 'agents'), { recursive: true });
  await mkdir(join(repo, '.claude', 'commands'), { recursive: true });
  const files: [string, string][] = [
    ['CLAUDE.md', 'Canary word: tangerine-CLAUDEMD\n'],
    ['AGENTS.md', 'Canary word: tangerine-AGENTSMD\n'],
    ['CLAUDE.local.md', 'Canary word: tangerine-LOCALMD\n'],
    ['.claude/CLAUDE.md', 'Canary word: tangerine-DOTCLAUDEMD\n'],
    ['.claude/settings.json', JSON.stringify({ env: { CANARY_PROJECT_ENV: 'tangerine-PROJECTENV' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch "$CLAUDE_PROJECT_DIR/HOOK_PROJECT_RAN"' }] }] } })],
    ['.claude/settings.local.json', JSON.stringify({ env: { CANARY_LOCAL_ENV: 'tangerine-LOCALENV' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch "$CLAUDE_PROJECT_DIR/HOOK_LOCAL_RAN"' }] }] } })],
    ['.claude/skills/canary-skill/SKILL.md', '---\nname: canary-skill\ndescription: Canary skill tangerine-SKILL\n---\nCanary.\n'],
    ['.claude/agents/canary-agent.md', '---\nname: canary-agent\ndescription: Canary agent tangerine-AGENT\n---\nCanary.\n'],
    ['.claude/commands/canary-command.md', '---\ndescription: Canary command tangerine-COMMAND\n---\nCanary.\n'],
    ['.mcp.json', JSON.stringify({ mcpServers: { canary: { command: process.execPath, args: [mcpServerScript] } } })],
  ];
  for (const [path, content] of files) await writeFile(join(repo, path), content);
  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'canaries'], { cwd: repo });
  return files.map(([path]) => path);
}

async function canaryMcpServer(dir: string): Promise<string> {
  const path = join(dir, 'canary-mcp.mjs');
  const sdk = new URL('../../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url).pathname;
  await writeFile(
    path,
    `import { McpServer } from '${sdk}server/mcp.js';\nimport { StdioServerTransport } from '${sdk}server/stdio.js';\n` +
      `const s = new McpServer({ name: 'canary', version: '1' }, { instructions: 'Canary word: tangerine-PROJECTMCP' });\n` +
      `s.registerTool('canary_tool', { description: 'canary', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'x' }] }));\n` +
      `await s.connect(new StdioServerTransport());\n`,
  );
  return path;
}

async function session(repo: string, label: string, clean: CleanEnvironment, servers: Record<string, { command: string; args: string[] }>, model: string): Promise<ProbeSession> {
  for (const marker of ['HOOK_PROJECT_RAN', 'HOOK_LOCAL_RAN']) await rm(join(repo, marker), { force: true });
  const { argv, env } = buildClaudeArgs({ model, effort: 'low', webTools: 'disabled', maxBudgetUsd: null, maxTurns: null, mcpServers: servers }, { cleanEnvironment: clean });
  const lines: string[] = [];
  await new Promise<void>((resolve) => {
    const child = spawn('claude', argv, { cwd: repo, env: { ...process.env, ...env } });
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      lines.push(...parts);
    });
    child.on('close', () => {
      if (buffer) lines.push(buffer);
      resolve();
    });
    child.stdin.end(CANARY_PROMPT);
  });
  const parsed = parseClaudeStream(lines);
  const answer = parsed.result?.resultText ?? '';
  const words = /WORDS=([^\n]*)/.exec(answer)?.[1] ?? '';
  const envLine = /ENV=(\S*)/.exec(answer)?.[1] ?? '';
  return {
    label,
    cleanEnvironment: clean,
    mcpServers: Object.keys(servers),
    argv: ['claude', ...argv],
    environment: parsed.init?.environment ?? null,
    environmentProblems: environmentProblems(parsed.init?.environment ?? null, Object.keys(servers)),
    canaryWordsSeen: [...words.matchAll(/tangerine-[A-Z]+/g)].map((m) => m[0]).sort(),
    settingsEnvSeen: [...envLine.matchAll(/tangerine-[A-Z]+/g)].map((m) => m[0]).sort(),
    hooksRan: ['HOOK_PROJECT_RAN', 'HOOK_LOCAL_RAN'].filter((marker) => existsSync(join(repo, marker))),
    answer: answer.slice(0, 500),
  };
}

export async function runIsolationProbe(options: { model?: string; root?: string } = {}): Promise<{ report: IsolationProbeReport; path: string }> {
  const model = options.model ?? 'claude-haiku-4-5-20251001';
  const scratch = await mkdtemp(join(tmpdir(), 'drift-isolation-probe-'));
  const repo = join(scratch, 'repo');
  await mkdir(repo);
  const canaries = await plantCanaries(repo, await canaryMcpServer(scratch));
  const drift = { drift: { command: process.execPath, args: [DRIFT_CLI, 'mcp'] } };

  const sessions: ProbeSession[] = [];
  sessions.push(await session(repo, 'isolated, no MCP (baseline, full report, brief)', 'isolated', {}, model));
  sessions.push(await session(repo, 'isolated, Drift MCP (drift-mcp)', 'isolated', drift, model));
  sessions.push(await session(repo, 'safe-mode (the v1 runs), for reference', 'safe-mode', {}, model));

  const version = (await run('claude', ['--version'])).stdout.trim();
  const [plain, mcp] = sessions;
  const conclusions = [
    `Isolated sessions saw canary words: ${[plain, mcp].flatMap((s) => s!.canaryWordsSeen).join(', ') || 'none'}.`,
    `Isolated sessions received settings env: ${[plain, mcp].flatMap((s) => s!.settingsEnvSeen).join(', ') || 'none'}.`,
    `Isolated sessions ran hooks: ${[plain, mcp].flatMap((s) => s!.hooksRan).join(', ') || 'none'}.`,
    `Environment fingerprints: no-MCP ${plain!.environment?.fingerprint ?? 'none'}, Drift MCP ${mcp!.environment?.fingerprint ?? 'none'} (${plain!.environment?.fingerprint === mcp!.environment?.fingerprint ? 'equal' : 'DIFFERENT'}).`,
    `Tools present only with Drift MCP: ${(mcp!.environment?.tools ?? []).filter((t) => !(plain!.environment?.tools ?? []).includes(t)).join(', ') || 'none'}; tools present only without it: ${(plain!.environment?.tools ?? []).filter((t) => !(mcp!.environment?.tools ?? []).includes(t)).join(', ') || 'none'}.`,
    `Environment problems: no-MCP ${plain!.environmentProblems.join('; ') || 'none'}; Drift MCP ${mcp!.environmentProblems.join('; ') || 'none'}.`,
    `safe-mode for reference: words ${sessions[2]!.canaryWordsSeen.join(', ') || 'none'}; settings env ${sessions[2]!.settingsEnvSeen.join(', ') || 'none'}; MCP servers ${JSON.stringify(sessions[2]!.environment?.mcpServers.map((s) => s.name) ?? [])}.`,
  ];

  const report: IsolationProbeReport = { generatedAt: new Date().toISOString(), claudeCodeVersion: version, model, canaries, sessions, conclusions };
  const dir = join(resultsRoot(options.root ?? process.cwd()), 'isolation');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `claude-code-${version.split(' ')[0]}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rm(scratch, { recursive: true, force: true });
  return { report, path };
}
