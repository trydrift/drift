import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryJobQueue } from '../dist/queue/memory.js';
import { SqliteJobQueue } from '../dist/queue/sqlite.js';
import { QueueWorker } from '../dist/queue/worker.js';
import { backoffMs, MAX_ATTEMPTS, type Job, type JobQueue } from '../dist/queue/types.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * The queue exists because the webhook runner used to answer GitHub with 202
 * and then start an untracked promise — an acknowledgement it could not honour
 * across a restart. The tests that matter most here are the durability ones:
 * a delivery recorded before the 202 must still be there after the process that
 * accepted it is gone.
 */

const logger = createLogger('error');

/** `node:sqlite` landed in Node 22.5; the runner reports this, and so do we. */
const sqliteAvailable = await (async () => {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'drift-queue-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function delivery(id: string) {
  return { deliveryId: id, event: 'push', payload: JSON.stringify({ ref: 'refs/heads/main' }) };
}

/**
 * The contract both implementations must satisfy.
 *
 * Running one suite against both is what keeps the in-memory queue usable as a
 * stand-in for the durable one in other tests: if they diverged, every test
 * built on the fast one would be testing a fiction.
 */
function contractTests(name: string, create: () => Promise<JobQueue>) {
  describe(`${name}: job queue contract`, () => {
    test('enqueues and claims in order', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      await queue.enqueue(delivery('d2'));

      const first = await queue.claim();
      const second = await queue.claim();
      assert.equal(first?.deliveryId, 'd1');
      assert.equal(second?.deliveryId, 'd2');
      assert.equal(await queue.claim(), null, 'an empty queue yields nothing');
      await queue.close();
    });

    test('a repeated delivery id is a duplicate, not a second job', async () => {
      // GitHub retries deliveries. Processing one twice means two branches and
      // two agent dispatches for one push.
      const queue = await create();
      const first = await queue.enqueue(delivery('same'));
      const second = await queue.enqueue(delivery('same'));

      assert.equal(first.status, 'queued');
      assert.equal(second.status, 'duplicate');
      assert.equal(second.id, first.id);

      assert.ok(await queue.claim());
      assert.equal(await queue.claim(), null, 'only one job should exist');
      await queue.close();
    });

    test('a claimed job is not claimable again', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      assert.ok(await queue.claim());
      assert.equal(await queue.claim(), null);
      await queue.close();
    });

    test('claiming increments the attempt count', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      const first = await queue.claim();
      assert.equal(first?.attempts, 1);

      await queue.fail(first!.id, 'boom', Date.now() - 1);
      const second = await queue.claim();
      assert.equal(second?.attempts, 2);
      await queue.close();
    });

    test('a retry is not claimable before its scheduled time', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      const job = await queue.claim();
      await queue.fail(job!.id, 'transient', Date.now() + 60_000);

      assert.equal(await queue.claim(), null, 'backoff must be respected');
      assert.ok(await queue.claim(Date.now() + 61_000), 'and released once it passes');
      await queue.close();
    });

    test('a job failed without a retry time is terminal', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      const job = await queue.claim();
      await queue.fail(job!.id, 'permanent');

      assert.equal(await queue.claim(Date.now() + 86_400_000), null);
      const stats = await queue.stats();
      assert.equal(stats.failed, 1);
      await queue.close();
    });

    test('recover returns in-flight jobs to the queue', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      await queue.claim();

      assert.equal(await queue.recover(), 1);
      const again = await queue.claim();
      assert.equal(again?.deliveryId, 'd1', 'an interrupted job must be picked up again');
      await queue.close();
    });

    test('recover leaves finished jobs alone', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      const job = await queue.claim();
      await queue.complete(job!.id);

      assert.equal(await queue.recover(), 0);
      assert.equal(await queue.claim(), null);
      await queue.close();
    });

    test('stats report depth without exposing payloads', async () => {
      const queue = await create();
      await queue.enqueue(delivery('d1'));
      await queue.enqueue(delivery('d2'));
      const running = await queue.claim();
      await queue.enqueue(delivery('d3'));
      await queue.complete(running!.id);

      const stats = await queue.stats();
      assert.equal(stats.queued, 2);
      assert.equal(stats.done, 1);
      assert.equal(stats.running, 0);

      // The health endpoint serialises exactly this object.
      const serialized = JSON.stringify(stats);
      assert.ok(!serialized.includes('refs/heads/main'), 'stats must not carry payload data');
      assert.ok(!serialized.includes('d1'), 'stats must not carry delivery ids');
      await queue.close();
    });

    test('the payload survives the round trip verbatim', async () => {
      const queue = await create();
      const payload = JSON.stringify({ ref: 'refs/heads/main', nested: { emoji: '✅', quote: '"' } });
      await queue.enqueue({ deliveryId: 'd1', event: 'push', payload });

      const job = await queue.claim();
      assert.equal(job?.payload, payload);
      await queue.close();
    });
  });
}

contractTests('memory', async () => new MemoryJobQueue());

if (sqliteAvailable) {
  let n = 0;
  contractTests('sqlite', () => SqliteJobQueue.open(join(dir, `contract-${n++}.db`)));
}

