import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { loadFixtures, loadFixtureYamlBody } from './load.ts';
import { hashFixtureRevision } from './hash.ts';
import { loadAdjudication } from './review.ts';
import { runDeterministicEvaluation, buildReport } from './run.ts';
import { SCORING_VERSION } from './score.ts';

const execFile = promisify(execFileCallback);
const AUDITS_DIR = join(process.cwd(), 'eval', 'reports', 'audits');

/**
 * One file per run, written only via `--record`, never on a plain
 * `eval:deterministic`. That keeps ordinary CI runs from dirtying a tracked
 * file — the failure mode the previous append-only `accuracy-audit.md` had.
 */
export interface AuditRecord {
  repositoryCommit: string;
  branch: string;
  dirty: boolean;
  fixtureSetHash: string;
  fixtureHashes: Record<string, string>;
  acceptedReviewIds: Record<string, string[]>;
  adjudicationHashes: Record<string, string>;
  scoringVersion: string;
  adapterVersions: Record<string, string>;
  command: string;
  timestamp: string;
  environment: { node: string; platform: string };
  metrics: unknown;
}

async function computeFixtureSetHash(fixtureHashes: Record<string, string>): Promise<string> {
  const hash = createHash('sha256');
  for (const id of Object.keys(fixtureHashes).sort()) {
    hash.update(id);
    hash.update('\0');
    hash.update(fixtureHashes[id]!);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function buildAuditRecord(): Promise<AuditRecord> {
  const fixtures = await loadFixtures();
  const report = await buildReport(fixtures);
  const [commit, branch, status] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['branch', '--show-current']),
    git(['status', '--porcelain']),
  ]);

  const fixtureHashes: Record<string, string> = {};
  const adjudicationHashes: Record<string, string> = {};
  const acceptedReviewIds: Record<string, string[]> = {};
  for (const fixture of fixtures) {
    const body = await loadFixtureYamlBody(fixture.id);
    const hashes = await hashFixtureRevision(join(process.cwd(), 'eval', 'fixtures', fixture.id), body);
    fixtureHashes[fixture.id] = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
    const adjudication = await loadAdjudication(fixture.id);
    if (adjudication) {
      adjudicationHashes[fixture.id] = createHash('sha256').update(JSON.stringify(adjudication.decision)).digest('hex');
      acceptedReviewIds[fixture.id] = adjudication.acceptedReviewIds;
    }
  }

  return {
    repositoryCommit: commit,
    branch,
    dirty: status.length > 0,
    fixtureSetHash: await computeFixtureSetHash(fixtureHashes),
    fixtureHashes,
    acceptedReviewIds,
    adjudicationHashes,
    scoringVersion: SCORING_VERSION,
    adapterVersions: { 'drift-full-pipeline': '1', 'drift-component-localize-repair': '1', 'drift-component-fixplan-application': '1' },
    command: 'npm run eval:accuracy:audit -- --record',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    metrics: report.metrics,
  };
}

async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', [...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function recordKey(record: AuditRecord): string {
  return `${record.repositoryCommit}-${record.fixtureSetHash}-${record.scoringVersion}`;
}

function withoutVolatileFields(record: AuditRecord): Omit<AuditRecord, 'timestamp' | 'environment' | 'dirty'> {
  const { timestamp: _timestamp, environment: _environment, dirty: _dirty, ...rest } = record;
  return rest;
}

async function writeAuditRecord(record: AuditRecord): Promise<{ path: string; skipped: boolean }> {
  await mkdir(AUDITS_DIR, { recursive: true });
  const key = recordKey(record);
  const jsonPath = join(AUDITS_DIR, `${key}.json`);
  const mdPath = join(AUDITS_DIR, `${key}.md`);

  try {
    const existing = JSON.parse(await readFile(jsonPath, 'utf8')) as AuditRecord;
    if (JSON.stringify(withoutVolatileFields(existing)) === JSON.stringify(withoutVolatileFields(record))) {
      return { path: jsonPath, skipped: true };
    }
    throw new Error(
      `Refusing to overwrite ${jsonPath}: an audit record for this exact commit/fixture-set/scoring-version already exists with different metrics. ` +
        'This should not happen for a deterministic scorer at a fixed commit — investigate before forcing a new record.',
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderAuditMarkdown(record), 'utf8');
  return { path: jsonPath, skipped: false };
}

function renderAuditMarkdown(record: AuditRecord): string {
  return [
    `# Accuracy audit — ${record.repositoryCommit.slice(0, 12)}`,
    '',
    `- Commit: \`${record.repositoryCommit}\``,
    `- Branch: \`${record.branch}\``,
    `- Dirty worktree at record time: \`${record.dirty}\``,
    `- Fixture set hash: \`${record.fixtureSetHash}\``,
    `- Scoring version: \`${record.scoringVersion}\``,
    `- Command: \`${record.command}\``,
    `- Timestamp: ${record.timestamp}`,
    `- Environment: node ${record.environment.node} on ${record.environment.platform}`,
    '',
    '```json',
    JSON.stringify(record.metrics, null, 2),
    '```',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const record = await buildAuditRecord();
  if (process.argv.includes('--record')) {
    const { path, skipped } = await writeAuditRecord(record);
    console.log(skipped ? `audit record already exists and matches: ${path}` : `wrote ${path}`);
  } else {
    console.log(JSON.stringify(record, null, 2));
    console.log('\n(pass --record to persist this under eval/reports/audits/)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { runDeterministicEvaluation };
