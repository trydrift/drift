import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KONG_CATEGORY_MAPPING, MappingTable } from '../mapping.ts';
import { MARKER_BASELINE, parseCsv, scoreKong, statesDetail, type KongRecord } from './kong.ts';

/**
 * The importer, offline.
 *
 * No dataset, no network. Every record here is written for this file rather
 * than copied from Kong, both to avoid redistributing someone else's data in a
 * test and because the shapes that break an importer are easier to write than
 * to find: a commit message containing a comma, a quote, a CRLF and a blank
 * line, all inside one CSV field.
 *
 * That parser is the highest-risk code in the adapter. A wrong parse does not
 * throw — it shifts every label one column left and produces a complete,
 * plausible, entirely wrong result set.
 */

const record = (overrides: Partial<KongRecord> = {}): KongRecord => ({
  id: 'acme/widget@abc123#0',
  project: 'acme/widget',
  commit: 'abc123',
  commitMessage: 'fix: something\n\nBREAKING CHANGE: removed `oldName`, use `newName` instead\n',
  category: 'remove method',
  documentationPlace: 'pr/issue',
  ...overrides,
});

const score = (overrides: Partial<KongRecord>, kinds: string[], count = kinds.length) =>
  scoreKong({
    record: record(overrides),
    experiment: 'rq2-category',
    prediction: {
      breakingChanges: kinds.map((kind) => ({ kind, symbols: ['oldName'] })) as never,
      passages: ['BREAKING CHANGE: removed `oldName`'],
    },
    datasetVersion: 'test-doi',
    sourceHash: 'test-hash',
    durationMs: 1,
  });

test('a multi-line, quoted, comma-bearing commit message survives the CSV parse intact', () => {
  const csv = [
    'project,commit_id,commit_message,document_breaking_change',
    '"acme/widget",abc123,"feat: add a thing\r\n\r\nBREAKING CHANGE: ""quoted"", and comma-bearing\r\nsecond line",yes',
    'acme/other,def456,"plain",no',
  ].join('\n');

  const rows = parseCsv(csv);
  assert.equal(rows.length, 2, 'a record spanning several physical lines is still one record');
  assert.equal(rows[0]!['project'], 'acme/widget');
  assert.equal(rows[0]!['document_breaking_change'], 'yes', 'the label must not shift a column');
  assert.match(rows[0]!['commit_message']!, /BREAKING CHANGE: "quoted", and comma-bearing/);
  assert.match(rows[0]!['commit_message']!, /second line/);
  assert.equal(rows[1]!['document_breaking_change'], 'no');
});

test('a byte-order mark does not become part of the first column name', () => {
  const rows = parseCsv('﻿project,commit_id\nacme/widget,abc123\n');
  assert.equal(rows[0]!['project'], 'acme/widget', 'a BOM-prefixed header would key this as "\\ufeffproject"');
});

test('the marker baseline reads only the marker, and reads it case-insensitively', () => {
  assert.equal(MARKER_BASELINE.test('BREAKING CHANGE: x'), true);
  assert.equal(MARKER_BASELINE.test('breaking-change: x'), true);
  assert.equal(MARKER_BASELINE.test('BREAKING CHANGES'), true);
  assert.equal(MARKER_BASELINE.test('this is a breaking bug fix'), false, '"breaking" alone is not the marker');
});

test('a message that is only the marker is recorded as stating no detail', () => {
  assert.equal(statesDetail('refactor: x\n\nBREAKING CHANGE\n'), false);
  assert.equal(statesDetail('refactor: x\n\nBREAKING CHANGE:\n'), false);
  assert.equal(statesDetail('BREAKING CHANGE: removed oldName, use newName instead'), true);
});

/*
 * Mapping. The property under test is that the table refuses rather than
 * guesses — a generous mapping is how a corpus's coverage improves and its
 * accuracy figure quietly starts measuring the mapping.
 */

test('only change_signature maps exactly, and the declaration families are ambiguous', () => {
  assert.equal(KONG_CATEGORY_MAPPING.lookup('change_signature').status, 'exact');
  for (const label of ['remove method', 'rename class', 'move module', 'remove field']) {
    const mapping = KONG_CATEGORY_MAPPING.lookup(label);
    assert.equal(mapping.status, 'ambiguous', `${label} must not be scored`);
    assert.ok(mapping.note.length > 0, `${label} must carry the reason it is not scored`);
    assert.equal(MappingTable.scorable(mapping.status), false);
  }
});

test('a label the table has never seen is unsupported, never silently dropped', () => {
  const mapping = KONG_CATEGORY_MAPPING.lookup('some future category');
  assert.equal(mapping.status, 'unsupported');
  assert.match(mapping.note, /No mapping is declared/);
});

test('label lookup is insensitive to case and separator style', () => {
  assert.equal(KONG_CATEGORY_MAPPING.lookup('Change_Signature').status, 'exact');
  assert.equal(KONG_CATEGORY_MAPPING.lookup('change signature').status, 'exact');
});

/*
 * Scoring. The distinction that matters most: detection is answerable for
 * every record, and category correctness only for a mappable one.
 */

test('detection is scored on an unmappable record; category is not', () => {
  const result = score({ category: 'remove method' }, ['removed-export']);
  assert.equal(result.excluded, null, 'an unmappable label must not exclude the whole case');
  assert.equal(result.outcomes.detectedBreaking, true);
  assert.equal(result.outcomes.categoryCorrect, undefined, 'the question was not asked, so there is no answer');
});

test('category is scored on a mappable record, and is correct when the kind is among those produced', () => {
  assert.equal(score({ category: 'change_signature' }, ['signature-change']).outcomes.categoryCorrect, true);
  assert.equal(score({ category: 'change_signature' }, ['behaviour-change']).outcomes.categoryCorrect, false);
});

test('a message describing several changes is not marked wrong for ordering', () => {
  const result = score({ category: 'change_signature' }, ['behaviour-change', 'signature-change']);
  assert.equal(result.outcomes.categoryCorrect, true);
});

test('producing nothing is a miss, not an exclusion', () => {
  const result = score({ category: 'change_signature' }, []);
  assert.equal(result.excluded, null);
  assert.equal(result.outcomes.detectedBreaking, false);
  assert.equal(result.outcomes.categoryCorrect, false);
});

test('every case carries the provenance needed to find the original commit again', () => {
  const result = score({}, ['removed-export']);
  assert.equal(result.provenance.repository, 'https://github.com/acme/widget');
  assert.equal(result.provenance.commit, 'abc123');
  assert.equal(result.provenance.datasetVersion, 'test-doi');
  assert.match(result.provenance.extra['commitMessageSha256']!, /^[0-9a-f]{64}$/);
  assert.equal(result.provenance.extra['markerBaselinePredictsBreaking'], 'true');
});

test('the baseline prediction is stored per case, so a re-score can rebuild it offline', () => {
  // Without this the marker baseline would silently vanish the first time a
  // past run was re-scored, which is worse than never having published one.
  const withMarker = score({}, []);
  const withoutMarker = score({ commitMessage: 'chore: tidy up\n' }, []);
  assert.equal(withMarker.provenance.extra['markerBaselinePredictsBreaking'], 'true');
  assert.equal(withoutMarker.provenance.extra['markerBaselinePredictsBreaking'], 'false');
});
