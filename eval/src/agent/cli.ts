import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitCase, recordAdmissions } from './admission.ts';
import { listCaseIds, loadSuite } from './cases.ts';
import { ClaudeCodeProvider } from './providers/claude-code.ts';
import { README_BLOCK_BEGIN, README_BLOCK_END, renderPublicCopy, renderReadmeBlock, renderReport } from './report.ts';
import { rescoreRuns } from './rescore.ts';
import { runBenchmark } from './runner.ts';
import type { Condition } from './schema.ts';
import { listRuns, reportsRoot } from './store.ts';
import { buildSummary, readLatestSummary, writeSummary } from './summary.ts';
import { verifyPublicClaims } from './verify.ts';

/**
 * The command surface.
 *
 *   run             produce trial artifacts (costs money)
 *   validate-cases  admission checks; `--write` records passes in a draft suite
 *   aggregate       canonical summary from one or more runs (free, offline)
 *   report          markdown report, README block and public copy from latest.json
 *   verify          stale public metrics fail here
 *   runs / cases    listings
 */

function usage(): string {
  return [
    'Usage:',
    '  benchmark:agent run --suite <suite> [--case <id>] [--runs N] [--model M] [--effort E] [--conditions baseline,drift]',
    '                      [--run-id ID] [--retry-infrastructure] [--web-tools allow|disabled] [--no-drift-verify] [--max-budget-usd X] [--max-turns N] [--notes TEXT]',
    '  benchmark:agent validate-cases [--suite <suite>] [--case <id>] [--repeats N] [--write]',
    '  benchmark:agent aggregate --runs a,b [--out latest]',
    '  benchmark:agent rescore --runs a,b        # re-evaluate diff-derivable rules after a case changed; marks the artifacts',
    '  benchmark:agent report',
    '  benchmark:agent verify',
    '  benchmark:agent runs | cases | suites',
    '',
    'Defaults: --runs 5, --model claude-sonnet-5, --effort high, provider claude-code, web tools disabled, Drift --verify on.',
  ].join('\n');
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  const root = process.cwd();
  const log = (message: string) => console.log(message);

  if (command === 'runs') {
    const runs = await listRuns(root);
    log(runs.length === 0 ? 'No runs recorded.' : runs.join('\n'));
    return 0;
  }

  if (command === 'cases') {
    log((await listCaseIds(root)).join('\n') || 'No cases.');
    return 0;
  }

  if (command === 'suites') {
    const { listSuites } = await import('./cases.ts');
    log((await listSuites(root)).join('\n') || 'No suites.');
    return 0;
  }

  if (command === 'validate-cases') {
    const single = flag(argv, 'case');
    const suite = flag(argv, 'suite');
    let ids: string[];
    if (single) ids = [single];
    else if (suite) {
      const manifest = await loadSuite(suite, root).catch(() => null);
      ids = manifest ? manifest.cases.map((c) => c.id) : await listCaseIds(root);
    } else ids = await listCaseIds(root);
    const repeats = Number(flag(argv, 'repeats') ?? 2);
    const results = [];
    for (const id of ids) {
      const result = await admitCase(id, { repeats, root, onProgress: log });
      results.push(result);
      log(`${result.admitted ? 'ADMIT ' : 'REJECT'} ${id}`);
      for (const step of result.steps) log(`  ${step.passed ? '✓' : '✗'} ${step.step}${step.detail ? `: ${step.detail}` : ''}`);
    }
    if (has(argv, 'write')) {
      if (!suite) {
        console.error('--write needs --suite <draft suite>');
        return 2;
      }
      const manifest = await recordAdmissions(suite, results, root);
      log(`suite ${suite}: ${manifest.cases.length} admitted case(s) recorded`);
    }
    return results.every((r) => r.admitted) ? 0 : 1;
  }

  if (command === 'run') {
    const suite = flag(argv, 'suite');
    if (!suite) {
      console.error(usage());
      return 2;
    }
    const model = flag(argv, 'model') ?? 'claude-sonnet-5';
    const effort = flag(argv, 'effort') ?? 'high';
    const runs = Number(flag(argv, 'runs') ?? 5);
    const conditions = flag(argv, 'conditions')?.split(',').filter(Boolean) as Condition[] | undefined;
    log(`Live run: suite ${suite}, ${runs} run(s) per condition, ${model} at effort ${effort}. This makes real model calls.`);
    const outcome = await runBenchmark({
      suite,
      ...(flag(argv, 'case') ? { caseIds: flag(argv, 'case')!.split(',').filter(Boolean) } : {}),
      runs,
      ...(conditions ? { conditions } : {}),
      provider: new ClaudeCodeProvider(),
      model,
      effort,
      webTools: flag(argv, 'web-tools') === 'allow' ? 'allowed' : 'disabled',
      maxBudgetUsd: flag(argv, 'max-budget-usd') ? Number(flag(argv, 'max-budget-usd')) : null,
      maxTurns: flag(argv, 'max-turns') ? Number(flag(argv, 'max-turns')) : null,
      driftVerify: !has(argv, 'no-drift-verify'),
      githubToken: process.env['GITHUB_TOKEN'],
      ...(flag(argv, 'run-id') ? { runId: flag(argv, 'run-id')! } : {}),
      retryInfrastructure: has(argv, 'retry-infrastructure'),
      notes: flag(argv, 'notes') ?? '',
      root,
      onProgress: log,
    });
    log(`run ${outcome.runId}: ${outcome.written} trial(s) written, ${outcome.skipped} skipped, in eval/results/agent/raw/${outcome.runId}/`);
    return 0;
  }

  if (command === 'rescore') {
    const runs = flag(argv, 'runs')?.split(',').filter(Boolean);
    if (!runs?.length) {
      console.error(usage());
      return 2;
    }
    const outcomes = await rescoreRuns(runs, root);
    for (const outcome of outcomes) {
      log(`${outcome.changed ? 'CHANGED ' : 'same    '} ${outcome.trialId}: ${outcome.before.success ? 'success' : `failed [${outcome.before.failureReasons.join(', ')}]`} → ${outcome.after.success ? 'success' : `failed [${outcome.after.failureReasons.join(', ')}]`}`);
    }
    log(`${outcomes.length} trial(s) re-scored, ${outcomes.filter((o) => o.changed).length} changed`);
    return 0;
  }

  if (command === 'aggregate') {
    const runs = flag(argv, 'runs')?.split(',').filter(Boolean);
    if (!runs?.length) {
      console.error(usage());
      return 2;
    }
    const summary = await buildSummary({ runIds: runs, root });
    if (flag(argv, 'out') === 'stdout') {
      log(JSON.stringify(summary, null, 2));
      return 0;
    }
    const paths = await writeSummary(summary, root);
    log(`summary written to ${paths.latest} and ${paths.history}`);
    log(`publication gates: ${summary.publication.eligible ? 'PASS' : 'NOT MET'}${summary.publication.eligible ? '' : ` (${summary.publication.gates.filter((g) => !g.passed).map((g) => g.name).join(', ')})`}`);
    return 0;
  }

  if (command === 'report') {
    const summary = await readLatestSummary(root);
    await mkdir(reportsRoot(root), { recursive: true });
    const reportPath = join(reportsRoot(root), 'latest.md');
    const copyPath = join(reportsRoot(root), 'public-copy.md');
    await writeFile(reportPath, `${summary ? renderReport(summary) : '# Dependency Upgrade Agent Benchmark\n\nNo result has been aggregated yet.'}\n`, 'utf8');
    await writeFile(copyPath, `${renderPublicCopy(summary)}\n`, 'utf8');
    // README block, replaced in place.
    const readmePath = join(root, 'README.md');
    const readme = await readFile(readmePath, 'utf8');
    const begin = readme.indexOf(README_BLOCK_BEGIN);
    const end = readme.indexOf(README_BLOCK_END);
    if (begin >= 0 && end > begin) {
      const updated = readme.slice(0, begin) + renderReadmeBlock(summary) + readme.slice(end + README_BLOCK_END.length);
      if (updated !== readme) await writeFile(readmePath, updated, 'utf8');
    }
    log(`report written to ${reportPath}; public copy to ${copyPath}; README block ${begin >= 0 ? 'refreshed' : 'not present'}`);
    return 0;
  }

  if (command === 'verify') {
    const findings = await verifyPublicClaims(root);
    if (findings.length === 0) {
      log('verify: every public agent-benchmark claim matches eval/results/agent/latest.json');
      return 0;
    }
    for (const finding of findings) console.error(`${finding.file}: ${finding.problem}`);
    return 1;
  }

  console.error(usage());
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
