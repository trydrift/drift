import { fileURLToPath } from 'node:url';
import { classifyVerificationCommand } from './verification-commands.js';

/**
 * Keeps broad verification out of an agent session the controller verifies.
 *
 * Telling an agent that Drift runs the build and tests afterwards does not stop
 * it: in the controller's first pilots, sessions told exactly that still ran
 * the whole-project typecheck five to seven times each, re-reading its output on
 * every later turn — the loop the controller exists to own. For Claude Code the
 * rule is enforced with a PreToolUse hook: a whole-project build, typecheck,
 * lint or test command is refused with a message saying Drift runs it and will
 * report failures; a targeted check (one test file, one file's lint) runs.
 *
 * The hook is passed with `--settings`, which applies even when every settings
 * source is disabled, and it runs this module with the tool call on stdin.
 */

export const VERIFICATION_GUARD_MARKER = 'Drift runs this repository';

export function guardDecision(input: string): { block: false } | { block: true; reason: string } {
  let command = '';
  try {
    const event = JSON.parse(input) as { tool_name?: string; tool_input?: { command?: unknown } };
    if (event.tool_name && event.tool_name !== 'Bash') return { block: false };
    command = typeof event.tool_input?.command === 'string' ? event.tool_input.command : '';
  } catch {
    return { block: false };
  }
  if (classifyVerificationCommand(command) !== 'broad') return { block: false };
  return {
    block: true,
    reason:
      `${VERIFICATION_GUARD_MARKER}'s full build, typecheck, lint and tests itself after this session and hands any failures ` +
      'to the next one, so this whole-project command was not run. If you need to check an edit, run a targeted check ' +
      'instead: a single test file, or the linter on the file you changed.',
  };
}

/** `--settings` content that installs the guard for Bash tool calls. */
export function verificationGuardSettings(nodePath = process.execPath): Record<string, unknown> {
  const script = fileURLToPath(new URL('./verification-guard-hook.js', import.meta.url));
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${JSON.stringify(nodePath)} ${JSON.stringify(script)}` }] }],
    },
  };
}
