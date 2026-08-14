import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributedMessage,
  coAuthorTrailer,
  withTrailers,
  DRIFT_COAUTHOR,
} from '../dist/repo/attribution.js';
import {
  branchNameFor,
  resolveBaseBranch,
  sanitizeBranchName,
  titleFor,
} from '../dist/plan/pull-request.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';

describe('crediting Drift on a commit', () => {
  test('adds a co-author trailer, keeping the human as the author', () => {
    // The developer chose the upgrade, reviewed the diff, and pressed the
    // button. Rewriting authorship to a tool would misattribute their decision.
    const message = attributedMessage('chore(deps): upgrade zod to 4.0.0', 'It was fine.');

    assert.match(message, /^chore\(deps\): upgrade zod to 4\.0\.0\n\nIt was fine\.\n\n/);
    assert.ok(message.endsWith('Co-authored-by: Drift <trydrift@users.noreply.github.com>'));
  });

  test('a trailer must be its own last paragraph, or git ignores it', () => {
    const message = attributedMessage('subject only');
    assert.equal(message, 'subject only\n\nCo-authored-by: Drift <trydrift@users.noreply.github.com>');
  });

  test('never accumulates the same trailer twice', () => {
    // Re-running an upgrade on a branch that already has one is ordinary.
    const once = attributedMessage('subject', 'body');
    const twice = withTrailers(once, [coAuthorTrailer(DRIFT_COAUTHOR)]);
    assert.equal(once, twice);
  });

  test('joins an existing trailer block rather than opening a second one', () => {
    // Two trailer paragraphs mean git only reads the last, which would silently
    // drop whatever the first one said.
    const message = withTrailers('subject\n\nbody\n\nSigned-off-by: A <a@example.com>', [
      coAuthorTrailer(DRIFT_COAUTHOR),
    ]);

    assert.equal(
      message,
      'subject\n\nbody\n\nSigned-off-by: A <a@example.com>\nCo-authored-by: Drift <trydrift@users.noreply.github.com>',
    );
  });

  test('matches an existing trailer case-insensitively, as git does', () => {
    const message = withTrailers('subject\n\nco-authored-by: Drift <trydrift@users.noreply.github.com>', [
      coAuthorTrailer(DRIFT_COAUTHOR),
    ]);
    assert.equal(message.match(/co-authored-by/gi)?.length, 1);
  });

  test('can be switched off, for a repository that lints trailers', () => {
    // A tool that cannot be told to stop adding a trailer is a tool that gets
    // uninstalled by the first team with a commit-lint rule.
    assert.equal(attributedMessage('subject', 'body', { enabled: false }), 'subject\n\nbody');
  });

  test('credits several authors when more than one contributed', () => {
    const message = attributedMessage('subject', '', {
      coAuthors: [DRIFT_COAUTHOR, { name: 'Agent', email: 'agent@example.com' }],
    });
    assert.match(message, /Co-authored-by: Drift <.*>\nCo-authored-by: Agent <agent@example\.com>$/);
  });
});

