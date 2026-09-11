import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupTemporaryDirectory } from './cleanup.ts';

test('temporary cleanup retries and never replaces a completed case result', async () => {
  let receivedPath = '';
  let receivedOptions: Record<string, unknown> = {};
  const logs: string[] = [];

  await assert.doesNotReject(() =>
    cleanupTemporaryDirectory('/tmp/drift-completed-case', {
      remove: (async (path, options) => {
        receivedPath = String(path);
        receivedOptions = options as Record<string, unknown>;
        throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
      }) as typeof import('node:fs/promises').rm,
      log: (message) => logs.push(message),
    }),
  );

  assert.equal(receivedPath, '/tmp/drift-completed-case');
  assert.deepEqual(receivedOptions, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  assert.match(logs[0] ?? '', /ENOTEMPTY|directory not empty/);
});
