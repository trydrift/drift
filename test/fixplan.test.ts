import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  opEditAt,
  editAtOccurrence,
  applyFixPlanToContent,
  resolveAnchor,
} from '../dist/fixplan/execute.js';
import { validateFixPlan } from '../dist/fixplan/validate.js';
import { inferOps } from '../dist/fixplan/infer.js';
import { FIX_PLAN_SCHEMA_VERSION, planAssurance } from '../dist/fixplan/schema.js';

/**
 * The property every test in here exists to defend:
 *
 *   A `proven` fix plan is incapable of modifying any source occurrence that
 *   Drift did not explicitly localize for that breaking change.
 *
 * Anchors are per-occurrence, not per-line. `primary.oldMethod();
 * backup.oldMethod();` is one line with two occurrences, and a plan localized
 * against the first must be structurally unable to reach the second.
 */

/** Apply one op at an occurrence, returning the new line or `null` if it declined. */
const apply = (line: string, op: unknown, occurrence: { column: number; matchedText: string }) => {
  const edit = opEditAt(line, op as never, occurrence);
  return edit === null ? null : line.slice(0, edit.start) + edit.text + line.slice(edit.end);
};

/** The occurrence of `text` in `line`, by index — `nth` is 0-based. */
const at = (line: string, text: string, nth = 0) => {
  let column = -1;
  for (let i = 0; i <= nth; i++) column = line.indexOf(text, column + 1);
  assert.notEqual(column, -1, `fixture error: no occurrence ${nth} of ${text}`);
  return { column, matchedText: text };
};

const change = (overrides: Record<string, unknown> = {}) => ({
  id: 'bc_1',
  dependency: 'acme-sdk',
  kind: 'renamed-export' as const,
  summary: '`connect` was renamed to `createConnection`.',
  remediation: 'Replace `connect` with `createConnection`.',
  symbols: ['connect'],
  replacementSymbols: ['createConnection'],
  confidence: 'high' as const,
  citations: ['ev_1'],
  ...overrides,
});

const evidence = (overrides: Record<string, unknown> = {}) => ({
  id: 'ev_1',
  source: 'changelog' as const,
  dependency: 'acme-sdk',
  title: 'CHANGELOG 2.0.0',
  content: '`connect` is now `createConnection`.',
  weight: 1,
  ...overrides,
});

const plan = (ops: unknown[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: FIX_PLAN_SCHEMA_VERSION,
  id: 'fp_1',
  breakingChangeId: 'bc_1',
  dependency: 'acme-sdk',
  fromVersion: '1.0.0',
  toVersion: '2.0.0',
  changeKind: 'renamed-export' as const,
  migration: '`connect` became `createConnection`.',
  rationale: 'The changelog states the rename.',
  ops,
  citations: ['ev_1'],
  provenance: { author: 'model' as const, model: 'claude-opus-5', authoredAt: '2026-01-01T00:00:00Z' },
  ...overrides,
});

/** An impact site carrying the exact occurrence localization established. */
const site = (file: string, line: number, occurrence?: { column: number; matchedText: string }) => ({
  breakingChangeId: 'bc_1',
  file,
  line,
  excerpt: '',
  matchedSymbol: 'connect',
  confidence: 'high' as const,
  ...(occurrence ?? {}),
});

