import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DriftSession, type TaskGroup } from '../src/session.js';

/**
 * A spinner is a claim that something is happening right now.
 *
 * Which makes one left turning after its run has ended the most expensive kind
 * of wrong thing the panel can say: the honest reading is "still working, wait",
 * and that is advice to wait forever. Pressing stop, and an error thrown past
 * the handle that would have closed a step, both used to leave exactly that.
 */

function groups(): TaskGroup[] {
  return [
    {
      id: 'c1',
      title: 'fix(deps): migrate the call sites',
      state: 'pending',
      tasks: [
        { id: 'c1-0', label: 'chain() removed', file: 'src/a.ts', line: 3, state: 'pending' },
        { id: 'c1-1', label: 'pluck() removed', file: 'src/b.ts', line: 9, state: 'pending' },
      ],
    },
    {
      id: 'c2',
      title: 'fix(deps): update the tests',
      state: 'pending',
      tasks: [{ id: 'c2-0', label: 'assertion shape changed', file: 'test/a.test.ts', line: 1, state: 'pending' }],
    },
  ];
}

function stepOf(session: DriftSession, id: string) {
  const item = session.thread.find((entry) => entry.id === id);
  assert.ok(item && item.kind === 'step');
  return item;
}

function taskItem(session: DriftSession) {
  const item = session.thread.find((entry) => entry.kind === 'tasks');
  assert.ok(item && item.kind === 'tasks');
  return item;
}

describe('putting down work that has stopped', () => {
  test('a step still running is not left spinning', () => {
    const session = new DriftSession();
    const step = session.step('Checking your dependencies');
    step.progress('Reading changelog', 'lodash 4 → 5');
    assert.equal(stepOf(session, step.id).state, 'running');

    session.settleLive('stopped');

    const settled = stepOf(session, step.id);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.phase, 'Stopped');
    session.dispose();
  });

  test('the concern in progress is marked stopped, and the ones never reached are skipped', () => {
    const session = new DriftSession();
    const tasks = session.tasks('Fixing 3 sites', '2 commits.', groups());
    tasks.start('c1');

    session.settleLive('stopped');

    const item = taskItem(session);
    // The one being worked on when the developer pressed stop.
    assert.equal(item.groups[0]!.state, 'skipped');
    assert.ok(item.groups[0]!.tasks.every((task) => task.state === 'skipped'));
    // The one that never started is not a casualty; it simply never happened.
    assert.equal(item.groups[1]!.state, 'skipped');
    session.dispose();
  });

  test('an error marks the concern that was running as failed, not skipped', () => {
    const session = new DriftSession();
    const tasks = session.tasks('Fixing 3 sites', '2 commits.', groups());
    tasks.start('c1');

    session.settleLive('failed');

    const item = taskItem(session);
    assert.equal(item.groups[0]!.state, 'failed');
    // Still only ever reported as not-reached, because it wasn't.
    assert.equal(item.groups[1]!.state, 'skipped');
    session.dispose();
  });

  test('work that finished properly is left exactly as it finished', () => {
    const session = new DriftSession();
    const step = session.step('Checking your dependencies');
    step.done('Checked 12 packages');
    const tasks = session.tasks('Fixing 3 sites', '2 commits.', groups());
    tasks.start('c1');
    tasks.finish('c1', 'done', ['src/a.ts', 'src/b.ts']);
    tasks.start('c2');
    tasks.finish('c2', 'unchanged', []);

    session.settleLive('failed');

    assert.equal(stepOf(session, step.id).state, 'done');
    const item = taskItem(session);
    assert.equal(item.groups[0]!.state, 'done');
    assert.equal(item.groups[1]!.state, 'unchanged');
    session.dispose();
  });

  test('a conversation reopened tomorrow cannot still be scanning', () => {
    // The same rule the snapshot has always applied, kept honest here so the
    // two ways a spinner can outlive its run stay covered together.
    const session = new DriftSession();
    session.step('Checking your dependencies');
    const saved = session.snapshot();
    const step = saved.find((item) => item.kind === 'step');
    assert.ok(step && step.kind === 'step');
    assert.equal(step.state, 'done');
    session.dispose();
  });
});
