import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIssueWithGh, createPullRequestWithGh, ghAvailability, type GhRunner } from '../src/gh.js';
import { compareUrl } from '../src/ship.js';

/**
 * The GitHub CLI path, tested without a GitHub CLI.
 *
 * Every one of these cases is a real machine somebody ships from: `gh` absent,
 * `gh` present but signed out, `gh` refusing because the base branch is wrong,
 * `gh` reporting a pull request that already exists. The contract under all of
 * them is the same and is the reason this code exists at all — the branch is
 * already pushed, so the worst outcome is a compare link, never a failure.
 *
 * The fake runner also records every argument, which is how the safety
 * properties are checked: nothing here may ever ask `gh` to merge, and nothing
 * may ever ask git to force.
 */

interface Recorded {
  args: readonly string[];
  cwd: string;
}

function runner(
  handlers: Record<string, (args: readonly string[]) => Promise<{ stdout: string }>>,
  calls: Recorded[] = [],
): GhRunner {
  return async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    const key = args.slice(0, 2).join(' ');
    const handler = handlers[key] ?? handlers[args[0] ?? ''] ?? null;
    if (!handler) throw Object.assign(new Error(`unexpected: gh ${args.join(' ')}`), { stderr: '' });
    return handler(args);
  };
}

const ok = async () => ({ stdout: '' });
const fails = async () => {
  throw Object.assign(new Error('exit 1'), { stderr: 'gh: something went wrong' });
};

function request(over: Partial<Parameters<typeof createPullRequestWithGh>[0]> = {}) {
  return {
    cwd: '/repo',
    head: 'drift/upgrade-react-18.3.1-to-19.2.0',
    base: 'develop',
    title: 'chore(deps): upgrade react to 19.2.0',
    body: '| Package | Version |\n| --- | --- |\n| react | 18.3.1 → 19.2.0 |',
    ...over,
  };
}

describe('deciding whether the GitHub CLI can help', () => {
  test('a machine with no gh is not a machine with a problem', async () => {
    const availability = await ghAvailability('/repo', runner({ '--version': fails }));
    assert.deepEqual(availability, { installed: false, authenticated: false });
  });

  test('tells "not installed" apart from "installed, signed out"', async () => {
    const availability = await ghAvailability(
      '/repo',
      runner({ '--version': ok, 'auth status': fails }),
    );
    assert.deepEqual(availability, { installed: true, authenticated: false });
  });

  test('is ready only when gh holds a credential', async () => {
    const availability = await ghAvailability(
      '/repo',
      runner({ '--version': ok, 'auth status': ok }),
    );
    assert.deepEqual(availability, { installed: true, authenticated: true });
  });
});

describe('opening the pull request directly', () => {
  test('creates it when gh is installed and signed in', async () => {
    const calls: Recorded[] = [];
    const outcome = await createPullRequestWithGh(
      request(),
      runner(
        {
          '--version': ok,
          'auth status': ok,
          'pr create': async () => ({ stdout: 'https://github.com/acme/app/pull/412\n' }),
        },
        calls,
      ),
    );

    assert.equal(outcome.kind, 'opened');
    assert.deepEqual(outcome.kind === 'opened' ? outcome.pr : null, {
      url: 'https://github.com/acme/app/pull/412',
      number: 412,
      existing: false,
    });
    assert.ok(calls.every((call) => call.cwd === '/repo'));
  });

  test('carries the head, the base, the title and the report body', async () => {
    const calls: Recorded[] = [];
    let body = '';

    await createPullRequestWithGh(
      request({ draft: true, labels: ['dependencies'], reviewers: ['acme/platform'] }),
      runner(
        {
          '--version': ok,
          'auth status': ok,
          'pr create': async (args) => {
            // The body goes through a file, so no shell ever sees it.
            const path = args[args.indexOf('--body-file') + 1]!;
            body = await readFile(path, 'utf8');
            return { stdout: 'https://github.com/acme/app/pull/1' };
          },
        },
        calls,
      ),
    );

    const create = calls.find((call) => call.args[1] === 'create')!.args;
    assert.deepEqual(
      [create[create.indexOf('--head') + 1], create[create.indexOf('--base') + 1]],
      ['drift/upgrade-react-18.3.1-to-19.2.0', 'develop'],
    );
    assert.equal(create[create.indexOf('--title') + 1], 'chore(deps): upgrade react to 19.2.0');
    assert.ok(create.includes('--draft'));
    assert.equal(create[create.indexOf('--label') + 1], 'dependencies');
    assert.equal(create[create.indexOf('--reviewer') + 1], 'acme/platform');
    assert.match(body, /react \| 18\.3\.1 → 19\.2\.0/);
  });

  test('stays out of draft unless asked', async () => {
    const calls: Recorded[] = [];
    await createPullRequestWithGh(
      request(),
      runner(
        {
          '--version': ok,
          'auth status': ok,
          'pr create': async () => ({ stdout: 'https://github.com/acme/app/pull/2' }),
        },
        calls,
      ),
    );
    assert.ok(!calls.some((call) => call.args.includes('--draft')));
  });

  test('reads the URL past whatever banner gh printed first', async () => {
    const outcome = await createPullRequestWithGh(
      request(),
      runner({
        '--version': ok,
        'auth status': ok,
        'pr create': async () => ({
          stdout: 'Warning: 3 uncommitted changes\nCreating pull request\nhttps://github.com/acme/app/pull/77\n',
        }),
      }),
    );
    assert.equal(outcome.kind === 'opened' ? outcome.pr.number : null, 77);
  });
});

