import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { execCommand, type Exec } from '../util/exec.js';
import type { VerificationFailure } from './verifier.js';

/**
 * What the project's checks cover, measured with the project's own tools.
 *
 * A check that passes because it checks less is the failure a controller
 * cannot see from exit codes. In the controller's development run, a repair
 * session migrated ESLint 8 → 10 by writing a flat config without the
 * recommended rule sets — `npm run lint` passed, and the project's rules no
 * longer ran. Lint rules, linted files, discovered tests and compiler
 * strictness are measured at the pre-upgrade commit and again when the checks
 * pass; anything that shrank is a verification failure, attributed to the
 * configuration file that controls it, so the loop repairs it instead of
 * reporting success.
 *
 * Each probe asks the installed tool itself — ESLint's `calculateConfigForFile`
 * and `isPathIgnored`, `jest --listTests`, TypeScript's config parser — so a
 * change of configuration *format* (`.eslintrc` to a flat config) compares what
 * is enforced, not how it is written. Legitimate upstream changes are
 * tolerated: a rule the new version removed or deprecated, a rule that moved
 * to another plugin namespace under the same name, and a handful of rules that
 * left a recommended set. A probe that cannot run measures nothing and
 * reports nothing.
 */

export interface EslintCoverage {
  sampleFile: string | null;
  /** Rule → severity (0 off, 1 warn, 2 error) for the sample file. */
  rules: Record<string, number>;
  /** Tracked source files under the lint targets that ESLint does not ignore. */
  lintedFiles: string[];
  /** Existence of the rules asked about, in the installed ESLint and plugins. `null` when unknown. */
  known: Record<string, { exists: boolean; deprecated: boolean } | null>;
  /** Rules a loaded plugin's shipped presets switch off as covered elsewhere. Absent on older inventories. */
  supersededOff?: string[];
  configFile: string | null;
}

export interface TscCoverage {
  /** tsconfig path → effective strictness flags and the number of project source files. */
  configs: Record<string, { strict: Record<string, boolean>; files: string[] }>;
}

export interface CoverageInventory {
  eslint: EslintCoverage | null;
  jest: { tests: string[]; configFile: string | null } | null;
  tsc: TscCoverage | null;
}

