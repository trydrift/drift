import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PublicCase } from '../case/schema.ts';
import type { MaterializedCase } from '../case/materialize.ts';
import type { OracleStageArtifact } from '../artifacts/prediction.ts';
import { extractDiagnostics, processExitDiagnostic, signatureOf } from './signature.ts';

const execFile = promisify(execFileCallback);

/**
 * Runs one oracle stage against a disposable copy of the case, and records
 * *what* failed rather than only whether something did.
 *
 * Three stages, not two, and the middle one is the one benchmarks usually
 * skip. BASELINE (old dependency, original consumer) proves the consumer
 * worked before the upgrade, so a later repaired pass means the repair did
 * something rather than the check being trivially green. BROKEN (new
 * dependency, original consumer, untouched) proves the upgrade actually breaks
 * this consumer — without it, a "successful repair" can be a repair of
 * nothing. REPAIRED runs only when a repair was genuinely attempted.
 *
 * Every stage's output is parsed into a failure signature, so the evaluator
 * can require that a repair resolves the *specific* failures the upgrade
 * introduced and introduces none of its own, instead of comparing counts.
 *
 * `unable-to-run` is a first-class outcome and never matches an expectation.
 * An install that could not complete is an infrastructure fact about this
 * machine, and scoring it as either a product success or a product failure
 * would be reporting a fiction in both directions.
 */

export type StageName = 'baseline' | 'broken' | 'repaired' | 'full-ci';

export interface StageRunOptions {
  stage: StageName;
  command: string;
  expected: 'pass' | 'fail';
  /** Which frozen upstream tree the consumer is pointed at for this stage. */
  dependencyVersion: 'old' | 'new';
  /** Applies a repair to the disposable consumer copy before install. Baseline and broken pass through untouched. */
  prepareConsumer?: (consumerDir: string) => Promise<void>;
  /** Overrides the case's install command, for a stage that needs a different one. */
  installCommand?: string;
}

const MAX_EXCERPT = 4000;
const MAX_BUFFER = 32 * 1024 * 1024;

export async function runCaseStage(
  publicCase: PublicCase,
  materialized: MaterializedCase,
  options: StageRunOptions,
): Promise<OracleStageArtifact> {
  const started = Date.now();
  const temp = await mkdtemp(join(tmpdir(), `drift-eval-${options.stage}-`));

  try {
    const consumerDir = join(temp, 'consumer');
    const upstreamDir = join(temp, 'upstream', options.dependencyVersion);
    await cp(materialized.root, consumerDir, { recursive: true });
    await cp(
      options.dependencyVersion === 'old' ? materialized.upstreamOldDir : materialized.upstreamNewDir,
      upstreamDir,
      { recursive: true },
    );

    // The manifest declares a real published version so that *detection* has
    // something to diff; installation has to resolve it somewhere, and for an
    // offline case that somewhere is the frozen tree. Rewriting the specifier
    // here — rather than in the case data — is what lets both be true at once.
    await repointDependency(consumerDir, publicCase.dependency.name, `../upstream/${options.dependencyVersion}`);

    if (options.prepareConsumer) await options.prepareConsumer(consumerDir);

    const install = await runCommand(consumerDir, options.installCommand ?? publicCase.oracles.install, publicCase);
    if (install.code !== 0) {
      return {
        stage: options.stage,
        expected: options.expected,
        observed: 'unable-to-run',
        matchesExpectation: false,
        signature: [],
        exitCode: install.code,
        outputExcerpt: excerpt(install.output),
        durationMs: Date.now() - started,
      };
    }

    const run = await runCommand(consumerDir, options.command, publicCase);
    const diagnostics = extractDiagnostics(run.output, { cwd: consumerDir });
    // A failure that produced nothing this parser recognizes still has to be
    // *some* identity, or two unrelated unreadable failures would compare
    // equal to each other and to nothing. `process:exit:<code>` is that
    // identity, and it reads as "failed for an unreadable reason" in a report.
    if (run.code !== 0 && diagnostics.length === 0) diagnostics.push(processExitDiagnostic(run.code));

    const observed: OracleStageArtifact['observed'] = run.spawnFailed ? 'unable-to-run' : run.code === 0 ? 'pass' : 'fail';

    return {
      stage: options.stage,
      expected: options.expected,
      observed,
      matchesExpectation: observed !== 'unable-to-run' && observed === options.expected,
      signature: signatureOf(diagnostics),
      exitCode: run.code,
      outputExcerpt: excerpt(run.output),
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

interface CommandResult {
  code: number;
  output: string;
  /** The binary could not be started at all — distinct from it running and failing. */
  spawnFailed: boolean;
}

async function runCommand(cwd: string, command: string, publicCase: PublicCase): Promise<CommandResult> {
  const [program, ...args] = command.split(/\s+/).filter(Boolean);
  if (!program) return { code: 0, output: '', spawnFailed: false };

  const env = {
    ...process.env,
    // Pinned per case, because both silently change test outcomes and neither
    // is obvious when it does. Defects4J pins the same two for the same reason.
    TZ: publicCase.environment.timezone,
    LC_ALL: publicCase.environment.locale,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...(publicCase.networkPolicy === 'disabled' ? { npm_config_offline: 'true' } : {}),
  };

  try {
    const { stdout, stderr } = await execFile(program, args, { cwd, env, maxBuffer: MAX_BUFFER });
    return { code: 0, output: `${stdout}\n${stderr}`, spawnFailed: false };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    // A string `code` is a spawn errno (ENOENT, EACCES): the consumer's own
    // check never ran. A number is the process's exit status: it ran and
    // failed, which is a product result.
    if (typeof error.code === 'string') return { code: -1, output: output || error.message, spawnFailed: true };
    return { code: typeof error.code === 'number' ? error.code : 1, output, spawnFailed: false };
  }
}

async function repointDependency(consumerDir: string, dependency: string, relativePath: string): Promise<void> {
  const path = join(consumerDir, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const section of [manifest.dependencies, manifest.devDependencies]) {
    if (section?.[dependency]) section[dependency] = `file:${relativePath}`;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function excerpt(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= MAX_EXCERPT ? trimmed : `${trimmed.slice(0, MAX_EXCERPT)}\n… (${trimmed.length - MAX_EXCERPT} more characters)`;
}
