import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyOpToLine, applyOpsToLine, applyFixPlanToContent } from '../dist/fixplan/execute.js';
import { validateFixPlan } from '../dist/fixplan/validate.js';
import { inferOps } from '../dist/fixplan/infer.js';
import { FIX_PLAN_SCHEMA_VERSION, planAssurance } from '../dist/fixplan/schema.js';

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

const site = (file: string, line: number) => ({
  breakingChangeId: 'bc_1',
  file,
  line,
  excerpt: '',
  matchedSymbol: 'connect',
  confidence: 'high' as const,
});

describe('fix plan ops: each declines rather than guesses', () => {
  test('rename-identifier ignores members and string contents', () => {
    const op = { kind: 'rename-identifier', from: 'connect', to: 'createConnection' } as const;

    assert.equal(applyOpToLine('connect(url);', op), 'createConnection(url);');
    assert.equal(applyOpToLine('client.connect(url);', op), null);
    assert.equal(applyOpToLine('log("connect failed");', op), null);
    assert.equal(
      applyOpToLine('connect(url); // connect', op),
      'createConnection(url); // createConnection',
    );
  });

  test('rename-member is the exact inverse — members only', () => {
    const op = { kind: 'rename-member', from: 'connect', to: 'createConnection' } as const;

    assert.equal(applyOpToLine('client.connect(url);', op), 'client.createConnection(url);');
    assert.equal(applyOpToLine('connect(url);', op), null);
    assert.equal(applyOpToLine('c?.connect();', op), 'c?.createConnection();');
    assert.equal(applyOpToLine('log(".connect");', op), null);
  });

  test('replace-import-path only rewrites lines that actually import', () => {
    const op = { kind: 'replace-import-path', from: 'acme-sdk', to: 'acme-sdk/client' } as const;

    assert.equal(
      applyOpToLine("import { connect } from 'acme-sdk';", op),
      "import { connect } from 'acme-sdk/client';",
    );
    assert.equal(applyOpToLine("const name = 'acme-sdk';", op), null);
    assert.equal(applyOpToLine("require('acme-sdk')", op), "require('acme-sdk/client')");
    // A longer specifier is not the one named, so it is left alone.
    assert.equal(applyOpToLine("import x from 'acme-sdk/other';", op), null);
  });

  test('insert-argument reads the real argument list, and declines when it cannot', () => {
    const op = { kind: 'insert-argument', callee: 'connect', index: 1, text: '{ retries: 3 }' } as const;

    assert.equal(applyOpToLine('connect(url);', op), 'connect(url, { retries: 3 });');
    // Commas nested in a call are not separators.
    assert.equal(
      applyOpToLine('connect(build(a, b));', op),
      'connect(build(a, b), { retries: 3 });',
    );
    // The list does not close on this line — declined, not guessed at.
    assert.equal(applyOpToLine('connect(url,', op), null);
    // Position beyond the end of the list.
    assert.equal(applyOpToLine('connect();', { ...op, index: 2 }), null);
    // A bare name does not match a member call of the same name.
    assert.equal(applyOpToLine('client.connect(url);', op), null);
  });

  test('insert-argument is idempotent — it will not stack the same argument twice', () => {
    const op = { kind: 'insert-argument', callee: 'connect', index: 1, text: '{ retries: 3 }' } as const;
    const once = applyOpToLine('connect(url);', op)!;
    assert.equal(applyOpToLine(once, op), null);
  });

  test('wrap-call adds a prefix once and only once', () => {
    const op = { kind: 'wrap-call', callee: 'connect', wrapper: 'await' } as const;

    assert.equal(applyOpToLine('const c = connect(url);', op), 'const c = await connect(url);');
    assert.equal(applyOpToLine('const c = await connect(url);', op), null);
    assert.equal(
      applyOpToLine('const c = client.connect(url);', { ...op, callee: 'client.connect' }),
      'const c = await client.connect(url);',
    );
  });

  test('ops compose on one line, in order', () => {
    const result = applyOpsToLine("import { connect } from 'acme-sdk';", [
      { kind: 'replace-import-path', from: 'acme-sdk', to: 'acme-sdk/client' },
      { kind: 'rename-identifier', from: 'connect', to: 'createConnection' },
    ]);

    assert.equal(result.line, "import { createConnection } from 'acme-sdk/client';");
    assert.deepEqual(result.applied, ['replace-import-path', 'rename-identifier']);
  });
});

