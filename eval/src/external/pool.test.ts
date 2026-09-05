import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { forEachWithConcurrency } from './pool.ts';
import { parseArgs } from './cli.ts';

describe('bounded case concurrency', () => {
  test('runs every item exactly once', async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      seen.push(item);
    });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  });

  test('never exceeds the bound', async () => {
    let inFlight = 0;
    let peak = 0;
    await forEachWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    assert.ok(peak <= 4, `peak in flight was ${peak}`);
    assert.ok(peak > 1, 'work actually overlapped');
  });

  test('a bound of one is genuinely serial, so it stays a usable control', async () => {
    let inFlight = 0;
    let peak = 0;
    await forEachWithConcurrency([1, 2, 3, 4], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    assert.equal(peak, 1);
  });

  test('fewer items than the bound starts only as many workers as there is work', async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2], 16, async (item) => {
      seen.push(item);
    });
    assert.deepEqual(seen.sort(), [1, 2]);
  });

  test('an empty list is not an error', async () => {
    await forEachWithConcurrency([], 4, async () => {
      throw new Error('must not run');
    });
  });

  test('a failing case rejects rather than being silently dropped', async () => {
    await assert.rejects(
      () => forEachWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('case 2 failed');
      }),
      /case 2 failed/,
    );
  });
});

describe('--concurrency', () => {
  const base = ['bump'];

  test('is parsed as a positive integer', () => {
    assert.equal(parseArgs([...base, '--concurrency', '8']).concurrency, 8);
  });

  test('is absent by default, so the runner picks', () => {
    assert.equal(parseArgs(base).concurrency, undefined);
  });

  test('refuses a value that would silently mean "no bound"', () => {
    assert.throws(() => parseArgs([...base, '--concurrency', '0']), /positive integer/);
    assert.throws(() => parseArgs([...base, '--concurrency', '-2']), /positive integer/);
    assert.throws(() => parseArgs([...base, '--concurrency', 'lots']), /positive integer/);
  });
});
