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

/**
 * A deadline that only stops *waiting* leaves the work running. That is how 21
 * of BUMP's cases came to consume 8.8 hours between them — better than a third
 * of a 22.7-hour run — inside cases that had already been abandoned, each
 * still holding a `mvn test` open to its own ten-minute limit while the next
 * case tried to start.
 */
test('the deadline aborts the work, not just the wait', async () => {
  let observed: AbortSignal | undefined;
  await assert.rejects(
    () =>
      withDeadline((signal) => {
        observed = signal;
        return new Promise(() => undefined);
      }, 50),
    /deadline/,
  );

  assert.ok(observed, 'the work is handed a signal');
  assert.equal(observed!.aborted, true, 'and it is aborted when the deadline fires');
});

test('work that finishes in time is never aborted', async () => {
  let observed: AbortSignal | undefined;
  const value = await withDeadline(async (signal) => {
    observed = signal;
    return 'done';
  }, 5_000);

  assert.equal(value, 'done');
  assert.equal(observed!.aborted, false);
});
