import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchNameFor,
  buildIssueContent,
  groupForAction,
  issueMarker,
} from '../dist/actions/issue-branch.js';
import type { BreakingChange, ImpactSite } from '../dist/types.js';

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

function site(overrides: Partial<ImpactSite> = {}): ImpactSite {
  return {
    breakingChangeId: 'bc_1',
    file: 'src/index.ts',
    line: 10,
    excerpt: 'leftPad(str, 8)',
    matchedSymbol: 'default',
    confidence: 'high',
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

  test('"package" scope files only the changes that reach code in this repository', () => {
    const changes = [
      change({ id: 'a', dependency: 'zod' }),
      change({ id: 'b', dependency: 'zod' }),
      change({ id: 'c', dependency: 'zod' }), // upstream-only: no impact site below
    ];
    const impactSites = [site({ breakingChangeId: 'a' }), site({ breakingChangeId: 'b', line: 20 })];
    const [target] = groupForAction(changes, 'package', impactSites);
    assert.deepEqual(
      target!.changes.map((c) => c.id),
      ['a', 'b'],
    );
    assert.equal(target!.upstreamOnlyCount, 1);
    assert.equal(target!.impactSites!.length, 2);
  });

  test('"package" scope falls back to the full group when nothing reaches this repository', () => {
    const changes = [change({ id: 'a', dependency: 'zod' }), change({ id: 'b', dependency: 'zod' })];
    const [target] = groupForAction(changes, 'package', []);
    assert.equal(target!.changes.length, 2);
    assert.equal(target!.upstreamOnlyCount, 0);
  });

  test('"change" scope carries each finding\'s own impact sites', () => {
    const changes = [change({ id: 'a' }), change({ id: 'b' })];
    const impactSites = [site({ breakingChangeId: 'a' })];
    const targets = groupForAction(changes, 'change', impactSites);
    assert.equal(targets.find((t) => t.changes[0]!.id === 'a')!.impactSites!.length, 1);
    assert.equal(targets.find((t) => t.changes[0]!.id === 'b')!.impactSites!.length, 0);
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

  test('leads with where it affects the repo, and links every impact site', () => {
    const target = {
      dependency: 'zod',
      changes: [change({ id: 'a' })],
      impactSites: [site({ breakingChangeId: 'a', file: 'src/schema.ts', line: 42 })],
      repoBlobUrl: 'https://github.com/acme/widgets/blob/deadbeef',
    };
    const content = buildIssueContent(target);
    assert.match(content.body, /will affect your code in 1 place across 1 file/);
    assert.match(content.body, /\[`src\/schema\.ts:42`\]\(https:\/\/github\.com\/acme\/widgets\/blob\/deadbeef\/src\/schema\.ts#L42\)/);
  });

  test('notes upstream-only changes without dumping them into the body', () => {
    const target = {
      dependency: 'zod',
      changes: [change({ id: 'a' })],
      impactSites: [site({ breakingChangeId: 'a' })],
      upstreamOnlyCount: 345,
    };
    const content = buildIssueContent(target);
    assert.match(content.body, /345 additional upstream breaking changes do not reach code in this repository/);
  });

  test('is honest when nothing in the group reached this repository at all', () => {
    const target = { dependency: 'zod', changes: [change({ id: 'a' }), change({ id: 'b' })], impactSites: [] };
    const content = buildIssueContent(target);
    assert.match(content.body, /none of them matched code in this repository/);
    assert.doesNotMatch(content.body, /will affect your code/);
  });
});
