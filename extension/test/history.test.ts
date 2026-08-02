import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTitle } from '../src/history.js';
import { scanTitle } from '../src/severity.js';
import type { ThreadItem } from '../src/session.js';

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
