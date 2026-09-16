import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import semver from 'semver';
import type { AgentCase, FailureReason, ForbiddenRule, HiddenMaterial, PatchStats, ValidationResult } from './schema.ts';
import { HIDDEN_DIRECTORY, gitShow, projectEnv, runCommand, type CommandRun, type Workspace } from './workspace.ts';

/**
 * The four validation layers, run against the agent's final tree after the
 * agent process has exited.
 *
 *   A. dependency integrity   the dependency is still at the new version:
 *                             manifest, lockfile (a fresh install succeeds),
 *                             and the version actually installed
 *   B. the project's own checks
 *   C. hidden regression tests, staged into the workspace only now
 *   D. case-specific workaround rules over the diff
 *
 * Success is the conjunction. Every layer records what it saw so a failure
 * is a list of reasons, never a bare `false`.
 */

export const MAX_EXCERPT = 4000;

export function excerpt(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= MAX_EXCERPT ? trimmed : `${trimmed.slice(0, MAX_EXCERPT)}\n… (${trimmed.length - MAX_EXCERPT} more characters)`;
}

/* ---------------------------------------------------------------- */
/* Patch classification                                              */
/* ---------------------------------------------------------------- */

const TEST_PATTERNS = [/(^|\/)(test|tests|__tests__|spec|specs|e2e)(\/|$)/, /\.(test|spec)\.[cm]?[jt]sx?$/, /_test\.(go|py|rb)$/, /(^|\/)test_[^/]+\.py$/, /Test\.java$/];
const DEPENDENCY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
]);
const CONFIG_PATTERNS = [/(^|\/)\.[^/]+$/, /\.(json|ya?ml|toml|ini|cfg|conf|config\.[cm]?[jt]s|rc)$/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)(Makefile|Dockerfile)$/];
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|java|kt|go|rs|rb|php|cs|swift|scala|ex|exs|dart|vue|svelte)$/;

export function classifyPath(path: string): 'test' | 'dependency' | 'source' | 'config' | 'other' {
  const base = path.split('/').pop() ?? path;
  if (DEPENDENCY_FILES.has(base)) return 'dependency';
  if (TEST_PATTERNS.some((pattern) => pattern.test(path))) return 'test';
  if (SOURCE_EXTENSIONS.test(path)) return 'source';
  if (CONFIG_PATTERNS.some((pattern) => pattern.test(path))) return 'config';
  return 'other';
}

/** Parses `git diff --name-status` and `--numstat` output. */
export function patchStatsFrom(nameStatus: string, numstat: string): PatchStats {
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const path = rest[rest.length - 1];
    if (!status || !path) continue;
    changedFiles.push(path);
    if (status.startsWith('D')) deletedFiles.push(path);
  }
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const line of numstat.split('\n')) {
    const [added, deleted] = line.split('\t');
    if (added && added !== '-') linesAdded += Number(added) || 0;
    if (deleted && deleted !== '-') linesDeleted += Number(deleted) || 0;
  }
  const counts = { source: 0, test: 0, config: 0, dependency: 0, other: 0 };
  for (const file of changedFiles) counts[classifyPath(file)] += 1;
  return {
    files: changedFiles.length,
    sourceFiles: counts.source,
    testFiles: counts.test,
    configFiles: counts.config,
    dependencyFiles: counts.dependency,
    otherFiles: counts.other,
    linesAdded,
    linesDeleted,
    changedFiles: changedFiles.sort(),
    deletedFiles: deletedFiles.sort(),
  };
}

/* ---------------------------------------------------------------- */
/* A. Dependency integrity                                           */
/* ---------------------------------------------------------------- */

export interface ManifestReading {
  specifier: string | null;
  scripts: Record<string, string> | null;
}

