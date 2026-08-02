import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createWebhookServer, verifySignature } from '../dist/runners/webhook.js';
import { MemoryJobQueue } from '../dist/queue/memory.js';
import { matchGlob, matchesAny } from '../dist/util/glob.js';
import { stableId, slugify } from '../dist/util/id.js';
import { createLogger } from '../dist/util/logger.js';

describe('webhook signature verification', () => {
  const secret = 'a-test-secret';
  const body = Buffer.from(JSON.stringify({ action: 'created' }));
  const valid = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  test('accepts a correct signature', () => {
    assert.equal(verifySignature(body, valid, secret), true);
  });

  test('rejects a tampered body', () => {
    assert.equal(verifySignature(Buffer.from('{"action":"deleted"}'), valid, secret), false);
  });

  test('rejects a wrong secret', () => {
    assert.equal(verifySignature(body, valid, 'other-secret'), false);
  });

  test('fails closed on missing or malformed input', () => {
    assert.equal(verifySignature(body, undefined, secret), false);
    assert.equal(verifySignature(body, 'garbage', secret), false);
    assert.equal(verifySignature(body, 'sha1=abc', secret), false);
    assert.equal(verifySignature(body, valid, ''), false, 'an empty secret must never pass');
  });
});

/**
 * The accept path.
 *
 * The property under test is that a 202 means the delivery is recorded. The
 * previous design returned 202 and then started an untracked promise, so any
 * restart between the two lost the work with GitHub already told it succeeded.
 */
describe('webhook delivery acceptance', () => {
  const secret = 'a-test-secret';

  async function withServer(
    fn: (url: string, queue: MemoryJobQueue) => Promise<void>,
  ): Promise<void> {
    const queue = new MemoryJobQueue();
    const { server, shutdown } = createWebhookServer({
      port: 0,
      webhookSecret: secret,
      repoToken: 'token',
      logger: createLogger('error'),
      queue,
      // Never reached: these tests stop before the worker is started.
      dryRun: true,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await fn(`http://127.0.0.1:${port}`, queue);
    } finally {
      await shutdown();
    }
  }

  function post(url: string, body: string, headers: Record<string, string> = {}) {
    return fetch(`${url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        ...headers,
      },
      body,
    });
  }

  const payload = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40) });

  test('a valid delivery is recorded before it is acknowledged', async () => {
    await withServer(async (url, queue) => {
      const response = await post(url, payload);
      assert.equal(response.status, 202);

      // Already durable at the moment the response was produced — not queued
      // by a promise that happens to run afterwards.
      const stats = await queue.stats();
      assert.equal(stats.queued, 1);
    });
  });

  test('an invalid signature is rejected and records nothing', async () => {
    await withServer(async (url, queue) => {
      const response = await post(url, payload, { 'x-hub-signature-256': 'sha256=deadbeef' });
      assert.equal(response.status, 401);
      assert.equal((await queue.stats()).queued, 0);
    });
  });

  test('a delivery without an id is refused', async () => {
    // Without it there is no replay key, so accepting would mean accepting
    // duplicates silently.
    await withServer(async (url, queue) => {
      const response = await post(url, payload, { 'x-github-delivery': '' });
      assert.equal(response.status, 400);
      assert.equal((await queue.stats()).queued, 0);
    });
  });

  test('a redelivered id is acknowledged without queueing twice', async () => {
    await withServer(async (url, queue) => {
      assert.equal((await post(url, payload)).status, 202);
      const second = await post(url, payload);

      assert.equal(second.status, 202, 'GitHub must not be told to retry');
      assert.equal((await second.json()).duplicate, true);
      assert.equal((await queue.stats()).queued, 1, 'one delivery, one job');
    });
  });

  test('malformed JSON is rejected', async () => {
    await withServer(async (url, queue) => {
      const response = await post(url, '{not json');
      assert.equal(response.status, 400);
      assert.equal((await queue.stats()).queued, 0);
    });
  });

  test('a failure to record answers 5xx so GitHub retries', async () => {
    // The one case where 202 would be a lie Drift can detect at the time.
    await withServer(async (url, queue) => {
      queue.enqueue = async () => {
        throw new Error('disk full');
      };
      const response = await post(url, payload);
      assert.equal(response.status, 500);
    });
  });

  test('health reports queue depth without exposing payloads', async () => {
    await withServer(async (url) => {
      await post(url, payload);
      const response = await fetch(`${url}/health`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.queue.queued, 1);
      assert.ok(!JSON.stringify(body).includes('refs/heads/main'), 'health must not leak delivery contents');
      assert.ok(!JSON.stringify(body).includes('delivery-1'), 'health must not leak delivery ids');
    });
  });

  test('health degrades when deliveries have failed permanently', async () => {
    await withServer(async (url, queue) => {
      await queue.enqueue({ deliveryId: 'x', event: 'push', payload: '{}' });
      const job = await queue.claim();
      await queue.fail(job!.id, 'permanent');

      const body = await (await fetch(`${url}/health`)).json();
      assert.equal(body.status, 'degraded');
      assert.equal(body.queue.failed, 1);
    });
  });

  test('unknown routes are not found', async () => {
    await withServer(async (url) => {
      assert.equal((await fetch(`${url}/`)).status, 404);
      assert.equal((await fetch(`${url}/webhook`)).status, 404, 'GET /webhook is not a delivery');
    });
  });
});

describe('glob matching', () => {
  test('single star does not cross path separators', () => {
    assert.ok(matchGlob('src/*.ts', 'src/a.ts'));
    assert.ok(!matchGlob('src/*.ts', 'src/nested/a.ts'));
  });

  test('double star crosses separators and may match zero segments', () => {
    assert.ok(matchGlob('src/**/*.ts', 'src/a.ts'));
    assert.ok(matchGlob('src/**/*.ts', 'src/deep/nested/a.ts'));
    assert.ok(matchGlob('**/*.lock', 'a/b/c.lock'));
  });

  test('matches package names', () => {
    assert.ok(matchGlob('@types/*', '@types/node'));
    assert.ok(!matchGlob('@types/*', 'typescript'));
    assert.ok(matchesAny(['express', 'acme-*'], 'acme-sdk'));
  });

  test('escapes regex metacharacters in literals', () => {
    assert.ok(matchGlob('a.b.c', 'a.b.c'));
    assert.ok(!matchGlob('a.b.c', 'axbxc'), 'a dot is a literal dot, not "any character"');
  });
});

describe('identifiers', () => {
  test('ids are deterministic across calls', () => {
    assert.equal(stableId('bc', 'pkg', '1.0.0'), stableId('bc', 'pkg', '1.0.0'));
    assert.notEqual(stableId('bc', 'pkg', '1.0.0'), stableId('bc', 'pkg', '2.0.0'));
  });

  test('slugs are safe for git refs', () => {
    assert.equal(slugify('@scope/Package Name!'), 'scope-package-name');
    assert.equal(slugify('...'), 'change', 'never produces an empty ref component');
  });
});
