import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBody } from '../src/ui/webview.js';
import type { ViewModel } from '../src/ui/webview.js';

/**
 * What the panel says when it is not allowed to do anything.
 *
 * VS Code's Restricted Mode is not an error state and not a Drift state: the
 * window simply has not been trusted, and every single thing this panel offers
 * — scan, recent change, fix — ends in a git command, a package manager or an
 * agent binary. Until then Drift can run none of it.
 *
 * The failure this guards against is the one a fresh Codespace produced: a
 * panel that rendered its usual three invitations, all of them dead, or nothing
 * at all. A developer looking at an empty panel cannot tell whether Drift is
 * broken, still starting, or waiting on a dialog they dismissed. So the one
 * thing the untrusted panel must do is *say which*, and offer the only button
 * that can change it.
 */

function model(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    nonce: 'n',
    repoLabel: null,
    signedInLabel: null,
    agents: [],
    agentId: 'auto',
    agentLabel: 'Copilot',
    mode: 'ask',
    effortLabel: null,
    modelLabel: null,
    permission: 'ask',
    branchMode: 'current',
    commitMode: 'ask',
    scopeLabel: null,
    attachments: [],
    thread: [],
    candidates: {},
    review: null,
    busy: false,
    cancellable: false,
    stopping: false,
    awaitingAnswer: false,
    commands: [],
    menu: [],
    stale: null,
    draft: '',
    draftToken: 0,
    conversationId: 'c1',
    ...overrides,
  } as ViewModel;
}

test('an untrusted workspace is explained, not left blank', () => {
  const html = renderBody(model({ untrusted: true }));

  assert.match(html, /trust this folder/i, 'it names what is missing');
  assert.match(html, /Restricted Mode/, 'in the words VS Code itself uses, so the two are recognisably the same thing');
  assert.match(html, /Nothing has been analysed/i, 'and does not let an empty panel imply a clean result');
});

test('the untrusted panel offers the one button that can unblock it', () => {
  const html = renderBody(model({ untrusted: true }));

  // `command` + `data-command` is what the client's generic dispatch posts to
  // the host, where exactly this one command id is allowed through.
  assert.match(html, /data-action="command"[^>]*data-command="workbench\.trust\.manage"/);
});

test('the untrusted panel does not offer what it cannot do', () => {
  const html = renderBody(model({ untrusted: true }));

  // Every one of these ends in a subprocess. Offering them here would be
  // inviting the developer to press buttons that silently do nothing.
  assert.doesNotMatch(html, /data-command="\/scan"/);
  assert.doesNotMatch(html, /data-command="\/recent"/);
});

test('a trusted workspace is unchanged', () => {
  const html = renderBody(model());

  assert.match(html, /data-command="\/scan"/, 'the normal invitations are back');
  assert.doesNotMatch(html, /Restricted Mode/);
});
