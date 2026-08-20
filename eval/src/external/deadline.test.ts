import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseTimeout, withDeadline } from './deadline.ts';

/**
 * These exist because of a concrete loss, not a hypothetical one: two
 * whole-corpus runs sat at 0% CPU for five hours each, stalled on a network
 * call with no ceiling, and produced no artifact at all.
 */

test('work that finishes inside the deadline returns its value', async () => {
  assert.equal(await withDeadline(async () => 'done', 5_000), 'done');
});

test('work that exceeds the deadline throws a CaseTimeout naming the elapsed budget', async () => {
  await assert.rejects(
    () => withDeadline(() => new Promise(() => undefined), 50),
    (error: unknown) => {
      assert.ok(error instanceof CaseTimeout);
      assert.match((error as Error).message, /deadline/);
      return true;
    },
  );
});

test("a rejection from the work itself is the work's error, not a timeout", async () => {
  await assert.rejects(
    () =>
      withDeadline(async () => {
        throw new Error('the remote hung up');
      }, 5_000),
    /the remote hung up/,
  );
});

test('the deadline timer is cleared as soon as the work settles', async () => {
  // Without the `clearTimeout` in the `finally`, a 10-minute budget would keep
  // Node alive for ten minutes after the last case finished. Counting live
  // handles is the only way to see that from a test.
  const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  await withDeadline(async () => 'quick', 600_000);
  const after = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  assert.ok(after <= before, `a timer outlived its case: ${before} -> ${after}`);
});
