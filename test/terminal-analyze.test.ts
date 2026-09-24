import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderAnalyzeReport, unsettledCount } from '../dist/report/terminal-analyze.js';
import { createPalette } from '../dist/util/terminal.js';

/**
 * `drift analyze` in a terminal.
 *
 * Every assertion is made against the plain, colourless rendering, because the
 * places this output is read most — a piped log, a CI transcript, a Codespace
 * someone pasted into a chat — have no colour. A fact that only survives as a
 * red glyph is not in the output.
 *
 * The thing worth guarding is not the layout. It is that a finding Drift could
 * *not* rule on stays visible: the whole point of the disposition vocabulary is
 * that "we could not check this" and "this is fine" are different facts, and a
 * summary that dropped the unknowns to look tidy would be the one place in
 * Drift where a gap reads as a pass.
 */

const palette = createPalette({ color: false, unicode: true, hyperlinks: false });

function plan(overrides: Record<string, unknown> = {}) {
  return {
    changes: [{ name: 'axios', from: '0.21.4', to: '1.7.7' }],
    breakingChanges: [
      { id: 'bc-hit', dependency: 'axios', summary: '`AxiosTransformer` is no longer exported.' },
      { id: 'bc-unknown', dependency: 'axios', summary: 'The signature of `Method` changed.' },
      { id: 'bc-clear', dependency: 'axios', summary: '`AxiosProxyConfig.username` was removed.' },
    ],
    dispositions: [
      { changeId: 'bc-hit', state: 'actionable' },
      { changeId: 'bc-unknown', state: 'unknown' },
      { changeId: 'bc-clear', state: 'unaffected' },
    ],
    impactSites: [
      { breakingChangeId: 'bc-hit', file: 'src/api-client.ts', line: 2 },
      { breakingChangeId: 'bc-hit', file: 'src/api-client.ts', line: 16 },
    ],
    gaps: [{ surface: 'build, typecheck, and test' }],
    ...overrides,
  } as never;
}

describe('the terminal report for analyze', () => {
  test('leads with what reaches this repository, and says where', () => {
    const out = renderAnalyzeReport(plan(), palette, 100);

    assert.match(out, /Affects this repository \(1\)/);
    assert.match(out, /AxiosTransformer` is no longer exported/);
    assert.match(out, /src\/api-client\.ts:2/);
    assert.match(out, /src\/api-client\.ts:16/);
  });

  test('a change nothing could rule on is still shown, and not as a pass', () => {
    const out = renderAnalyzeReport(plan(), palette, 100);

    assert.match(out, /Check before upgrading — Drift could not settle these either way \(1\)/);
    assert.match(out, /The signature of `Method` changed/);
  });

  test('a breaking change with no disposition is unknown, never unaffected', () => {
    // Absence of a ruling is not a ruling of "fine". This is the failure that
    // would quietly turn a summary into a false all-clear.
    const out = renderAnalyzeReport(plan({ dispositions: [] }), palette, 100);

    assert.match(out, /Check before upgrading — Drift could not settle these either way \(3\)/);
    assert.doesNotMatch(out, /Affects this repository/);
  });

  test('surfaces that were never checked are named', () => {
    const out = renderAnalyzeReport(plan(), palette, 100);

    assert.match(out, /Not checked/);
    assert.match(out, /build, typecheck, and test/);
  });

  test('an empty section is omitted rather than printed as a zero', () => {
    const out = renderAnalyzeReport(
      plan({ dispositions: [{ changeId: 'bc-hit', state: 'actionable' }, { changeId: 'bc-unknown', state: 'actionable' }, { changeId: 'bc-clear', state: 'actionable' }] }),
      palette,
      100,
    );

    assert.match(out, /Affects this repository \(3\)/);
    assert.doesNotMatch(out, /not reached here/);
  });

  test('the upgrade being analysed is named', () => {
    const out = renderAnalyzeReport(plan(), palette, 100);
    assert.match(out, /axios\s+0\.21\.4 → 1\.7\.7/);
  });

  test('many sites are capped, and the count still tells the truth', () => {
    const sites = Array.from({ length: 9 }, (_, i) => ({
      breakingChangeId: 'bc-hit',
      file: 'src/api-client.ts',
      line: i + 1,
    }));
    const out = renderAnalyzeReport(plan({ impactSites: sites }), palette, 100);

    assert.match(out, /…and 6 more/, 'the six it did not print are still accounted for');
  });
});

describe('a major that changed a lot, and reaches nothing anyone can point at', () => {
  // The ordinary shape of a real scan: ajv 6 → 8 removes three dozen type
  // exports, localization ties none of them to this repository, and the
  // reader used to get thirty-six lines differing by an identifier.
  const many = (n: number) =>
    ({
      changes: [
        { name: 'ajv', from: '6.12.6', to: '8.20.0' },
        { name: 'punycode', from: '2.1.1', to: '2.3.1' },
      ],
      breakingChanges: [
        ...Array.from({ length: n }, (_, i) => ({ id: `ajv-${i}`, dependency: 'ajv', summary: `\`ajv.Type${i}\` is no longer exported (was an interface).` })),
        { id: 'puny-0', dependency: 'punycode', summary: '`punycode.ucs2` moved.' },
      ],
      dispositions: [],
      impactSites: [],
      gaps: [
        { surface: 'upstream release evidence', dependency: 'punycode' },
        { surface: 'build, typecheck, and test' },
      ],
    }) as never;

  test('one package contributes a few lines and a count, not a screen', () => {
    const out = renderAnalyzeReport(many(36), palette, 100);

    assert.match(out, /Check before upgrading — Drift could not settle these either way \(37\)/);
    assert.match(out, /ajv \(36\)/, 'the package is named above its findings');
    assert.match(out, /…and 32 more from ajv — `--markdown` lists them/);
    assert.equal(out.split('\n').filter((l) => /is no longer exported/.test(l)).length, 4);
    assert.match(out, /`punycode\.ucs2` moved/, 'the other package is not buried by the noisy one');
  });

  test('a gap names the package it is about', () => {
    const out = renderAnalyzeReport(many(2), palette, 100);

    assert.match(out, /upstream release evidence — punycode/);
    assert.match(out, /· build, typecheck, and test/, 'a gap about the whole run still stands alone');
  });

  test('the count the next-step line quotes is the findings nothing ruled on', () => {
    assert.equal(unsettledCount(many(36)), 37);
    assert.equal(unsettledCount(plan()), 1);
  });
});