export interface CoverageOptions {
  /** Git root. */
  root: string;
  /** Workspace member directory, relative to `root`. */
  dir?: string;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  /** From the baseline, so both sides measure the same file and the same rules. */
  reference?: CoverageInventory | null;
  /** Lint targets and tsconfig paths, taken from the baseline's scripts so a changed script cannot move them. */
  lintTargets?: readonly string[];
  tsconfigs?: readonly string[];
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const STRICT_FLAGS = [
  'strict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization',
  'noImplicitThis', 'useUnknownInCatchVariables', 'alwaysStrict', 'noUnusedLocals', 'noUnusedParameters', 'noImplicitReturns',
  'noFallthroughCasesInSwitch', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitOverride',
];
/** Rules that may leave a recommended set between major versions before it counts as weakening. */
const MISSING_RULE_TOLERANCE = 4;

/** Lint targets and tsconfig paths named in a package.json's scripts. */
export async function coverageTargets(root: string, dir = ''): Promise<{ lintTargets: string[]; tsconfigs: string[] }> {
  const cwd = dir ? join(root, dir) : root;
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // No manifest: nothing named.
  }
  const lintTargets = new Set<string>();
  const tsconfigs = new Set<string>();
  for (const body of Object.values(scripts)) {
    for (const segment of body.split(/&&|\|\||;/)) {
      const words = segment.trim().split(/\s+/);
      const eslintAt = words.findIndex((word) => word === 'eslint' || word.endsWith('/eslint'));
      if (eslintAt >= 0) {
        for (let i = eslintAt + 1; i < words.length; i += 1) {
          const word = words[i]!;
          if (word.startsWith('-')) {
            if (['--ext', '-c', '--config', '--rulesdir', '--resolve-plugins-relative-to', '--ignore-path', '-f', '--format', '-o', '--output-file', '--cache-location', '--max-warnings'].includes(word)) i += 1;
            continue;
          }
          lintTargets.add(word.replace(/^['"]|['"]$/g, '').replace(/\/$/, ''));
        }
      }
      const tscAt = words.findIndex((word) => word === 'tsc' || word.endsWith('/tsc'));
      if (tscAt >= 0) {
        const projectAt = words.findIndex((word, i) => i > tscAt && (word === '-p' || word === '--project'));
        tsconfigs.add(projectAt >= 0 && words[projectAt + 1] ? words[projectAt + 1]! : 'tsconfig.json');
      }
    }
  }
  return { lintTargets: [...lintTargets], tsconfigs: [...tsconfigs] };
}

export async function measureCoverage(options: CoverageOptions): Promise<CoverageInventory> {
  const exec = options.exec ?? execCommand;
  const cwd = options.dir ? join(options.root, options.dir) : options.root;
  const tracked = await trackedSourceFiles(options.root, options.dir ?? '', exec);
  const [eslint, jest, tsc] = await Promise.all([
    probeEslint(cwd, tracked, options, exec),
    probeJest(cwd, exec, options.env),
    probeTsc(cwd, options, exec),
  ]);
  return { eslint, jest, tsc };
}

/**
 * What the after-inventory no longer covers. Each finding is a verification
 * failure on the configuration file, with a message saying what was lost.
 */
export function coverageWeakening(before: CoverageInventory, after: CoverageInventory, cwd: string): VerificationFailure[] {
  const failures: VerificationFailure[] = [];

  if (before.eslint && after.eslint) {
    const file = after.eslint.configFile ?? before.eslint.configFile ?? undefined;
    const downgraded: string[] = [];
    const missing: string[] = [];
    for (const [rule, severity] of Object.entries(before.eslint.rules)) {
      if (severity < 1) continue;
      const known = after.eslint.known[rule];
      if (known && (!known.exists || known.deprecated)) continue;
      const now = after.eslint.rules[rule] ?? sameNamedRule(after.eslint.rules, rule);
      if (now === undefined) {
        if (severity === 2) missing.push(rule);
      } else if (now < severity && !(now === 0 && after.eslint.supersededOff?.includes(rule))) {
        downgraded.push(`${rule} (${label(severity)} → ${label(now)})`);
      }
    }
    if (downgraded.length > 0) {
      failures.push(coverageFailure('eslint', file, `the lint configuration enforces ${downgraded.length} rule(s) less strictly than before the upgrade: ${downgraded.slice(0, 12).join(', ')}`));
    }
    if (missing.length > MISSING_RULE_TOLERANCE) {
      failures.push(coverageFailure('eslint', file, `the lint configuration no longer enables ${missing.length} rule(s) that were errors before the upgrade (for example ${missing.slice(0, 12).join(', ')}); a recommended set or plugin was probably dropped rather than migrated`));
    }
    const nowIgnored = before.eslint.lintedFiles.filter((path) => !after.eslint!.lintedFiles.includes(path) && existsSync(join(cwd, path)));
    if (nowIgnored.length > 0) {
      failures.push(coverageFailure('eslint', file, `the linter no longer checks ${nowIgnored.length} file(s) it checked before the upgrade: ${nowIgnored.slice(0, 10).join(', ')}`));
    }
  }

  if (before.jest && after.jest) {
    const lost = before.jest.tests.filter((path) => !after.jest!.tests.includes(path) && existsSync(join(cwd, path)));
    if (lost.length > 0) {
      failures.push(coverageFailure('jest', after.jest.configFile ?? before.jest.configFile ?? undefined, `the test runner no longer runs ${lost.length} test file(s) it ran before the upgrade: ${lost.slice(0, 10).join(', ')}`));
    }
  }

  if (before.tsc && after.tsc) {
    for (const [config, was] of Object.entries(before.tsc.configs)) {
      const now = after.tsc.configs[config];
      if (!now) continue;
      const relaxed = STRICT_FLAGS.filter((flag) => was.strict[flag] && !now.strict[flag]);
      if (relaxed.length > 0) failures.push(coverageFailure('tsc', config, `the compiler configuration ${config} no longer enables ${relaxed.join(', ')}`));
      const dropped = was.files.filter((path) => !now.files.includes(path) && existsSync(join(cwd, path)));
      if (dropped.length > 0) failures.push(coverageFailure('tsc', config, `the compiler configuration ${config} no longer includes ${dropped.length} file(s) it compiled before the upgrade: ${dropped.slice(0, 10).join(', ')}`));
    }
  }

  return failures;
}

export const COVERAGE_CHECK_LABEL = 'coverage (what the checks enforce)';

function coverageFailure(tool: string, file: string | undefined, message: string): VerificationFailure {
  return {
    check: COVERAGE_CHECK_LABEL,
    signature: `${COVERAGE_CHECK_LABEL}|${tool}|${message.replace(/\d+/g, 'n').slice(0, 120)}`,
    message: `Weakened ${tool} coverage: ${message}. Migrate the configuration so it enforces what it did before; do not make the check pass by checking less.`,
    ...(file ? { file } : {}),
  };
}

function sameNamedRule(rules: Record<string, number>, rule: string): number | undefined {
  // `rulesdir/no-unsafe-execa` → `local/no-unsafe-execa`: a local rule moved to another plugin namespace.
  const base = rule.split('/').pop()!;
  if (!rule.includes('/')) return undefined;
  const match = Object.entries(rules).find(([name]) => name.includes('/') && name.split('/').pop() === base);
  return match?.[1];
}

function label(severity: number): string {
  return severity === 2 ? 'error' : severity === 1 ? 'warn' : 'off';
}

async function trackedSourceFiles(root: string, dir: string, exec: Exec): Promise<string[]> {
  const listed = await exec('git', ['ls-files', '--', dir || '.'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (listed.code !== 0) return [];
  return listed.stdout
    .split('\n')
    .filter((path) => SOURCE_FILE.test(path) && !path.includes('node_modules/'))
    .map((path) => (dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path))
    .slice(0, 3000);
}

/**
 * Probe output is one line prefixed with this marker. Loading a project's
 * configuration runs the project's code, which can print anything — the
 * ESLint 10 case's rules plugin runs its own test file and prints "All tests
 * passed!" — so the rest of stdout is ignored.
 */
const PROBE_MARK = '__DRIFT_COVERAGE__';

function probeResult<T>(stdout: string): T | null {
  const line = stdout.split('\n').reverse().find((candidate) => candidate.startsWith(PROBE_MARK));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(PROBE_MARK.length)) as T | null;
  } catch {
    return null;
  }
}

const ESLINT_PROBE = `
const MARK = '${PROBE_MARK}';
const { createRequire } = require('module');
const path = require('path');
const req = createRequire(path.join(process.cwd(), 'package.json'));
(async () => {
  let mod;
  try { mod = req('eslint'); } catch { process.stdout.write('\\n' + MARK + 'null\\n'); return; }
  const Klass = typeof mod.loadESLint === 'function' ? await mod.loadESLint() : mod.ESLint;
  const eslint = new Klass({ cwd: process.cwd() });
  const files = JSON.parse(process.env.DRIFT_FILES || '[]');
  const linted = [];
  for (const file of files) {
    try { if (!(await eslint.isPathIgnored(file))) linted.push(file); } catch {}
  }
  const sample = process.env.DRIFT_SAMPLE || linted.find((f) => /\\.tsx?$/.test(f)) || linted[0] || null;
  const rules = {};
  if (sample) {
    try {
      const config = await eslint.calculateConfigForFile(sample);
      for (const [name, value] of Object.entries((config && config.rules) || {})) {
        const s = Array.isArray(value) ? value[0] : value;
        rules[name] = s === 'error' || s === 2 ? 2 : s === 'warn' || s === 1 ? 1 : 0;
      }
    } catch {}
  }
  let builtin = null;
  try { builtin = req('eslint/use-at-your-own-risk').builtinRules; } catch {}
  const known = {};
  for (const name of JSON.parse(process.env.DRIFT_RULES || '[]')) {
    try {
      if (!name.includes('/')) {
        const def = builtin ? builtin.get(name) : undefined;
        known[name] = builtin ? { exists: Boolean(def), deprecated: Boolean(def && def.meta && def.meta.deprecated) } : null;
        continue;
      }
      const parts = name.split('/');
      const rule = parts.pop();
      const prefix = parts.join('/');
      const candidates = prefix.startsWith('@')
        ? (prefix.includes('/') ? [prefix.replace(/^(@[^/]+)\\/(.+)$/, '$1/eslint-plugin-$2')] : [prefix + '/eslint-plugin'])
        : ['eslint-plugin-' + prefix];
      let plugin = null;
      for (const candidate of candidates) { try { plugin = req(candidate); break; } catch {} }
      const table = plugin && (plugin.rules || (plugin.default && plugin.default.rules));
      if (!table) { known[name] = null; continue; }
      const def = table[rule];
      known[name] = { exists: Boolean(def), deprecated: Boolean(def && def.meta && def.meta.deprecated) };
    } catch { known[name] = null; }
  }
  // Rules a loaded plugin's own shipped presets switch off because something
  // else now covers them (typescript-eslint turns off no-class-assign, no-with,
  // no-undef … in favour of the compiler). Switching one off follows the plugin.
  const supersededOff = new Set();
  const scan = (config) => {
    if (!config || typeof config !== 'object') return;
    if (Array.isArray(config)) { config.forEach(scan); return; }
    for (const [rule, value] of Object.entries(config.rules || {})) {
      const s = Array.isArray(value) ? value[0] : value;
      if (s === 'off' || s === 0) supersededOff.add(rule);
    }
    if (config.overrides) scan(config.overrides);
  };
  const prefixes = new Set(Object.keys(rules).filter((r) => r.includes('/')).map((r) => r.split('/').slice(0, -1).join('/')));
  const pluginNames = new Set(['typescript-eslint']);
  for (const prefix of prefixes) {
    if (prefix.startsWith('@')) pluginNames.add(prefix.includes('/') ? prefix.replace(/^(@[^/]+)\\/(.+)$/, '$1/eslint-plugin-$2') : prefix + '/eslint-plugin');
    else pluginNames.add('eslint-plugin-' + prefix);
  }
  for (const name of pluginNames) {
    try {
      const plugin = req(name);
      for (const config of Object.values(plugin.configs || (plugin.default && plugin.default.configs) || {})) scan(config);
    } catch {}
  }
  process.stdout.write('\\n' + MARK + JSON.stringify({ sampleFile: sample, rules, lintedFiles: linted, known, supersededOff: [...supersededOff] }) + '\\n');
})().catch(() => process.stdout.write('\\n' + MARK + 'null\\n'));
`;

async function probeEslint(cwd: string, tracked: readonly string[], options: CoverageOptions, exec: Exec): Promise<EslintCoverage | null> {
  if (!existsSync(join(cwd, 'node_modules', 'eslint'))) return null;
  const targets = options.lintTargets ?? [];
  const inTargets = targets.length === 0 ? [] : tracked.filter((path) => targets.some((target) => target === '.' || path === target || path.startsWith(`${target}/`)));
  const reference = options.reference?.eslint;
  const result = await exec(process.execPath, ['-e', ESLINT_PROBE], {
    cwd,
    timeoutMs: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...(options.env ?? process.env),
      DRIFT_FILES: JSON.stringify(inTargets),
      ...(reference?.sampleFile ? { DRIFT_SAMPLE: reference.sampleFile } : {}),
      DRIFT_RULES: JSON.stringify(reference ? Object.keys(reference.rules) : []),
    },
  });
  const parsed = probeResult<Omit<EslintCoverage, 'configFile'>>(result.stdout);
  if (!parsed) return null;
  return { ...parsed, configFile: configFileIn(cwd, ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc']) };
}

async function probeJest(cwd: string, exec: Exec, env?: NodeJS.ProcessEnv): Promise<CoverageInventory['jest']> {
  const bin = join(cwd, 'node_modules', '.bin', 'jest');
  if (!existsSync(bin)) return null;
  const result = await exec(bin, ['--listTests'], { cwd, env: { ...(env ?? process.env), CI: '1' }, timeoutMs: 180_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.code !== 0) return null;
  const tests = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
    .map((path) => relativeTo(cwd, path))
    .filter((path) => !path.startsWith('..'))
    .sort();
  return { tests, configFile: configFileIn(cwd, ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json', 'package.json']) };
}

const TSC_PROBE = `
(() => {
const MARK = '${PROBE_MARK}';
const { createRequire } = require('module');
const path = require('path');
const req = createRequire(path.join(process.cwd(), 'package.json'));
let ts;
try { ts = req('typescript'); } catch { process.stdout.write('\\n' + MARK + 'null\\n'); return; }
const out = {};
for (const config of JSON.parse(process.env.DRIFT_TSCONFIGS || '[]')) {
  const file = path.resolve(process.cwd(), config);
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) continue;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file));
  const o = parsed.options;
  const strict = Boolean(o.strict);
  const flag = (name) => (o[name] === undefined ? strict : Boolean(o[name]));
  out[config] = {
    strict: {
      strict,
      noImplicitAny: flag('noImplicitAny'), strictNullChecks: flag('strictNullChecks'), strictFunctionTypes: flag('strictFunctionTypes'),
      strictBindCallApply: flag('strictBindCallApply'), strictPropertyInitialization: flag('strictPropertyInitialization'),
      noImplicitThis: flag('noImplicitThis'), useUnknownInCatchVariables: flag('useUnknownInCatchVariables'), alwaysStrict: flag('alwaysStrict'),
      noUnusedLocals: Boolean(o.noUnusedLocals), noUnusedParameters: Boolean(o.noUnusedParameters), noImplicitReturns: Boolean(o.noImplicitReturns),
      noFallthroughCasesInSwitch: Boolean(o.noFallthroughCasesInSwitch), noUncheckedIndexedAccess: Boolean(o.noUncheckedIndexedAccess),
      exactOptionalPropertyTypes: Boolean(o.exactOptionalPropertyTypes), noImplicitOverride: Boolean(o.noImplicitOverride),
    },
    files: parsed.fileNames.filter((f) => !f.includes('/node_modules/')).map((f) => path.relative(process.cwd(), f)).sort(),
  };
}
process.stdout.write('\\n' + MARK + JSON.stringify({ configs: out }) + '\\n');
})();
`;

async function probeTsc(cwd: string, options: CoverageOptions, exec: Exec): Promise<TscCoverage | null> {
  const configs = (options.tsconfigs ?? []).filter((config) => existsSync(join(cwd, config)));
  if (configs.length === 0 || !existsSync(join(cwd, 'node_modules', 'typescript'))) return null;
  const result = await exec(process.execPath, ['-e', TSC_PROBE], {
    cwd,
    timeoutMs: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...(options.env ?? process.env), DRIFT_TSCONFIGS: JSON.stringify(configs) },
  });
  return probeResult<TscCoverage>(result.stdout);
}

function configFileIn(cwd: string, names: readonly string[]): string | null {
  return names.find((name) => existsSync(join(cwd, name))) ?? null;
}

function relativeTo(cwd: string, path: string): string {
  const withoutPrivate = (p: string) => p.replace(/^\/private(?=\/)/, '');
  return relative(withoutPrivate(cwd), withoutPrivate(path)).split(sep).join('/');
}
