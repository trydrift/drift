import { execFile as execFileCallback } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { runManifestSchema, trialSchema, type RunManifest, type TrialArtifact } from './schema.ts';

const execFile = promisify(execFileCallback);

/**
 * Where a run's artifacts live, and the rule that none is ever overwritten.
 *
 *   eval/results/agent/raw/<run-id>/manifest.json
 *   eval/results/agent/raw/<run-id>/trials/<case>__<condition>__rep-NN.json
 *   eval/results/agent/raw/<run-id>/trials/<case>__<condition>__rep-NN.diff
 *   eval/results/agent/raw/<run-id>/trials/<case>__<condition>__rep-NN.stream.jsonl.gz   (gitignored)
 *   eval/results/agent/latest.json                                                        canonical summary
 *   eval/results/agent/history/<generatedAt>__<suite>__<model>.json                       every past summary
 *   eval/reports/agent/latest.md
 *
 * A trial that already exists is skipped by the runner (so an interrupted run
 * can be resumed under the same id) and never replaced. Re-running a trial
 * that went badly is best-of-k; the runner does not offer it.
 */

export function resultsRoot(root = process.cwd()): string {
  return join(root, 'eval', 'results', 'agent');
}

export function rawRoot(root?: string): string {
  return join(resultsRoot(root), 'raw');
}

export function runDir(runId: string, root?: string): string {
  return join(rawRoot(root), runId);
}

export function reportsRoot(root = process.cwd()): string {
  return join(root, 'eval', 'reports', 'agent');
}

export function trialBaseName(caseId: string, condition: string, repetition: number): string {
  return `${caseId}__${condition}__rep-${String(repetition).padStart(2, '0')}`;
}

export async function writeRunManifest(manifest: RunManifest, root?: string): Promise<void> {
  const dir = runDir(manifest.runId, root);
  await mkdir(join(dir, 'trials'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(runManifestSchema.parse(manifest), null, 2)}\n`, 'utf8');
}

export async function readRunManifest(runId: string, root?: string): Promise<RunManifest> {
  return runManifestSchema.parse(JSON.parse(await readFile(join(runDir(runId, root), 'manifest.json'), 'utf8')));
}

export async function trialExists(runId: string, caseId: string, condition: string, repetition: number, root?: string): Promise<boolean> {
  try {
    await readFile(join(runDir(runId, root), 'trials', `${trialBaseName(caseId, condition, repetition)}.json`), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Sets aside a recorded trial that was excluded for an infrastructure
 * failure, so the slot can be attempted again. The artifact is renamed to
 * `<name>.attempt-N.*`, never deleted: every attempt stays on disk. Refuses
 * to touch a valid trial — retrying an observed agent outcome is best-of-k.
 */
export async function setAsideInfrastructureFailure(runId: string, caseId: string, condition: string, repetition: number, root?: string): Promise<{ setAside: boolean; reason: string }> {
  const dir = join(runDir(runId, root), 'trials');
  const base = trialBaseName(caseId, condition, repetition);
  let artifact: TrialArtifact;
  try {
    artifact = trialSchema.parse(JSON.parse(await readFile(join(dir, `${base}.json`), 'utf8')));
  } catch {
    return { setAside: false, reason: 'no artifact' };
  }
  if (artifact.validity.valid) return { setAside: false, reason: 'a valid trial is never retried' };
  let attempt = 1;
  while (await exists(join(dir, `${base}.attempt-${attempt}.json`))) attempt += 1;
  const { rename } = await import('node:fs/promises');
  for (const suffix of ['.json', '.diff', '.stream.jsonl.gz']) {
    await rename(join(dir, `${base}${suffix}`), join(dir, `${base}.attempt-${attempt}${suffix}`)).catch(() => undefined);
  }
  return { setAside: true, reason: `${artifact.validity.infrastructureFailure ?? 'invalid'} set aside as attempt ${attempt}` };
}

export class DuplicateTrialError extends Error {}

export async function writeTrial(artifact: TrialArtifact, extras: { diff: string; streamLines: readonly string[] }, root?: string): Promise<string> {
  const parsed = trialSchema.parse(artifact);
  const dir = join(runDir(parsed.runId, root), 'trials');
  await mkdir(dir, { recursive: true });
  const base = trialBaseName(parsed.caseId, parsed.condition, parsed.repetition);
  const path = join(dir, `${base}.json`);
  if (await exists(path)) {
    throw new DuplicateTrialError(`A trial artifact already exists at ${path}. A repeated trial takes the next repetition index; overwriting one is how a benchmark becomes best-of-k.`);
  }
  await writeFile(join(dir, `${base}.diff`), extras.diff, 'utf8');
  await writeGzip(join(dir, `${base}.stream.jsonl.gz`), extras.streamLines.join('\n') + '\n');
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return path;
}

async function writeGzip(path: string, content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const gzip = createGzip();
    const out = createWriteStream(path);
    gzip.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    gzip.on('error', reject);
    gzip.end(content);
  });
}

export async function readTrials(runId: string, root?: string): Promise<TrialArtifact[]> {
  const dir = join(runDir(runId, root), 'trials');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const trials: TrialArtifact[] = [];
  // Set-aside attempts (`*.attempt-N.json`) are kept on disk for the audit
  // trail but are not trials: each was excluded for an infrastructure failure
  // and its slot was attempted again.
  for (const name of entries.filter((entry) => entry.endsWith('.json') && !/\.attempt-\d+\.json$/.test(entry)).sort()) {
    trials.push(trialSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8'))));
  }
  return trials;
}

export async function listRuns(root?: string): Promise<string[]> {
  try {
    const entries = await readdir(rawRoot(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function driftRevision(root = process.cwd()): Promise<{ commit: string; dirty: boolean }> {
  try {
    const { stdout: commit } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
    const { stdout: status } = await execFile('git', ['status', '--porcelain', '--', 'src', 'eval/src', 'package.json', 'package-lock.json'], { cwd: root });
    return { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { commit: 'unavailable', dirty: false };
  }
}

export async function driftVersion(root = process.cwd()): Promise<string> {
  try {
    return (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function newRunId(suite: string, model: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${stamp}__${suite}__${model.replace(/[^a-z0-9.-]+/gi, '-')}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
