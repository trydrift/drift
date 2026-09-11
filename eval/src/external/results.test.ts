import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DATASETS } from './dataset.ts';
import { computeMetrics } from './metrics.ts';
import type { ExternalCaseResult } from './record.ts';
import { resultsDir, selectionDocument, writeRun, type RunManifest } from './results.ts';
import { select } from './selection.ts';

/**
 * Provenance is the load-bearing property of every artifact here.
 *
 * Every other honesty rule in this harness — "no percentage was typed by
 * hand", "every number names the build that produced it" — rests on the
 * manifest being true. It was not: `writeRun` rebuilt the manifest from the
 * current git revision on every call, so re-scoring a run stamped it with
 * today's commit and the artifact then claimed observations had been produced
 * by a build that never saw them.
 */

const CASE: ExternalCaseResult = {
  schemaVersion: 'drift-external-case-v1',
  caseId: 'c',
  provenance: {
    dataset: 'roseau',
    datasetVersion: 'doi',
    recordId: 'r',
    repository: 'https://example.invalid/r',
    commit: 'deadbeef',
    baseCommit: null,
    dependency: null,
    fromVersion: null,
    toVersion: null,
    packageManager: null,
    requiredRuntime: null,
    oracleCommand: null,
    containerImage: null,
    sourceHash: 'h',
    extra: {},
  },
  truth: { label: 'l', mappedTo: null, mappingStatus: 'exact', mappingNote: '', polarity: 'positive' },
  prediction: {},
  outcomes: { detectedBreaking: true },
  excluded: null,
  durationMs: 1,
};

async function write(root: string, runId: string, priorManifest?: RunManifest): Promise<RunManifest> {
  const dataset = DATASETS['roseau']!;
  await writeRun({
    runId,
    dataset,
    datasetVersion: 'doi',
    selection: select([{ id: 'c', strata: [] }]),
    environment: { capturedAt: 'now', platform: 'test', arch: 'test', node: 'v0', tools: [] },
    results: [CASE],
    metrics: computeMetrics({ dataset, available: 1, results: [CASE] }),
    ...(priorManifest ? { priorManifest } : {}),
    root,
  });
  return JSON.parse(await readFile(join(resultsDir(runId, root), 'manifest.json'), 'utf8')) as RunManifest;
}

