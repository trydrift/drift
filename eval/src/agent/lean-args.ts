/**
 * The Claude Code arguments behind the benchmark's lean-session conditions.
 *
 * This lived in the product as `remediation.agent.leanSession` until the
 * ten-case suite measured it. The fixed per-call context it removes is real —
 * about 41.5k tokens down to 12.6k — and so is what it costs: 80.0% of
 * upgrades fixed correctly against 96.8% with the agent's own tool set, and
 * half of those failures passed the project's own checks while being
 * behaviourally broken. A product that exists to say when an upgrade breaks
 * code does not ship a switch whose failures look like successes, so the
 * setting was removed.
 *
 * The flags stay here so the measurement can be reproduced: the
 * `baseline-lean` and `drift` conditions launch with them, and
 * `eval/reports/agent/final-verdict.md` reports what they found.
 */
export const CLAUDE_CODE_LEAN_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'TaskOutput', 'TaskStop'] as const;
export const CLAUDE_CODE_LEAN_SESSION_ARGS: readonly string[] = ['--tools', ...CLAUDE_CODE_LEAN_TOOLS, '--disable-slash-commands'];