/** Reads what a manifest declares for the dependency. npm manifests are parsed; others are grepped for the exact version. */
export function readManifest(agentCase: AgentCase, content: string | null): ManifestReading {
  if (content === null) return { specifier: null, scripts: null };
  if (agentCase.integrity.manifestPath.endsWith('package.json')) {
    try {
      const manifest = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const spec = manifest[section]?.[agentCase.dependency.name];
        if (typeof spec === 'string') return { specifier: spec, scripts: (manifest['scripts'] as Record<string, string> | undefined) ?? null };
      }
      return { specifier: null, scripts: (manifest['scripts'] as Record<string, string> | undefined) ?? null };
    } catch {
      return { specifier: null, scripts: null };
    }
  }
  // Non-npm manifests: the exact pinned version must still be present next to the name.
  const name = agentCase.dependency.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${name}[^\\n]*?(${agentCase.dependency.toVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
  const match = pattern.exec(content);
  return { specifier: match ? match[1]! : null, scripts: null };
}

/** Whether an npm specifier still selects the upgraded version and no longer the old one. */
export function specifierKeepsUpgrade(specifier: string | null, fromVersion: string, toVersion: string): { ok: boolean; reason: string } {
  if (specifier === null) return { ok: false, reason: 'the dependency is no longer declared in the manifest' };
  if (specifier.startsWith('file:') || specifier.startsWith('link:') || /^(git|https?|ssh):/.test(specifier) || specifier.startsWith('github:')) {
    return { ok: false, reason: `the dependency was redirected to "${specifier}"` };
  }
  const range = semver.validRange(specifier);
  if (!range) {
    // A non-semver spelling (a tag, a workspace: protocol). Accept only an exact match on the new version.
    return specifier === toVersion ? { ok: true, reason: '' } : { ok: false, reason: `the specifier "${specifier}" is not a semver range and is not the exact new version` };
  }
  if (!semver.satisfies(toVersion, range)) return { ok: false, reason: `the specifier "${specifier}" no longer admits ${toVersion}` };
  if (semver.satisfies(fromVersion, range)) return { ok: false, reason: `the specifier "${specifier}" still admits the old version ${fromVersion}` };
  return { ok: true, reason: '' };
}

/* ---------------------------------------------------------------- */
/* D. Forbidden-workaround rules                                     */
/* ---------------------------------------------------------------- */

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

/** Lines the diff adds, keyed by file, parsed from a unified diff. */
export function addedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      current = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    if (current && line.startsWith('+') && !line.startsWith('+++')) out.get(current)!.push(line.slice(1));
  }
  return out;
}

export interface ForbiddenContext {
  diff: string;
  patch: PatchStats;
  /** Reads a file from the final tree; `null` when absent. */
  readFinal: (path: string) => Promise<string | null>;
  /** Reads a file from the start commit; `null` when absent. */
  readStart: (path: string) => Promise<string | null>;
  /** Lists files in the final tree matching a glob. */
  listFinal: (glob: string) => Promise<string[]>;
}

export async function evaluateForbidden(rules: readonly ForbiddenRule[], ctx: ForbiddenContext): Promise<ValidationResult['forbidden']> {
  const results: ValidationResult['forbidden'] = [];
  for (const rule of rules) {
    switch (rule.kind) {
      case 'path-unchanged': {
        const touched = ctx.patch.changedFiles.filter((file) => rule.paths.some((path) => file === path || matchesGlob(file, path)));
        results.push({ kind: rule.kind, description: rule.description, passed: touched.length === 0, detail: touched.length ? `changed: ${touched.join(', ')}` : '' });
        break;
      }
      case 'file-present': {
        const missing: string[] = [];
        for (const path of rule.paths) if ((await ctx.readFinal(path)) === null) missing.push(path);
        results.push({ kind: rule.kind, description: rule.description, passed: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : '' });
        break;
      }
      case 'pattern-absent': {
        const pattern = new RegExp(rule.pattern, 'm');
        const hits: string[] = [];
        for (const file of await ctx.listFinal(rule.glob)) {
          const content = await ctx.readFinal(file);
          if (content !== null && pattern.test(content)) hits.push(file);
        }
        results.push({ kind: rule.kind, description: rule.description, passed: hits.length === 0, detail: hits.length ? `found in: ${hits.join(', ')}` : '' });
        break;
      }
      case 'pattern-not-added': {
        const pattern = new RegExp(rule.pattern);
        const hits: string[] = [];
        for (const [file, lines] of addedLinesByFile(ctx.diff)) {
          if (!matchesGlob(file, rule.glob)) continue;
          if (lines.some((line) => pattern.test(line))) hits.push(file);
        }
        results.push({ kind: rule.kind, description: rule.description, passed: hits.length === 0, detail: hits.length ? `added in: ${hits.join(', ')}` : '' });
        break;
      }
      case 'manifest-scripts-unchanged': {
        const before = await ctx.readStart(rule.manifestPath);
        const after = await ctx.readFinal(rule.manifestPath);
        const scriptsOf = (content: string | null): string => {
          if (content === null) return 'absent';
          try {
            return JSON.stringify((JSON.parse(content) as { scripts?: unknown }).scripts ?? null);
          } catch {
            return 'unparseable';
          }
        };
        const same = scriptsOf(before) === scriptsOf(after);
        results.push({ kind: rule.kind, description: rule.description, passed: same, detail: same ? '' : `scripts changed in ${rule.manifestPath}` });
        break;
      }
      case 'no-test-deletions': {
        const deleted = ctx.patch.deletedFiles.filter((file) => rule.globs.some((glob) => matchesGlob(file, glob)));
        results.push({ kind: rule.kind, description: rule.description, passed: deleted.length === 0, detail: deleted.length ? `deleted: ${deleted.join(', ')}` : '' });
        break;
      }
    }
  }
  return results;
}

