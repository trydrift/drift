import { join } from 'node:path';
import { mineRepositories } from '../corpus/mine-npm.ts';

/**
 * `eval:corpus:mine` — Layer A. Emits candidates and rejections; promotes
 * nothing. A candidate becomes a case only after the reproducibility gate and
 * independent review have both ruled on it.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const repositories = argv.filter((arg) => /^[\w.-]+\/[\w.-]+$/.test(arg));
  if (repositories.length === 0) {
    console.error('Usage: eval:corpus:mine <owner/repo> [<owner/repo> …] [--max N] [--since YYYY-MM-DD]');
    return 2;
  }

  const max = Number(argv[argv.indexOf('--max') + 1]) || 3;
  const since = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : undefined;
  const outputDir = join(process.cwd(), 'eval', 'corpus');

  const result = await mineRepositories({
    repositories,
    maxPerRepository: max,
    ...(since ? { since } : {}),
    outputDir,
  });

  console.log(`\n${result.candidates.length} candidate(s), ${result.rejections.length} rejection(s).\n`);

  for (const candidate of result.candidates) {
    console.log(
      `candidate ${candidate.repository}#${candidate.prNumber}: ${candidate.dependency.name} ${candidate.dependency.fromVersion} -> ${candidate.dependency.toVersion}` +
        ` · ${candidate.developerPatchFiles.length} source file(s)` +
        (candidate.unrelatedFiles.length > 0 ? ` · ${candidate.unrelatedFiles.length} unrelated file(s) — causality risk` : ''),
    );
  }

  // The rejection histogram is the most informative output here: it is this
  // miner's own selection bias, stated rather than hidden.
  const byReason = new Map<string, number>();
  for (const rejection of result.rejections) byReason.set(rejection.reason, (byReason.get(rejection.reason) ?? 0) + 1);
  if (byReason.size > 0) {
    console.log('\nrejections by reason:');
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
