import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { predictionArtifactSchema, type PredictionArtifact } from '../artifacts/prediction.ts';

const execFile = promisify(execFileCallback);

/**
 * Immutable storage for prediction artifacts.
 *
 * A live trial costs money and cannot be reproduced by re-running it, so the
 * artifact is the durable result and every later number is derived from it.
 * Three consequences, all deliberate:
 *
 *   - An existing artifact is never silently overwritten. A second run of the
 *     same trial index is a different trial and must say so, or it is refused.
 *     Overwriting is how a benchmark quietly becomes best-of-k.
 *   - Every attempt is written, including the ones that failed. Retaining only
 *     the successful trial of three is the same misreport as best-of-k with
 *     extra steps.
 *   - Scoring reads from here, never from a live agent, so the evaluator can
 *     be fixed and every past trial re-scored without paying again — and CI
 *     can validate the evaluator with zero model calls.
 */

export const RUN_MANIFEST_VERSION = 'drift-bench-run-v1';

export interface RunManifest {
  version: string;
  runId: string;
  createdAt: string;
  driftCommit: string;
  driftTreeDirty: boolean;
  scoringVersion: string;
  /** Exact command that produced the run, so it can be repeated. */
  command: string;
  node: string;
  platform: string;
  arch: string;
  /** Case ids in the run, with the full public-capsule hash each prediction saw. */
  cases: { caseId: string; publicCapsuleHash: string }[];
  notes: string;
}

export function runsRoot(root = process.cwd()): string {
  return join(root, 'eval', 'runs');
}

export function runDir(runId: string, root?: string): string {
  return join(runsRoot(root), runId);
}

export async function writeManifest(manifest: RunManifest, root?: string): Promise<void> {
  const dir = runDir(manifest.runId, root);
  await mkdir(join(dir, 'predictions'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * One artifact per case × track × trial. The trial index is in the filename so
 * a collision is a filesystem-level refusal rather than a silent replacement.
 */
export function artifactName(artifact: PredictionArtifact): string {
  return `${artifact.caseId}__${artifact.track}__trial-${String(artifact.provenance.trial).padStart(2, '0')}.json`;
}

export class DuplicateTrialError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `A prediction artifact already exists at ${path}. A repeated trial must use the next trial index; overwriting one is how a benchmark silently becomes best-of-k.`,
    );
    this.name = 'DuplicateTrialError';
    this.path = path;
  }
}

export async function writeArtifact(artifact: PredictionArtifact, root?: string): Promise<string> {
  const parsed = predictionArtifactSchema.parse(artifact);
  const dir = join(runDir(parsed.runId, root), 'predictions');
  await mkdir(dir, { recursive: true });
  const path = join(dir, artifactName(parsed));

  try {
    await readFile(path, 'utf8');
    throw new DuplicateTrialError(path);
  } catch (err) {
    if (err instanceof DuplicateTrialError) throw err;
    // ENOENT is the expected path: nothing there yet.
  }

  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return path;
}

export async function readArtifacts(runId: string, root?: string): Promise<PredictionArtifact[]> {
  const dir = join(runDir(runId, root), 'predictions');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const artifacts: PredictionArtifact[] = [];
  for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
    artifacts.push(predictionArtifactSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8'))));
  }
  return artifacts;
}

export async function listRuns(root?: string): Promise<string[]> {
  try {
    const entries = await readdir(runsRoot(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** Where this build of Drift came from. `unavailable` rather than a guess when git cannot answer. */
export async function driftRevision(root = process.cwd()): Promise<{ commit: string; dirty: boolean }> {
  try {
    const { stdout: commit } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
    const { stdout: status } = await execFile('git', ['status', '--porcelain'], { cwd: root });
    return { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { commit: 'unavailable', dirty: false };
  }
}

/** A run id that sorts chronologically and never collides within a second. */
export function newRunId(label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${stamp}-${label}`;
}
