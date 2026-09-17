/**
 * Whether a shell command is the project's verification, and how widely.
 *
 * One classifier for two jobs: the remediation controller's guard refuses
 * broad checks inside a session it verifies itself, and the agent benchmark
 * counts them in every condition. Enforcement and measurement cannot drift
 * apart when they are the same function.
 *
 * Broad: a whole-project run — `npm test`, `yarn build`, `npx tsc` with no file
 * arguments, `npx jest` with no path or name filter, `eslint .`. Narrow: the
 * same tools pointed at specific files or tests (`npx jest src/a.test.ts`,
 * `npx tsc --noEmit src/a.ts`, `node eslint-rules/x.test.js`). Anything else is
 * not verification.
 *
 * Literal and conservative: a command line is split on `&&`, `;` and `|`, and
 * each part is classified on its own; one broad part makes the command broad.
 */

/** Commands longer than this are classified on their first part only; nothing an agent needs to run is this long. */
const MAX_COMMAND_CHARS = 4000;
const CHECK_SCRIPT = new Set(['test', 'tests', 'build', 'compile', 'typecheck', 'type-check', 'tsc', 'lint', 'check']);
const NOT_CHECKS = new Set(['install', 'add', 'ci', 'view', 'info', 'ls', 'why', 'outdated', 'remove', 'uninstall']);
const JS_TOOLS = new Set(['tsc', 'jest', 'vitest', 'mocha', 'eslint', 'ava', 'pytest', 'tox']);
const JVM_TOOLS = new Set(['mvn', 'gradle', './gradlew']);
const SEPARATORS = new Set(['&&', '||', ';', '|']);
/** Options whose value is configuration, not a target: `jest --config jest.config.js` still runs everything. */
const VALUE_OPTIONS = new Set(['--config', '-c', '--project', '-p', '--rootDir', '--reporter', '--require', '-r', '--setupFiles']);
const NAME_FILTERS = new Set(['-t', '--testNamePattern', '--grep', '-g', '-k', '--testPathPattern', '--filter']);

/**
 * Tokenised rather than matched with regular expressions: the input is an
 * agent-issued command line, and a pattern that backtracks on it would let
 * one command stall the guard.
 */
export function classifyVerificationCommand(command: string): 'broad' | 'narrow' | null {
  const tokens = command.slice(0, MAX_COMMAND_CHARS).split(/\s+/).flatMap(splitSeparators).filter(Boolean);
  let result: 'broad' | 'narrow' | null = null;
  let part: string[] = [];
  const flush = () => {
    const kind = classifyPart(part);
    part = [];
    return kind;
  };
  for (const token of [...tokens, ';']) {
    if (!SEPARATORS.has(token)) {
      part.push(token);
      continue;
    }
    const kind = flush();
    if (kind === 'broad') return 'broad';
    if (kind === 'narrow') result = 'narrow';
  }
  return result;
}

function splitSeparators(token: string): string[] {
  // `npm test;` and `a&&b` — separators glued to words.
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < token.length; i += 1) {
    const two = token.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      if (current) out.push(current);
      out.push(two);
      current = '';
      i += 1;
    } else if (token[i] === ';' || token[i] === '|') {
      if (current) out.push(current);
      out.push(token[i]!);
      current = '';
    } else {
      current += token[i];
    }
  }
  if (current) out.push(current);
  return out;
}

function classifyPart(input: readonly string[]): 'broad' | 'narrow' | null {
  let words = [...input];
  // Leading `cd dir`, `env`, `VAR=value`, `corepack`.
  if (words[0] === 'cd') return null;
  if (words[0] === 'env') words = words.slice(1);
  while (words[0] && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words = words.slice(1);
  if (words[0] === 'corepack') words = words.slice(1);
  if (words.length === 0) return null;

  const [first, second] = words;
  if ((first === 'npm' || first === 'pnpm' || first === 'yarn' || first === 'bun') && second) {
    const hasRun = second === 'run' || second === 'run-script';
    const name = hasRun ? words[2] : second;
    if (name && NOT_CHECKS.has(name)) return null;
    if (name && isCheckScript(name)) return hasNarrowingArgs(words.slice(hasRun ? 3 : 2)) ? 'narrow' : 'broad';
  }

  let rest = words;
  if (rest[0] === 'npx') {
    rest = rest.slice(1);
    if (rest[0] === '--no' || rest[0] === '--no-install') rest = rest.slice(1);
  } else if (rest[0] === 'yarn') {
    rest = rest.slice(1);
  } else if (rest[0] === 'pnpm') {
    rest = rest.slice(rest[1] === 'exec' ? 2 : 1);
  }
  const tool = (rest[0] ?? '').replace(/^\.\/node_modules\/\.bin\//, '');
  const args = rest.slice(1);

  if (tool === 'cargo' || tool === 'go') {
    if (!['test', 'build', 'check', 'vet'].includes(args[0] ?? '')) return null;
    return args.some((arg) => arg.endsWith('.rs') || arg.endsWith('.go') || arg === '-p' || arg === '-run') ? 'narrow' : 'broad';
  }
  if (JVM_TOOLS.has(tool)) {
    if (args.some((arg) => arg.startsWith('-Dtest=') || arg === '--tests')) return 'narrow';
    return args.some((arg) => ['test', 'verify', 'compile', 'build', 'check', 'package'].includes(arg)) ? 'broad' : null;
  }
  if (JS_TOOLS.has(tool)) {
    if (args.some((arg) => ['--version', '--help', '--init', '--showConfig'].includes(arg))) return null;
    if (tool === 'eslint') {
      const targets = args.filter((arg) => !arg.startsWith('-'));
      const wide = targets.some((arg) => ['.', 'src', 'lib', 'test', 'tests', './', 'src/', 'lib/', 'test/', 'tests/'].includes(arg));
      return wide || !targets.some(isSourceFile) ? 'broad' : 'narrow';
    }
    return hasNarrowingArgs(args) ? 'narrow' : 'broad';
  }

  // Running one test file directly with node is a narrow check.
  if (first === 'node') {
    const target = words[1] === '--test' ? words[2] : words[1];
    if (words[1] === '--test' && target) return 'narrow';
    if (target && /\.(?:test|spec)\.[cm]?[jt]s$/.test(target)) return 'narrow';
  }
  return null;
}

function isCheckScript(name: string): boolean {
  const colon = name.indexOf(':');
  return CHECK_SCRIPT.has(colon === -1 ? name : name.slice(0, colon));
}

function isSourceFile(arg: string): boolean {
  const bare = arg.split(':')[0]!;
  return /\.(?:[cm]?[jt]sx?|py)$/.test(bare);
}

function hasNarrowingArgs(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') continue;
    if (VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (NAME_FILTERS.has(arg)) return true;
    if (!arg.startsWith('-') && isSourceFile(arg)) return true;
  }
  return false;
}
