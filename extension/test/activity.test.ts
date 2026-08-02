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

/**
 * Telling the agent's actions apart.
 *
 * The drawer exists to answer "what did this do to my repository?", and it
 * could not: nearly every row read `Thinking`, so reading a file and rewriting
 * one were indistinguishable without opening both. These tests pin the
 * distinctions a reviewer actually acts on — read versus edit versus create —
 * against the shapes the CLIs really print.
 */
describe('classifying what an agent did', () => {
  test('a tool call is named after the tool, not after thinking', () => {
    for (const [line, kind, title] of [
      ['Read(src/http.ts)', 'read', 'Read'],
      ['⏺ Edit(src/http.ts)', 'edit', 'Edit'],
      ['● Write(src/http/client.ts)', 'create', 'Create'],
      ['Update(package.json)', 'edit', 'Edit'],
      ['Grep(sendStatus)', 'search', 'Grep'],
      ['Glob(**/*.ts)', 'search', 'Glob'],
      ['- Bash(npm run typecheck)', 'bash', 'Bash'],
      ['apply_patch(src/a.ts)', 'edit', 'Edit'],
    ] as const) {
      const activity = activityFromReport(line);
      assert.equal(activity.kind, kind, `${line} → kind ${activity.kind}`);
      assert.equal(activity.title, title, `${line} → title ${activity.title}`);
    }
  });

  test('the file a tool touched is carried through, so the row links somewhere', () => {
    assert.equal(activityFromReport('Read(src/http.ts)').file, 'src/http.ts');
    assert.equal(activityFromReport('⏺ Edit(src/deep/nested/mod.rs)').file, 'src/deep/nested/mod.rs');
  });

  test('a shell tool puts its command where it can be read in full', () => {
    const activity = activityFromReport('Bash(npm test -- --run)');
    assert.equal(activity.kind, 'bash');
    assert.equal(activity.input, 'npm test -- --run');
  });

  test('creating a file is never filed as an edit', () => {
    // The one case a reviewer most needs to catch: a file appearing that they
    // never had. Folding it into "edit" would bury it among the rewrites.
    for (const line of ['Write(src/new.ts)', 'Created src/new.ts', 'Wrote src/new.ts']) {
      assert.equal(activityFromReport(line).kind, 'create', line);
    }
  });

  test('narrated work counts too, since not every agent prints tool calls', () => {
    assert.equal(activityFromReport('Reading src/http.ts to find the call sites').kind, 'read');
    assert.equal(activityFromReport('Editing src/http.ts').kind, 'edit');
    assert.equal(activityFromReport('Updated src/routes/index.ts').kind, 'edit');
  });

  test('an intention without a file is not reported as a file changing', () => {
    // "Writing the migration now" is an agent mid-stride. Promoting it to
    // Create would put a row in the drawer claiming a write that never landed.
    const activity = activityFromReport('Writing the replacement now');
    assert.equal(activity.kind, 'status');
  });

  test('an English word in a sentence is not mistaken for a file path', () => {
    assert.equal(activityFromReport('Reading through the changelog carefully').file, undefined);
  });

  test('a version number is not a file to click through to', () => {
    assert.equal(activityFromReport('Updated to 5.1.0').file, undefined);
  });

  test('an unknown tool name is not forced into a category', () => {
    // Better a plain Thinking row than a confident wrong label on a tool this
    // does not know: the drawer's value is that its labels can be trusted.
    assert.equal(activityFromReport('Frobnicate(whatever)').kind, 'thinking');
  });
});