test('a re-score preserves the run it re-scores, and records itself separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-results-test-'));
  try {
    const first = await write(root, 'run-a');

    const forged: RunManifest = {
      ...first,
      createdAt: '2020-01-01T00:00:00.000Z',
      driftCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      command: 'the original command',
    };
    const rescored = await write(root, 'run-a', forged);

    assert.equal(rescored.createdAt, '2020-01-01T00:00:00.000Z', 'the observation date must not move');
    assert.equal(rescored.driftCommit, forged.driftCommit, 'the build that produced the observations must not move');
    assert.equal(rescored.command, 'the original command', 'the command that produced them must not move');
    assert.ok(rescored.rescoredAt, 'the re-score records its own timestamp');
    assert.ok(rescored.rescoredAtCommit, 'and its own commit');
    assert.notEqual(rescored.rescoredAt, rescored.createdAt, 'the two dates are separate facts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a genuine run stamps itself and carries no re-score footprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-results-test-'));
  try {
    const manifest = await write(root, 'run-b');
    assert.equal(manifest.rescoredAt, undefined, 'a first run has not been re-scored');
    assert.equal(manifest.runId, 'run-b');
    assert.ok(manifest.createdAt.startsWith('20'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a caller-supplied revision is stamped as-is, not re-derived from git status', async () => {
  /*
   * `writeRun` writes into `eval/results/<runId>/`, a tracked directory. A
   * republished run id already has committed contents there, so a `git
   * status` taken *inside* `writeRun` — after the caller's own provisional
   * manifest and environment snapshot already landed there — sees this run's
   * own writes as uncommitted changes and reports `dirty: true` no matter how
   * clean the checkout was when the run started. The fix is that a caller who
   * captured the revision before writing anything can hand it to `writeRun`
   * and have it stamped verbatim.
   */
  const root = await mkdtemp(join(tmpdir(), 'drift-results-test-'));
  try {
    const dataset = DATASETS['roseau']!;
    await writeRun({
      runId: 'run-revision',
      dataset,
      datasetVersion: 'doi',
      selection: select([{ id: 'c', strata: [] }]),
      environment: { capturedAt: 'now', platform: 'test', arch: 'test', node: 'v0', tools: [] },
      results: [CASE],
      metrics: computeMetrics({ dataset, available: 1, results: [CASE] }),
      root,
      revision: { commit: 'cafecafecafecafecafecafecafecafecafecafe', dirty: false },
    });
    const manifest = JSON.parse(
      await readFile(join(resultsDir('run-revision', root), 'manifest.json'), 'utf8'),
    ) as RunManifest;
    assert.equal(manifest.driftCommit, 'cafecafecafecafecafecafecafecafecafecafe');
    assert.equal(manifest.driftTreeDirty, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the report names the build that produced the observations, not the one that scored them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-results-test-'));
  try {
    const first = await write(root, 'run-c');
    await write(root, 'run-c', { ...first, driftCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const report = await readFile(join(resultsDir('run-c', root), 'report.md'), 'utf8');
    assert.match(report, /bbbbbbbbbb/, 'the observing commit belongs in the provenance table');
    assert.match(report, /Re-scored/, 'and the re-score is disclosed rather than hidden');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * Resume.
 *
 * The property that matters is that resuming produces one artifact covering
 * the whole selection with each case exactly once. A resume that duplicated a
 * case would inflate every denominator it appears in, and a resume that
 * dropped the earlier attempt's work would make the feature pointless.
 */
test('a resumed run carries the earlier attempt forward exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-resume-test-'));
  try {
    const dataset = DATASETS['roseau']!;
    const earlier: ExternalCaseResult[] = [
      { ...CASE, caseId: 'a' },
      { ...CASE, caseId: 'b' },
    ];
    const thisAttempt: ExternalCaseResult[] = [{ ...CASE, caseId: 'c' }];
    const results = [...earlier, ...thisAttempt];

    await writeRun({
      runId: 'resumed',
      dataset,
      datasetVersion: 'doi',
      selection: select([
        { id: 'a', strata: [] },
        { id: 'b', strata: [] },
        { id: 'c', strata: [] },
      ]),
      environment: { capturedAt: 'now', platform: 'test', arch: 'test', node: 'v0', tools: [] },
      results,
      metrics: computeMetrics({ dataset, available: 3, results }),
      root,
    });

    const metrics = JSON.parse(
      await readFile(join(resultsDir('resumed', root), 'metrics.json'), 'utf8'),
    ) as { selected: number; scored: number };
    assert.equal(metrics.selected, 3, 'the artifact covers the whole selection');
    assert.equal(metrics.scored, 3);
    assert.equal(new Set(results.map((entry) => entry.caseId)).size, results.length, 'and no case appears twice');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * `selection.json` is a required artifact — `site/scripts/sync-benchmarks.mjs`
 * parses it on every build — and it had two writers producing *different*
 * documents for the same path: the runner wrote every case id the moment the
 * selection was decided, and `writeRun` wrote a summary that omits the ids for
 * a whole-corpus run. A megabyte and 28KB, racing.
 *
 * `kong-rq1-documented/selection.json` lost that race in a way nothing caught
 * until the site build: a complete document, then the orphaned tail of the
 * longer one that had been written underneath it. Unparseable, and the whole
 * benchmark refresh was unmergeable because of it.
 *
 * The two writers now build the document through one function, so they cannot
 * disagree about its length.
 */
test('both writers of selection.json produce the same document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-selection-'));
  try {
    const dataset = DATASETS['roseau']!;
    const selection = select([{ id: 'c', strata: [] }]);

    await write(root, 'run-a');
    const written = await readFile(join(resultsDir('run-a', root), 'selection.json'), 'utf8');

    // The runner's early write, built from the shared helper, must be byte-identical
    // to what the final artifact write puts down — otherwise one can outlive the other.
    assert.equal(`${JSON.stringify(selectionDocument(selection, dataset), null, 2)}\n`, written);

    // And it must parse. The failure this guards produced valid JSON followed by
    // trailing data, which `JSON.parse` rejects and a length check would not.
    assert.doesNotThrow(() => JSON.parse(written) as unknown);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a whole-corpus selection omits the id list rather than restating the corpus', () => {
  const dataset = DATASETS['roseau']!;
  const all = select([{ id: 'a', strata: [] }, { id: 'b', strata: [] }]);
  const doc = selectionDocument(all, dataset) as { mode: string; ids: string[]; idsOmitted?: string };

  if (doc.mode === 'all') {
    assert.deepEqual(doc.ids, [], 'a whole-corpus run writes no id list');
    assert.match(doc.idsOmitted ?? '', /every available case/);
  }
});