describe('ops act on one occurrence, never on the line', () => {
  test('rename-identifier rewrites only the anchored occurrence', () => {
    const line = 'connect(a); connect(b);';
    const op = { kind: 'rename-identifier', from: 'connect', to: 'createConnection' };

    assert.equal(apply(line, op, at(line, 'connect(', 0)), 'createConnection(a); connect(b);');
    assert.equal(apply(line, op, at(line, 'connect(', 1)), 'connect(a); createConnection(b);');
  });

  test('rename-member rewrites only the anchored receiver’s method', () => {
    // The exact bug this rework exists to fix: only `primary` was bound from
    // the dependency that moved.
    const line = 'primary.oldMethod(); backup.oldMethod();';
    const op = { kind: 'rename-member', from: 'oldMethod', to: 'newMethod' };

    assert.equal(
      apply(line, op, at(line, 'oldMethod(', 0)),
      'primary.newMethod(); backup.oldMethod();',
    );
    assert.equal(
      apply(line, op, at(line, 'oldMethod(', 1)),
      'primary.oldMethod(); backup.newMethod();',
    );
  });

  test('rename-identifier still refuses members, and rename-member still refuses bare names', () => {
    const line = 'connect(a); client.connect(b);';

    assert.equal(
      apply(line, { kind: 'rename-identifier', from: 'connect', to: 'createConnection' }, at(line, 'connect(', 1)),
      null,
    );
    assert.equal(
      apply(line, { kind: 'rename-member', from: 'connect', to: 'createConnection' }, at(line, 'connect(', 0)),
      null,
    );
  });

  test('an occurrence whose text no longer matches is refused outright', () => {
    const line = 'createConnection(a);';
    assert.equal(
      apply(line, { kind: 'rename-identifier', from: 'connect', to: 'createConnection' }, { column: 0, matchedText: 'connect(' }),
      null,
    );
  });

  test('a string literal sharing the name is never the target', () => {
    const line = 'log("connect"); connect(a);';
    const op = { kind: 'rename-identifier', from: 'connect', to: 'createConnection' };
    assert.equal(apply(line, op, at(line, 'connect(', 0)), 'log("connect"); createConnection(a);');
  });

  test('replace-import-path rewrites the specifier, and declines when the line has two of them', () => {
    const single = "import { connect } from 'acme-sdk';";
    const op = { kind: 'replace-import-path', from: 'acme-sdk', to: 'acme-sdk/client' };
    assert.equal(apply(single, op, at(single, 'connect')), "import { connect } from 'acme-sdk/client';");

    // Not an import line at all.
    const notImport = "const name = 'acme-sdk'; connect(a);";
    assert.equal(apply(notImport, op, at(notImport, 'connect(')), null);

    // Ambiguous: two identical specifiers, no way to say which was meant.
    const twice = "import { connect } from 'acme-sdk'; export * from 'acme-sdk';";
    assert.equal(apply(twice, op, at(twice, 'connect')), null);
  });

  test('insert-argument targets the anchored call only', () => {
    const line = 'connect(a); connect(b);';
    const op = { kind: 'insert-argument', callee: 'connect', index: 1, text: '{ retries: 3 }' };

    assert.equal(apply(line, op, at(line, 'connect(', 0)), 'connect(a, { retries: 3 }); connect(b);');
    // Nested commas are not separators.
    const nested = 'connect(build(x, y));';
    assert.equal(apply(nested, op, at(nested, 'connect(')), 'connect(build(x, y), { retries: 3 });');
    // The list does not close on this line — declined, not guessed at.
    assert.equal(apply('connect(a,', op, { column: 0, matchedText: 'connect(' }), null);
  });

  test('wrap-call prefixes the anchored call only', () => {
    const line = 'const x = connect(a); const y = connect(b);';
    const op = { kind: 'wrap-call', callee: 'connect', wrapper: 'await' };

    assert.equal(
      apply(line, op, at(line, 'connect(', 0)),
      'const x = await connect(a); const y = connect(b);',
    );
    // Already prefixed.
    const done = 'const x = await connect(a);';
    assert.equal(apply(done, op, at(done, 'connect(')), null);
  });

  test('first applicable op wins — an occurrence is one token, not a pipeline', () => {
    const line = 'connect(a);';
    const result = editAtOccurrence(line, [
      { kind: 'rename-member', from: 'connect', to: 'createConnection' },
      { kind: 'rename-identifier', from: 'connect', to: 'createConnection' },
    ], at(line, 'connect('));

    assert.equal(result!.op, 'rename-identifier');
  });
});

