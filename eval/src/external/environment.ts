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
  /**
   * The version string the tool printed, verbatim first line — or
   * `installed (version unknown)` when the tool ran but printed no line that
   * reads as a version (e.g. a bare usage banner). `unavailable` when it did
   * not run at all. The three states are deliberately distinct: a reader must
   * be able to tell "present, version X" from "present, version opaque" from
   * "absent", and a stray `SYNOPSIS` in this field collided the first two.
   */
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

interface Probe {
  tool: string;
  /** Args for the call that proves the tool exists (must exit 0 when installed). */
  args: string[];
  /**
   * Optional extra args tried only to obtain a cleaner version string. Failure
   * here never changes `available` — some builds of a tool (japicmp among
   * them) print a usage banner for the availability probe and only reveal a
   * version behind a flag an older build might not support.
   */
  versionArgs?: string[];
  neededFor: string;
}

const PROBES: Probe[] = [
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
  // a report that does not say which one happened is unreadable. `--help` is
  // what reliably exits 0 across japicmp builds; `--version` is tried after,
  // only to replace the `SYNOPSIS` banner `--help` leads with.
  {
    tool: 'japicmp',
    args: ['--help'],
    versionArgs: ['--version'],
    neededFor: "Drift's Java API-surface diff, which its maven capability declares it requires",
  },
];

/** The first line of `text`, trimmed; `''` when there is no non-empty line. */
function firstNonEmptyLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

/** Exported for the tools gate (`missing` and, later, the japicmp hard-gate) and its test. */
export { readsAsVersion, probeVersionString };

/**
 * Does this line read as a version, or as the top of a usage banner?
 *
 * A version line has a digit in it somewhere ("git version 2.39.5",
 * "openjdk version \"19\"", "Docker version 29.7.2"). A usage banner leads
 * with a section word — `SYNOPSIS`, `Usage:`, `NAME`, `OPTIONS` — and no
 * number. This is intentionally permissive about what counts as a version and
 * strict about what counts as a banner: a false "banner" reading only costs a
 * real version string, while a banner token kept in the field is the bug this
 * exists to prevent.
 */
function readsAsVersion(line: string): boolean {
  if (!line) return false;
  if (/^(synopsis|usage|name|options|description|examples|commands|arguments)\b/i.test(line)) return false;
  return /\d/.test(line);
}

async function probeVersionString(tool: string, versionArgs: string[] | undefined, fallbackLine: string): Promise<string> {
  if (readsAsVersion(fallbackLine)) return fallbackLine;
  if (versionArgs) {
    try {
      const { stdout, stderr } = await execFile(tool, versionArgs, { timeout: 30_000 });
      const line = firstNonEmptyLine(stdout) || firstNonEmptyLine(stderr);
      if (readsAsVersion(line)) return line;
    } catch {
      // The tool is installed — the availability probe already succeeded — it
      // just does not answer this flag. Fall through to the honest label.
    }
  }
  return 'installed (version unknown)';
}

export async function probeEnvironment(): Promise<EnvironmentRecord> {
  const tools = await Promise.all(
    PROBES.map(async ({ tool, args, versionArgs, neededFor }) => {
      try {
        const { stdout, stderr } = await execFile(tool, args, { timeout: 30_000 });
        // `java -version` writes to stderr; taking whichever stream spoke means
        // a probe does not report a tool missing because it printed elsewhere.
        const line = firstNonEmptyLine(stdout) || firstNonEmptyLine(stderr);
        const version = await probeVersionString(tool, versionArgs, line);
        return { tool, available: true, version, neededFor };
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
