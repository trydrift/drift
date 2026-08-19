import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { loadFixtures } from './load.ts';
import { deterministicPredictions, SCORING_VERSION } from './run.ts';
import { scoreFixtures } from './score.ts';

const execFile = promisify(execFileCallback);
const REPORT_PATH = join(process.cwd(), 'eval', 'reports', 'accuracy-audit.md');

async function main(): Promise<void> {
  const fixtures = await loadFixtures();
  const predictions = await deterministicPredictions(fixtures);
  const metrics = scoreFixtures(fixtures, predictions);
  const metadata = await runMetadata();
  const fixtureHash = await hashDirectory(join(process.cwd(), 'eval', 'fixtures'));
  const generatedAt = new Date().toISOString();

  await mkdir(join(process.cwd(), 'eval', 'reports'), { recursive: true });
  await ensureAuditHeader();
  await appendFile(
    REPORT_PATH,
    [
      '',
      `## ${generatedAt} - ${metadata.commit.slice(0, 12)}`,
      '',
      `- Commit: \`${metadata.commit}\``,
      `- Branch: \`${metadata.branch}\``,
      `- Dirty worktree: \`${metadata.dirty ? 'yes' : 'no'}\``,
      `- Fixture set hash: \`${fixtureHash}\``,
      `- Scoring version: \`${SCORING_VERSION}\``,
      '- Command: `npm run eval:accuracy:audit`',
      '',
      '| Adapter | Fixtures | Detection F1 | Impact F1 | Repair Oracle | Gold Patch | Repair Files F1 | False-safe | Score |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...metrics.map((metric) =>
        [
          metric.adapter,
          metric.fixtures,
          metric.upstream.f1.toFixed(3),
          metric.impactSites.f1.toFixed(3),
          metric.repairOraclePassRate.toFixed(3),
          metric.repairGoldPatchExactRate.toFixed(3),
          metric.repairChangedFiles.f1.toFixed(3),
          metric.falseSafeCount,
          metric.costSensitiveScore.toFixed(3),
        ]
          .join(' | ')
          .replace(/^/, '| ')
          .replace(/$/, ' |'),
      ),
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`wrote ${REPORT_PATH}`);
}

async function ensureAuditHeader(): Promise<void> {
  try {
    await readFile(REPORT_PATH, 'utf8');
  } catch {
    await writeFile(
      REPORT_PATH,
      [
        '# Drift Accuracy Audit Trail',
        '',
        'Each entry records the benchmark metrics for one commit and fixture-set hash.',
        'Generated deterministic reports remain reproducible; this file is the historical run log.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

async function runMetadata(): Promise<{ commit: string; branch: string; dirty: boolean }> {
  const [commit, branch, status] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['branch', '--show-current']),
    git(['status', '--porcelain']),
  ]);

  return { commit, branch, dirty: status.length > 0 };
}

async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', [...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listFiles(root)) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