describe('fix plan validation: the gate', () => {
  const files = new Map([['src/app.ts', "import { connect } from 'acme-sdk';\n\nconnect(url);\n"]]);
  const sites = [site('src/app.ts', 1), site('src/app.ts', 3)];

  test('accepts a grounded, attested, idempotent plan and anchors every covered site', () => {
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites,
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'accepted');
    assert.equal(result.assurance, 'proven');
    assert.equal(result.covered, 2);
    assert.equal(result.residual, 0);
    assert.equal(result.anchors.length, 2);
    assert.equal(result.anchors[0]!.line, "import { connect } from 'acme-sdk';");
  });

  test('rejects a replacement no cited evidence mentions', () => {
    const result = validateFixPlan({
      // `openSocket` appears nowhere upstream — the classic confident invention.
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'openSocket' }]),
      change: change(),
      sites,
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /Nothing in the cited evidence mentions `openSocket`/);
  });

  test('a substring of an attested word does not count as attestation', () => {
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'Connection' }]),
      change: change({ replacementSymbols: [], summary: 'connect changed', remediation: 'update it' }),
      sites,
      fileContents: files,
      evidence: [evidence({ content: 'createConnection is the replacement.' })],
    });

    assert.equal(result.verdict, 'rejected');
  });

  test('rejects a plan about a symbol the finding never mentions', () => {
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'unrelated', to: 'createConnection' }]),
      change: change(),
      sites,
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /never mentions/);
  });

  test('rejects a non-literal argument — no rule may execute code', () => {
    const result = validateFixPlan({
      plan: plan([
        { kind: 'insert-argument', callee: 'connect', index: 1, text: 'buildOptions()' },
      ]),
      change: change(),
      sites,
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /is not a literal/);
  });

  test('partial coverage resolves what it can and reports the rest with a reason', () => {
    const mixed = new Map([
      ['src/app.ts', "connect(url);\nclient.connect(url);\n"],
    ]);
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites: [site('src/app.ts', 1), site('src/app.ts', 2)],
      fileContents: mixed,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'partial');
    assert.equal(result.covered, 1);
    assert.equal(result.residual, 1);
    assert.equal(result.sites[1]!.status, 'residual');
    assert.match(result.sites[1]!.reason!, /shaped differently/);
  });

  test('a comment naming the symbol is never rewritten', () => {
    const commented = new Map([['src/app.ts', '// connect() is deprecated\n']]);
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }]),
      change: change(),
      sites: [site('src/app.ts', 1)],
      fileContents: commented,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /matched any of the call sites/);
  });

  test('a plan using a checked op is marked checked, not proven', () => {
    const async = new Map([['src/app.ts', 'const c = connect(url);\n']]);
    const result = validateFixPlan({
      plan: plan([{ kind: 'wrap-call', callee: 'connect', wrapper: 'await' }]),
      change: change({ kind: 'signature-change', summary: '`connect` is now async.' }),
      sites: [site('src/app.ts', 1)],
      fileContents: async,
      evidence: [evidence({ content: '`connect` now returns a promise.' })],
    });

    assert.equal(result.verdict, 'accepted');
    assert.equal(result.assurance, 'checked');
    assert.equal(planAssurance(result.plan.ops), 'checked');
  });

  test('a model-authored plan citing evidence Drift never gathered is rejected', () => {
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }], {
        citations: ['ev_invented'],
      }),
      change: change(),
      sites,
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /did not gather/);
  });

  test('a recipe-provenance plan must name the recipe it came from', () => {
    const result = validateFixPlan({
      plan: plan([{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }], {
        provenance: { author: 'recipe', authoredAt: '2026-01-01T00:00:00Z' },
        citations: [],
      }),
      change: change(),
      sites,
      fileContents: files,
      evidence: [evidence()],
    });

    assert.equal(result.verdict, 'rejected');
    assert.match(result.rejections.join(' '), /claims to come from a community recipe but names none/);
  });
});

describe('applyFixPlanToContent: re-derived, never replayed', () => {
  const ops = [{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }];

  test('rewrites only anchored lines, even when the file shifted', () => {
    const shifted = "// a new header line\nimport { connect } from 'acme-sdk';\n\nconnect(url);\nconnect(other);\n";
    const anchors = [
      { file: 'src/app.ts', line: "import { connect } from 'acme-sdk';", lineNumber: 1 },
      { file: 'src/app.ts', line: 'connect(url);', lineNumber: 3 },
    ];

    const result = applyFixPlanToContent(shifted, ops, anchors, 'src/app.ts');
    const lines = result.split('\n');

    assert.equal(lines[1], "import { createConnection } from 'acme-sdk';");
    assert.equal(lines[3], 'createConnection(url);');
    // Never localized, never anchored, never touched.
    assert.equal(lines[4], 'connect(other);');
  });

  test('declines an ambiguous text match rather than guessing which line was localized', () => {
    const duplicated = 'x();\nconnect(url);\nconnect(url);\n';
    const anchors = [{ file: 'src/app.ts', line: 'connect(url);', lineNumber: 9 }];

    assert.equal(applyFixPlanToContent(duplicated, ops, anchors, 'src/app.ts'), duplicated);
  });

  test('is idempotent across repeated application', () => {
    const source = 'connect(url);\n';
    const anchors = [{ file: 'src/app.ts', line: 'connect(url);', lineNumber: 1 }];
    const once = applyFixPlanToContent(source, ops, anchors, 'src/app.ts');

    assert.equal(applyFixPlanToContent(once, ops, anchors, 'src/app.ts'), once);
  });
});

describe('inferOps: reading a rule back out of a community recipe’s edits', () => {
  test('recovers a rename from what the recipe actually did', () => {
    const result = inferOps([
      { file: 'a.ts', lineNumber: 1, before: 'connect(url);', after: 'createConnection(url);' },
      { file: 'b.ts', lineNumber: 4, before: '  connect(other);', after: '  createConnection(other);' },
    ]);

    assert.deepEqual(result.unexplained, []);
    assert.equal(result.ops.length, 1);
    assert.deepEqual(result.ops[0], {
      kind: 'rename-identifier',
      from: 'connect',
      to: 'createConnection',
    });
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
    assert.ok(result.ops.length >= 1 && result.ops.length <= 3);
  });

  test('reports an edit no op in the vocabulary can explain', () => {
    const result = inferOps([
      {
        file: 'a.ts',
        lineNumber: 1,
        // A restructure, not a rule — exactly what must not be silently taken.
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
