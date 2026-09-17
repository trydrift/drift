import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { LocalCheck } from '../detect/checks.js';
import { detectPackageManagers } from '../detect/package-manager.js';
import { nodeWorkspaceFs } from '../detect/workspace.js';
import { availableChecks, runChecks, type CheckOutcome } from '../verification/checks.js';
import { parseVerificationDiagnostics } from '../verification/diagnostics.js';
import { execCommand, type Exec } from '../util/exec.js';

/**
 * Verification the remediation controller runs itself, outside any agent.
 *
 * A coding agent left to verify its own work runs the whole build and test
 * suite, reads the log, edits, and runs it all again — and every one of those
 * logs stays in its context for the rest of the session. Measured on real
 * upgrades, most of an agent's input tokens are spent after its first edit, in
 * exactly that loop. Here the checks run as plain processes: their output is
 * reduced to the failures an upgrade introduced, and only those reach the next
 * (fresh) agent session.
 *
 * Three things make that reduction honest rather than convenient:
 *
 * - **Pre-existing failures are subtracted, not ignored.** A check that already
 *   failed before the upgrade (a test that needs Docker, a path that differs on
 *   macOS) is measured at the pre-upgrade commit; only failures absent there
 *   count. Without this, the loop chases problems the upgrade never caused and
 *   edits code it has no business touching.
 * - **A failure nothing could parse still fails.** An unrecognised tool that
 *   exits non-zero is a failure with its tail attached, never a pass.
 * - **Verification does not edit the tree.** Some test scripts rewrite files
 *   (`jest-it-up` raises coverage thresholds in `jest.config.js`). Anything a
 *   check changed is restored and reported, so a pass cannot smuggle in a
 *   configuration change nobody reviewed.
 */

export interface VerificationFailure {
  /** The check that reported it. */
  check: string;
  /** Normalised text that identifies this failure across runs. */
  signature: string;
  /** Repository-relative file, when the failure names one. */
  file?: string;
  line?: number;
  message: string;
}

export interface CheckResult {
  label: string;
  kind: LocalCheck['kind'];
  status: CheckOutcome['status'];
  durationMs: number;
  /** Failures this upgrade introduced; failures also present at baseline are excluded. */
  failures: VerificationFailure[];
  /** Failures matched to the pre-upgrade baseline and therefore not counted. */
  preexisting: number;
  /** Bounded tail of the output, for a failure no parser recognised. */
  tail: string;
  /** Repository files the output mentions, for scoping a repair when no diagnostic names a line. */
  mentionedFiles: string[];
}

export interface VerificationRun {
  passed: boolean;
  checks: CheckResult[];
  failures: VerificationFailure[];
  /** Stable across runs with the same failures. The controller's no-progress test. */
  fingerprint: string;
  durationMs: number;
  /** Whether dependencies were (re)installed before the checks ran. */
  installed: boolean;
  /** Set when the install itself failed; the checks are still run. */
  installFailure?: string;
  /** Tracked files a check modified, which were restored. */
  sideEffectsReverted: string[];
}

export interface RemediationVerifier {
  readonly checks: readonly LocalCheck[];
  run(options?: { signal?: AbortSignal }): Promise<VerificationRun>;
}

export interface ProjectVerifierOptions {
  /** Git root the controller edits. */
  root: string;
  /** Workspace member the checks run in, relative to `root`. */
  dir?: string;
  checks: readonly LocalCheck[];
  /** Outcomes of the same checks at the pre-upgrade commit. See `measureBaseline`. */
  baseline?: readonly CheckOutcome[];
  /**
   * Install dependencies before running checks when a manifest or lockfile
   * changed since the last install. `never` for a caller that installs itself.
   */
  install?: 'when-manifests-change' | 'never';
  /** Install before the first run too — for a freshly created worktree that has no installed dependencies. */
  installFirst?: boolean;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Seam for tests. */
  runChecks?: typeof runChecks;
}

const TAIL_LINES = 40;
const MAX_FAILURES_PER_CHECK = 200;

/**
 * The checks a remediation must leave passing.
 *
 * `availableChecks` (typecheck, test, build) plus the repository's own lint
 * script and any narrower `test:*`/`lint:*` script that is not already run by
 * one of those. Watch, fix, coverage-report, integration and end-to-end scripts
 * are excluded: they hang, rewrite files, or need infrastructure a local run
 * does not have. What is not discovered here is not verified, and the controller
 * says so in its record rather than implying more coverage than it had.
 */
