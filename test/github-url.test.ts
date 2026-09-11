import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { githubRepoSlug } from '../dist/util/github-url.js';

/**
 * One shared GitHub URL parser. It validates the host, never a substring, so a
 * look-alike domain can't drive Drift to fetch evidence from an attacker's
 * server.
 */
describe('githubRepoSlug', () => {
  const ok: Array<[string, string]> = [
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['http://github.com/owner/repo', 'owner/repo'],
    ['https://www.github.com/owner/repo', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['git+https://github.com/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo/issues', 'owner/repo'],
    ['https://github.com/owner/repo/archive/refs/tags/v1.0.0.tar.gz', 'owner/repo'],
    ['https://github.com/owner/repo#readme', 'owner/repo'],
    ['  https://github.com/Owner/Repo-Name  ', 'Owner/Repo-Name'],
  ];
  for (const [input, expected] of ok) {
    test(`resolves ${input}`, () => assert.equal(githubRepoSlug(input), expected));
  }

  const rejected: string[] = [
    'https://evilgithub.com/owner/repo',
    'https://github.com.evil.com/owner/repo',
    'https://github.com.evil.com/owner/repo.git',
    'https://raw.githubusercontent.com/owner/repo/main/x',
    'https://gitlab.com/owner/repo.git',
    'https://example.com/x.zip',
    'https://github.com/owner',
    'https://github.com/',
    'https://github.com/sponsors/owner',
    'git@evilgithub.com:owner/repo.git',
    'not a url at all',
    '',
    null,
    undefined,
  ];
  for (const input of rejected) {
    test(`rejects ${JSON.stringify(input)}`, () => assert.equal(githubRepoSlug(input), null));
  }
});
