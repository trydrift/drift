import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherDependencyEvidence } from '../dist/evidence/index.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';
import { clearHttpCache } from '../dist/util/http.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

test('RubyGems changelog_uri is first-class evidence and wins before filename probing', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/v1/gems/sidekiq.json')) {
      return new Response(JSON.stringify({
        info: 'Background jobs',
        homepage_uri: 'https://sidekiq.org',
        source_code_uri: 'https://github.com/sidekiq/sidekiq',
        changelog_uri: 'https://github.com/sidekiq/sidekiq/blob/main/Changes.md',
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/v1/versions/sidekiq.json')) {
      return new Response(JSON.stringify([{ number: '8.0.0' }, { number: '7.0.0' }]), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://raw.githubusercontent.com/sidekiq/sidekiq/main/Changes.md') {
      return new Response('# 8.0.0\n\nBREAKING: `Sidekiq::OldWorker` was removed.\n');
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const consulted: string[] = [];
  const evidence = await gatherDependencyEvidence({
    name: 'sidekiq',
    ecosystem: 'rubygems',
    from: '7.0.0',
    to: '8.0.0',
    kind: 'runtime',
    bump: 'major',
    manifestPath: 'Gemfile.lock',
  }, {
    config: {
      ...DEFAULT_CONFIG,
      evidence: {
        ...DEFAULT_CONFIG.evidence,
        githubReleases: false,
        changelog: true,
        typeSurface: false,
        openapi: false,
        protobuf: false,
        graphql: false,
      },
    },
    logger: createLogger('error'),
    onProseConsulted: (_change, source) => consulted.push(source.url),
  });

  assert.ok(evidence.some((item) => item.source === 'changelog' && /OldWorker/.test(item.content)));
  assert.deepEqual(consulted, ['https://github.com/sidekiq/sidekiq/blob/main/Changes.md']);
  const declaredAt = calls.indexOf('https://raw.githubusercontent.com/sidekiq/sidekiq/main/Changes.md');
  const guessedAt = calls.findIndex((url) => /raw\.githubusercontent\.com\/sidekiq\/sidekiq\/(?:main|master)\/CHANGELOG\.md/.test(url));
  assert.ok(declaredAt >= 0 && (guessedAt < 0 || declaredAt < guessedAt), 'declared metadata is attempted before repository filename guesses');
});
