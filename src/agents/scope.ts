import { execFile } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CommitUnit, RemediationPlan } from '../types.js';
import { matchesAny as matchesGlob } from '../util/glob.js';

const run = promisify(execFile);

export const DEFAULT_PROTECTED_PATHS = [
  '.git/**',
  '.github/workflows/**',
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  'secrets/**',
  '**/secrets/**',
  'node_modules/**',
  'extension/node_modules/**',
];

const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_CHANGED_LINES = 2000;

export type ChangedPathStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedPath {
  path: string;
  status: ChangedPathStatus;
  oldPath?: string;
}

export interface ScopeValidationOptions {
  root: string;
  baselineRef: string;
  commit: CommitUnit;
  protectedPaths?: readonly string[];
  maxFiles?: number;
  maxChangedLines?: number;
  forbidTestWeakening?: boolean;
  /**
   * Packages this remediation upgraded. An edit to their manifest entries is
   * a revert or a downgrade, whatever else the agent changed with it.
   */
  upgradedDependencies?: readonly string[];
}

export interface ScopeValidationResult {
  ok: boolean;
  changed: ChangedPath[];
  patch: string;
  reasons: string[];
  warnings: string[];
}

export interface CloudScopeValidationOptions {
  plan: RemediationPlan;
  changedFiles: readonly string[];
  protectedPaths?: readonly string[];
  maxFiles?: number;
}

export interface CloudScopeValidationResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

export function validateCloudChangedFiles(options: CloudScopeValidationOptions): CloudScopeValidationResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const protectedPaths = options.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const allowed = new Set(
    options.plan.commits.flatMap((commit) => (commit.allowedFiles?.length ? commit.allowedFiles : commit.files)).map(normalizePlanPath),
  );

  if (options.changedFiles.length > (options.maxFiles ?? DEFAULT_MAX_FILES)) {
    reasons.push(`Agent changed ${options.changedFiles.length} files, above the limit of ${options.maxFiles ?? DEFAULT_MAX_FILES}.`);
  }

  for (const file of options.changedFiles) {
    const normalized = normalizePlanPath(file);
    if (!normalized || normalized !== file.replace(/^\.\//, '').replace(/\\/g, '/')) {
      reasons.push(`Agent produced an invalid path: ${file}.`);
      continue;
    }
    if (!allowed.has(normalized)) reasons.push(`Agent changed ${normalized}, which is outside the remediation plan's allowed files.`);
    if (matchesAny(protectedPaths, normalized)) reasons.push(`Agent changed protected path ${normalized}.`);
    if (isWorkflow(normalized) && !allowed.has(normalized)) {
      reasons.push(`Agent changed workflow path ${normalized} without an explicit file grant.`);
    }
    if (isLockfile(normalized) && !allowed.has(normalized)) {
      reasons.push(`Agent changed lockfile ${normalized} without an explicit file grant.`);
    }
  }

  warnings.push(
    'Cloud reconciliation validates changed paths after the provider writes them; it cannot provide the pre-commit transactional guarantee used for local runner agents.',
  );

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)] };
}

