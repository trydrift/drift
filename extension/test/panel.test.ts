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
    awaitingAnswer: false,
    commands: SLASH_COMMANDS,
    draft: '',
    ...over,
  };
}

test('an empty session renders the welcome state and a composer', () => {
  const html = renderPanel(model());

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /class="welcome"/);
  assert.match(html, /class="composer/);
  assert.match(html, /data-command="\/scan"/);
  // The composer, not a header toolbar, owns the per-turn settings.
  assert.match(html, /data-action="setAgent"/);
  assert.match(html, /data-action="setMode"/);
  assert.match(html, /data-action="setEffort"/);
  assert.match(html, /data-action="setPermission"/);
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
  // Busy swaps send for stop, so a long scan is always interruptible.
  assert.match(html, /data-action="stop"/);
  assert.ok(!/data-action="submit"/.test(html));
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

test('every slash command is offered in the palette', () => {
  const html = renderPanel(model());
  for (const command of SLASH_COMMANDS) {
    assert.ok(html.includes(`data-command="${command.name}"`), `${command.name} is missing`);
  }
});
