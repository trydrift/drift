import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFixtureRevision } from '../hash.ts';
import { loadFixtures } from '../load.ts';
import { fixtureDir, loadAdjudication, loadReviews } from '../review.ts';
import { summarizeReviews } from './reviews.ts';

/**
 * A packet suitable for handing to another AI or human for a second opinion.
 * Deliberately excludes any hidden chain-of-thought: only the persisted
 * evidence, rationale, conclusions, uncertainty, and provenance fields a
 * review record already carries — the same fields a reader of this repo
 * could see.
 */
export interface ReviewExportPacket {
  fixture: {
    id: string;
    ecosystem: string;
    dependency: string;
    fromVersion: string;
    toVersion: string;
    scenarioLabel: string;
    complexity: string;
    network: string;
    readiness: string;
  };
  hashes: Awaited<ReturnType<typeof hashFixtureRevision>>;
  upstreamOld: Record<string, string>;
  upstreamNew: Record<string, string>;
  consumer: Record<string, string>;
  reviews: Awaited<ReturnType<typeof loadReviews>>;
  /** Per-review current/stale status, so a reader can tell superseded evidence from what's actually accepted. */
  reviewsStatus: Awaited<ReturnType<typeof summarizeReviews>>['reviews'];
  adjudication: Awaited<ReturnType<typeof loadAdjudication>>;
  /** Whether `adjudication` fairly reflects the accepted review(s), and why not if it doesn't — see `eval/src/review.ts`. */
  adjudicationDelta: Awaited<ReturnType<typeof summarizeReviews>>['adjudicationDelta'];
  disagreementSummary: Awaited<ReturnType<typeof summarizeReviews>>['disagreements'];
}

export async function exportReviewPacket(fixtureId: string, root?: string): Promise<ReviewExportPacket> {
  const fixtures = await loadFixtures(root);
  const fixture = fixtures.find((f) => f.id === fixtureId);
  if (!fixture) throw new Error(`Unknown fixture ${fixtureId}`);

  const dir = fixtureDir(fixtureId, root);
  const fixtureYamlBody = await readFile(join(dir, 'fixture.yml'), 'utf8');
  const [hashes, upstreamOld, upstreamNew, consumer, reviews, adjudication, summary] = await Promise.all([
    hashFixtureRevision(dir, fixtureYamlBody),
    readTextFiles(join(dir, 'upstream', 'old')),
    readTextFiles(join(dir, 'upstream', 'new')),
    readTextFiles(join(dir, 'consumer')),
    loadReviews(fixtureId, root),
    loadAdjudication(fixtureId, root),
    summarizeReviews(fixtureId, root),
  ]);

  return {
    fixture: {
      id: fixture.id,
      ecosystem: fixture.ecosystem,
      dependency: fixture.dependency,
      fromVersion: fixture.fromVersion,
      toVersion: fixture.toVersion,
      scenarioLabel: fixture.scenarioLabel,
      complexity: fixture.complexity,
      network: fixture.network,
      readiness: fixture.readiness,
    },
    hashes,
    upstreamOld,
    upstreamNew,
    consumer,
    reviews,
    reviewsStatus: summary.reviews,
    adjudication,
    adjudicationDelta: summary.adjudicationDelta,
    disagreementSummary: summary.disagreements,
  };
}

async function readTextFiles(root: string): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises');
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relPath);
      } else {
        try {
          out[relPath] = await readFile(join(dir, entry.name), 'utf8');
        } catch {
          out[relPath] = '<binary or unreadable>';
        }
      }
    }
  };
  await walk(root, '');
  return out;
}

export async function runExportCli(argv = process.argv.slice(2)): Promise<number> {
  const fixtureId = argv.find((a) => !a.startsWith('--'));
  if (!fixtureId) {
    console.error('usage: npm run eval:review:export -- <fixture-id>');
    return 1;
  }
  const packet = await exportReviewPacket(fixtureId);
  console.log(JSON.stringify(packet, null, 2));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runExportCli();
}
