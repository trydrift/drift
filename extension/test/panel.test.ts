import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPanel, SLASH_COMMANDS, type ViewModel } from '../src/ui/webview.js';
import { describeSeverity, severityOf } from '../src/severity.js';
import type { UpgradeCandidate } from '../src/upgrades.js';

/**
 * The panel is the product, and it is a large amount of generated markup. It is
 * a pure function of a view model and imports no `vscode`, specifically so that
 * it can be rendered here — an unrenderable panel that typechecks is still a
 * broken extension.
 *
 * The assertions that matter are about *framing* as much as structure: the panel
 * must not shout about breaking changes that do not affect the repository, and it
 * must never inline unescaped content from a changelog.
 */

function candidate(over: Partial<UpgradeCandidate> = {}): UpgradeCandidate {
  return {
    id: 'lodash@4.17.21->5.0.0',
    name: 'lodash',
    kind: 'runtime',
    manifestPath: 'package.json',
    current: '4.17.21',
    range: '^4.17.0',
    safeLatest: '4.17.23',
    selected: '5.0.0',
    latest: '5.0.0',
    versions: ['5.0.0', '4.17.23'],
    status: 'ready',
    evidenceCount: 3,
    breakingCount: 7,
    impactCount: 0,
    impactFiles: 0,
    risk: 'none',
    summary: '7 breaking changes in lodash, but this repository does not use any of the affected APIs.',
    ...over,
  };
}

function model(over: Partial<ViewModel> = {}): ViewModel {
  return {
    nonce: 'abc123',
    repoLabel: 'acme/app',
    signedInLabel: null,
    agents: [{ id: 'copilot-lm', label: 'GitHub Copilot', available: true }],
    agentId: 'auto',
    agentLabel: 'GitHub Copilot',
    mode: 'agent',
    effort: 'balanced',
    permission: 'auto-edit',
    attachments: [],
    thread: [],
    candidates: {},
    review: null,
    busy: false,
    cancellable: true,
    awaitingAnswer: false,
    commands: SLASH_COMMANDS,
    menu: [
      {
        id: 'context',
        title: 'Context',
        items: [{ id: 'context:file', label: 'Add a file…', detail: 'Search this project by path', icon: 'file' }],
      },
      {
        id: 'model',
        title: 'Model',
        items: [
          { id: 'agent:auto', label: 'Auto', hint: 'agent', checked: true },
          { id: 'effort:thorough', label: 'Thorough', hint: 'effort' },
        ],
      },
    ],
    stale: null,
    draft: '',
    ...over,
  };
}

