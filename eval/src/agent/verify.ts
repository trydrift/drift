import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { README_BLOCK_BEGIN, README_BLOCK_END } from './report.ts';

/**
 * The agent benchmark is internal, and this is what keeps it so.
 *
 * It used to feed a README block, a `/benchmarks/agent` page and a homepage
 * card built to show "N% fewer agent input tokens" the moment its publication
 * gates passed. Held-out runs then showed that no Drift configuration beats an
 * unaided agent on both tokens and correctness (`eval/reports/agent/
 * final-verdict.md`), so every one of those surfaces was removed. A teaser for
 * a result that is not coming is worse than no mention at all.
 *
 * This fails the build if any of them comes back:
 *
 *   - README.md carries an agent-benchmark block;
 *   - the site carries a copy of the summary, or a page to render one;
 *   - a public document states a percentage that reads as an agent-benchmark
 *     claim — fewer input tokens, or remediations that rose.
 *
 * Runs in CI. The harness, cases and reports stay; only publishing is gone.
 */

export interface VerifyFinding {
  file: string;
  problem: string;
}

/** Documents a reader sees. Any agent-benchmark figure in one of these is a public claim. */
const PUBLIC_DOCUMENTS = [
  'README.md',
  'docs/overview.md',
  'docs/research.md',
  'eval/agent/README.md',
  'site/src/app/page.tsx',
];

const CLAIM = /\d+(?:\.\d+)?%\s*(?:fewer|less)\s+(?:agent\s+)?input tokens|successful (?:dependency )?remediations?\s+(?:increased|rose|from)\s+\d+/i;

export async function verifyPublicClaims(root = process.cwd()): Promise<VerifyFinding[]> {
  const findings: VerifyFinding[] = [];

  const readme = await readFile(join(root, 'README.md'), 'utf8').catch(() => null);
  if (readme !== null && (readme.includes(README_BLOCK_BEGIN) || readme.includes(README_BLOCK_END))) {
    findings.push({ file: 'README.md', problem: 'carries an agent-benchmark block; the agent benchmark is internal and publishes nothing' });
  }

  for (const surface of ['site/src/data/benchmarks/agent.json', 'site/src/app/benchmarks/agent/page.tsx']) {
    if (await exists(join(root, surface))) {
      findings.push({ file: surface, problem: 'publishes the agent benchmark; it is internal and publishes nothing' });
    }
  }

  for (const file of PUBLIC_DOCUMENTS) {
    const text = await readFile(join(root, file), 'utf8').catch(() => null);
    if (text === null) continue;
    const match = CLAIM.exec(text);
    if (match) findings.push({ file, problem: `states an agent-benchmark figure: "${match[0]}"` });
  }

  return findings;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
