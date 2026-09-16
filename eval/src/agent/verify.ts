import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { README_BLOCK_BEGIN, README_BLOCK_END, renderReadmeBlock } from './report.ts';
import { readLatestSummary, type AgentBenchmarkSummary } from './summary.ts';

/**
 * Stale-metric detection.
 *
 * Public surfaces may only carry numbers that the canonical summary produced,
 * and only while the summary still says they are publishable:
 *
 *   - the README's fenced block must equal what `renderReadmeBlock` produces
 *     from `latest.json` right now;
 *   - the site's copy of the summary must equal `latest.json` byte for byte;
 *   - when the gates are not met, none of the guarded documents may contain a
 *     percentage that looks like a benchmark claim next to the words "agent
 *     input tokens" or "successful remediations".
 *
 * Runs in CI. A stale README after a re-aggregation fails the build rather
 * than quoting a number the evidence no longer supports.
 */

export interface VerifyFinding {
  file: string;
  problem: string;
}

export async function verifyPublicClaims(root = process.cwd(), summary?: AgentBenchmarkSummary | null): Promise<VerifyFinding[]> {
  const findings: VerifyFinding[] = [];
  const latest = summary === undefined ? await readLatestSummary(root) : summary;

  // README block.
  const readmePath = join(root, 'README.md');
  const readme = await readFile(readmePath, 'utf8').catch(() => null);
  if (readme === null) findings.push({ file: 'README.md', problem: 'missing' });
  else {
    const begin = readme.indexOf(README_BLOCK_BEGIN);
    const end = readme.indexOf(README_BLOCK_END);
    if (begin < 0 || end < 0 || end < begin) {
      findings.push({ file: 'README.md', problem: `no ${README_BLOCK_BEGIN} … ${README_BLOCK_END} block; run \`npm run benchmark:agent:report\`` });
    } else {
      const actual = readme.slice(begin, end + README_BLOCK_END.length);
      const expected = renderReadmeBlock(latest);
      if (actual !== expected) findings.push({ file: 'README.md', problem: 'the agent-benchmark block differs from what latest.json generates; run `npm run benchmark:agent:report`' });
    }
  }

  // Site copy.
  const sitePath = join(root, 'site', 'src', 'data', 'benchmarks', 'agent.json');
  const siteCopy = await readFile(sitePath, 'utf8').catch(() => null);
  const latestRaw = await readFile(join(root, 'eval', 'results', 'agent', 'latest.json'), 'utf8').catch(() => null);
  if (siteCopy === null) findings.push({ file: 'site/src/data/benchmarks/agent.json', problem: 'missing; run `npm run sync` in site/' });
  else if (latestRaw === null) {
    if (!/"status":\s*"no-result"/.test(siteCopy)) findings.push({ file: 'site/src/data/benchmarks/agent.json', problem: 'carries a result but eval/results/agent/latest.json does not exist' });
  } else if (normalize(siteCopy) !== normalize(latestRaw)) {
    findings.push({ file: 'site/src/data/benchmarks/agent.json', problem: 'differs from eval/results/agent/latest.json; run `npm run sync` in site/' });
  }

  // Ungated claims in prose.
  if (!latest || !latest.publication.eligible) {
    const guarded = ['README.md', 'docs/overview.md', 'docs/research.md', 'eval/agent/README.md'];
    const claim = /\d+(?:\.\d+)?%\s*(?:fewer|less)\s+(?:agent\s+)?input tokens|successful (?:dependency )?remediations?\s+(?:increased|rose|from)\s+\d+/i;
    for (const file of guarded) {
      const text = await readFile(join(root, file), 'utf8').catch(() => null);
      if (text === null) continue;
      const stripped = readmeWithoutBlock(text);
      const match = claim.exec(stripped);
      if (match) findings.push({ file, problem: `quantitative claim without a publishable result: "${match[0]}"` });
    }
  }

  return findings;
}

function readmeWithoutBlock(text: string): string {
  const begin = text.indexOf(README_BLOCK_BEGIN);
  const end = text.indexOf(README_BLOCK_END);
  if (begin < 0 || end < 0) return text;
  return text.slice(0, begin) + text.slice(end + README_BLOCK_END.length);
}

function normalize(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}