/* ---------------------------------------------------------------- */
/* Failure reasons                                                   */
/* ---------------------------------------------------------------- */

const CHECK_FAILURE: Record<string, FailureReason> = {
  build: 'build_failure',
  typecheck: 'typecheck_failure',
  test: 'existing_test_failure',
  lint: 'lint_failure',
  runtime: 'runtime_failure',
};

export function deriveFailureReasons(input: {
  agentStatus: 'completed' | 'timeout' | 'error' | 'launch-failure' | 'provider-error';
  changedFiles: number;
  dependencyIntegrity: ValidationResult['dependencyIntegrity'];
  checks: ValidationResult['checks'];
  hiddenTests: ValidationResult['hiddenTests'];
  forbidden: ValidationResult['forbidden'];
}): FailureReason[] {
  const reasons = new Set<FailureReason>();
  if (input.agentStatus === 'timeout') reasons.add('timeout');
  if (input.agentStatus === 'error') reasons.add('agent_error');
  if (input.changedFiles === 0) reasons.add('incomplete_fix');
  if (!input.dependencyIntegrity.passed) {
    reasons.add(input.dependencyIntegrity.installSucceeded ? 'dependency_reverted' : 'install_failure');
    if (input.dependencyIntegrity.installSucceeded && input.dependencyIntegrity.details.some((d) => /lockfile/i.test(d))) reasons.add('install_failure');
  }
  for (const check of input.checks) if (!check.passed) reasons.add(CHECK_FAILURE[check.kind] ?? 'existing_test_failure');
  if (input.hiddenTests.some((test) => !test.passed)) reasons.add('hidden_regression_failure');
  if (input.forbidden.some((rule) => !rule.passed)) reasons.add('prohibited_workaround');
  return [...reasons].sort();
}

/* ---------------------------------------------------------------- */
/* The validation run                                                */
/* ---------------------------------------------------------------- */

function outcomeOf(name: string, run: CommandRun): { name: string; passed: boolean; exitCode: number | null; spawnFailed: boolean; timedOut: boolean; durationMs: number; outputExcerpt: string } {
  return {
    name,
    passed: !run.spawnFailed && !run.timedOut && run.code === 0,
    exitCode: run.code,
    spawnFailed: run.spawnFailed,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    outputExcerpt: excerpt(run.output),
  };
}

export async function listFiles(root: string, glob: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === HIDDEN_DIRECTORY) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const rel = relative(root, path).split(sep).join('/');
        if (matchesGlob(rel, glob)) out.push(rel);
      }
    }
  };
  await walk(root);
  return out.sort();
}

export interface ValidationInput {
  agentCase: AgentCase;
  workspace: Workspace;
  hidden: HiddenMaterial;
  agentStatus: 'completed' | 'timeout' | 'error' | 'launch-failure' | 'provider-error';
  diff: string;
  patch: PatchStats;
  onProgress?: (message: string) => void;
}

