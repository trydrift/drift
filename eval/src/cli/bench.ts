import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runBenchmark } from '../bench.ts';
import { evaluateRun } from '../evaluate.ts';
import { renderReport } from '../report/bench-report.ts';
import { loadPublicCases } from '../case/load.ts';
import { listRuns } from '../runs/store.ts';
import type { Track } from '../artifacts/prediction.ts';

/**
 * The benchmark command surface.
 *
 * Deliberately split into `run` (produce artifacts, may cost money) and
 * `evaluate` (score artifacts, always free and always offline). Anyone can
 * re-score a paid run, and CI can validate the evaluator without making a
 * single model call.
 */

const DETERMINISTIC_TRACKS: Track[] = ['detect-end-to-end', 'repair-codemod'];
const LIVE_TRACKS: Track[] = ['repair-fixplan-model', 'repair-agent', 'repair-full-remediation'];

function usage(): string {
  return [
    'Usage:',
    '  eval:bench run [--tracks a,b] [--cases a,b] [--trials N] [--run-id ID] [--agent codex] [--model M] [--effort E]',
    '  eval:bench evaluate <run-id> [--out FILE]',
    '  eval:bench runs',
    '',
    `Deterministic tracks (no model calls): ${DETERMINISTIC_TRACKS.join(', ')}`,
    `Live tracks (cost money, require a configured model or agent): ${LIVE_TRACKS.join(', ')}`,
  ].join('\n');
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];

  if (command === 'runs') {
    const runs = await listRuns();
    console.log(runs.length === 0 ? 'No runs recorded.' : runs.join('\n'));
    return 0;
  }

  if (command === 'run') {
    const tracks = (flag(argv, 'tracks')?.split(',').filter(Boolean) as Track[] | undefined) ?? DETERMINISTIC_TRACKS;
    const live = tracks.filter((track) => LIVE_TRACKS.includes(track));

    // Stated up front rather than discovered from a bill. A live track is
    // opt-in by naming it, and naming it prints what it will do.
    if (live.length > 0) {
      console.log(`Live tracks selected: ${live.join(', ')}. These make real model/agent calls.`);
    }

    const { runId, artifacts } = await runBenchmark({
      tracks,
      ...(flag(argv, 'cases') ? { caseIds: flag(argv, 'cases')!.split(',').filter(Boolean) } : {}),
      ...(flag(argv, 'trials') ? { trials: Number(flag(argv, 'trials')) } : {}),
      ...(flag(argv, 'run-id') ? { runId: flag(argv, 'run-id')! } : {}),
      fixPlan: {
        // `repair-fixplan-cache` restores plans an *earlier* run authored and
        // the gate accepted. Pointing a model run at the same directory is how
        // one gets populated, through production's own `cache.put`; without a
        // directory the cache track reports `cache-unavailable` and is
        // excluded from every rate rather than scored as a failure.
        ...(flag(argv, 'fixplan-cache') ? { cacheDir: flag(argv, 'fixplan-cache')! } : {}),
      },
      agent: {
        ...(flag(argv, 'agent') ? { agentId: flag(argv, 'agent')! } : {}),
        ...(flag(argv, 'model') ? { model: flag(argv, 'model')! } : {}),
        ...(flag(argv, 'effort') ? { effort: flag(argv, 'effort') as 'low' | 'medium' | 'high' | 'xhigh' } : {}),
        ...(flag(argv, 'timeout') ? { timeoutSeconds: Number(flag(argv, 'timeout')) } : {}),
      },
    });

    console.log(`run ${runId}: ${artifacts.length} artifact(s) written to eval/runs/${runId}/predictions/`);
    return 0;
  }

  if (command === 'evaluate') {
    const runId = argv[1];
    if (!runId) {
      console.error(usage());
      return 2;
    }

    const result = await evaluateRun(runId);
    const report = renderReport({ result, cases: await loadPublicCases() });

    const out = flag(argv, 'out');
    if (out) {
      await mkdir(join(process.cwd(), 'eval', 'reports'), { recursive: true });
      await writeFile(out, `${report}\n`, 'utf8');
      console.log(`report written to ${out}`);
    } else {
      console.log(report);
    }

    // A product miss is a result and never fails this command. Only an
    // integrity break does — a false-safe, a production scope escape, an
    // unaudited workspace, or a stale artifact scored against evidence it
    // never saw.
    if (result.integrityFailures.length > 0) {
      console.error('\nIntegrity failures:');
      for (const failure of result.integrityFailures) console.error(`  - ${failure}`);
      return 1;
    }
    return 0;
  }

  console.error(usage());
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