export async function detectRemediationChecks(root: string, dir = ''): Promise<LocalCheck[]> {
  const base = await availableChecks(root, dir);
  const absolute = dir ? join(root, dir) : root;
  const fs = nodeWorkspaceFs();
  const entries = await fs.readDirectory(absolute);
  const node = detectPackageManagers({ entries }).find((detected) => detected.manager.ecosystem === 'npm');
  if (!node) return base;

  const manifest = await fs.readFile(join(absolute, 'package.json'));
  const scripts = parseScripts(manifest);
  if (!scripts) return base;

  const runner = node.manager.id === 'yarn' || node.manager.id === 'yarn-berry' ? 'yarn' : node.manager.id;
  const selectedNames = new Set(base.map((check) => scriptNameOf(check)).filter((name): name is string => Boolean(name)));
  const extra = Object.keys(scripts)
    .filter((name) => /^(?:lint|test)(?::[\w.-]+)?$/.test(name))
    .filter((name) => !/(?:watch|fix|coverage|cov\b|integration|e2e|all|ci|debug|update|snapshot|dev|ui|open|serve)/i.test(name))
    .filter((name) => !selectedNames.has(name))
    .sort();

  const chosen: string[] = [];
  for (const name of extra) chosen.push(name);
  // A script another selected script already runs (`lint` → `yarn lint:eslint`)
  // would be run twice and reported twice.
  const all = [...selectedNames, ...chosen];
  const kept = chosen.filter((name) => !all.some((other) => other !== name && invokesScript(scripts[other] ?? '', name)));

  return [
    ...base.filter((check) => !kept.length || !all.some((other) => other !== scriptNameOf(check) && invokesScript(scripts[other] ?? '', scriptNameOf(check) ?? ''))),
    ...kept.map((name): LocalCheck => {
      const args = runner === 'yarn' ? [name] : ['run', name];
      return {
        kind: name.startsWith('lint') ? 'lint' : 'test',
        label: [runner, ...args].join(' '),
        command: { command: runner, args },
        source: `\`scripts.${name}\` in package.json`,
        commandOrigin: { kind: 'host', command: runner },
        compileCapable: false,
      };
    }),
  ];
}

/**
 * Run the given checks at another commit, in a throwaway worktree, after a
 * fresh install. What already failed there is not the upgrade's doing.
 */
