import type { Condition } from './schema.ts';

/**
 * The order conditions run in, fixed before anything runs.
 *
 * Forward/reverse alternation balances two conditions and nothing more: with
 * four, `A B C D / D C B A / A B C D` puts B and C in the middle every time. A
 * Williams design does better: a Latin square in which every condition takes
 * every position once per cycle of rows and, for an even number of
 * conditions, every condition immediately follows every other exactly once
 * (for an odd number the square and its mirror are both used).
 *
 * Rows are assigned to (case, repetition) blocks in suite order — the case's
 * index in the suite, never its index in whichever process runs it — so runs
 * split one case per process follow one global design, and a retried slot
 * keeps the position it was assigned before any result was seen.
 *
 * With 9 blocks and a 4-row square, one row is used three times and the rest
 * twice; every condition's count in every position is then 2 or 3. That is
 * the most even assignment 9 blocks allow, and no trials are added to reach it.
 */

export const SCHEDULE_DESIGN = 'williams-v1';

/** Rows of a Williams design over `k` items, as index permutations. */
export function williamsRows(k: number): number[][] {
  if (k <= 0) return [];
  if (k === 1) return [[0]];
  const first: number[] = [0];
  for (let step = 1; first.length < k; step += 1) {
    first.push(step % 2 === 1 ? (step + 1) / 2 : k - step / 2);
  }
  const rows = Array.from({ length: k }, (_, shift) => first.map((index) => (index + shift) % k));
  return k % 2 === 0 ? rows : [...rows, ...rows.map((row) => [...row].reverse())];
}

export interface ScheduleSlot {
  design: typeof SCHEDULE_DESIGN;
  /** `caseIndex * runs + (repetition - 1)`. */
  block: number;
  row: number;
  /** 1-based position of this condition within its block. */
  position: number;
}

export function blockOrder(
  conditions: readonly Condition[],
  caseIndex: number,
  repetition: number,
  runs: number,
): { order: Condition[]; slots: Map<Condition, ScheduleSlot> } {
  const rows = williamsRows(conditions.length);
  const block = caseIndex * runs + (repetition - 1);
  const row = rows.length === 0 ? 0 : block % rows.length;
  const order = (rows[row] ?? []).map((index) => conditions[index]!);
  const slots = new Map<Condition, ScheduleSlot>(
    order.map((condition, index) => [condition, { design: SCHEDULE_DESIGN, block, row, position: index + 1 }]),
  );
  return { order, slots };
}

/** Position counts per condition over a full design, for reports and tests. */
export function positionCounts(conditions: readonly Condition[], caseCount: number, runs: number): Record<string, number[]> {
  const counts: Record<string, number[]> = Object.fromEntries(conditions.map((c) => [c, conditions.map(() => 0)]));
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex += 1) {
    for (let repetition = 1; repetition <= runs; repetition += 1) {
      const { slots } = blockOrder(conditions, caseIndex, repetition, runs);
      for (const [condition, slot] of slots) counts[condition]![slot.position - 1]! += 1;
    }
  }
  return counts;
}