describe('a pull request that already exists', () => {
  test('returns the open one rather than calling the retry a failure', async () => {
    const outcome = await createPullRequestWithGh(
      request(),
      runner({
        '--version': ok,
        'auth status': ok,
        'pr create': fails,
        'pr view': async () => ({
          stdout: JSON.stringify({ url: 'https://github.com/acme/app/pull/9', number: 9 }),
        }),
      }),
    );

    assert.deepEqual(outcome.kind === 'opened' ? outcome.pr : null, {
      url: 'https://github.com/acme/app/pull/9',
      number: 9,
      existing: true,
    });
  });

  test('asks gh rather than reading the wording of its error', async () => {
    const calls: Recorded[] = [];
    await createPullRequestWithGh(
      request(),
      runner(
        {
          '--version': ok,
          'auth status': ok,
          'pr create': fails,
          'pr view': async () => ({ stdout: JSON.stringify({ url: 'https://github.com/a/b/pull/3' }) }),
        },
        calls,
      ),
    );

    const view = calls.find((call) => call.args[1] === 'view');
    assert.ok(view, 'gh pr view is how "already exists" is answered');
    assert.equal(view.args[2], 'drift/upgrade-react-18.3.1-to-19.2.0');
  });
});

describe('falling back', () => {
  test('a missing gh is reported as unavailable, not as a failure', async () => {
    const outcome = await createPullRequestWithGh(request(), runner({ '--version': fails }));
    assert.deepEqual(outcome, { kind: 'unavailable', reason: 'not-installed' });
  });

  test('a signed-out gh is reported as unavailable too', async () => {
    const outcome = await createPullRequestWithGh(
      request(),
      runner({ '--version': ok, 'auth status': fails }),
    );
    assert.deepEqual(outcome, { kind: 'unavailable', reason: 'not-authenticated' });
  });

  test('never runs pr create at all when gh cannot be used', async () => {
    const calls: Recorded[] = [];
    await createPullRequestWithGh(request(), runner({ '--version': ok, 'auth status': fails }, calls));
    assert.ok(!calls.some((call) => call.args[1] === 'create'));
  });

  test('a genuine refusal from GitHub surfaces the reason, not a stack trace', async () => {
    const outcome = await createPullRequestWithGh(
      request(),
      runner({
        '--version': ok,
        'auth status': ok,
        'pr create': async () => {
          throw Object.assign(new Error('exit 1'), {
            stderr: 'pull request create failed: GraphQL: No commits between develop and drift/x',
          });
        },
        'pr view': fails,
      }),
    );

    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.message : '', /No commits between/);
  });

  test('every unavailable path still has a compare page to offer', () => {
    // What the caller falls back to. The branch is pushed by the time any of
    // this runs, so the link opens against refs that exist.
    assert.equal(
      compareUrl('git@github.com:acme/app.git', 'develop', 'drift/upgrade-react-18.3.1-to-19.2.0'),
      'https://github.com/acme/app/compare/develop...drift%2Fupgrade-react-18.3.1-to-19.2.0?expand=1',
    );
  });

  test('an empty success is not reported as an opened pull request', async () => {
    const outcome = await createPullRequestWithGh(
      request(),
      runner({
        '--version': ok,
        'auth status': ok,
        'pr create': async () => ({ stdout: '\n' }),
        'pr view': fails,
      }),
    );
    assert.equal(outcome.kind, 'failed');
  });
});