export async function measureBaseline(options: {
  root: string;
  ref: string;
  dir?: string;
  checks: readonly LocalCheck[];
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  installTimeoutMs?: number;
  runChecks?: typeof runChecks;
}): Promise<{ outcomes: CheckOutcome[]; durationMs: number; installFailure?: string }> {
  const exec = options.exec ?? execCommand;
  const started = Date.now();
  const common = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: options.root });
  const gitDir = resolve(options.root, common.stdout.trim() || '.git');
  const worktree = join(gitDir, 'drift-baselines', createHash('sha256').update(`${options.ref}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12));
  const add = await exec('git', ['worktree', 'add', '--detach', worktree, options.ref], { cwd: options.root });
  if (add.code !== 0) {
    return { outcomes: [], durationMs: Date.now() - started, installFailure: `Could not create a baseline worktree: ${add.stderr.trim()}` };
  }
  try {
    const cwd = options.dir ? join(worktree, options.dir) : worktree;
    const installFailure = await install(cwd, exec, options.env, options.installTimeoutMs);
    const outcomes = await (options.runChecks ?? runChecks)({
      root: worktree,
      dir: options.dir,
      checks: options.checks,
      exec,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    return { outcomes, durationMs: Date.now() - started, ...(installFailure ? { installFailure } : {}) };
  } finally {
    await exec('git', ['worktree', 'remove', '--force', worktree], { cwd: options.root });
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createProjectVerifier(options: ProjectVerifierOptions): RemediationVerifier {
  const exec = options.exec ?? execCommand;
  const cwd = options.dir ? join(options.root, options.dir) : options.root;
  let installedFor: string | null = null;

  return {
    checks: options.checks,
    async run(runOptions = {}) {
      const started = Date.now();
      let installed = false;
      let installFailure: string | undefined;

      if ((options.install ?? 'when-manifests-change') === 'when-manifests-change') {
        const key = await dependencyStateKey(cwd);
        if (installedFor === null && options.installFirst) {
          // Nothing declared has changed yet, so any lockfile rewrite this
          // install makes is churn, not part of the fix: restore it.
          const untouched = await trackedState(options.root, exec);
          installFailure = await install(cwd, exec, options.env);
          await revertSideEffects(options.root, untouched, exec);
          installed = true;
          installedFor = await dependencyStateKey(cwd);
        } else if (installedFor === null) {
          // The tree the controller starts from was installed by whoever
          // created it; only a change from there needs a new install.
          installedFor = key;
        } else if (key !== installedFor) {
          installFailure = await install(cwd, exec, options.env);
          installed = true;
          installedFor = await dependencyStateKey(cwd);
        }
      }

      const before = await trackedState(options.root, exec);
      const outcomes = await (options.runChecks ?? runChecks)({
        root: options.root,
        dir: options.dir,
        checks: options.checks,
        exec,
        env: options.env,
        timeoutMs: options.timeoutMs,
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      });
      const sideEffectsReverted = await revertSideEffects(options.root, before, exec);

      const checks = outcomes.map((outcome) => resultFor(outcome, options.baseline?.find((b) => b.label === outcome.label), options.root));
      const failures = checks.flatMap((check) => check.failures);
      const passed = checks.every((check) => check.status === 'passed' || check.failures.length === 0);

      return {
        passed,
        checks,
        failures,
        fingerprint: fingerprintOf(checks),
        durationMs: Date.now() - started,
        installed,
        ...(installFailure ? { installFailure } : {}),
        sideEffectsReverted,
      };
    },
  };
}

/**
 * Failures in one check's output, minus those in the same check's baseline.
 *
 * A check that failed after the upgrade but passed (or did not exist) before,
 * with nothing parseable in its output, still yields one failure: the exit
 * itself. A check that did not run at all yields none — "not run" is recorded
 * on the check, and treating a missing binary as an upgrade break would send an
 * agent to fix the machine.
 */
export function resultFor(outcome: CheckOutcome, baseline: CheckOutcome | undefined, root: string): CheckResult {
  const output = outcome.fullOutput ?? outcome.output ?? '';
  const tail = stripAnsi(output).split('\n').filter((line) => line.trim() && !/^\s*(?:PASS|✓|√|ok \d)/.test(line)).slice(-TAIL_LINES).join('\n');
  // The tail, not the whole output: a test runner prints every passing suite's
  // path, and a repair scoped to all of them is not scoped at all.
  const mentionedFiles = outcome.status === 'failed' ? filesMentioned(tail, root) : [];
  const base: CheckResult = {
    label: outcome.label,
    kind: outcome.kind,
    status: outcome.status,
    durationMs: outcome.durationMs,
    failures: [],
    preexisting: 0,
    tail,
    mentionedFiles,
  };
  if (outcome.status !== 'failed') return base;

  const parsed = extractFailures(outcome.label, output, root);
  const baselineFailed = baseline?.status === 'failed';
  const baselineSignatures = baselineFailed
    ? new Set(extractFailures(outcome.label, baseline!.fullOutput ?? baseline!.output ?? '', root).map((failure) => failure.signature))
    : new Set<string>();

  const introduced = parsed.filter((failure) => !baselineSignatures.has(failure.signature));
  const preexisting = parsed.length - introduced.length;

  if (parsed.length === 0 && !baselineFailed) {
    return {
      ...base,
      failures: [{ check: outcome.label, signature: `${outcome.label}|exit`, message: `\`${outcome.label}\` failed${outcome.reason ? ` (${outcome.reason})` : ''}.` }],
    };
  }
  return { ...base, failures: introduced.slice(0, MAX_FAILURES_PER_CHECK), preexisting };
}

/**
 * Individual failures in a check's output: compiler diagnostics, failing test
 * names, unmet coverage thresholds, and tool-level errors. Signatures have
 * their varying parts (absolute paths, durations, counts) removed so that the
 * same failure in two runs, or in the baseline, compares equal.
 */
