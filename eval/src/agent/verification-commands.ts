import type { ParsedStream } from './providers/claude-code.ts';

/**
 * Whether an agent ran the project's verification itself, and how widely.
 *
 * Broad: a whole-project run — `npm test`, `yarn build`, `npx tsc` with no file
 * arguments, `npx jest` with no path or name filter, `eslint .`. Narrow: the
 * same tools pointed at specific files or tests (`npx jest src/a.test.ts`,
 * `npx tsc --noEmit src/a.ts`, `node eslint-rules/x.test.js`). Anything else is
 * not verification and is not counted.
 *
 * Literal and conservative: a command line is split on `&&`, `;` and `|`, and
 * each part is classified on its own; one Bash invocation that runs a broad
 * check counts once. The same classifier is applied to every condition.
 */

export interface VerificationCommandCounts {
  broad: number;
  narrow: number;
  broadCommands: string[];
}

const SCRIPT_RUNNERS = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)(.*)$/;
const CHECK_SCRIPT = /^(?:test|tests|build|compile|typecheck|type-check|tsc|lint|check)(?::[\w.-]+)?$/;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.[cm]?[jt]sx?|\.py)(?:\s|$|:)/;

export function classifyVerificationCommand(command: string): 'broad' | 'narrow' | null {
  let result: 'broad' | 'narrow' | null = null;
  for (const raw of command.split(/&&|\|\||;|\|/)) {
    const part = raw.trim().replace(/^(?:cd\s+\S+\s*$)/, '').replace(/^(?:env\s+)?(?:[A-Z_]+=\S+\s+)*/, '').replace(/^corepack\s+/, '');
    const kind = classifyPart(part);
    if (kind === 'broad') return 'broad';
    if (kind === 'narrow') result = 'narrow';
  }
  return result;
}

function classifyPart(part: string): 'broad' | 'narrow' | null {
  if (!part) return null;
  const script = SCRIPT_RUNNERS.exec(part);
  if (script) {
    const [, name, rest] = script;
    if (name === 'install' || name === 'add' || name === 'ci' || name === 'view' || name === 'info' || name === 'ls') return null;
    // `npm test -- src/a.test.ts` narrows the run. A name that is not a check
    // script may still be a tool (`yarn jest`), which the pattern below reads.
    if (CHECK_SCRIPT.test(name!)) return hasNarrowingArgs(rest ?? '') ? 'narrow' : 'broad';
  }

  const tool = /^(?:npx\s+(?:--no(?:-install)?\s+)?|yarn\s+|pnpm\s+(?:exec\s+)?|\.\/node_modules\/\.bin\/)?(tsc|jest|vitest|mocha|eslint|ava|pytest|tox|mvn|gradle|\.\/gradlew|cargo|go)\b(.*)$/.exec(part);
  if (tool) {
    const [, name, rest = ''] = tool;
    if (name === 'cargo' || name === 'go') return /^\s*(?:test|build|check|vet)\b/.test(rest) ? (/\s\S+\.(?:rs|go)\b|-p\s|\s-run\s/.test(rest) ? 'narrow' : 'broad') : null;
    if (name === 'mvn' || name === 'gradle' || name === './gradlew') return /-Dtest=|--tests\s/.test(rest) ? 'narrow' : /\b(?:test|verify|compile|build|check|package)\b/.test(rest) ? 'broad' : null;
    if (/--version|--help|--init|--showConfig/.test(rest)) return null;
    if (name === 'eslint') return /\s(?:\.|src|lib|test|tests)\/?(?:\s|$)/.test(`${rest} `) || !/\S+\.[cm]?[jt]sx?/.test(rest) ? 'broad' : 'narrow';
    return hasNarrowingArgs(rest) ? 'narrow' : 'broad';
  }

  // Running one test file directly with node is a narrow check.
  if (/^node\s+(?:--test\s+)?\S+\.(?:test|spec)\.[cm]?[jt]s\b/.test(part) || /^node\s+--test\s+\S+/.test(part)) return 'narrow';
  return null;
}

function hasNarrowingArgs(rest: string): boolean {
  // A configuration file is not a target: `jest --config jest.config.js` still runs everything.
  const args = rest
    .replace(/^\s*--(?=\s|$)/, ' ')
    .replace(/\s(?:--config|-c|--project|-p|--rootDir|--reporter|--require|-r|--setupFiles)(?:=|\s+)\S+/g, ' ')
    .replace(/\s--\w[\w-]*=\S+/g, ' ');
  return TEST_FILE.test(args) || /\s(?:-t|--testNamePattern|--grep|-g|-k|--testPathPattern|--filter)\s/.test(` ${args} `);
}

export function agentVerificationCommands(parsed: ParsedStream): VerificationCommandCounts {
  const counts: VerificationCommandCounts = { broad: 0, narrow: 0, broadCommands: [] };
  for (const use of parsed.toolUses) {
    if (use.name !== 'Bash' || typeof use.input['command'] !== 'string') continue;
    const command = use.input['command'];
    const kind = classifyVerificationCommand(command);
    if (kind === 'broad') {
      counts.broad += 1;
      if (counts.broadCommands.length < 20) counts.broadCommands.push(command.slice(0, 200));
    } else if (kind === 'narrow') {
      counts.narrow += 1;
    }
  }
  return counts;
}