test('an empty session renders the welcome state and a composer', () => {
  const html = renderPanel(model());

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /class="welcome /);
  assert.match(html, /class="composer/);
  assert.match(html, /data-command="\/scan"/);
  // One menu, opened from the composer, holding every per-turn setting.
  assert.match(html, /data-action="openMenu" data-anchor="context"/);
  assert.match(html, /data-action="openMenu" data-anchor="model"/);
  assert.match(html, /id="menu-filter"/);
});

test('the composer menu is one list, searchable, in two named sections', () => {
  const html = renderPanel(model());

  assert.match(html, /data-section="context"/);
  assert.match(html, /data-section="model"/);
  // Every row carries the words it can be found by, so one filter box reaches
  // settings that used to live behind five separate buttons.
  assert.match(html, /data-action="menu" data-id="effort:thorough"/);
  assert.match(html, /data-search="[^"]*effort[^"]*"/);
  // The menu ships hidden and is opened in the webview, not by the host.
  assert.match(html, /<div class="menu" id="menu" hidden>/);
});

test('no control in the panel is an OS-drawn form widget', () => {
  // A native dropdown inside a webview is painted by the operating system: it
  // ignores the colour theme, mis-centres its own label, and cannot show the
  // sentence that explains each option. The menu is themed markup; the only
  // native elements are the two text-entry fields, which VS Code themes itself.
  const c = candidate({ impactCount: 2, impactFiles: 1 });
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.ok(!/<select\b/.test(html), 'no native dropdowns');
  assert.ok(!/<option\b/.test(html), 'no native dropdown options');
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(inputs.length, 1, 'the menu filter is the only input');
  assert.match(inputs[0]!, /type="text"/);
  // The target-version control is the one inside a result row, and it is a
  // button too — consistency here is the whole point.
  assert.match(html, /data-action="pickVersion" data-id="/);
});

test('the nonce is applied to both the script and the CSP', () => {
  const html = renderPanel(model({ nonce: 'NONCEVALUE' }));
  assert.match(html, /script-src 'nonce-NONCEVALUE'/);
  assert.match(html, /<script nonce="NONCEVALUE">/);
  assert.ok(!html.includes('unsafe-eval'));
});

test('an upstream-only package is not framed as an alarm', () => {
  const c = candidate();
  assert.equal(severityOf(c), 'upstream-only');

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  // The row reads "Safe here", and carries neither the warning tint nor the
  // error tint — only `affected` and `error` deviate from the calm default.
  assert.match(html, /Safe here/);
  assert.match(html, /class="dot upstream-only"/);
  assert.ok(!/class="dot affected"/.test(html), 'must not be tinted as affecting the repo');
  assert.ok(!/verdict affected/.test(html), 'must not be labelled as affecting the repo');
  assert.match(describeSeverity(c), /none used here/);
});

test('a package that does affect the repo says so, with counts', () => {
  const c = candidate({ impactCount: 4, impactFiles: 2 });
  assert.equal(severityOf(c), 'affected');

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade needs attention.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /4 sites here/);
  assert.match(html, /class="dot affected"/);
  assert.match(html, /data-action="fixPackage"/);
});

test('a running step shows the specific phase, detail and progress', () => {
  const html = renderPanel(
    model({
      busy: true,
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Reading release notes and changelog',
          detail: 'react 18.3.1 → 19.2.0',
          done: 12,
          total: 48,
          state: 'running',
          log: ['Reading manifest — package.json', 'Reading release notes and changelog — react 18.3.1 → 19.2.0'],
        },
      ],
    }),
  );

  assert.match(html, /Reading release notes and changelog/);
  assert.match(html, /react 18\.3\.1 → 19\.2\.0/);
  assert.match(html, /12 \/ 48/);
  assert.match(html, /width:25%/);
  // Agent work is interruptible, and says so with a stop button.
  assert.match(html, /data-action="stop"/);
  assert.ok(!/data-action="submit"/.test(html));
});

test('a dependency check offers no way to stop it', () => {
  // A scan stopped half way has not checked the packages it never reached, but
  // the tallies, the safe list and the headline would all read as though it had.
  // The one wrong answer Drift must never give is "safe" about something nothing
  // looked at, so this run has no stop button at all.
  const html = renderPanel(
    model({
      busy: true,
      cancellable: false,
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Reading release notes',
          detail: 'react',
          done: 3,
          total: 40,
          state: 'running',
          log: ['a', 'b'],
        },
      ],
    }),
  );

  assert.ok(!/data-action="stop"/.test(html), 'a scan cannot be interrupted');
  assert.ok(!/data-action="submit"/.test(html));
  assert.match(html, /class="working"/);
});

test('the introduction survives the opening scan and goes when talking starts', () => {
  const scanning = renderPanel(
    model({
      busy: true,
      cancellable: false,
      thread: [
        { id: 's1', kind: 'step', title: 'Checking your dependencies', phase: 'Reading', detail: '', done: 0, total: 9, state: 'running', log: [] },
      ],
    }),
  );

  // Still explaining what the panel is for, now underneath the work it started.
  assert.match(scanning, /class="welcome compact"/);
  assert.ok(scanning.indexOf('class="step') < scanning.indexOf('class="welcome'), 'the scan comes first');

  const talking = renderPanel(
    model({ thread: [{ id: 'u1', kind: 'user', text: 'hello', attachments: [] }] }),
  );
  assert.ok(!/class="welcome/.test(talking), 'the conversation replaces the introduction');
});

test('a turn with a checkpoint offers a rewind', () => {
  const withCheckpoint = renderPanel(
    model({ thread: [{ id: 'u1', kind: 'user', text: '/fix', attachments: [], checkpoint: 'c1' }] }),
  );
  assert.match(withCheckpoint, /data-action="rewind" data-id="u1"/);

  // No snapshot, no button: a folder that is not a git repository cannot be
  // rewound, and offering the control anyway would be a promise Drift cannot keep.
  const without = renderPanel(model({ thread: [{ id: 'u1', kind: 'user', text: '/fix', attachments: [] }] }));
  assert.ok(!/data-action="rewind"/.test(without));
});

test('safe upgrades can be taken in one action, unknown ones cannot', () => {
  const clean = candidate({ id: 'a@1->2', name: 'a', breakingCount: 0, summary: 'no breaking changes' });
  const upstream = candidate({ id: 'b@1->2', name: 'b' });
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'Two upgrades.', ids: [clean.id, upstream.id] }],
      candidates: { [clean.id]: clean, [upstream.id]: upstream },
    }),
  );

  assert.match(html, /data-action="upgradeAll"/);
  assert.match(html, /Upgrade all 2/);
});

