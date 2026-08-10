import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { severityOf } from '../dist/upgrade/severity.js';
import { DriftConfigSchema } from '../dist/config/schema.js';

/**
 * These recordings are not fixtures written for this suite. They are
 * `site/scripts/capture.mjs` output — real `drift analyze` runs against real
 * open-source repositories (gitlab, kubernetes, deno, scrapy, and eleven
 * others), captured once and replayed on the marketing site. Reusing them
 * here means the only end-to-end coverage of "does Drift survive a real,
 * large, messy repository" isn't limited to the single got/npm walkthrough in
 * docs/testing-on-a-real-repo.md — every ecosystem the site demoes is also a
 * regression check.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'site', 'src', 'data');

interface EvidenceRef {
  source: string;
  title: string;
  url: string | null;
  locator: string | null;
}

interface ImpactSite {
  file: string;
  line: number;
}

interface BreakingChange {
  confidence: 'high' | 'medium' | 'low';
  evidence?: EvidenceRef[];
  sites: ImpactSite[];
}

interface Candidate {
  name: string;
  ecosystem: string;
  status: string;
  breakingCount: number;
  impactCount: number;
  impactFiles: number;
  gaps: string[];
  recommendation: string | null;
  breaking: BreakingChange[];
}

interface Recording {
  id: string;
  ecosystem: string;
  repo: string;
  candidates: Candidate[];
}

async function loadRecordings(): Promise<Recording[]> {
  const entries = await readdir(dataDir);
  const files = entries.filter((name) => name.endsWith('.json') && name !== 'index.json');
  return Promise.all(
    files.map(async (name) => JSON.parse(await readFile(join(dataDir, name), 'utf8')) as Recording),
  );
}

describe('real-repository recordings, replayed as regression fixtures', () => {
  test('one recording per supported ecosystem', async () => {
    const recordings = await loadRecordings();
    const supported = DriftConfigSchema.parse({}).ecosystems;
    const covered = new Set(recordings.map((r) => r.ecosystem));

    assert.equal(recordings.length, supported.length, 'expected one real-repo recording per ecosystem');
    for (const ecosystem of supported) {
      assert.ok(covered.has(ecosystem), `no recording captured for ecosystem "${ecosystem}"`);
    }
  });

  test('every breaking change carries at least one evidence citation', async () => {
    const recordings = await loadRecordings();

    for (const recording of recordings) {
      for (const candidate of recording.candidates) {
        for (const breaking of candidate.breaking) {
          assert.ok(
            breaking.evidence && breaking.evidence.length > 0,
            `${recording.id}: ${candidate.name} has a breaking change with no evidence`,
          );
        }
      }
    }
  });

  test("severityOf's verdict agrees with the recorded counts", async () => {
    const recordings = await loadRecordings();

    for (const recording of recordings) {
      for (const candidate of recording.candidates) {
        const verdict = severityOf({
          status: candidate.status,
          breakingCount: candidate.breakingCount,
          impactCount: candidate.impactCount,
          impactFiles: candidate.impactFiles,
          gaps: candidate.gaps,
          recommendation: candidate.recommendation ?? undefined,
        });

        if (verdict === 'affected') {
          assert.ok(
            candidate.impactCount > 0,
            `${recording.id}: ${candidate.name} verdict "affected" but impactCount is 0`,
          );
        }
        if (verdict === 'clean' || verdict === 'upstream-only') {
          assert.equal(
            candidate.impactCount,
            0,
            `${recording.id}: ${candidate.name} verdict "${verdict}" but impactCount > 0`,
          );
        }
      }
    }
  });

  test('impact sites shown are a subset of the recorded impact count', async () => {
    // capture.mjs keeps only the top 4 breaking changes per candidate and the
    // top 4 sites per breaking change (see site/scripts/capture.mjs), so the
    // sites actually present in the recording undercount impactCount on a
    // large repository. What must still hold is that the truncated sample
    // never *exceeds* the real total, and that "affected" candidates show at
    // least one site.
    const recordings = await loadRecordings();

    for (const recording of recordings) {
      for (const candidate of recording.candidates) {
        const siteCount = candidate.breaking.reduce((sum, b) => sum + b.sites.length, 0);
        assert.ok(
          siteCount <= candidate.impactCount,
          `${recording.id}: ${candidate.name} shows more sites (${siteCount}) than its recorded impactCount (${candidate.impactCount})`,
        );
        if (candidate.impactCount > 0) {
          assert.ok(siteCount > 0, `${recording.id}: ${candidate.name} has impactCount > 0 but no sites shown`);
        }
      }
    }
  });
});
