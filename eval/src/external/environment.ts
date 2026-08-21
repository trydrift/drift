import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * What this machine can actually run, probed rather than assumed.
 *
 * The rule the rest of the harness depends on: a benchmark is never quietly
 * downgraded because a tool is missing. If Maven is not installed, a Java
 * repair track does not report zero repairs — it reports
 * `environment-unavailable` naming `maven`, the case leaves the denominator
 * with that reason attached, and the report says so in a table. Zero would be
 * a measurement, and there was no measurement.
 *
 * The probe is therefore not a convenience. It is what turns "the run produced
 * no Java results" into a sentence a reader can act on.
 */

export interface ToolProbe {
  tool: string;
  available: boolean;
  /** The version string the tool printed, verbatim first line. `unavailable` when it did not run. */
  version: string;
  /** What this tool is needed for, so a missing row explains its own consequence. */
  neededFor: string;
}

export interface EnvironmentRecord {
  capturedAt: string;
  platform: string;
  arch: string;
  node: string;
  tools: ToolProbe[];
}

const PROBES: { tool: string; args: string[]; neededFor: string }[] = [
  { tool: 'node', args: ['--version'], neededFor: 'every npm/TypeScript case, and Drift itself' },
  { tool: 'npm', args: ['--version'], neededFor: 'installing a TypeScript consumer before its build oracle can run' },
  { tool: 'git', args: ['--version'], neededFor: 'checking out an original repository at the exact evaluated commit' },
  { tool: 'java', args: ['-version'], neededFor: 'any Java case' },
  { tool: 'mvn', args: ['--version'], neededFor: "BUMP's Maven oracle, and building Roseau from its replication kit" },
  { tool: 'docker', args: ['--version'], neededFor: "BUMP's published pre/breaking images and TimeMachine's date-filtered PyPI infrastructure" },
  { tool: 'python3', args: ['--version'], neededFor: 'any Python case' },
  { tool: 'uv', args: ['--version'], neededFor: "TimeMachine's documented environment setup" },
  // Drift shells out to this by name for the Java API-surface diff. Without it
  // the surface cannot be computed, and Drift correctly declines to conclude
  // anything — which is a different result from Drift concluding wrongly, and
  // a report that does not say which one happened is unreadable.
  { tool: 'japicmp', args: ['--help'], neededFor: "Drift's Java API-surface diff, which its maven capability declares it requires" },
];

export async function probeEnvironment(): Promise<EnvironmentRecord> {
  const tools = await Promise.all(
    PROBES.map(async ({ tool, args, neededFor }) => {
      try {
        const { stdout, stderr } = await execFile(tool, args, { timeout: 30_000 });
        // `java -version` writes to stderr; taking whichever stream spoke means
        // a probe does not report a tool missing because it printed elsewhere.
        const output = (stdout.trim() || stderr.trim()).split('\n')[0]?.trim() ?? '';
        return { tool, available: true, version: output || 'unavailable', neededFor };
      } catch {
        return { tool, available: false, version: 'unavailable', neededFor };
      }
    }),
  );

  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    tools,
  };
}

/** The tools a run needs but does not have, as a list a report can print without further work. */
export function missing(environment: EnvironmentRecord, required: readonly string[]): string[] {
  const byName = new Map(environment.tools.map((tool) => [tool.tool, tool]));
  return required.filter((tool) => byName.get(tool)?.available !== true);
}