test('a scan whose results have gone stale says so and offers a rescan', () => {
  const c = candidate();
  const html = renderPanel(
    model({
      stale: { reason: 'dependencies', label: 'package.json changed since this scan.' },
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /package.json changed since this scan/);
  assert.match(html, /data-action="rescan"/);
});

test('every disclosure carries a key, so re-rendering cannot collapse it', () => {
  // The panel re-renders many times a second during a scan. Without a stable
  // key on each <details>, everything the developer opened slams shut each time
  // a package arrives — exactly when they are reading it.
  const c = candidate({ impactCount: 2, impactFiles: 1 });
  const html = renderPanel(
    model({
      thread: [
        { id: 's1', kind: 'step', title: 'Checking', phase: 'x', detail: '', done: 1, total: 2, state: 'running', log: ['a', 'b'] },
        { id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] },
      ],
      candidates: { [c.id]: c },
    }),
  );

  for (const tag of html.matchAll(/<details\b[^>]*>/g)) {
    assert.match(tag[0], /data-key="/, `a <details> has no key: ${tag[0]}`);
  }
  assert.match(html, /data-key="log:s1"/);
  assert.match(html, /data-key="pkg:lodash"/);
});

test('an open question renders its options and no answer', () => {
  const html = renderPanel(
    model({
      awaitingAnswer: true,
      thread: [
        {
          id: 'q1',
          kind: 'question',
          text: 'Two migrations are valid here. Which do you want?',
          options: [
            { label: 'Use the new async API', value: 'async' },
            { label: 'Keep it synchronous', value: 'sync' },
          ],
          allowFreeText: true,
        },
      ],
    }),
  );

  assert.match(html, /class="turn assistant question open"/);
  assert.match(html, /data-action="answer" data-id="q1" data-value="async"/);
  assert.match(html, /Or type your own answer below/);
});

test('an answered question shows the answer and no buttons', () => {
  const html = renderPanel(
    model({
      thread: [
        {
          id: 'q1',
          kind: 'question',
          text: 'Which?',
          options: [{ label: 'A', value: 'a' }],
          allowFreeText: false,
          answer: 'a',
        },
      ],
    }),
  );

  assert.match(html, /answered-with/);
  assert.ok(!/data-action="answer"/.test(html));
});

test('the changes card lists files with keep and undo at both levels', () => {
  const html = renderPanel(
    model({
      thread: [{ id: 'c1', kind: 'changes', title: 'Changes waiting for you' }],
      review: {
        totals: { files: 1, hunks: 2, added: 5, removed: 3, groups: 1 },
        groups: [
          {
            order: 1,
            title: 'fix(deps): migrate lodash chain calls',
            paths: ['src/report.ts'],
            files: [
              {
                path: 'src/report.ts',
                baseline: 'a',
                current: 'b',
                hunks: [
                  { id: '1-1', start: 1, end: 2, baselineStart: 1, baselineEnd: 2, modifiedLines: ['b'], baselineLines: ['a'] },
                  { id: '9-9', start: 9, end: 10, baselineStart: 9, baselineEnd: 10, modifiedLines: ['d'], baselineLines: ['c'] },
                ],
                stat: { added: 5, removed: 3 },
              },
            ],
          },
        ],
      },
    }),
  );

  assert.match(html, /data-action="keepAll"/);
  assert.match(html, /data-action="undoAll"/);
  assert.match(html, /data-action="keepGroup" data-order="1"/);
  assert.match(html, /data-action="keepFile" data-path="src\/report.ts"/);
  assert.match(html, /data-action="openDiff" data-path="src\/report.ts"/);
  // The promise that makes review safe, stated where the decision is made.
  assert.match(html, /Nothing is committed yet/);
});

test('a committed group reports its sha and offers no further action', () => {
  const html = renderPanel(
    model({
      thread: [{ id: 'c1', kind: 'changes', title: 'Changes' }],
      review: {
        totals: { files: 1, hunks: 1, added: 1, removed: 0, groups: 1 },
        groups: [
          {
            order: 1,
            title: 'done',
            paths: ['done.ts'],
            files: [],
            committed: { sha: 'abcdef1234', branch: 'drift/fix' },
          },
          {
            order: 2,
            title: 'still open',
            paths: ['a.ts'],
            files: [
              {
                path: 'a.ts',
                baseline: 'x',
                current: 'y',
                hunks: [{ id: '0-0', start: 0, end: 1, baselineStart: 0, baselineEnd: 1, modifiedLines: ['y'], baselineLines: ['x'] }],
                stat: { added: 1, removed: 1 },
              },
            ],
          },
        ],
      },
    }),
  );

  assert.match(html, /Committed as abcdef1/);
  assert.ok(!/data-action="keepGroup" data-order="1"/.test(html), 'a committed group has no keep button');
  assert.match(html, /data-action="keepGroup" data-order="2"/);
});

test('evidence content from a third party is escaped, not injected', () => {
  // Changelog text is fetched from the internet. Rendering it unescaped would
  // put arbitrary markup inside the panel.
  const hostile = '<img src=x onerror="alert(1)">';
  const c = candidate({
    impactCount: 1,
    impactFiles: 1,
    summary: hostile,
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: hostile, ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.ok(!html.includes('<img src=x'), 'raw markup must not survive rendering');
  assert.match(html, /&lt;img src=x/);
});

test('attachment chips render with a remove button', () => {
  const html = renderPanel(
    model({ attachments: [{ kind: 'file', label: 'src/http.ts', value: 'src/http.ts' }] }),
  );

  assert.match(html, /class="chip">/);
  assert.match(html, /data-action="detach" data-value="src\/http.ts"/);
});

test('a panel with every item type produces balanced markup', () => {
  // Unbalanced tags in a webview do not throw — the browser silently reparents
  // everything after the mistake, and the panel just looks broken. So this walks
  // a fully-populated render and checks the tags actually close.
  const c = candidate({ impactCount: 5, impactFiles: 2, risk: 'medium' });
  const html = renderPanel(
    model({
      attachments: [{ kind: 'file', label: 'src/http.ts', value: 'src/http.ts' }],
      awaitingAnswer: true,
      thread: [
        { id: 'u1', kind: 'user', text: '/scan', attachments: [] },
        { id: 'a1', kind: 'assistant', text: 'Here is what I found:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```' },
        { id: 's1', kind: 'step', title: 'Checking', phase: 'Reading changelog', detail: 'lodash 4 → 5', done: 3, total: 9, state: 'done', log: ['a', 'b'] },
        { id: 'p1', kind: 'packages', headline: '**1 of 1** affects your code.', ids: [c.id] },
        { id: 'q1', kind: 'question', text: 'Which migration?', options: [{ label: 'A', value: 'a' }], allowFreeText: true },
        { id: 'n1', kind: 'notice', tone: 'warn', text: 'heads up' },
        { id: 'ch1', kind: 'changes', title: 'Changes waiting' },
      ],
      candidates: { [c.id]: c },
      review: {
        totals: { files: 1, hunks: 1, added: 2, removed: 1, groups: 1 },
        groups: [
          {
            order: 1,
            title: 'fix: migrate',
            paths: ['src/a.ts'],
            files: [
              {
                path: 'src/a.ts',
                baseline: 'x',
                current: 'y',
                hunks: [{ id: '0-0', start: 0, end: 1, baselineStart: 0, baselineEnd: 1, modifiedLines: ['y'], baselineLines: ['x'] }],
                stat: { added: 2, removed: 1 },
              },
            ],
          },
        ],
      },
    }),
  );

  const voids = new Set(['meta', 'br', 'hr', 'img', 'input', 'source', 'path', 'circle', 'rect', 'use']);
  const stack: string[] = [];

  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    if (voids.has(name) || match[3]!.trimEnd().endsWith('/')) continue;

    if (closing) {
      assert.equal(stack.pop(), name, `</${name}> closed the wrong element`);
    } else {
      stack.push(name);
    }
  }

  assert.deepEqual(stack, [], 'every tag is closed');
});

test('every slash command is offered in the palette', () => {
  const html = renderPanel(model());
  for (const command of SLASH_COMMANDS) {
    assert.ok(html.includes(`data-command="${command.name}"`), `${command.name} is missing`);
  }
});
