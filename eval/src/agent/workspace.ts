import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { agentRoot, caseDir } from './cases.ts';
import type { AgentCase } from './schema.ts';

const execFile = promisify(execFileCallback);

/**
 * The disposable workspace an agent session runs in, and the proof that it
 * contains nothing private.
 *
 * Built from the case's *source*, never from the case directory:
 *
 *   git      a `--mirror` clone cached under `eval/agent/.cache/mirrors/`
 *            (the only thing reused across trials, and only ever read), from
 *            which `git archive` exports the base tree and the start tree.
 *   fixture  `fixture/start/` is the start tree; `fixture/base/` overlays the
 *            files that differ at the base commit.
 *
 * The workspace is then a fresh repository with exactly two commits — the
 * consumer before the bump, and the consumer with the bump — and no remote.
 * The agent sees the same thing a developer sees the morning after a
 * Dependabot commit landed, and it cannot reach the maintainer's later fix
 * because that history was never copied.
 *
 * After building, `auditWorkspace` walks the tree and refuses anything named
 * like private material and any symlink leaving the workspace. This is a
 * directory audit, not a sandbox: the private half of the case is still
 * readable elsewhere on this host by a process the agent starts. Every trial
 * records that as `isolation: workspace-audit`.
 */

export const HIDDEN_DIRECTORY = '.drift-hidden';
const PRIVATE_NAMES = new Set(['hidden', HIDDEN_DIRECTORY, 'hidden.yml', 'reference.patch']);

export interface Workspace {
  /** Temp root holding `repo/`. */
  root: string;
  /** The repository the agent runs in. */
  repo: string;
  /** The directory the upgrade lands in (`repo` joined with `workspaceDir`). */
  project: string;
  baseCommit: string;
  startCommit: string;
  startTreeHash: string;
  auditedPaths: number;
  teardown: () => Promise<void>;
}

export function mirrorsRoot(root?: string): string {
  return join(agentRoot(root), '.cache', 'mirrors');
}

export function mirrorPath(repository: string, root?: string): string {
  return join(mirrorsRoot(root), `${createHash('sha256').update(repository).digest('hex').slice(0, 16)}.git`);
}

/** Clone once, fetch on demand. Read-only afterwards. */
export async function ensureMirror(repository: string, commits: readonly string[], root?: string): Promise<string> {
  const path = mirrorPath(repository, root);
  await mkdir(dirname(path), { recursive: true });
  let exists = false;
  try {
    await stat(join(path, 'HEAD'));
    exists = true;
  } catch {
    // not cloned yet
  }
  if (!exists) {
    await execFile('git', ['clone', '--mirror', '--quiet', repository, path], { maxBuffer: 64 * 1024 * 1024 });
  }
  for (const commit of commits) {
    try {
      await execFile('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: path });
    } catch {
      await execFile('git', ['fetch', '--quiet', 'origin', commit], { cwd: path, maxBuffer: 64 * 1024 * 1024 }).catch(async () => {
        await execFile('git', ['remote', 'update', '--prune'], { cwd: path, maxBuffer: 64 * 1024 * 1024 });
      });
      await execFile('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: path });
    }
  }
  return path;
}

async function exportTree(mirror: string, commit: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', commit], { cwd: mirror });
    const tar = spawn('tar', ['-x', '-C', into]);
    archive.stdout.pipe(tar.stdin);
    let stderr = '';
    archive.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    tar.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    archive.on('error', reject);
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`git archive ${commit} failed: ${stderr.trim()}`))));
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.email=bench@drift.invalid', '-c', 'user.name=Drift Benchmark', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', message]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

async function clearTree(repo: string): Promise<void> {
  for (const entry of await readdir(repo)) {
    if (entry === '.git') continue;
    await rm(join(repo, entry), { recursive: true, force: true });
  }
}

export async function materializeWorkspace(agentCase: AgentCase, root?: string): Promise<Workspace> {
  const temp = await mkdtemp(join(tmpdir(), `drift-agent-${agentCase.id}-`));
  const repo = join(temp, 'repo');
  const teardown = () => rm(temp, { recursive: true, force: true });

  try {
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '--quiet', '--initial-branch=main']);

    if (agentCase.source.kind === 'git') {
      const wanted = [agentCase.source.baseCommit, ...(agentCase.source.startCommit ? [agentCase.source.startCommit] : [])];
      const mirror = await ensureMirror(agentCase.source.repository, wanted, root);
      await exportTree(mirror, agentCase.source.baseCommit, repo);
      const baseCommit = await commitAll(repo, `Consumer before upgrading ${agentCase.dependency.name}`);
      if (agentCase.source.startCommit) {
        await clearTree(repo);
        await exportTree(mirror, agentCase.source.startCommit, repo);
      } else {
        // The bump-only state, constructed: the base tree plus the case's
        // public start patch (manifest and lockfile), applied with git so a
        // patch that no longer applies fails loudly here.
        const patch = await readFile(resolve(caseDir(agentCase.id, root), agentCase.source.startPatch!), 'utf8');
        await applyPatch(repo, patch);
      }
      const startCommit = await commitAll(
        repo,
        `Upgrade ${agentCase.dependency.name} ${agentCase.dependency.fromVersion} -> ${agentCase.dependency.toVersion}`,
      );
      return await finish(temp, repo, agentCase, baseCommit, startCommit, teardown, root);
    }

    const fixture = resolve(caseDir(agentCase.id, root), agentCase.source.path);
    await cp(join(fixture, 'start'), repo, { recursive: true });
    await cp(join(fixture, 'base'), repo, { recursive: true, force: true });
    const baseCommit = await commitAll(repo, `Consumer before upgrading ${agentCase.dependency.name}`);
    await clearTree(repo);
    await cp(join(fixture, 'start'), repo, { recursive: true });
    const startCommit = await commitAll(
      repo,
      `Upgrade ${agentCase.dependency.name} ${agentCase.dependency.fromVersion} -> ${agentCase.dependency.toVersion}`,
    );
    return await finish(temp, repo, agentCase, baseCommit, startCommit, teardown, root);
  } catch (err) {
    await teardown();
    throw err;
  }
}