export async function validateAgentWorktree(
  options: ScopeValidationOptions,
): Promise<ScopeValidationResult> {
  const changed = await changedPaths(options.root);
  const patch = await diff(options.root, options.baselineRef);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const allowed = new Set((options.commit.allowedFiles?.length ? options.commit.allowedFiles : options.commit.files).map(normalizePlanPath));
  const protectedPaths = options.protectedPaths ?? DEFAULT_PROTECTED_PATHS;

  if (changed.length > (options.maxFiles ?? DEFAULT_MAX_FILES)) {
    reasons.push(`Agent changed ${changed.length} files, above the limit of ${options.maxFiles ?? DEFAULT_MAX_FILES}.`);
  }

  const changedLines = await changedLineCount(options.root, options.baselineRef, changed);
  if (changedLines > (options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES)) {
    reasons.push(`Agent changed ${changedLines} lines, above the limit of ${options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES}.`);
  }

  for (const entry of changed) {
    for (const path of [entry.oldPath, entry.path].filter((p): p is string => Boolean(p))) {
      const normalized = normalizePlanPath(path);
      if (!normalized || normalized !== path.replace(/^\.\//, '').replace(/\\/g, '/')) {
        reasons.push(`Agent produced an invalid path: ${path}.`);
        continue;
      }
      if (!allowed.has(normalized)) {
        reasons.push(`Agent changed ${normalized}, which is outside this unit's allowed files.`);
      }
      if (matchesAny(protectedPaths, normalized)) {
        reasons.push(`Agent changed protected path ${normalized}.`);
      }
      if (isWorkflow(normalized) && !allowed.has(normalized)) {
        reasons.push(`Agent changed workflow path ${normalized} without an explicit file grant.`);
      }
      if (isLockfile(normalized) && !allowed.has(normalized)) {
        reasons.push(`Agent changed lockfile ${normalized} without an explicit file grant.`);
      }
    }

    const symlink = await symlinkProblem(options.root, entry.path);
    if (symlink) reasons.push(symlink);
  }

  for (const secret of secretFindings(patch, await untrackedContents(options.root, changed))) {
    reasons.push(secret);
  }

  if (options.forbidTestWeakening ?? true) {
    const weakening = testWeakeningFindings(patch, changed);
    reasons.push(...weakening.errors);
    warnings.push(...weakening.warnings);
    reasons.push(...workaroundFindings(patch, changed));
  }

  if (options.upgradedDependencies?.length) {
    reasons.push(...upgradedDependencyFindings(patch, options.upgradedDependencies));
  }

  for (const entry of changed) {
    if (await isSubmoduleChange(options.root, entry.path)) {
      reasons.push(`Agent changed submodule ${entry.path} without explicit authorization.`);
    }
  }

  return { ok: reasons.length === 0, changed, patch, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)] };
}

export interface UpgradeFixOffender {
  path: string;
  oldPath?: string;
  reasons: string[];
}

export interface UpgradeFixValidation {
  changed: ChangedPath[];
  /** Files whose own change breaks a rule. Revert these; keep the rest. */
  offenders: UpgradeFixOffender[];
  warnings: string[];
}

/**
 * Validate a whole-upgrade fix one file at a time.
 *
 * `validateAgentWorktree` judges a commit unit as a whole and rejects it as a
 * whole, which is right when the unit is a handful of lines Drift planned and
 * wrong for an agent fixing an entire upgrade: measured on ten real upgrades,
 * an agent that also touched a CI workflow had every correct source edit it
 * made thrown away with it. So each changed file is checked against its own
 * diff — protected paths, secrets, symlinks, submodules, weakened tests and
 * configuration, a reverted or downgraded dependency — and only the files
 * that break a rule are returned, for the caller to revert. There is no file
 * list to stay inside: the job is the upgrade, and scope is what the rules
 * above forbid rather than what Drift happened to localize.
 */
export async function validateUpgradeFix(options: {
  root: string;
  baselineRef: string;
  protectedPaths?: readonly string[];
  upgradedDependencies?: readonly string[];
}): Promise<UpgradeFixValidation> {
  const changed = await changedPaths(options.root);
  const sections = patchSections(await diff(options.root, options.baselineRef));
  const protectedPaths = options.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const offenders: UpgradeFixOffender[] = [];
  const warnings: string[] = [];

  for (const entry of changed) {
    const reasons: string[] = [];
    for (const path of [entry.oldPath, entry.path].filter((p): p is string => Boolean(p))) {
      const normalized = normalizePlanPath(path);
      if (!normalized) reasons.push(`Agent produced an invalid path: ${path}.`);
      else if (matchesAny(protectedPaths, normalized)) reasons.push(`Agent changed protected path ${normalized}.`);
    }
    const symlink = await symlinkProblem(options.root, entry.path);
    if (symlink) reasons.push(symlink);
    if (await isSubmoduleChange(options.root, entry.path)) {
      reasons.push(`Agent changed submodule ${entry.path} without explicit authorization.`);
    }

    const filePatch = sections.get(entry.path) ?? '';
    reasons.push(...secretFindings(filePatch, await untrackedContents(options.root, [entry])));
    const weakening = testWeakeningFindings(filePatch, [entry]);
    reasons.push(...weakening.errors);
    warnings.push(...weakening.warnings);
    reasons.push(...workaroundFindings(filePatch, [entry]));
    if (options.upgradedDependencies?.length) reasons.push(...upgradedDependencyFindings(filePatch, options.upgradedDependencies));

    if (reasons.length > 0) {
      offenders.push({ path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), reasons: [...new Set(reasons)] });
    }
  }

  return { changed, offenders, warnings: [...new Set(warnings)] };
}