export function extractFailures(check: string, rawOutput: string, root: string): VerificationFailure[] {
  const output = stripAnsi(rawOutput);
  const failures = new Map<string, VerificationFailure>();
  const add = (failure: Omit<VerificationFailure, 'check' | 'signature'> & { key: string }) => {
    const signature = `${check}|${normalise(failure.key, root)}`;
    if (failures.has(signature)) return;
    failures.set(signature, {
      check,
      signature,
      message: failure.message.slice(0, 300),
      ...(failure.file ? { file: failure.file } : {}),
      ...(failure.line ? { line: failure.line } : {}),
    });
  };

  for (const diagnostic of parseVerificationDiagnostics(output, root)) {
    if (diagnostic.severity !== 'error' || diagnostic.origin === 'stack-frame') continue;
    const file = repoRelative(diagnostic.file, root);
    add({
      key: `${file}:${diagnostic.line}:${diagnostic.code ?? ''}:${diagnostic.message}`,
      file,
      line: diagnostic.line,
      message: `${file}:${diagnostic.line} ${diagnostic.code ? `${diagnostic.code} ` : ''}${diagnostic.message}`,
    });
  }

  const lines = output.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    let match: RegExpExecArray | null;
    if ((match = /^●\s+(.+?)\s*$/.exec(trimmed)) && !/^Console$/.test(match[1]!)) {
      const location = locationAfter(lines, index, root);
      add({ key: `test:${match[1]}`, message: `Test failed: ${match[1]}`, ...location });
    } else if ((match = /^FAIL\s+(\S+)/.exec(trimmed))) {
      const file = repoRelative(match[1]!, root);
      add({ key: `suite:${file}`, file, message: `Test suite failed: ${file}` });
    } else if ((match = /^not ok \d+ - (.+)$/.exec(trimmed))) {
      add({ key: `test:${match[1]}`, message: `Test failed: ${match[1]}`, ...locationAfter(lines, index, root) });
    } else if ((match = /^\d+\) (.+)$/.exec(trimmed)) && /failing/.test(output)) {
      add({ key: `test:${match[1]}`, message: `Test failed: ${match[1]}`, ...locationAfter(lines, index, root) });
    } else if ((match = /^FAILED\s+(\S+?)(?:::(\S+))?(?:\s|$)/.exec(trimmed))) {
      const file = repoRelative(match[1]!, root);
      add({ key: `test:${match[1]}::${match[2] ?? ''}`, file, message: `Test failed: ${match[1]}${match[2] ? `::${match[2]}` : ''}` });
    } else if ((match = /coverage threshold for (\w+) \(([\d.]+)%\) not met/.exec(trimmed))) {
      add({ key: `coverage:${match[1]}`, message: trimmed });
    } else if ((match = /^(\/?[^\s:]+\.[cm]?[jt]sx?)$/.exec(trimmed)) && /^\s+\d+:\d+\s+error\s/.test(lines[index + 1] ?? '')) {
      // ESLint's stylish formatter: a path line, then `  line:col  error  message  rule`.
      const file = repoRelative(match[1]!, root);
      for (let next = index + 1; next < lines.length && /^\s+\d+:\d+\s+/.test(lines[next]!); next += 1) {
        const lint = /^\s+(\d+):\d+\s+error\s+(.+?)\s{2,}(\S+)\s*$/.exec(lines[next]!);
        if (lint) add({ key: `${file}:${lint[1]}:${lint[3]}`, file, line: Number(lint[1]), message: `${file}:${lint[1]} ${lint[2]} (${lint[3]})` });
      }
    } else if (/^(?:Error|TypeError|SyntaxError|ReferenceError|Oops!|ESLint couldn't|Cannot find module)\b/.test(trimmed)) {
      add({ key: `error:${trimmed}`, message: trimmed, ...locationAfter(lines, index, root) });
    }
  }

  return [...failures.values()];
}

/** The first in-repository stack frame or `path:line` after a failure heading. */
function locationAfter(lines: readonly string[], index: number, root: string): { file?: string; line?: number } {
  for (const line of lines.slice(index + 1, index + 40)) {
    const frame = /\(?((?:\/|\.{0,2}\/)?[\w@./-]+\.[cm]?[jt]sx?):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!frame) continue;
    const file = repoRelative(frame[1]!, root);
    if (file.startsWith('node_modules/') || file.includes('/node_modules/') || file.startsWith('..') || file.startsWith('/')) continue;
    return { file, line: Number(frame[2]) };
  }
  return {};
}

