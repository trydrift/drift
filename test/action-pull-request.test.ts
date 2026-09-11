import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { commentOnPullRequest } from '../dist/runners/action.js';

/**
 * Renovate and Dependabot do not push to a watched branch — they open a pull
 * request, and that PR is where the merge decision is actually made. Until
 * Drift could reach it, Drift was a tool somebody had to remember to run,
 * which in practice is a tool nobody runs.
 */

const repo = { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: 'a', afterSha: 'b', workspace: '/w' };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeGithub(existing: { id: number; body: string | null; authorLogin: string | null }[] = []) {
  const calls: string[] = [];
  return {
    calls,
    listIssueComments: async () => existing,
    commentOnIssue: async (_r: unknown, n: number, body: string) => {
      calls.push(`create:${n}:${body.slice(0, 25)}`);
      return true;
    },
    updateIssueComment: async (_r: unknown, id: number, body: string) => {
      calls.push(`update:${id}:${body.slice(0, 25)}`);
    },
  };
}

describe('commenting Drift’s verdict on an update bot’s PR', () => {
  test('posts once when there is nothing to replace', async () => {
    const github = fakeGithub();
    await commentOnPullRequest({
      event: { pull_request: { number: 42 } },
      repo: repo as never,
      github: github as never,
      logger: silent as never,
      body: 'the verdict',
    });
    assert.equal(github.calls.length, 1);
    assert.match(github.calls[0]!, /^create:42:<!-- drift:pr-verdict -->/);
  });

  test('replaces its own previous comment instead of appending', async () => {
    // A bot rebases and the workflow re-runs; a PR carrying nine stale
    // verdicts is worse than one carrying none.
    const github = fakeGithub([
      { id: 7, body: 'someone else', authorLogin: 'human' },
      { id: 9, body: '<!-- drift:pr-verdict -->\nold verdict', authorLogin: 'github-actions' },
    ]);
    await commentOnPullRequest({
      event: { pull_request: { number: 42 } },
      repo: repo as never,
      github: github as never,
      logger: silent as never,
      body: 'new verdict',
    });
    assert.deepEqual(github.calls.length, 1);
    assert.match(github.calls[0]!, /^update:9:/);
  });

  test('does nothing when the event is not a pull request', async () => {
    const github = fakeGithub();
    await commentOnPullRequest({
      event: { ref: 'refs/heads/main' },
      repo: repo as never,
      github: github as never,
      logger: silent as never,
      body: 'x',
    });
    assert.deepEqual(github.calls, []);
  });

  test('a missing permission is a warning, not a failed run', async () => {
    // `pull-requests: write` is not granted by default, and the analysis
    // succeeded regardless.
    const github = {
      listIssueComments: async () => {
        throw new Error('Resource not accessible by integration');
      },
    };
    let warned = '';
    await commentOnPullRequest({
      event: { pull_request: { number: 1 } },
      repo: repo as never,
      github: github as never,
      logger: { ...silent, warn: (m: string) => (warned = m) } as never,
      body: 'x',
    });
    assert.match(warned, /pull-requests: write/);
  });
});
