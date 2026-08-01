import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { digestDiagnostics, parseDiagnostics, renderDigest } from '../src/diagnostics-digest.js';

/**
 * Compiler output is the best evidence available about what an upgrade broke,
 * and far too much of it to hand to an agent whole. These tests are written
 * against the shape of a real TypeScript 5 → 7 run on this repository, which
 * produced 213 diagnostics that were really eight problems — and where the
 * loudest of them, 104 errors about `@types/node`, had nothing to do with the
 * migration at all.
 */

/** Lines taken from an actual `tsc` run under TypeScript 7.0.2. */
const TSC_OUTPUT = [
  `src/evidence/type-surface.ts(596,20): error TS2339: Property 'createSourceFile' does not exist on type 'typeof import("/Users/someone/app/node_modules/typescript/lib/version")'.`,
  `src/evidence/type-surface.ts(596,45): error TS2339: Property 'ScriptTarget' does not exist on type 'typeof import("/Users/someone/app/node_modules/typescript/lib/version")'.`,
  `src/index/metarag.ts(141,12): error TS2339: Property 'forEachChild' does not exist on type 'typeof import("/Users/someone/app/node_modules/typescript/lib/version")'.`,
  `src/evidence/type-surface.ts(617,30): error TS2694: Namespace '"/Users/someone/app/node_modules/typescript/lib/version"' has no exported member 'Node'.`,
  `src/evidence/type-surface.ts(658,14): error TS2694: Namespace '"/Users/someone/app/node_modules/typescript/lib/version"' has no exported member 'ExportDeclaration'.`,
  `src/index/metarag.ts(180,22): error TS2694: Namespace '"/Users/someone/app/node_modules/typescript/lib/version"' has no exported member 'ImportClause'.`,
  `src/util/logger.ts(14,19): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try \`npm i --save-dev @types/node\` and then add 'node' to the types field in your tsconfig.`,
  `src/util/exec.ts(48,29): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try \`npm i --save-dev @types/node\` and then add 'node' to the types field in your tsconfig.`,
  `src/runners/webhook.ts(262,9): error TS2591: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try \`npm i --save-dev @types/node\` and then add 'node' to the types field in your tsconfig.`,
  `src/cli.ts(2,26): error TS2591: Cannot find name 'node:path'. Do you need to install type definitions for node? Try \`npm i --save-dev @types/node\` and then add 'node' to the types field in your tsconfig.`,
].join('\n');

const FOCUS = ['src/evidence/type-surface.ts', 'src/index/metarag.ts'];

describe('parsing compiler output', () => {
  test('reads the file, line and code out of tsc\'s default format', () => {
    const sites = parseDiagnostics(`src/a.ts(12,5): error TS2591: Cannot find name 'process'.`);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.file, 'src/a.ts');
    assert.equal(sites[0]!.line, 12);
    assert.match(sites[0]!.message, /^TS2591: /);
  });

  test('also reads the colon format some scripts produce', () => {
    const sites = parseDiagnostics(`src/a.ts:12:5 - error TS2591: Cannot find name 'process'.`);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.file, 'src/a.ts');
    assert.equal(sites[0]!.line, 12);
  });

  test('prose around the diagnostics is not mistaken for one', () => {
    const sites = parseDiagnostics(['> app@1.0.0 typecheck', '> tsc --noEmit', '', 'Found 3 errors.'].join('\n'));
    assert.equal(sites.length, 0);
  });
});

