import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchNameFor,
  buildIssueContent,
  groupForAction,
  issueMarker,
} from '../dist/actions/issue-branch.js';
import type { BreakingChange } from '../dist/types.js';

/**
 * The one-click issue/branch feature's content builders — the part shared
 * by the CLI's interactive prompt and the extension's report webview.
 * Everything here is pure, so these tests never touch git or GitHub.
 */

function change(overrides: Partial<BreakingChange> = {}): BreakingChange {
  return {
    id: 'bc_1',
    dependency: 'left-pad',
    kind: 'removed-export',
    summary: 'removed the default export',
    remediation: 'use the named export instead',
    symbols: ['default'],
    confidence: 'high',
    citations: [],
    ...overrides,
  };
}

describe('groupForAction', () => {
  test('"change" scope gives every finding its own target', () => {
    const changes = [change({ id: 'a' }), change({ id: 'b' })];
    const targets = groupForAction(changes, 'change');
    assert.equal(targets.length, 2);
    assert.deepEqual(targets.map((t) => t.changes.length), [1, 1]);
  });

  test('"package" scope bundles findings for the same dependency', () => {
    const changes = [
      change({ id: 'a', dependency: 'left-pad' }),
      change({ id: 'b', dependency: 'left-pad' }),
      change({ id: 'c', dependency: 'right-pad' }),
    ];
    const targets = groupForAction(changes, 'package');
    assert.equal(targets.length, 2);
    const leftPad = targets.find((t) => t.dependency === 'left-pad')!;
    assert.equal(leftPad.changes.length, 2);
  });
});

describe('issueMarker', () => {
  test('is deterministic and order-independent', () => {
    const forward = { dependency: 'left-pad', changes: [change({ id: 'a' }), change({ id: 'b' })] };
    const backward = { dependency: 'left-pad', changes: [change({ id: 'b' }), change({ id: 'a' })] };
    assert.equal(issueMarker(forward), issueMarker(backward));
  });

  test('differs across dependencies with the same finding ids', () => {
    const a = issueMarker({ dependency: 'left-pad', changes: [change({ id: 'a' })] });
    const b = issueMarker({ dependency: 'right-pad', changes: [change({ id: 'a' })] });
    assert.notEqual(a, b);
  });
});

describe('branchNameFor', () => {
  test('is a safe git ref for a single finding', () => {
    const name = branchNameFor({ dependency: 'left-pad', changes: [change({ id: 'bc_1' })] });
    assert.match(name, /^drift\/left-pad\/bc-1$/);
  });

  test('drops the finding id when bundling a whole package', () => {
    const name = branchNameFor({
      dependency: 'left-pad',
      changes: [change({ id: 'a' }), change({ id: 'b' })],
    });
    assert.equal(name, 'drift/left-pad');
  });
});

describe('buildIssueContent', () => {
  test('embeds the dedup marker and every finding', () => {
    const target = { dependency: 'left-pad', changes: [change({ id: 'a' }), change({ id: 'b' })] };
    const content = buildIssueContent(target);
    assert.match(content.title, /left-pad/);
    assert.match(content.body, /removed the default export/);
    assert.ok(content.body.includes(issueMarker(target)));
    assert.deepEqual(content.labels, ['drift', 'drift:left-pad']);
  });

  test('links the tracking branch when one is supplied', () => {
    const target = { dependency: 'left-pad', changes: [change()] };
    const content = buildIssueContent(target, 'drift/left-pad/bc-1');
    assert.match(content.body, /drift\/left-pad\/bc-1/);
  });
});
