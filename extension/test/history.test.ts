import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DriftHistory, deriveTitle } from '../src/history.js';
import { scanTitle } from '../src/severity.js';
import { DriftSession, type ThreadItem } from '../src/session.js';
import { DriftState } from '../src/state.js';
import { DriftReview } from '../src/review/store.js';
import { DriftHomeView } from '../src/ui/home.js';

/**
 * What a saved conversation is called.
 *
 * The history list had forty entries and every one of them read `/scan`,
 * because the title was "the first thing the developer typed" and everything
 * in this panel is started by a button that submits a slash command. A title
 * in a list like that has exactly one job — telling two entries apart — and it
 * was doing none of it. These tests are about that job, not about phrasing.
 */

const user = (text: string): ThreadItem => ({ id: 'i1', kind: 'user', text, attachments: [] });

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  readonly keys = () => [...this.values.keys()];
  get<T>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

function output(): vscode.LogOutputChannel {
  return {
    name: 'Drift Test',
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    append: () => undefined,
    appendLine: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
    logLevel: 2,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
  } as unknown as vscode.LogOutputChannel;
}

function homeFixture() {
  const memento = new MemoryMemento();
  const session = new DriftSession();
  const review = new DriftReview();
  const home = new DriftHomeView(vscode.Uri.file('/tmp/drift-test'), new DriftState(), session, review, output(), memento);
  const history = new DriftHistory(memento);
  return { home, session, history };
}

function installMessages() {
  const messages = { warnings: [] as string[], infos: [] as string[] };
  const originalWarning = vscode.window.showWarningMessage;
  const originalInfo = vscode.window.showInformationMessage;
  vscode.window.showWarningMessage = async (message: string) => {
    messages.warnings.push(message);
    return 'Delete' as never;
  };
  vscode.window.showInformationMessage = async (message: string) => {
    messages.infos.push(message);
    return undefined;
  };
  return {
    messages,
    restore: () => {
      vscode.window.showWarningMessage = originalWarning;
      vscode.window.showInformationMessage = originalInfo;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('naming a saved conversation', () => {
  test('a bare command becomes what the command did', () => {
    assert.equal(deriveTitle([user('/scan')]), 'Dependency scan');
    assert.equal(deriveTitle([user('/recent')]), 'Recent dependency changes');
    assert.equal(deriveTitle([user('/review')]), 'Review changes');
  });

  test("a command's argument survives, since it is what differs between two runs", () => {
    assert.equal(deriveTitle([user('/fix react')]), 'Fix react');
    assert.equal(deriveTitle([user('/upgrade lodash')]), 'Upgrade lodash');
  });

  test('a sentence is already a title and is left alone', () => {
    const text = 'why does the express upgrade break my error handler';
    assert.equal(deriveTitle([user(text)]), text);
  });

  test('an unknown command is still shown rather than swallowed', () => {
    assert.equal(deriveTitle([user('/frobnicate everything')]), 'frobnicate everything');
  });

  test('a conversation nobody typed into is named after the work in it', () => {
    // Opened from a lens, a code action or the report — there is no user turn
    // to read, and "Conversation" would be the least useful answer available.
    const items: ThreadItem[] = [
      { id: 'i1', kind: 'tasks', title: 'Copilot is fixing 4 sites', subtitle: '', groups: [] },
    ];
    assert.equal(deriveTitle(items), 'Copilot is fixing 4 sites');
  });

  test('titles are bounded, so one long paste cannot take over the list', () => {
    assert.ok(deriveTitle([user('x'.repeat(400))]).length <= 80);
  });
});

/**
 * Naming a scan by what it found.
 *
 * This is the half that actually fixes the reported problem: every scan is
 * started the same way, so only the result distinguishes two of them.
 */
describe('naming a scan by its result', () => {
  const candidate = (over: Partial<Parameters<typeof scanTitle>[0][number]>) => ({
    status: 'ok',
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    recommendation: 'no-breaking-changes',
    ...over,
  });

  test('the affected count leads, because that is what a scan is remembered by', () => {
    const title = scanTitle([
      candidate({ impactCount: 3, impactFiles: 2 }),
      candidate({}),
      candidate({}),
    ]);
    assert.equal(title, 'Scan — 1 of 3 affect this repo');
  });

  test('two scans of different repositories do not get the same name', () => {
    const clean = scanTitle([candidate({}), candidate({})]);
    const broken = scanTitle([candidate({ impactCount: 1, impactFiles: 1 }), candidate({})]);
    assert.notEqual(clean, broken);
  });

  test('unverified is never folded into safe, even in a title', () => {
    // The same claim the verdict refuses to make. A history entry reading "all
    // safe" for a run that could not check half of it is that claim, one level
    // further out.
    const title = scanTitle([candidate({}), candidate({ recommendation: 'insufficient-evidence' })]);
    assert.match(title, /unverified/);
    assert.doesNotMatch(title, /all safe/);
  });

  test('a scan that found nothing to do says so rather than reading as empty', () => {
    assert.equal(scanTitle([], 12), 'Scan — 12 up to date');
  });
});

describe('clearing conversation history', () => {
  test('clears a non-empty current conversation before autosave has persisted it', async () => {
    const { home, session, history } = homeFixture();
    const { messages, restore } = installMessages();
    try {
      session.user('scan this before autosave');
      assert.equal(history.list().length, 0);

      await home.clearHistory();

      assert.equal(messages.warnings.length, 1);
      assert.match(messages.warnings[0]!, /Delete 1 Drift conversation/);
      assert.equal(session.isEmpty, true);
      assert.equal(history.list().length, 0);

      await sleep(2100);
      assert.equal(history.list().length, 0, 'a pending autosave must not resurrect the cleared thread');
    } finally {
      restore();
      home.dispose();
    }
  });

  test('counts the current conversation and older persisted conversations once each', async () => {
    const { home, session, history } = homeFixture();
    const { messages, restore } = installMessages();
    try {
      await history.save({ id: 'old-1', title: 'Old one', items: [user('/scan')] });
      await history.save({ id: 'old-2', title: 'Old two', items: [user('/recent')] });
      session.user('live thread');

      await home.clearHistory();

      assert.match(messages.warnings[0]!, /Delete 3 Drift conversations/);
      assert.equal(session.isEmpty, true);
      assert.equal(history.list().length, 0);
    } finally {
      restore();
      home.dispose();
    }
  });

  test('does not double-count the current conversation when it is already persisted', async () => {
    const { home, session, history } = homeFixture();
    const { messages, restore } = installMessages();
    try {
      session.user('already saved');
      await sleep(2100);
      assert.equal(history.list().length, 1);

      await home.clearHistory();

      assert.match(messages.warnings[0]!, /Delete 1 Drift conversation\?/);
      assert.doesNotMatch(messages.warnings[0]!, /conversations/);
      assert.equal(session.isEmpty, true);
      assert.equal(history.list().length, 0);
    } finally {
      restore();
      home.dispose();
    }
  });

  test('keeps the existing no-history message when saved and current history are empty', async () => {
    const { home, history } = homeFixture();
    const { messages, restore } = installMessages();
    try {
      await home.clearHistory();

      assert.equal(messages.warnings.length, 0);
      assert.deepEqual(messages.infos, ['Drift: there is no saved conversation history to clear.']);
      assert.equal(history.list().length, 0);
    } finally {
      restore();
      home.dispose();
    }
  });
});
