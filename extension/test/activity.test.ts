import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { activityFromReport } from '../src/agent-activity.js';

/**
 * What the panel calls each thing an agent does.
 *
 * This used to be decided by which pipe a line arrived on, so every row in the
 * drawer was titled `STDERR` — these CLIs stream their reasoning to stderr and
 * keep stdout for the final answer, which makes the stream name both the most
 * available signal and the least informative one. The tests here are about
 * naming: a developer scanning the drawer should be able to tell reasoning from
 * a shell command from a source lookup without opening any of them.
 */

describe('naming agent activity', () => {
  test('never labels a row with the stream it came from', () => {
    for (const line of [
      'stderr: thinking about the import shape',
      'Considering whether the factory helper covers this call site',
      'stdout: done',
    ]) {
      const activity = activityFromReport(line);
      assert.ok(!/^std(out|err)$/i.test(activity.title), `"${line}" was titled ${activity.title}`);
    }
  });

  test('reasoning is thinking, whichever pipe carried it', () => {
    const activity = activityFromReport('The old call passed a status code as the second argument');
    assert.equal(activity.kind, 'thinking');
    assert.equal(activity.title, 'Thinking');
  });

  test('a shell command reads as a command', () => {
    const activity = activityFromReport('npm run typecheck');
    assert.equal(activity.kind, 'bash');
    assert.equal(activity.input, 'npm run typecheck');
  });

  test('a line carrying a URL becomes a source the developer can open', () => {
    const activity = activityFromReport('Checking the changelog at https://github.com/acme/lib/releases/tag/v5');
    assert.equal(activity.kind, 'search');
    assert.deepEqual(activity.links, ['https://github.com/acme/lib/releases/tag/v5']);
  });

  test('a query string survives intact, since a truncated URL opens the wrong page', () => {
    const activity = activityFromReport('web search: https://example.com/s?q=migrate&hl=en');
    assert.deepEqual(activity.links, ['https://example.com/s?q=migrate&hl=en']);
  });

  test('sentence punctuation after a URL is not part of the URL', () => {
    const activity = activityFromReport('Read https://example.com/notes.html, then edited the file.');
    assert.deepEqual(activity.links, ['https://example.com/notes.html']);
  });

  test('the same source cited twice is listed once', () => {
    const activity = activityFromReport('https://example.com/a and again https://example.com/a');
    assert.deepEqual(activity.links, ['https://example.com/a']);
  });

  test('colour codes are stripped without eating bracketed prose', () => {
    const activity = activityFromReport('[32mApplying[0m fix [1] of 3');
    assert.equal(activity.detail, 'Applying fix [1] of 3');
    assert.equal(activity.title, 'Applying');
  });

  test('a line it cannot place is still shown, not dropped', () => {
    const activity = activityFromReport('~~~ some agent-specific banner ~~~');
    assert.equal(activity.detail, '~~~ some agent-specific banner ~~~');
  });
});