describe('branch names git will accept', () => {
  test('a scoped package does not become a nested ref', () => {
    // `@octokit/rest` must not create a branch inside a directory called
    // `@octokit` — that collides with every other package in the scope.
    const name = branchNameFor({
      changes: [{ name: '@octokit/rest', from: '21.0.0', to: '22.0.1' }],
      now: new Date('2026-08-02T00:00:00Z'),
    });

    assert.equal(name, 'drift/upgrade-octokit-rest-21.0.0-to-22.0.1-2026-08-02');
    // One slash, from the prefix, and nothing else.
    assert.equal(name.split('/').length, 2);
  });

  test('rejects the shapes git itself refuses', () => {
    assert.equal(sanitizeBranchName('foo..bar'), 'foo.bar');
    assert.equal(sanitizeBranchName('trailing.lock'), 'trailing-lock');
    assert.equal(sanitizeBranchName('-leading-and-trailing-'), 'leading-and-trailing');
    assert.equal(sanitizeBranchName('spaces and ~tildes^'), 'spaces-and-tildes');
    // Never empty: an empty ref name would fail at push with a cryptic error.
    assert.equal(sanitizeBranchName('///'), 'drift-upgrade');
  });

  test('several packages collapse to a countable name', () => {
    // A branch name listing twelve packages is unusable in a branch list.
    const name = branchNameFor({
      changes: [
        { name: 'a', from: '1.0.0', to: '2.0.0' },
        { name: 'b', from: '1.0.0', to: '2.0.0' },
      ],
      now: new Date('2026-08-02T00:00:00Z'),
    });
    assert.equal(name, 'drift/upgrade-2-packages-2026-08-02');
  });

  test('a prefix means the same with or without its slash', () => {
    const facts = { changes: [{ name: 'zod', from: '3.0.0', to: '4.0.0' }], now: new Date('2026-08-02') };
    assert.equal(
      branchNameFor(facts, { prefix: 'deps' }),
      branchNameFor(facts, { prefix: 'deps/' }),
    );
  });

  test('an unknown placeholder is left visible rather than blanked', () => {
    // `drift/upgrade-{whoops}` is obviously wrong and gets fixed. An empty
    // `drift/upgrade-` looks plausible and collides with the next run.
    const name = branchNameFor(
      { changes: [{ name: 'zod', from: '3.0.0', to: '4.0.0' }] },
      { branch: '{prefix}upgrade-{whoops}' },
    );
    assert.match(name, /whoops/);
  });

  test('titles read as prose, not as a branch slug', () => {
    assert.equal(
      titleFor({ changes: [{ name: 'zod', from: '3.24.1', to: '4.0.0' }] }),
      'chore(deps): upgrade zod to 4.0.0',
    );
    assert.equal(
      titleFor({ changes: [{ name: 'a', from: '1', to: '2' }, { name: 'b', from: '1', to: '2' }] }),
      'chore(deps): upgrade 2 packages',
    );
  });

  test('the default config templates produce the default names', () => {
    // The config defaults and the module defaults must not drift apart, or the
    // Action and the extension would name the same upgrade differently.
    const facts = { changes: [{ name: 'zod', from: '3.0.0', to: '4.0.0' }], now: new Date('2026-08-02') };
    assert.equal(
      branchNameFor(facts, {
        branch: DEFAULT_CONFIG.pullRequest.branchTemplate,
        prefix: DEFAULT_CONFIG.remediation.branchPrefix,
      }),
      branchNameFor(facts),
    );
    assert.equal(
      titleFor(facts, { title: DEFAULT_CONFIG.pullRequest.titleTemplate }),
      titleFor(facts),
    );
  });
});

describe('which branch a pull request should merge into', () => {
  test('targets the branch the work was actually started from', () => {
    // On a team that develops on `develop`, targeting `main` proposes merging
    // into the wrong place and shows a diff full of other people's commits.
    const resolved = resolveBaseBranch({
      policy: 'branched-from',
      branchedFrom: 'develop',
      defaultBranch: 'main',
      currentBranch: 'drift/upgrade-zod',
    });

    assert.equal(resolved?.branch, 'develop');
    assert.match(resolved!.reason, /branched from/);
  });

  test('falls back to the default branch, and says that it did', () => {
    // A branch created before Drift ran, or one whose reflog was pruned, has no
    // recorded start point. Saying so beats presenting a guess as a finding.
    const resolved = resolveBaseBranch({
      policy: 'branched-from',
      branchedFrom: null,
      defaultBranch: 'main',
      currentBranch: 'feature',
    });

    assert.equal(resolved?.branch, 'main');
    assert.match(resolved!.reason, /could not tell/);
  });

  test('honours an explicit preference for the default branch', () => {
    const resolved = resolveBaseBranch({
      policy: 'default-branch',
      branchedFrom: 'develop',
      defaultBranch: 'main',
      currentBranch: 'feature',
    });
    assert.equal(resolved?.branch, 'main');
  });

  test('there is nothing to open when the base is the current branch', () => {
    // Committing straight onto the default branch is a legitimate choice; it
    // just leaves no pull request to open, and saying so beats a 422.
    assert.equal(
      resolveBaseBranch({
        policy: 'branched-from',
        branchedFrom: null,
        defaultBranch: 'main',
        currentBranch: 'main',
      }),
      null,
    );
  });

  test('a branch that reports itself as its own start point is not a base', () => {
    assert.equal(
      resolveBaseBranch({
        policy: 'branched-from',
        branchedFrom: 'main',
        defaultBranch: null,
        currentBranch: 'main',
      }),
      null,
    );
  });
});

describe('pull request configuration', () => {
  test('finishing the job is the default; merging never is', () => {
    assert.equal(DEFAULT_CONFIG.pullRequest.enabled, true);
    assert.equal(DEFAULT_CONFIG.pullRequest.base, 'branched-from');
    // Interactive surfaces propose a name the developer can change.
    assert.equal(DEFAULT_CONFIG.pullRequest.confirm, 'ask');
    assert.equal(DEFAULT_CONFIG.pullRequest.coAuthor, true);
  });
});
