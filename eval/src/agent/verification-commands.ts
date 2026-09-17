import type { ParsedStream } from './providers/claude-code.ts';
import { classifyVerificationCommand, VERIFICATION_GUARD_MARKER } from '../../../dist/index.js';

/**
 * Verification commands an agent ran (or tried to run) itself, counted with
 * the product's own classifier — the same function the controller's guard
 * enforces with — for every condition.
 *
 * `broad`/`narrow` count Bash tool calls the agent issued. `blocked` counts
 * broad calls the verification guard refused (the tool result carries the
 * guard's message); those did not run, and are also in `broad`.
 */

export { classifyVerificationCommand };

export interface VerificationCommandCounts {
  broad: number;
  narrow: number;
  blocked: number;
  broadCommands: string[];
}

export function agentVerificationCommands(parsed: ParsedStream): VerificationCommandCounts {
  const counts: VerificationCommandCounts = { broad: 0, narrow: 0, blocked: 0, broadCommands: [] };
  for (const use of parsed.toolUses) {
    if (use.name !== 'Bash' || typeof use.input['command'] !== 'string') continue;
    const command = use.input['command'];
    const kind = classifyVerificationCommand(command);
    if (kind === 'broad') {
      counts.broad += 1;
      if (counts.broadCommands.length < 20) counts.broadCommands.push(command.slice(0, 200));
      if (parsed.toolResults.get(use.id)?.guardRefused) counts.blocked += 1;
    } else if (kind === 'narrow') {
      counts.narrow += 1;
    }
  }
  return counts;
}

export { VERIFICATION_GUARD_MARKER };
