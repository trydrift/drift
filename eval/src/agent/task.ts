import { createHash } from 'node:crypto';
import type { AgentCase, Condition } from './schema.ts';

/**
 * The task every condition receives, word for word.
 *
 * This is the whole of what the baseline agent is told. The Drift condition
 * receives exactly this text followed by Drift's report (see
 * `drift-context.ts`); nothing in the task changes between conditions, and
 * every trial records the hash of the task and of the complete prompt so two
 * trials can be shown to have been asked the same thing.
 */
export function renderTask(agentCase: AgentCase): string {
  const { name, fromVersion, toVersion } = agentCase.dependency;
  const where = agentCase.workspaceDir ? ` (in the \`${agentCase.workspaceDir}\` package of this repository)` : '';
  return [
    `The dependency ${name} has been upgraded from ${fromVersion} to ${toVersion}${where}.`,
    '',
    'Update this repository so that it works correctly with the new version.',
    '',
    'Find and fix all relevant incompatibilities.',
    '',
    'Do not revert or downgrade the dependency.',
    '',
    'Run the appropriate tests/build/typecheck and leave the repository in a working state.',
  ].join('\n');
}

/**
 * The generic-orchestrated condition's open session: the same task, except
 * that verification is the orchestrator's. The last line of the task is
 * replaced, not appended to, so the session is not told both to run the checks
 * and not to. No Drift analysis appears in it.
 */
export function renderGenericOrchestratedTask(agentCase: AgentCase): string {
  const lines = renderTask(agentCase).split('\n');
  const verifyLine = lines.findIndex((line) => line.startsWith('Run the appropriate tests'));
  lines.splice(
    verifyLine,
    1,
    [
      'An orchestrator runs this repository\'s build, typecheck, lint and tests after you finish, and starts a new session',
      'with any failures that remain. Do not run the full test suite, a full build, or other broad verification yourself;',
      'a narrow check of a file you edited is fine. Do not weaken, skip or delete tests, lower coverage thresholds, or',
      'relax compiler strictness.',
    ].join('\n'),
  );
  return lines.join('\n');
}

/**
 * The one benchmark-authored sentence in the Drift condition: it says what the
 * text that follows is. The report itself is production output, verbatim.
 */
export const DRIFT_PREAMBLE_HEADER = [
  '---',
  '',
  'Drift, a dependency-upgrade analysis tool, has already analysed this upgrade. It compared the two',
  'published versions of the package, computed what changed in its API, and searched this repository',
  'for the code that uses what changed. Its report follows, verbatim. Treat it as evidence to verify',
  'against the code, not as a complete list: it can miss places, and it never edits anything.',
  '',
].join('\n');

/**
 * The header for `drift-agent-brief`: says what follows, nothing more. The
 * brief carries its own operational instructions, and those are production
 * text (`AGENT_BRIEF_INSTRUCTIONS`), identical to what `drift analyze --agent`
 * and `plan_upgrade` print.
 */
export const DRIFT_BRIEF_HEADER = ['---', '', "Drift's agent brief for this upgrade follows, verbatim.", ''].join('\n');

/**
 * The whole of what `drift-mcp` adds to the prompt: that the tools exist.
 * When to call which tool is the server's own MCP `instructions`, which the
 * client places in context for any user who connects Drift.
 */
export const DRIFT_MCP_PREAMBLE = ['---', '', "Drift's MCP tools are available in this session."].join('\n');

export function composePrompt(task: string, preamble: string): string {
  return preamble ? `${task}\n\n${preamble}` : task;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function contextKindFor(condition: Condition): 'none' | 'drift' {
  return condition === 'baseline' || condition === 'generic-orchestrated' ? 'none' : 'drift';
}