describe('creating an issue', () => {
  test('drops labels and retries when the repository has none of them yet', async () => {
    const calls: Recorded[] = [];
    const outcome = await createIssueWithGh(
      {
        cwd: '/repo',
        title: 'Drift: react — a breaking change',
        body: 'body',
        labels: ['drift', 'drift:react'],
        marker: 'drift-issue:react:abc',
      },
      runner(
        {
          '--version': ok,
          'auth status': ok,
          'search issues': async () => ({ stdout: '[]' }),
          'issue create': async (args) => {
            if (args.includes('--label')) {
              throw Object.assign(new Error('exit 1'), {
                stderr: "could not add label: 'drift' not found",
              });
            }
            return { stdout: 'https://github.com/acme/repo/issues/42\n' };
          },
        },
        calls,
      ),
    );

    assert.deepEqual(outcome, {
      kind: 'opened',
      number: 42,
      url: 'https://github.com/acme/repo/issues/42',
      existing: false,
    });

    const issueCalls = calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.equal(issueCalls.length, 2, 'retries once, without labels');
    assert.ok(issueCalls[0]!.args.includes('--label'), 'first attempt asks for the labels');
    assert.ok(!issueCalls[1]!.args.includes('--label'), 'retry drops them rather than failing the issue');
  });

  test('a failure unrelated to labels is not retried', async () => {
    const calls: Recorded[] = [];
    const outcome = await createIssueWithGh(
      {
        cwd: '/repo',
        title: 'Drift: react — a breaking change',
        body: 'body',
        labels: ['drift'],
        marker: 'drift-issue:react:abc',
      },
      runner(
        {
          '--version': ok,
          'auth status': ok,
          'search issues': async () => ({ stdout: '[]' }),
          'issue create': fails,
        },
        calls,
      ),
    );

    assert.equal(outcome.kind, 'failed');
    const issueCalls = calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.equal(issueCalls.length, 1, 'no retry for an error that has nothing to do with labels');
  });
});

describe('what this code is never allowed to do', () => {
  test('announces the attempt only once gh is known to be usable', async () => {
    let announced = 0;
    await createPullRequestWithGh(
      { ...request(), onAttempt: () => (announced += 1) },
      runner({ '--version': ok, 'auth status': fails }),
    );
    assert.equal(announced, 0, 'nothing is announced on a machine with no signed-in gh');

    await createPullRequestWithGh(
      { ...request(), onAttempt: () => (announced += 1) },
      runner({
        '--version': ok,
        'auth status': ok,
        'pr create': async () => ({ stdout: 'https://github.com/a/b/pull/1' }),
      }),
    );
    assert.equal(announced, 1);
  });

  test('never merges, never closes, never forces, and never pushes', async () => {
    const calls: Recorded[] = [];
    const seen: string[] = [];

    const scenarios: Record<string, (args: readonly string[]) => Promise<{ stdout: string }>>[] = [
      { '--version': fails },
      { '--version': ok, 'auth status': fails },
      {
        '--version': ok,
        'auth status': ok,
        'pr create': async () => ({ stdout: 'https://github.com/a/b/pull/1' }),
      },
      { '--version': ok, 'auth status': ok, 'pr create': fails, 'pr view': fails },
      {
        '--version': ok,
        'auth status': ok,
        'pr create': fails,
        'pr view': async () => ({ stdout: JSON.stringify({ url: 'https://github.com/a/b/pull/4' }) }),
      },
    ];

    for (const handlers of scenarios) {
      await createPullRequestWithGh(request(), runner(handlers, calls));
    }

    for (const call of calls) seen.push(call.args.join(' '));
    const forbidden = /\b(merge|close|--force|-f\b|push|delete|ready)\b/;
    for (const line of seen) {
      assert.ok(!forbidden.test(line), `gh ${line} is not something Drift may run`);
    }
    // The only two subcommands that exist on this path.
    for (const line of seen) {
      assert.ok(
        line === '--version' || line === 'auth status' || line.startsWith('pr create') || line.startsWith('pr view'),
        `unexpected gh invocation: ${line}`,
      );
    }
  });
});