describe('sqlite durability', { skip: sqliteAvailable ? false : 'node:sqlite requires Node 22.5+' }, () => {
  test('a delivery accepted before a crash is still there afterwards', async () => {
    // The whole reason the queue exists. `close()` without draining stands in
    // for the process disappearing.
    const path = join(dir, 'restart.db');

    const first = await SqliteJobQueue.open(path);
    await first.enqueue(delivery('survives-restart'));
    await first.close();

    const second = await SqliteJobQueue.open(path);
    const job = await second.claim();
    assert.equal(job?.deliveryId, 'survives-restart');
    assert.equal(job?.event, 'push');
    await second.close();
  });

  test('a job interrupted mid-flight is recovered by the next process', async () => {
    const path = join(dir, 'inflight.db');

    const first = await SqliteJobQueue.open(path);
    await first.enqueue(delivery('interrupted'));
    await first.claim(); // Claimed, never completed — the process dies here.
    await first.close();

    const second = await SqliteJobQueue.open(path);
    assert.equal(await second.claim(), null, 'it is still marked running');
    assert.equal(await second.recover(), 1);

    const job = await second.claim();
    assert.equal(job?.deliveryId, 'interrupted');
    assert.equal(job?.attempts, 2, 'the earlier attempt is remembered');
    await second.close();
  });

  test('duplicate suppression survives a restart', async () => {
    const path = join(dir, 'dupe.db');

    const first = await SqliteJobQueue.open(path);
    await first.enqueue(delivery('once'));
    await first.close();

    const second = await SqliteJobQueue.open(path);
    const result = await second.enqueue(delivery('once'));
    assert.equal(result.status, 'duplicate', 'GitHub retrying after a restart must not double-process');
    await second.close();
  });

  test('completed jobs are retained, then prunable', async () => {
    const path = join(dir, 'prune.db');
    const queue = await SqliteJobQueue.open(path);

    await queue.enqueue(delivery('d1'));
    const job = await queue.claim();
    await queue.complete(job!.id);

    assert.equal(await queue.prune(60_000), 0, 'recent history is kept — it answers "did Drift see it?"');
    assert.equal(await queue.prune(-1), 1);
    await queue.close();
  });

  test('a long error message is stored bounded', async () => {
    const path = join(dir, 'longerr.db');
    const queue = await SqliteJobQueue.open(path);
    await queue.enqueue(delivery('d1'));
    const job = await queue.claim();

    await queue.fail(job!.id, 'x'.repeat(10_000));
    const stats = await queue.stats();
    assert.equal(stats.failed, 1);
    await queue.close();
  });
});

describe('retry policy', () => {
  test('backoff grows and is capped', () => {
    assert.ok(backoffMs(1) < backoffMs(2));
    assert.ok(backoffMs(2) < backoffMs(3));
    assert.ok(backoffMs(50) <= 5 * 60_000, 'an unbounded backoff would be indistinguishable from a stuck queue');
  });

  test('attempts are bounded', () => {
    assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 10);
  });
});

describe('queue worker', () => {
  test('processes queued jobs and marks them done', async () => {
    const queue = new MemoryJobQueue();
    const seen: string[] = [];

    const worker = new QueueWorker({
      queue,
      logger,
      pollIntervalMs: 5,
      handler: async (job: Job) => {
        seen.push(job.deliveryId);
      },
    });

    await queue.enqueue(delivery('d1'));
    await queue.enqueue(delivery('d2'));
    worker.start();

    await waitFor(async () => (await queue.stats()).done === 2);
    await worker.stop();

    assert.deepEqual(seen, ['d1', 'd2']);
  });

  test('retries a failing job, then gives up', async () => {
    const queue = new MemoryJobQueue();
    let attempts = 0;

    const worker = new QueueWorker({
      queue,
      logger,
      pollIntervalMs: 5,
      handler: async () => {
        attempts += 1;
        throw new Error('always fails');
      },
    });

    await queue.enqueue(delivery('d1'));
    // Backoff is real time, so the retry schedule is collapsed for the test by
    // releasing the job as soon as it is deferred.
    const originalFail = queue.fail.bind(queue);
    queue.fail = (id, error, retryAt) => originalFail(id, error, retryAt === undefined ? undefined : Date.now() - 1);

    worker.start();
    await waitFor(async () => (await queue.stats()).failed === 1, 5_000);
    await worker.stop();

    assert.equal(attempts, MAX_ATTEMPTS, 'it should stop after the attempt cap');
  });

  test('a handler failure does not stop the worker', async () => {
    const queue = new MemoryJobQueue();
    const seen: string[] = [];

    const worker = new QueueWorker({
      queue,
      logger,
      pollIntervalMs: 5,
      handler: async (job: Job) => {
        seen.push(job.deliveryId);
        if (job.deliveryId === 'bad') throw new Error('nope');
      },
    });

    await queue.enqueue(delivery('bad'));
    await queue.enqueue(delivery('good'));
    worker.start();

    await waitFor(async () => seen.includes('good'));
    await worker.stop();
  });

  test('stop waits for the job in flight', async () => {
    // A deploy that abandons a running job leaves it to be recovered and
    // re-run, which for Drift means a duplicate analysis.
    const queue = new MemoryJobQueue();
    let finished = false;
    let started = false;

    const worker = new QueueWorker({
      queue,
      logger,
      pollIntervalMs: 5,
      handler: async () => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 150));
        finished = true;
      },
    });

    await queue.enqueue(delivery('slow'));
    worker.start();
    await waitFor(async () => started);

    await worker.stop();
    assert.ok(finished, 'shutdown must not abandon a running job');
    assert.equal((await queue.stats()).done, 1);
  });

  test('stop is safe when nothing is running', async () => {
    const worker = new QueueWorker({ queue: new MemoryJobQueue(), logger, handler: async () => {} });
    await worker.stop();
    worker.start();
    await worker.stop();
    await worker.stop();
  });
});

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
