import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptInBaseline,
  diffHunks,
  diffStat,
  revertInCurrent,
  splitLines,
} from '../extension/src/diff.ts';

/**
 * The keep/undo review UI is only trustworthy if these hold. A hunk with the
 * wrong range does not merely look wrong — it reverts the wrong lines of
 * someone's file, which is the single most damaging thing this extension could
 * do. So the properties tested here are the invariants, not the happy paths:
 *
 *   - keeping every hunk reproduces the modified text exactly;
 *   - undoing every hunk reproduces the baseline text exactly;
 *   - keeping or undoing one hunk leaves the others still correct.
 */

const BASE = ['import { readFile } from "fs";', '', 'export function load(path) {', '  return readFile(path);', '}', ''].join('\n');

test('identical text has no hunks', () => {
  assert.deepEqual(diffHunks(BASE, BASE), []);
});

test('a single changed line is one hunk with both ranges', () => {
  const modified = BASE.replace('  return readFile(path);', '  return readFile(path, "utf8");');
  const hunks = diffHunks(BASE, modified);

  assert.equal(hunks.length, 1);
  const hunk = hunks[0]!;
  assert.equal(hunk.start, 3);
  assert.equal(hunk.end, 4);
  assert.equal(hunk.baselineStart, 3);
  assert.equal(hunk.baselineEnd, 4);
  assert.deepEqual(hunk.baselineLines, ['  return readFile(path);']);
  assert.deepEqual(hunk.modifiedLines, ['  return readFile(path, "utf8");']);
});

test('a pure insertion has an empty baseline range', () => {
  const lines = splitLines(BASE);
  lines.splice(1, 0, 'import { resolve } from "path";');
  const modified = lines.join('\n');

  const hunks = diffHunks(BASE, modified);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.baselineStart, hunks[0]!.baselineEnd);
  assert.deepEqual(hunks[0]!.modifiedLines, ['import { resolve } from "path";']);
});

test('a pure deletion has an empty modified range', () => {
  const lines = splitLines(BASE);
  lines.splice(1, 1);
  const modified = lines.join('\n');

  const hunks = diffHunks(BASE, modified);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.start, hunks[0]!.end);
  assert.equal(hunks[0]!.baselineLines.length, 1);
});

test('distant edits produce separate hunks', () => {
  const modified = BASE.replace('import { readFile } from "fs";', 'import { readFile } from "node:fs/promises";').replace(
    '  return readFile(path);',
    '  return await readFile(path, "utf8");',
  );

  const hunks = diffHunks(BASE, modified);
  assert.equal(hunks.length, 2);
  assert.ok(hunks[0]!.start < hunks[1]!.start, 'hunks are in document order');
});

test('adjacent edits are merged into one hunk', () => {
  // Two changes one line apart read as a single edit to a reviewer, so offering
  // them as two decisions would be busywork.
  const modified = ['a', 'CHANGED', 'x', 'CHANGED2', 'e'].join('\n');
  const baseline = ['a', 'b', 'x', 'd', 'e'].join('\n');

  assert.equal(diffHunks(baseline, modified).length, 1);
});

test('keeping every hunk reproduces the modified text', () => {
  const modified = ['import { readFile } from "node:fs/promises";', '', 'export async function load(path) {', '  return await readFile(path, "utf8");', '}', ''].join('\n');

  let baseline = BASE;
  // Applied back-to-front so earlier splices cannot shift later ranges.
  for (const hunk of diffHunks(BASE, modified).reverse()) {
    baseline = acceptInBaseline(baseline, hunk);
  }

  assert.equal(baseline, modified);
});

test('undoing every hunk reproduces the baseline text', () => {
  const modified = ['import { readFile } from "node:fs/promises";', '', 'export async function load(path) {', '  return await readFile(path, "utf8");', '}', ''].join('\n');

  let current = modified;
  for (const hunk of diffHunks(BASE, modified).reverse()) {
    current = revertInCurrent(current, hunk);
  }

  assert.equal(current, BASE);
});

test('keeping one hunk leaves the other still correct', () => {
  const modified = ['import { readFile } from "node:fs/promises";', '', 'export function load(path) {', '  return readFile(path, "utf8");', '}', ''].join('\n');

  const hunks = diffHunks(BASE, modified);
  assert.equal(hunks.length, 2);

  // Keep the first change; the second must remain, and only the second.
  const baseline = acceptInBaseline(BASE, hunks[0]!);
  const remaining = diffHunks(baseline, modified);

  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0]!.modifiedLines, ['  return readFile(path, "utf8");']);
});

test('undoing one hunk leaves the other still correct', () => {
  const modified = ['import { readFile } from "node:fs/promises";', '', 'export function load(path) {', '  return readFile(path, "utf8");', '}', ''].join('\n');

  const hunks = diffHunks(BASE, modified);
  const current = revertInCurrent(modified, hunks[1]!);
  const remaining = diffHunks(BASE, current);

  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0]!.modifiedLines, ['import { readFile } from "node:fs/promises";']);
});

test('a whole-file rewrite is a single hunk covering everything but the trailing newline', () => {
  const hunks = diffHunks(BASE, 'export const load = 1;\n');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.baselineStart, 0);
  // The final empty line from the trailing newline genuinely did not change, so
  // it stays outside the hunk.
  assert.equal(hunks[0]!.baselineEnd, splitLines(BASE).length - 1);
});

test('an empty baseline is treated as an all-new file', () => {
  const hunks = diffHunks('', 'a\nb\n');
  assert.equal(hunks.length, 1);
  assert.equal(diffStat('', 'a\nb\n').added, 2);
});

test('diffStat counts both sides', () => {
  const modified = BASE.replace('  return readFile(path);', '  const bytes = readFile(path);\n  return bytes;');
  const stat = diffStat(BASE, modified);

  assert.equal(stat.removed, 1);
  assert.equal(stat.added, 2);
});

test('large files fall back to a single hunk that still round-trips', () => {
  // Past the LCS cap the diff loses granularity, which is fine — but it must not
  // lose correctness, because keep and undo still have to work.
  const baseline = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  const modified = Array.from({ length: 4000 }, (_, i) => `LINE ${i}`).join('\n');

  const hunks = diffHunks(baseline, modified);
  assert.equal(hunks.length, 1);
  assert.equal(revertInCurrent(modified, hunks[0]!), baseline);
  assert.equal(acceptInBaseline(baseline, hunks[0]!), modified);
});
