import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * Three explicit oracle stages, not two.
 *
 * BASELINE: old dependency + original consumer, expected to pass — proves the
 * consumer worked before the upgrade, so a later "repaired" pass means the
 * repair actually did something rather than the oracle being trivially green.
 * BROKEN: new dependency + original consumer — proves the upgrade actually
 * breaks the consumer where a fixture claims it does (a fixture whose
 * untouched broken state already passes cannot credit a later repair).
 * REPAIRED: new dependency + repaired consumer, expected to pass.
 */
export type OracleStage = 'baseline' | 'broken' | 'repaired';
export type OracleOutcome = 'pass' | 'fail' | 'unable-to-run';

export interface OracleStageResult {
  stage: OracleStage;
  expected: 'pass' | 'fail';
  observed: OracleOutcome;
  /** `unable-to-run` never matches an expectation — an infrastructure failure is not a product result. */
  matchesExpectation: boolean;
}

export async function installFixtureDependencies(cwd: string): Promise<void> {
  await execFile('npm', ['install', '--package-lock=false', '--ignore-scripts'], { cwd, maxBuffer: 16 * 1024 * 1024 });
}

export async function runOracleCommand(cwd: string, command: string): Promise<OracleOutcome> {
  const [program, ...args] = command.split(/\s+/).filter(Boolean);
  if (!program) return 'pass';
  try {
    await execFile(program, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return 'pass';
  } catch (err) {
    // A spawn failure (missing binary, permission error) never ran the
    // consumer's own check at all — distinct from the check running and the
    // consumer code failing it.
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return 'unable-to-run';
    return 'fail';
  }
}

export function stageResult(stage: OracleStage, expected: 'pass' | 'fail', observed: OracleOutcome): OracleStageResult {
  return { stage, expected, observed, matchesExpectation: observed !== 'unable-to-run' && observed === expected };
}

/**
 * Points a copy of the consumer at a specific upstream version by rewriting
 * its `file:` dependency, the same mechanism the fixture already uses to
 * point at `upstream/new` by default.
 */
async function repointDependency(consumerDir: string, dependency: string, targetRelativePath: string): Promise<void> {
  const path = join(consumerDir, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8')) as { dependencies?: Record<string, string> };
  if (pkg.dependencies?.[dependency]) {
    pkg.dependencies[dependency] = `file:${targetRelativePath}`;
  }
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

export interface StageOracleSpec {
  stage: OracleStage;
  command: string;
  expected: 'pass' | 'fail';
  dependencyVersion: 'old' | 'new';
  /** Applies edits (e.g. a repair patch) to the consumer copy before install/run. Baseline/broken pass through unchanged. */
  prepareConsumer?: (consumerDir: string) => Promise<void>;
}

export interface StageOracleRun extends OracleStageResult {
  changedFiles?: string[];
}

/**
 * Runs one oracle stage in a disposable copy of the fixture, cleaned up
 * unconditionally afterward.
 */
export async function runOracleStage(fixtureDir: string, dependency: string, spec: StageOracleSpec): Promise<OracleStageResult> {
  const temp = await mkdtemp(join(tmpdir(), `drift-eval-${spec.stage}-`));
  try {
    const root = join(temp, 'fixture');
    await cp(fixtureDir, root, { recursive: true });
    const consumerDir = join(root, 'consumer');
    const targetDir = spec.dependencyVersion === 'old' ? '../upstream/old' : '../upstream/new';
    await repointDependency(consumerDir, dependency, targetDir);
    if (spec.prepareConsumer) await spec.prepareConsumer(consumerDir);

    try {
      await installFixtureDependencies(consumerDir);
    } catch {
      return stageResult(spec.stage, spec.expected, 'unable-to-run');
    }

    const observed = await runOracleCommand(consumerDir, spec.command);
    return stageResult(spec.stage, spec.expected, observed);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