describe('validation derives anchors from the localized occurrence', () => {
  test('two identical members, one localized — only that one is covered and anchored', () => {
    const line = 'primary.connect(); backup.connect();';
    const files = new Map([['src/app.ts', `${line}\n`]]);

    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-member', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites: [site('src/app.ts', 1, at(line, 'connect(', 0))],
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'accepted');
    assert.equal(result.covered, 1);
    assert.equal(result.anchors.length, 1);
    assert.equal(result.anchors[0]!.column, line.indexOf('connect('));
    assert.equal(result.sites[0]!.after, 'primary.createConnection(); backup.connect();');
  });

  test('two identical bare identifiers, one localized — the other is untouched', () => {
    const line = 'connect(a); connect(b);';
    const files = new Map([['src/app.ts', `${line}\n`]]);

    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites: [site('src/app.ts', 1, at(line, 'connect(', 1))],
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'accepted');
    assert.equal(result.sites[0]!.after, 'connect(a); createConnection(b);');
  });

  test('both occurrences localized means both are anchored — separately', () => {
    const line = 'connect(a); connect(b);';
    const files = new Map([['src/app.ts', `${line}\n`]]);

    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites: [site('src/app.ts', 1, at(line, 'connect(', 0)), site('src/app.ts', 1, at(line, 'connect(', 1))],
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.covered, 2);
    assert.equal(result.anchors.length, 2);
    assert.equal(
      applyFixPlanToContent(`${line}\n`, result.plan.ops, result.anchors, 'src/app.ts'),
      'createConnection(a); createConnection(b);\n',
    );
  });

  test('a site with no column is residual — Drift never established which occurrence', () => {
    const line = 'connect(';
    const files = new Map([['src/app.ts', `${line}\n  a,\n);\n`]]);

    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      // No column/matchedText: the call-opens-on-next-line fallback.
      sites: [site('src/app.ts', 1)],
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /matched any of the call sites/);
  });

  test('a stale site whose line changed under it is residual, not a blind splice', () => {
    const files = new Map([['src/app.ts', 'somethingElse(a);\n']]);

    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites: [site('src/app.ts', 1, { column: 0, matchedText: 'connect(' })],
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
  });

  test('partial coverage still resolves what it can, per occurrence', () => {
    const first = 'connect(a);';
    const second = 'client.connect(b);';
    const files = new Map([['src/app.ts', `${first}\n${second}\n`]]);

    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites: [site('src/app.ts', 1, at(first, 'connect(')), site('src/app.ts', 2, at(second, 'connect(') )],
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'partial');
    assert.equal(result.covered, 1);
    assert.equal(result.residual, 1);
    assert.match(result.sites[1]!.reason!, /exact occurrence/);
  });

  test('a version 1 plan is rejected rather than read as if its anchors were exact', () => {
    const line = 'connect(a);';
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }], { schemaVersion: 1 }),
      change: change(),
      sites: [site('src/app.ts', 1, at(line, 'connect('))],
      fileContents: new Map([['src/app.ts', `${line}\n`]]),
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /schema version 1/);
  });

  test('attestation, grounding and literal-only arguments are unchanged', () => {
    const line = 'connect(a);';
    const files = new Map([['src/app.ts', `${line}\n`]]);
    const sites = [site('src/app.ts', 1, at(line, 'connect('))];
    const check = (ops: unknown[]) =>
      validateFixPlan({ plan: plan(ops), change: change(), sites, fileContents: files, evidence: [evidence()] });

    assert.match(
      check([{ kind: 'rename-identifier', from: 'connect', to: 'openSocket' }]).rejections.join(' '),
      /Nothing in the cited evidence mentions `openSocket`/,
    );
    assert.match(
      check([{ kind: 'rename-identifier', from: 'unrelated', to: 'createConnection' }]).rejections.join(' '),
      /never mentions/,
    );
    assert.match(
      check([{ kind: 'insert-argument', callee: 'connect', index: 1, text: 'buildOptions()' }]).rejections.join(' '),
      /is not a literal/,
    );
  });

  test('a checked op is still marked checked, and a proven one proven', () => {
    const line = 'const c = connect(a);';
    const files = new Map([['src/app.ts', `${line}\n`]]);
    const sites = [site('src/app.ts', 1, at(line, 'connect('))];

    const checked = validateFixPlan({
      plan: plan([{ kind: 'wrap-call', callee: 'connect', wrapper: 'await' }]),
      change: change({ kind: 'signature-change', summary: '`connect` is now async.' }),
      sites,
      fileContents: files,
      evidence: [evidence({ content: '`connect` now returns a promise.' })],
    });
    assert.equal(checked.assurance, 'checked');
    assert.equal(planAssurance(checked.plan.ops), 'checked');

    const proven = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites,
      fileContents: files,
      evidence: [evidence()],
    });
    assert.equal(proven.assurance, 'proven');
  });
});