/** A combined patch split into one full section per file, headers kept, keyed by the file's new path. */
function patchSections(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  let path: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (path) sections.set(path, lines.join('\n'));
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git a/')) {
      flush();
      const at = line.lastIndexOf(' b/');
      path = at >= 0 ? line.slice(at + 3) : line.slice('diff --git a/'.length);
      lines = [line];
      continue;
    }
    if (path) lines.push(line);
  }
  flush();
  return sections;
}

export async function changedPaths(root: string): Promise<ChangedPath[]> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const tokens = out.split('\0').filter(Boolean);
  const entries: ChangedPath[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    const path = normalizePlanPath(token.slice(3));
    if (!path) continue;

    if (xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C') {
      const oldPath = normalizePlanPath(tokens[++i] ?? '');
      entries.push({ path, oldPath: oldPath || undefined, status: 'renamed' });
      continue;
    }

    if (xy === '??') entries.push({ path, status: 'untracked' });
    else if (xy.includes('D')) entries.push({ path, status: 'deleted' });
    else if (xy.includes('A')) entries.push({ path, status: 'added' });
    else entries.push({ path, status: 'modified' });
  }

  return entries;
}

export function normalizePlanPath(input: string): string {
  const path = input.replace(/^\.\//, '').replace(/\\/g, '/').trim();
  if (!path || path.startsWith('/') || path.includes('\0')) return '';
  const parts = path.split('/');
  if (parts.some((part) => part === '..' || part === '.')) return '';
  return parts.join('/');
}

export function testWeakeningFindings(
  patch: string,
  changed: readonly ChangedPath[],
): { errors: string[]; warnings: string[] } {
  const testFiles = new Set(
    changed
      .flatMap((entry) => [entry.path, entry.oldPath].filter((p): p is string => Boolean(p)))
      .filter(isTestPath),
  );
  if (testFiles.size === 0) return { errors: [], warnings: [] };

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (/^\+.*\b(describe|it|test)\.skip\s*\(/.test(line) || /^\+.*\b(skip|todo)\s*:\s*true\b/.test(line)) {
      errors.push('Agent added a skipped or todo test while test weakening is forbidden.');
    }

    if (/^-.*\b(describe|it|test)\s*\(/.test(line)) {
      warnings.push('Agent changed test structure; review is required for behavioural migrations.');
    }
  }

  // Fewer assertions in a test file is weakening. A rewritten assertion — the
  // same check against the migrated API, which a real migration of a test file
  // is made of — removes one line and adds one, and is not. This used to reject
  // any removed assertion line, which threw out correct test migrations.
  for (const [file, lines] of patchByFile(patch)) {
    if (!isTestPath(file)) continue;
    const removed = lines.filter((line) => /^-.*\b(assert|expect)\b/.test(line)).length;
    const added = lines.filter((line) => /^\+.*\b(assert|expect)\b/.test(line)).length;
    if (removed > added) errors.push(`Agent removed an assertion while test weakening is forbidden (${file}: ${removed} removed, ${added} added).`);
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/**
 * Ways to make a check pass without fixing anything that live outside test
 * files: a deleted test file, a lowered coverage threshold, a compiler
 * strictness flag switched off.
 *
 * `testWeakeningFindings` only looks inside test files, and these are exactly
 * the edits an agent under pressure from a red check reaches for — lowering
 * `coverageThreshold` in `jest.config.js` was the single most common failure
 * in Drift's own agent benchmark, in every condition.
 */
export function workaroundFindings(patch: string, changed: readonly ChangedPath[]): string[] {
  const errors: string[] = [];
  for (const entry of changed) {
    if (entry.status === 'deleted' && isTestPath(entry.path)) errors.push(`Agent deleted test file ${entry.path}.`);
  }

  for (const [file, lines] of patchByFile(patch)) {
    const removed = new Map<string, number>();
    for (const line of lines) {
      const threshold = /^-.*\b(branches|functions|lines|statements)\b['"]?\s*:\s*(\d+(?:\.\d+)?)/.exec(line);
      if (threshold) removed.set(threshold[1]!, Number(threshold[2]));
    }
    for (const line of lines) {
      const threshold = /^\+.*\b(branches|functions|lines|statements)\b['"]?\s*:\s*(\d+(?:\.\d+)?)/.exec(line);
      if (threshold && removed.has(threshold[1]!) && Number(threshold[2]) < removed.get(threshold[1]!)!) {
        errors.push(`Agent lowered the ${threshold[1]} coverage threshold in ${file}.`);
      }
      if (/^-.*coverageThreshold/.test(line) && !lines.some((other) => /^\+.*coverageThreshold/.test(other))) {
        errors.push(`Agent removed the coverage threshold in ${file}.`);
      }
    }

    // Suppression directives silence a check at the line it complains about.
    // In source, a type-check suppression that is new or reworded is not a
    // migration (a pure move leaves an identical removed line); in tests, only
    // more of them counts. A lint or coverage suppression may be renamed —
    // ESLint 10's own migration renames rules inside existing comments — but
    // not multiplied outside tests.
    const typeDirective = /@ts-(?:ignore|expect-error|nocheck)\b/;
    const lintDirective = /eslint-disable|istanbul ignore|c8 ignore|v8 ignore|#\s*type:\s*ignore|#\s*noqa|NOLINT/;
    const removedText = new Set(lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1).trim()));
    const count = (sign: string, pattern: RegExp) => lines.filter((line) => line.startsWith(sign) && pattern.test(line)).length;
    if (isTestPath(file)) {
      if (count('+', typeDirective) > count('-', typeDirective)) errors.push(`Agent added a type-check suppression in ${file}.`);
    } else if (SOURCE_EXTENSION.test(file)) {
      if (lines.some((line) => line.startsWith('+') && typeDirective.test(line) && !removedText.has(line.slice(1).trim()))) {
        errors.push(`Agent added or changed a type-check suppression (@ts-ignore/@ts-expect-error/@ts-nocheck) in ${file}.`);
      }
      if (count('+', lintDirective) > count('-', lintDirective)) errors.push(`Agent added a lint or coverage suppression in ${file}.`);
    }

    if (/(^|\/)tsconfig[\w.-]*\.json$/.test(file)) {
      for (const flag of ['strict', 'noImplicitAny', 'strictNullChecks', 'noImplicitReturns', 'noUnusedLocals', 'noUnusedParameters']) {
        const wasOn = lines.some((line) => new RegExp(`^-.*"${flag}"\\s*:\\s*true`).test(line));
        const nowOff = lines.some((line) => new RegExp(`^\\+.*"${flag}"\\s*:\\s*false`).test(line));
        const dropped = wasOn && !lines.some((line) => new RegExp(`^\\+.*"${flag}"\\s*:\\s*true`).test(line));
        if (nowOff || dropped) errors.push(`Agent relaxed \`${flag}\` in ${file}.`);
      }
    }
  }
  return [...new Set(errors)];
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|rb|php|cs|swift|scala)$/;

/** Any manifest line naming an upgraded dependency that was changed. */
export function upgradedDependencyFindings(patch: string, dependencies: readonly string[]): string[] {
  const errors: string[] = [];
  for (const [file, lines] of patchByFile(patch)) {
    if (!isManifest(file)) continue;
    for (const dependency of dependencies) {
      const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const named = new RegExp(`^[-+](?![-+])(?:.*["'\`]${escaped}["'\`]|\\s*${escaped}\\s*(?:[=<>~!^\\[;]|$))`);
      if (lines.some((line) => named.test(line))) {
        errors.push(`Agent changed the declaration of upgraded dependency ${dependency} in ${file}.`);
      }
    }
  }
  return [...new Set(errors)];
}

export function isProtectedPath(path: string, patterns: readonly string[] = DEFAULT_PROTECTED_PATHS): boolean {
  const normalized = normalizePlanPath(path);
  return !normalized || matchesAny(patterns, normalized) || isWorkflow(normalized);
}

export function isManifest(path: string): boolean {
  return /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|setup\.py|Pipfile|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|[\w.-]+\.csproj|pubspec\.yaml|mix\.exs)$/.test(path);
}

function patchByFile(patch: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git a/')) {
      // String search, not a regex: `a\/(.+?) b\/(.+)` backtracks polynomially
      // on a header repeating ' b/'. A renamed path keeps its new name after
      // the last ' b/'.
      const at = line.lastIndexOf(' b/');
      current = [];
      files.set(at >= 0 ? line.slice(at + 3) : line.slice('diff --git a/'.length), current);
      continue;
    }
    if (!current || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+') || line.startsWith('-')) current.push(line);
  }
  return files;
}

async function diff(root: string, ref: string): Promise<string> {
  const tracked = await git(root, ['diff', '--find-renames', ref]);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);
  const additions: string[] = [];
  for (const path of untracked.split('\n').map(normalizePlanPath).filter(Boolean)) {
    const content = await readText(resolve(root, path));
    additions.push([`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, ...content.split('\n').map((line) => `+${line}`)].join('\n'));
  }
  return [tracked, ...additions].filter((part) => part.trim()).join('\n');
}

async function changedLineCount(root: string, ref: string, changed: readonly ChangedPath[]): Promise<number> {
  const out = await git(root, ['diff', '--numstat', ref]);
  let total = 0;
  for (const line of out.split('\n')) {
    const [added, removed] = line.split('\t');
    total += parseNumstat(added) + parseNumstat(removed);
  }
  for (const entry of changed) {
    if (entry.status !== 'untracked' && entry.status !== 'added') continue;
    const content = await readText(resolve(root, entry.path));
    total += content.split('\n').length;
  }
  return total;
}

function parseNumstat(value: string | undefined): number {
  if (!value || value === '-') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function symlinkProblem(root: string, path: string): Promise<string | null> {
  const absolute = resolve(root, path);
  if (!isInside(root, absolute)) return `Agent path escapes the worktree: ${path}.`;

  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return `Agent changed symlink ${path}; symlink edits are not accepted automatically.`;
  } catch {
    return null;
  }

  const parent = resolve(root, dirname(path));
  try {
    const realRoot = await realpath(root);
    const realParent = await realpath(parent);
    if (!isInside(realRoot, realParent)) return `Agent path escapes the worktree: ${path}.`;
  } catch {
    return null;
  }
  return null;
}

async function isSubmoduleChange(root: string, path: string): Promise<boolean> {
  const out = await git(root, ['ls-files', '-s', '--', path]).catch(() => '');
  return out.split('\n').some((line) => line.startsWith('160000 '));
}

async function untrackedContents(root: string, changed: readonly ChangedPath[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of changed) {
    if (entry.status !== 'untracked' && entry.status !== 'added') continue;
    out.push(await readText(resolve(root, entry.path)));
  }
  return out;
}

function secretFindings(patch: string, untracked: readonly string[]): string[] {
  const findings: string[] = [];
  const candidates = [
    ...patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1)),
    ...untracked.flatMap((content) => content.split('\n')),
  ];

  for (const line of candidates) {
    if (/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)) findings.push('Agent added material that looks like a private key.');
    if (/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][^'"]{12,}/i.test(line)) {
      findings.push('Agent added material that looks like a secret value.');
    }
  }
  return [...new Set(findings)];
}

function isWorkflow(path: string): boolean {
  return path.startsWith('.github/workflows/');
}

export function isLockfile(path: string): boolean {
  return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Pipfile\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|conan\.lock|packages\.lock\.json|mix\.lock|pubspec\.lock|Podfile\.lock)$/.test(path);
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/**
 * The shared matcher. This file used to carry its own glob conversion, which
 * rewrote `**` to `.*` and then rewrote that `*` again to `[^/]*` — so every
 * `dir/**` protected path guarded one level only: `node_modules/x/index.d.ts`
 * and `.github/workflows/sub/ci.yml` were editable.
 */
function matchesAny(patterns: readonly string[], path: string): boolean {
  return matchesGlob(patterns.map(normalizePlanPath), path);
}

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}
