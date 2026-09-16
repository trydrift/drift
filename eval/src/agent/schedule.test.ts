import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { blockOrder, positionCounts, williamsRows } from './schedule.ts';
import type { Condition } from './schema.ts';

const FOUR: Condition[] = ['baseline', 'drift', 'drift-agent-brief', 'drift-mcp'];

describe('counterbalanced schedule', () => {
  test('a Williams square: every row a permutation, every item in every position once, every ordered pair adjacent once', () => {
    for (const k of [2, 4, 6]) {
      const rows = williamsRows(k);
      assert.equal(rows.length, k);
      for (const row of rows) assert.deepEqual([...row].sort((a, b) => a - b), [...Array(k).keys()]);
      for (let position = 0; position < k; position += 1) {
        assert.deepEqual(rows.map((row) => row[position]!).sort((a, b) => a - b), [...Array(k).keys()], `position ${position}`);
      }
      const pairs = new Set<string>();
      for (const row of rows) for (let i = 0; i + 1 < k; i += 1) pairs.add(`${row[i]}>${row[i + 1]}`);
      assert.equal(pairs.size, k * (k - 1), `k=${k}: every ordered pair once`);
    }
    // Odd k needs the mirrored rows to balance adjacency.
    assert.equal(williamsRows(3).length, 6);
  });

  test('the actual experiment (4 conditions × 3 cases × 3 repetitions): every condition 2 or 3 times in every position', () => {
    const counts = positionCounts(FOUR, 3, 3);
    assert.deepEqual(counts, {
      baseline: [3, 2, 2, 2],
      drift: [2, 3, 2, 2],
      'drift-agent-brief': [2, 2, 2, 3],
      'drift-mcp': [2, 2, 3, 2],
    });
    for (const [condition, perPosition] of Object.entries(counts)) {
      assert.equal(perPosition.reduce((a, b) => a + b, 0), 9, `${condition} still runs 9 times`);
      assert.ok(Math.max(...perPosition) - Math.min(...perPosition) <= 1, condition);
    }
  });

  test('within one case, a condition never takes the same position twice across its three repetitions', () => {
    for (let caseIndex = 0; caseIndex < 3; caseIndex += 1) {
      for (const condition of FOUR) {
        const positions = [1, 2, 3].map((repetition) => blockOrder(FOUR, caseIndex, repetition, 3).slots.get(condition)!.position);
        assert.equal(new Set(positions).size, 3, `case ${caseIndex} ${condition}: ${positions}`);
      }
    }
  });

  test('a slot depends only on the case’s suite index, the repetition and the condition — so parallel and retried runs agree', () => {
    const a = blockOrder(FOUR, 2, 3, 3);
    const b = blockOrder(FOUR, 2, 3, 3);
    assert.deepEqual([...a.slots], [...b.slots]);
    assert.deepEqual(a.slots.get('drift-mcp'), { design: 'williams-v1', block: 8, row: 0, position: 3 });
  });

  test('two conditions reduce to plain alternation per block', () => {
    const two: Condition[] = ['baseline', 'drift'];
    assert.deepEqual(blockOrder(two, 0, 1, 3).order, ['baseline', 'drift']);
    assert.deepEqual(blockOrder(two, 0, 2, 3).order, ['drift', 'baseline']);
  });
});