describe('digesting compiler output', () => {
  test('one root cause reported many times becomes one group with a count', () => {
    const digest = digestDiagnostics(TSC_OUTPUT, { focusFiles: FOCUS });
    const missingName = digest.groups.find((group) => group.code === 'TS2591');

    assert.ok(missingName, 'the @types/node problem was not grouped');
    assert.equal(missingName.total, 4);
    // The names are what make a collapsed group still actionable.
    assert.deepEqual(
      missingName.subjects.filter((s) => ['process', 'Buffer', 'node:path'].includes(s)).sort(),
      ['Buffer', 'node:path', 'process'],
    );
  });

  test('a machine-specific module path never splits a group', () => {
    // Every one of these messages quotes an absolute path into node_modules.
    // Left in the template it groups by checkout directory, which turned one
    // problem into nine near-identical ones.
    const digest = digestDiagnostics(TSC_OUTPUT, { focusFiles: FOCUS });
    const namespaces = digest.groups.filter((group) => group.code === 'TS2694');

    assert.equal(namespaces.length, 1, 'the namespace errors split into separate groups');
    assert.equal(namespaces[0]!.total, 3);
    assert.ok(!namespaces[0]!.template.includes('/Users/'), 'an absolute path survived into the template');
  });

  test("a type like 'typeof import(\"x\")' does not derail the quote matching", () => {
    // A character class that lets ' open a span and " close it produces
    // subjects such as `typeof import(` and leaves the rest in the template.
    const digest = digestDiagnostics(TSC_OUTPUT, { focusFiles: FOCUS });
    const property = digest.groups.find((group) => group.code === 'TS2339');

    assert.ok(property);
    assert.equal(property.template, "Property '…' does not exist on type '…'.");
    assert.ok(
      !property.subjects.some((subject) => subject.includes('typeof import(')),
      'the quote matching paired the wrong delimiters',
    );
  });

  test('what the upgrade was proved to affect is ranked above incidental noise', () => {
    const digest = digestDiagnostics(TSC_OUTPUT, { focusFiles: FOCUS });

    // The TypeScript API breakage is the migration; `@types/node` not resolving
    // is louder and unrelated. Ranking by count alone puts the noise first.
    assert.ok(digest.groups[0]!.focused, 'an unfocused group was ranked first');
    const noise = digest.groups.findIndex((group) => group.code === 'TS2591');
    const real = digest.groups.findIndex((group) => group.code === 'TS2339');
    assert.ok(real < noise, 'the incidental problem outranked the actual migration');
  });

  test('examples spread across files rather than repeating one line', () => {
    // A single line commonly emits several diagnostics, so taking the first N
    // showed the same location three times — which reads as "happens once".
    const repeated = Array.from(
      { length: 9 },
      (_, i) => `src/a.ts(7,${i + 1}): error TS2345: Argument of type 'A' is not assignable to parameter of type 'B'.`,
    )
      .concat(`src/b.ts(3,1): error TS2345: Argument of type 'C' is not assignable to parameter of type 'D'.`)
      .join('\n');

    const digest = digestDiagnostics(repeated);
    const sites = digest.groups[0]!.sites;
    const locations = new Set(sites.map((site) => `${site.file}:${site.line}`));

    assert.equal(locations.size, sites.length, 'the same location was shown twice');
    assert.ok(sites.some((site) => site.file === 'src/b.ts'), 'the second file never appeared');
    assert.equal(digest.groups[0]!.total, 10, 'the count was taken from the truncated list');
  });

  test('output with nothing diagnostic in it says so rather than claiming success', () => {
    const digest = digestDiagnostics('Error: Cannot find module ./thing\n    at Module._resolve');
    assert.equal(digest.unparsed, true);

    const rendered = renderDigest(digest, { label: 'npm test', rawTail: 'Error: Cannot find module ./thing' });
    assert.match(rendered, /could not parse/i);
    assert.match(rendered, /Cannot find module/);
  });

  test('the rendered digest is a fraction of the output it replaces', () => {
    const digest = digestDiagnostics(TSC_OUTPUT, { focusFiles: FOCUS });
    const rendered = renderDigest(digest, { label: 'npm run typecheck' });

    assert.ok(rendered.length < TSC_OUTPUT.length, 'the digest was no smaller than the raw output');
    // And it still says how many there really were, which is the part that
    // tells an agent to look for one shared cause.
    assert.match(rendered, /10 diagnostics/);
    assert.match(rendered, /4 occurrences/);
  });

  test('groups beyond the budget are counted, not silently dropped', () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `src/f${i}.ts(1,1): error TS${1000 + i}: Distinct problem number ${i} with '${i}'.`,
    ).join('\n');

    const digest = digestDiagnostics(many, { maxGroups: 5 });
    assert.equal(digest.groups.length, 5);
    assert.equal(digest.omittedGroups, 15);
    assert.equal(digest.omittedDiagnostics, 15);
    assert.match(renderDigest(digest, { label: 'npm run build' }), /15 smaller problems/);
  });
});
