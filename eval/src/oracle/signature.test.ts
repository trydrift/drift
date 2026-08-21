import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeFailToPass,
  extractDiagnostics,
  processExitDiagnostic,
  signatureOf,
} from './signature.ts';

test('extracts a TypeScript diagnostic without its position', () => {
  const [diagnostic] = extractDiagnostics(
    "src/app.ts(12,5): error TS2551: Property 'renamedFn' does not exist on type 'Lib'.",
  );
  assert.equal(diagnostic?.kind, 'tsc');
  assert.equal(diagnostic?.code, 'TS2551');
  assert.equal(diagnostic?.file, 'src/app.ts');
  assert.equal(diagnostic?.identity, "tsc:TS2551:src/app.ts:Property 'renamedFn' does not exist on type 'Lib'.");
});

test('the same diagnostic at a different line has the same identity', () => {
  const a = extractDiagnostics("src/app.ts(12,5): error TS2551: Property 'x' does not exist on type 'L'.");
  const b = extractDiagnostics("src/app.ts(48,17): error TS2551: Property 'x' does not exist on type 'L'.");
  assert.deepEqual(signatureOf(a), signatureOf(b));
});

test('the same diagnostic in a different temp materialization has the same identity', () => {
  const first = extractDiagnostics('/tmp/drift-eval-broken-a1b2/consumer/src/app.ts(3,1): error TS2305: no export.', {
    cwd: '/tmp/drift-eval-broken-a1b2/consumer',
  });
  const second = extractDiagnostics('/tmp/drift-eval-broken-z9y8/consumer/src/app.ts(9,1): error TS2305: no export.', {
    cwd: '/tmp/drift-eval-broken-z9y8/consumer',
  });
  assert.deepEqual(signatureOf(first), signatureOf(second));
  assert.deepEqual(signatureOf(first), ['tsc:TS2305:src/app.ts:no export.']);
});

test('a different diagnostic code is a different identity', () => {
  const a = signatureOf(extractDiagnostics("src/app.ts(1,1): error TS2551: Property 'x' does not exist on type 'L'."));
  const b = signatureOf(extractDiagnostics("src/app.ts(1,1): error TS2339: Property 'x' does not exist on type 'L'."));
  assert.notDeepEqual(a, b);
});

test('extracts failing TAP tests and ignores passing ones', () => {
  const output = ['TAP version 13', 'ok 1 - adds', 'not ok 2 - renames the export', '    not ok 1 - nested case'].join('\n');
  assert.deepEqual(signatureOf(extractDiagnostics(output)), ['test:nested case', 'test:renames the export']);
});

test('extracts a runtime error but not its stack frames', () => {
  const output = [
    'TypeError: lib.renamedFn is not a function',
    '    at Object.<anonymous> (/tmp/x/src/app.js:3:5)',
    '    at Module._compile (node:internal/modules/cjs/loader:1234:14)',
  ].join('\n');
  const diagnostics = extractDiagnostics(output);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.identity, 'runtime:TypeError:lib.renamedFn is not a function');
});

test('unreadable failure output produces no invented diagnostics', () => {
  assert.deepEqual(extractDiagnostics('Segmentation fault\nmake: *** [build] Error 139'), []);
  assert.equal(processExitDiagnostic(139).identity, 'process:exit:139');
});

test('a repair that clears every trigger failure is resolved', () => {
  const analysis = analyzeFailToPass({ baseline: [], broken: ['tsc:TS2551:a:x'], repaired: [] });
  assert.equal(analysis.verdict, 'resolved');
  assert.deepEqual(analysis.triggerFailures, ['tsc:TS2551:a:x']);
  assert.deepEqual(analysis.resolvedTriggers, ['tsc:TS2551:a:x']);
});

test('a pre-existing baseline failure is never a trigger and never creditable', () => {
  const analysis = analyzeFailToPass({
    baseline: ['test:flaky clock'],
    broken: ['test:flaky clock', 'tsc:TS2551:a:x'],
    repaired: ['test:flaky clock'],
  });
  assert.deepEqual(analysis.triggerFailures, ['tsc:TS2551:a:x']);
  assert.equal(analysis.verdict, 'resolved');
  assert.deepEqual(analysis.regressedChecks, []);
});

test('a repair that clears the trigger but breaks something else is regressed, not resolved', () => {
  const analysis = analyzeFailToPass({
    baseline: [],
    broken: ['tsc:TS2551:a:x'],
    repaired: ['test:serializes dates'],
  });
  assert.equal(analysis.verdict, 'regressed');
  assert.deepEqual(analysis.newFailures, ['test:serializes dates']);
  assert.deepEqual(analysis.regressedChecks, ['test:serializes dates']);
});

test('clearing some triggers is partially-resolved, never resolved', () => {
  const analysis = analyzeFailToPass({
    baseline: [],
    broken: ['tsc:TS2551:a:x', 'tsc:TS2551:b:y'],
    repaired: ['tsc:TS2551:b:y'],
  });
  assert.equal(analysis.verdict, 'partially-resolved');
  assert.deepEqual(analysis.resolvedTriggers, ['tsc:TS2551:a:x']);
  assert.deepEqual(analysis.unresolvedTriggers, ['tsc:TS2551:b:y']);
});

test('clearing no trigger is unresolved', () => {
  const analysis = analyzeFailToPass({ baseline: [], broken: ['tsc:TS2551:a:x'], repaired: ['tsc:TS2551:a:x'] });
  assert.equal(analysis.verdict, 'unresolved');
});

test('a bump that broke nothing can never credit a repair', () => {
  const analysis = analyzeFailToPass({ baseline: ['test:x'], broken: ['test:x'], repaired: [] });
  assert.equal(analysis.verdict, 'no-trigger');
  assert.deepEqual(analysis.triggerFailures, []);
});

test('no repair attempted is not-attempted, never a failure to fix', () => {
  const analysis = analyzeFailToPass({ baseline: [], broken: ['tsc:TS2551:a:x'] });
  assert.equal(analysis.verdict, 'not-attempted');
  assert.deepEqual(analysis.triggerFailures, ['tsc:TS2551:a:x']);
});

test('the count-based rule prior benchmarks use would pass a patch this one rejects', () => {
  // swe-bump-bench credits a patch when it produces no *more* diagnostics than
  // before. This patch swapped one real error for a different real error, so
  // the count is unchanged and the count-based rule says "success".
  const broken = ['tsc:TS2551:src/app.ts:x'];
  const repaired = ['tsc:TS2304:src/app.ts:cannot find name y'];
  assert.equal(repaired.length > broken.length, false, 'count-based rule would credit this patch');
  assert.equal(analyzeFailToPass({ baseline: [], broken, repaired }).verdict, 'regressed');
});

test('a bare hand-thrown Error is captured, not left as an unreadable failure', () => {
  const output = [
    'file:///tmp/drift-eval-broken-abc/consumer/src/app.js:5',
    '  throw new Error(`expected ADA, got ${value}`);',
    '        ^',
    '',
    'Error: expected ADA, got [object Object]',
    '    at file:///tmp/drift-eval-broken-abc/consumer/src/app.js:5:9',
  ].join('\n');
  const diagnostics = extractDiagnostics(output, { cwd: '/tmp/drift-eval-broken-abc/consumer' });
  assert.deepEqual(signatureOf(diagnostics), ['runtime:Error:expected ADA, got [object Object]']);
});

test('the echoed source line of a throw is not mistaken for a second failure', () => {
  const diagnostics = extractDiagnostics('  throw new Error(`boom`);');
  assert.deepEqual(diagnostics, []);
});