describe('applyFixPlanToContent: exact, relocatable, idempotent', () => {
  const ops = [{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }];
  const anchor = (over: Record<string, unknown> = {}) => ({
    file: 'src/app.ts',
    line: 'connect(a); connect(b);',
    lineNumber: 2,
    column: 0,
    matchedText: 'connect(',
    ...over,
  });

  test('rewrites the anchored occurrence and leaves its twin alone', () => {
    const content = 'header();\nconnect(a); connect(b);\n';
    assert.equal(
      applyFixPlanToContent(content, ops, [anchor()], 'src/app.ts'),
      'header();\ncreateConnection(a); connect(b);\n',
    );
  });

  test('relocates when an earlier edit shifted the line', () => {
    const shifted = '// a new header\nheader();\nconnect(a); connect(b);\n';
    assert.equal(
      applyFixPlanToContent(shifted, ops, [anchor()], 'src/app.ts'),
      '// a new header\nheader();\ncreateConnection(a); connect(b);\n',
    );
  });

  test('declines to relocate when two lines read identically', () => {
    const duplicated = 'connect(a); connect(b);\nx();\nconnect(a); connect(b);\n';
    // Recorded at line 9, which no longer exists — and the text is ambiguous.
    assert.equal(
      applyFixPlanToContent(duplicated, ops, [anchor({ lineNumber: 9 })], 'src/app.ts'),
      duplicated,
    );
  });

  test('declines when the anchored text is stale', () => {
    const changed = 'header();\nsomethingElse(a);\n';
    assert.equal(applyFixPlanToContent(changed, ops, [anchor()], 'src/app.ts'), changed);
  });

  test('is idempotent — the second application finds nothing to do', () => {
    const content = 'header();\nconnect(a); connect(b);\n';
    const once = applyFixPlanToContent(content, ops, [anchor()], 'src/app.ts');
    assert.equal(applyFixPlanToContent(once, ops, [anchor()], 'src/app.ts'), once);
  });

  test('two anchors on one line both apply, without invalidating each other’s offsets', () => {
    const content = 'connect(a); connect(b);\n';
    const anchors = [
      { file: 'src/app.ts', line: 'connect(a); connect(b);', lineNumber: 1, column: 0, matchedText: 'connect(' },
      { file: 'src/app.ts', line: 'connect(a); connect(b);', lineNumber: 1, column: 12, matchedText: 'connect(' },
    ];
    assert.equal(
      applyFixPlanToContent(content, ops, anchors, 'src/app.ts'),
      'createConnection(a); createConnection(b);\n',
    );
  });

  test('resolveAnchor reports exactly why it could or could not place an anchor', () => {
    const lines = ['x();', 'connect(a); connect(b);'];
    assert.equal(resolveAnchor(lines, anchor()), 1);
    // Right text, wrong column — the occurrence is not there.
    assert.equal(resolveAnchor(lines, anchor({ column: 5 })), null);
    assert.equal(resolveAnchor(['x();'], anchor()), null);
  });
});

describe('inferOps: reading a rule back out of a community recipe’s edits', () => {
  test('recovers a rename from what the recipe actually did', () => {
    const result = inferOps([
      { file: 'a.ts', lineNumber: 1, before: 'connect(url);', after: 'createConnection(url);' },
      { file: 'b.ts', lineNumber: 4, before: '  connect(other);', after: '  createConnection(other);' },
    ]);

    assert.deepEqual(result.unexplained, []);
    assert.deepEqual(result.ops[0], { kind: 'rename-identifier', from: 'connect', to: 'createConnection' });
  });

  test('recovers a combination of an import move and a rename', () => {
    const result = inferOps([
      {
        file: 'a.ts',
        lineNumber: 1,
        before: "import { connect } from 'acme-sdk';",
        after: "import { createConnection } from 'acme-sdk/client';",
      },
      { file: 'a.ts', lineNumber: 3, before: 'connect(url);', after: 'createConnection(url);' },
    ]);

    assert.deepEqual(result.unexplained, []);
  });

  test('a recipe that rewrote two occurrences on one line is not explainable', () => {
    // No single-occurrence op reproduces this, and inventing one would produce
    // a plan that applies differently from how it was inferred.
    const result = inferOps([
      { file: 'a.ts', lineNumber: 1, before: 'connect(a); connect(b);', after: 'createConnection(a); createConnection(b);' },
    ]);

    assert.equal(result.unexplained.length, 1);
  });

  test('reports an edit no op in the vocabulary can explain', () => {
    const result = inferOps([
      {
        file: 'a.ts',
        lineNumber: 1,
        before: 'const c = connect(url);',
        after: 'const { client: c, meta } = createConnection({ url, retries: 3 });',
      },
    ]);

    assert.equal(result.unexplained.length, 1);
  });

  test('is deterministic — the same edits infer the same ops every time', () => {
    const edits = [
      { file: 'a.ts', lineNumber: 1, before: 'connect(a);', after: 'createConnection(a);' },
      { file: 'a.ts', lineNumber: 2, before: 'connect(b);', after: 'createConnection(b);' },
    ];

    assert.deepEqual(inferOps(edits).ops, inferOps(edits).ops);
  });
});