export async function validateWorkspace(input: ValidationInput): Promise<{ result: ValidationResult; unableToRun: string[] }> {
  const { agentCase, workspace, hidden } = input;
  const env = projectEnv(agentCase);
  const unableToRun: string[] = [];
  const details: string[] = [];

  // A. Dependency integrity.
  const manifestPath = agentCase.workspaceDir ? `${agentCase.workspaceDir}/${agentCase.integrity.manifestPath}` : agentCase.integrity.manifestPath;
  const manifestContent = await readFile(join(workspace.repo, manifestPath), 'utf8').catch(() => null);
  const reading = readManifest(agentCase, manifestContent);
  const specifier = specifierKeepsUpgrade(reading.specifier, agentCase.dependency.fromVersion, agentCase.dependency.toVersion);
  if (!specifier.ok) details.push(`manifest: ${specifier.reason}`);

  input.onProgress?.('validation: install');
  const install = await runCommand(agentCase.commands.install, { cwd: workspace.project, timeoutMs: agentCase.commands.installTimeoutSeconds * 1000, env });
  const installSucceeded = !install.spawnFailed && !install.timedOut && install.code === 0;
  if (install.spawnFailed) unableToRun.push(`install could not be started: ${excerpt(install.output)}`);
  if (!installSucceeded && !install.spawnFailed) details.push(`install failed (${agentCase.integrity.lockfilePath ? 'lockfile invalid or out of sync' : 'exit ' + install.code}): ${excerpt(install.output).slice(0, 600)}`);

  let installedVersion: string | null = null;
  if (installSucceeded) {
    const probe = await runCommand(agentCase.commands.installedVersion, { cwd: workspace.project, timeoutMs: 120_000, env });
    if (probe.spawnFailed) unableToRun.push(`installed-version probe could not be started: ${excerpt(probe.output)}`);
    else if (probe.code === 0) installedVersion = probe.output.trim().split('\n').pop()?.trim() ?? null;
    else details.push(`installed-version probe failed: ${excerpt(probe.output).slice(0, 300)}`);
    if (installedVersion !== null && installedVersion !== agentCase.dependency.toVersion) {
      details.push(`installed version is ${installedVersion}, expected ${agentCase.dependency.toVersion}`);
    }
  }
  const dependencyIntegrity: ValidationResult['dependencyIntegrity'] = {
    passed: specifier.ok && installSucceeded && installedVersion === agentCase.dependency.toVersion,
    declaredSpecifier: reading.specifier,
    installedVersion,
    installSucceeded,
    details,
  };

  // B. The project's own checks. Only meaningful on an installed tree.
  const checks: ValidationResult['checks'] = [];
  for (const check of agentCase.commands.checks) {
    input.onProgress?.(`validation: ${check.name}`);
    const run = installSucceeded
      ? await runCommand(check.command, { cwd: workspace.project, timeoutMs: check.timeoutSeconds * 1000, env })
      : { code: null, spawnFailed: false, timedOut: false, durationMs: 0, output: 'not run: install failed' };
    if (run.spawnFailed) unableToRun.push(`check "${check.name}" could not be started: ${excerpt(run.output)}`);
    checks.push({ ...outcomeOf(check.name, run), kind: check.kind });
  }

  // C. Hidden tests, staged only now.
  const hiddenTests: ValidationResult['hiddenTests'] = [];
  const hiddenRoot = join(workspace.repo, HIDDEN_DIRECTORY);
  try {
    for (const test of hidden.tests) {
      input.onProgress?.(`validation: hidden ${test.id}`);
      for (const [path, content] of Object.entries(test.files)) {
        const target = join(workspace.repo, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
      const run = installSucceeded
        ? await runCommand(test.command, { cwd: workspace.project, timeoutMs: test.timeoutSeconds * 1000, env })
        : { code: null, spawnFailed: false, timedOut: false, durationMs: 0, output: 'not run: install failed' };
      if (run.spawnFailed) unableToRun.push(`hidden test "${test.id}" could not be started: ${excerpt(run.output)}`);
      hiddenTests.push({ ...outcomeOf(test.id, run), id: test.id, description: test.description });
    }
  } finally {
    await rm(hiddenRoot, { recursive: true, force: true });
  }

  // D. Case-specific rules.
  const forbidden = await evaluateForbidden(hidden.forbidden, {
    diff: input.diff,
    patch: input.patch,
    readFinal: (path) => readFile(join(workspace.repo, path), 'utf8').catch(() => null),
    readStart: (path) => gitShow(workspace.repo, workspace.startCommit, path),
    listFinal: (glob) => listFiles(workspace.repo, glob),
  });

  const failureReasons = deriveFailureReasons({
    agentStatus: input.agentStatus,
    changedFiles: input.patch.files,
    dependencyIntegrity,
    checks,
    hiddenTests,
    forbidden,
  });

  const success =
    unableToRun.length === 0 &&
    input.agentStatus === 'completed' &&
    failureReasons.length === 0 &&
    hiddenTests.length > 0 &&
    hiddenTests.every((test) => test.passed);

  return { result: { dependencyIntegrity, checks, hiddenTests, forbidden, success, failureReasons }, unableToRun };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
