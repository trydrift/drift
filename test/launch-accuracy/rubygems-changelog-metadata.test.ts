import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRegistryInfo } from '../../dist/evidence/registry.js';
import { fetchChangelog, fetchDeclaredChangelog } from '../../dist/evidence/changelog.js';
import { clearHttpCache } from '../../dist/util/http.js';

/**
 * RubyGems lets a gem state `changelog_uri` outright. Drift used it as one more
 * hint about which GitHub repository to guess filenames in, then threw the URL
 * away. Sidekiq publishes `Changes.md`; the probe list had `CHANGES.md`.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

function stub(responder: (url: string) => Response): void {
  clearHttpCache();
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(responder(String(input)))) as typeof fetch;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('RubyGems declared metadata is first-class evidence', () => {
  const SIDEKIQ_GEM = {
    info: 'Simple, efficient background processing for Ruby',
    homepage_uri: 'https://sidekiq.org',
    source_code_uri: 'https://github.com/sidekiq/sidekiq',
    changelog_uri: 'https://github.com/sidekiq/sidekiq/blob/main/Changes.md',
    documentation_uri: 'https://www.rubydoc.info/gems/sidekiq',
  };

  test('changelog, documentation and repository URLs are retained', async () => {
    stub((url) => {
      if (url.includes('/api/v1/gems/sidekiq.json')) return json(SIDEKIQ_GEM);
      if (url.includes('/api/v1/versions/sidekiq.json')) return json([{ number: '8.1.7' }]);
      return new Response('', { status: 404 });
    });

    const info = await fetchRegistryInfo('sidekiq', 'rubygems', '8.1.7');

    assert.equal(info?.changelogUrl, 'https://github.com/sidekiq/sidekiq/blob/main/Changes.md');
    assert.equal(info?.repositoryUrl, 'https://github.com/sidekiq/sidekiq');
    assert.equal(info?.documentationUrl, 'https://www.rubydoc.info/gems/sidekiq');
    assert.equal(info?.githubRepo, 'sidekiq/sidekiq');
  });

  test('a declared GitHub blob URL is read as raw content', async () => {
    stub((url) =>
      url === 'https://raw.githubusercontent.com/sidekiq/sidekiq/main/Changes.md'
        ? new Response('## 8.1.7\n- fixed things\n', { status: 200 })
        : new Response('', { status: 404 }),
    );

    const document = await fetchDeclaredChangelog('https://github.com/sidekiq/sidekiq/blob/main/Changes.md');

    assert.equal(document?.path, 'Changes.md');
    assert.match(document?.content ?? '', /8\.1\.7/);
  });

  test('the declared URL is attempted before any filename guessing', async () => {
    const asked: string[] = [];
    stub((url) => {
      asked.push(url);
      if (url === 'https://raw.githubusercontent.com/sidekiq/sidekiq/main/Changes.md') {
        return new Response('## 8.1.7\n- fixed things\n', { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const document = await fetchChangelog('sidekiq/sidekiq', ['main', 'master'], {
      declaredUrl: 'https://github.com/sidekiq/sidekiq/blob/main/Changes.md',
    });

    assert.equal(document?.path, 'Changes.md');
    assert.deepEqual(asked, ['https://raw.githubusercontent.com/sidekiq/sidekiq/main/Changes.md']);
  });

  test('a repository shipping only Changes.md is still found without a declared URL', async () => {
    stub((url) => {
      if (url === 'https://api.github.com/repos/sidekiq/sidekiq/contents/') {
        return json([
          { name: 'README.md', type: 'file' },
          { name: 'Changes.md', type: 'file' },
          { name: 'lib', type: 'dir' },
        ]);
      }
      if (url === 'https://raw.githubusercontent.com/sidekiq/sidekiq/main/Changes.md') {
        return new Response('## 8.1.7\n- fixed things\n', { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const document = await fetchChangelog('sidekiq/sidekiq');
    assert.equal(document?.path, 'Changes.md');
  });

  test('an unreadable declared changelog is not proof that none exists', async () => {
    stub((url) => {
      if (url.startsWith('https://raw.githubusercontent.com/demo/demo/main/CHANGELOG.md')) {
        return new Response('## 1.0.0\n- something\n', { status: 200 });
      }
      return new Response('', { status: 503 });
    });

    // The declared URL 503s, so discovery falls through to the probe rather
    // than concluding the package publishes no changelog.
    const document = await fetchChangelog('demo/demo', ['main'], {
      declaredUrl: 'https://github.com/demo/demo/blob/main/HISTORY.md',
    });

    assert.equal(document?.path, 'CHANGELOG.md');
  });
});