async function finish(
  temp: string,
  repo: string,
  agentCase: AgentCase,
  baseCommit: string,
  startCommit: string,
  teardown: () => Promise<void>,
  root?: string,
): Promise<Workspace> {
  // Installed dependencies and the hidden directory must never show up in
  // the agent's diff, whatever the repository's own ignore rules say.
  await mkdir(join(repo, '.git', 'info'), { recursive: true });
  await writeFile(join(repo, '.git', 'info', 'exclude'), ['node_modules/', `${HIDDEN_DIRECTORY}/`, '.venv/', '__pycache__/', 'target/'].join('\n') + '\n');
  const startTreeHash = (await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim();
  const auditedPaths = await auditWorkspace(repo, caseDir(agentCase.id, root));
  return {
    root: temp,
    repo,
    project: agentCase.workspaceDir ? join(repo, agentCase.workspaceDir) : repo,
    baseCommit,
    startCommit,
    startTreeHash,
    auditedPaths,
    teardown,
  };
}

/**
 * Walks the workspace and throws on private material or an escaping symlink.
 * Runs on every materialization, not only in tests.
 */
export async function auditWorkspace(repo: string, privateRoot: string): Promise<number> {
  const repoReal = await realpathSafe(repo);
  const privateReal = await realpathSafe(privateRoot);
  if (repoReal === privateReal || repoReal.startsWith(privateReal + sep)) {
    throw new Error(`Workspace ${repo} overlaps the case directory ${privateRoot}.`);
  }
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === '.git') continue;
      if (PRIVATE_NAMES.has(entry.name)) {
        throw new Error(`Workspace contains private-looking path ${relative(repo, path)}; refusing to hand it to an agent.`);
      }
      count += 1;
      if (entry.isSymbolicLink()) {
        const target = resolve(dir, await readlink(path));
        if (!target.startsWith(repoReal + sep) && target !== repoReal) {
          throw new Error(`Workspace symlink ${relative(repo, path)} points outside the workspace (${target}).`);
        }
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(repo);
  return count;
}

async function realpathSafe(path: string): Promise<string> {
  try {
    const { realpath } = await import('node:fs/promises');
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export interface CommandRun {
  code: number | null;
  spawnFailed: boolean;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

const SHELL_OPERATORS = /[|&;<>()$`\n*?[\]{}~!#'"\\]/;

/**
 * Runs one project command. Commands with shell syntax go through `/bin/sh -c`
 * (they are the case author's own text); plain ones are spawned directly.
 */
export async function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void },
): Promise<CommandRun> {
  const started = Date.now();
  const useShell = SHELL_OPERATORS.test(command);
  const program = useShell ? (process.platform === 'win32' ? process.env['COMSPEC'] ?? 'cmd.exe' : '/bin/sh') : command.split(/\s+/)[0]!;
  const args = useShell ? [process.platform === 'win32' ? '/d/s/c' : '-c', command] : command.split(/\s+/).slice(1);

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true });
    } catch (err) {
      resolvePromise({ code: null, spawnFailed: true, timedOut: false, durationMs: Date.now() - started, output: (err as Error).message });
      return;
    }
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, options.timeoutMs);
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      if (output.length < 4 * 1024 * 1024) output += text;
      options.onOutput?.(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, spawnFailed: true, timedOut, durationMs: Date.now() - started, output: `${output}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, spawnFailed: false, timedOut, durationMs: Date.now() - started, output });
    });
  });
}

export function projectEnv(agentCase: AgentCase, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TZ: agentCase.environment.timezone,
    LC_ALL: agentCase.environment.locale,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    CI: '1',
    ...extra,
  };
}

/** Unified diff of the working tree (untracked files included) against a ref, plus name-status. */
export async function captureDiff(repo: string, ref: string): Promise<{ diff: string; nameStatus: string; numstat: string }> {
  await git(repo, ['add', '-A', '--', '.']);
  const diff = await git(repo, ['diff', '--cached', '--no-color', '--binary', ref, '--']);
  const nameStatus = await git(repo, ['diff', '--cached', '--name-status', ref, '--']);
  const numstat = await git(repo, ['diff', '--cached', '--numstat', ref, '--']);
  await git(repo, ['reset', '--quiet']);
  return { diff, nameStatus, numstat };
}

export async function applyPatch(repo: string, patch: string): Promise<void> {
  const path = join(repo, '.git', 'drift-agent-apply.patch');
  await writeFile(path, patch, 'utf8');
  try {
    await git(repo, ['apply', '--whitespace=nowarn', path]);
  } finally {
    await rm(path, { force: true });
  }
}

export async function readWorkspaceFile(repo: string, path: string): Promise<string | null> {
  try {
    return await readFile(isAbsolute(path) ? path : join(repo, path), 'utf8');
  } catch {
    return null;
  }
}

export async function gitShow(repo: string, ref: string, path: string): Promise<string | null> {
  try {
    return await git(repo, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}