function filesMentioned(rawOutput: string, root: string): string[] {
  const found = new Set<string>();
  for (const match of stripAnsi(rawOutput).matchAll(/((?:\/|\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:[cm]?[jt]sx?|json|ya?ml|py|java|kt|go|rs|rb|php|cs|toml))(?=[:()\s'"]|$)/g)) {
    const file = repoRelative(match[1]!, root);
    if (!file || file.startsWith('..') || file.startsWith('/') || file.includes('node_modules/')) continue;
    found.add(file);
    if (found.size >= 50) break;
  }
  return [...found];
}

function repoRelative(path: string, root: string): string {
  const cleaned = path.replace(/\\/g, '/');
  const absoluteRoot = root.replace(/\\/g, '/');
  for (const prefix of [absoluteRoot, absoluteRoot.replace(/^\/private/, ''), `/private${absoluteRoot}`]) {
    if (cleaned.startsWith(`${prefix}/`)) return cleaned.slice(prefix.length + 1);
  }
  return cleaned.startsWith('/') ? relative(absoluteRoot, cleaned).replace(/\\/g, '/') : cleaned.replace(/^\.\//, '');
}

function normalise(text: string, root: string): string {
  const absoluteRoot = root.replace(/\\/g, '/');
  return text
    .split(absoluteRoot).join('')
    .replace(/\/private\/var\/folders\/[^\s'"]+|\/var\/folders\/[^\s'"]+|\/tmp\/[^\s'"]+/g, '<tmp>')
    .replace(/\(\d+(?:\.\d+)?\s*m?s\)/g, '')
    .replace(/\d+(?:\.\d+)?%/g, '<n>%')
    .replace(/\s+/g, ' ')
    .trim();
}

function fingerprintOf(checks: readonly CheckResult[]): string {
  const material = checks
    .map((check) => `${check.label}=${check.status}:${check.failures.map((failure) => failure.signature).sort().join(',')}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function parseScripts(manifest: string | null): Record<string, string> | null {
  if (!manifest) return null;
  try {
    const scripts = (JSON.parse(manifest) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function scriptNameOf(check: LocalCheck): string | undefined {
  const args = check.command.args;
  if (args[0] === 'run') return args[1];
  if (args[0] === 'test') return 'test';
  return args[0];
}

function invokesScript(body: string, name: string): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\\s+${escaped}(?![\\w:.-])`).test(body);
}

async function dependencyStateKey(cwd: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'pyproject.toml', 'uv.lock', 'poetry.lock', 'requirements.txt', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const content = await readFile(join(cwd, name), 'utf8').catch(() => null);
    hash.update(`${name}\0${content ?? ''}\0`);
  }
  return hash.digest('hex');
}

async function install(cwd: string, exec: Exec, env?: NodeJS.ProcessEnv, timeoutMs = 15 * 60_000): Promise<string | undefined> {
  const entries = await nodeWorkspaceFs().readDirectory(cwd);
  const detected = detectPackageManagers({ entries })[0];
  const command = detected?.manager.install;
  if (!command) return 'No install command is known for this project.';
  const result = await exec(command.command, command.args, { cwd, env, timeoutMs });
  return result.code === 0 ? undefined : `\`${[command.command, ...command.args].join(' ')}\` failed: ${`${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-10).join('\n')}`;
}

interface TrackedState {
  dirty: Map<string, string>;
}

async function trackedState(root: string, exec: Exec): Promise<TrackedState> {
  const status = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root });
  const dirty = new Map<string, string>();
  for (const entry of status.stdout.split('\0').filter(Boolean)) {
    const path = entry.slice(3);
    const content = await readFile(join(root, path)).catch(() => null);
    dirty.set(path, `${entry.slice(0, 2)}:${content ? createHash('sha256').update(content).digest('hex') : ''}`);
  }
  return { dirty };
}

/**
 * Restore any file a check changed. Files that were already dirty before the
 * checks ran and are unchanged are left alone; the controller verifies a
 * committed tree, so in practice everything a check touched is restored.
 */
async function revertSideEffects(root: string, before: TrackedState, exec: Exec): Promise<string[]> {
  const after = await trackedState(root, exec);
  const reverted: string[] = [];
  for (const [path, state] of after.dirty) {
    if (before.dirty.get(path) === state) continue;
    if (state.startsWith('??')) {
      await rm(join(root, path), { recursive: true, force: true }).catch(() => undefined);
    } else {
      await exec('git', ['checkout', '--', path], { cwd: root });
    }
    reverted.push(path);
  }
  return reverted.sort();
}

/** Anchored on the escape character, so bracketed prose like `[1]` survives. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
}
