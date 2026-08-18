import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOutdatedView } from '../dist/report/terminal-outdated.js';
import { createPalette, stripAnsi } from '../dist/util/terminal.js';
import { createStatusLine } from '../dist/util/status-line.js';

/**
 * `drift outdated` is read far more often than it is watched, and most of the
 * places it is read have no colour: a piped log, a CI transcript, a pull
 * request comment someone pasted it into. So every one of these assertions is
 * made against the plain rendering. If a fact only survives in colour, it is
 * not in the output. See `src/report/terminal-outdated.ts`.
 */

function harness(options: { unicode?: boolean; width?: number } = {}) {
  const lines: string[] = [];
  const palette = createPalette({
    color: false,
    unicode: options.unicode ?? true,
    hyperlinks: false,
  });
  const status = createStatusLine({
    palette,
    live: false,
    stream: { write: () => true, columns: 120 } as unknown as NodeJS.WriteStream,
    out: (line) => lines.push(line),
  });
  const view = createOutdatedView({ palette, status, interactive: false, width: options.width ?? 100 });
  return { view, lines, text: () => stripAnsi(lines.join('\n')) };
}

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'package.json#react@18.2.0',
  name: 'react',
  kind: 'runtime',
  ecosystem: 'npm',
  packageManager: 'npm',
  manifestPath: 'package.json',
  current: '18.2.0',
  range: '^18.2.0',
  selected: '18.3.1',
  latest: '19.2.0',
  safeLatest: '18.3.1',
  versions: ['19.2.0', '18.3.1'],
  status: 'clean',
  evidenceCount: 1,
  breakingCount: 0,
  impactCount: 0,
  impactFiles: 0,
  impactConfidence: 'none',
  risk: 'low',
  summary: 'Safe to upgrade.',
  gaps: [],
  toolRequests: [],
  ...over,
});

describe('the table of what is out of date', () => {
  test('carries npm outdated’s columns, in npm outdated’s order', () => {
    // Deliberately the table developers already know how to read.
    const { view, text } = harness();
    view.table([candidate()] as never, 10, 9);
    const header = text().split('\n').find((line) => line.includes('Package'))!;
    assert.match(header, /Package\s+Current\s+Wanted\s+Latest\s+Declared in/);
  });

  test('distinguishes the same package declared in two manifests', () => {
    // A monorepo lists `@types/node` three times. The name alone cannot say
    // which row is which, and the manifest path can.
    const { view, text } = harness();
    view.table(
      [
        candidate({ name: '@types/node', manifestPath: 'package.json' }),
        candidate({ name: '@types/node', manifestPath: 'site/package.json', id: 'site' }),
      ] as never,
      10,
      8,
    );
    assert.ok(text().includes('site/package.json'));
    assert.ok(text().includes('\n@types/node') || text().includes('@types/node'));
  });

  test('counts the up-to-date dependencies without folding the outdated in', () => {
    const { view, text } = harness();
    view.table([candidate()] as never, 10, 9);
    assert.match(text(), /1 of 10 direct dependencies has a newer version/);
    assert.match(text(), /9 up to date/);
  });

  test('says "Wanted" is the installed version when the range allows nothing newer', () => {
    // npm's own semantics: `wanted` is the newest release satisfying the
    // declared range, which for a major bump behind a caret is what is already
    // installed.
    const { view, text } = harness();
    view.table([candidate({ safeLatest: undefined, selected: '19.2.0' })] as never, 1, 0);
    const row = text().split('\n').find((line) => line.startsWith('react'))!;
    assert.match(row, /react\s+18\.2\.0\s+18\.2\.0\s+19\.2\.0/);
  });
});

describe('dependencies nothing would answer for', () => {
  test('are reported as unchecked, never as up to date', () => {
    // The single most misleading thing this command could say.
    const { view, text } = harness();
    view.unchecked([
      {
        name: 'mystery',
        kind: 'runtime',
        ecosystem: 'opam',
        packageManager: 'opam',
        manifestPath: 'x.opam',
        current: '1.0.0',
        reason: 'The opam repository publishes no version API.',
      },
    ] as never);
    const out = text();
    assert.ok(out.includes('could not be checked'));
    assert.ok(out.includes('not the same as up to date'));
    assert.ok(out.includes('The opam repository publishes no version API.'));
  });

  test('says nothing at all when every dependency was reachable', () => {
    const { view, lines } = harness();
    view.unchecked([]);
    assert.deepEqual(lines, []);
  });
});

describe('a settled package', () => {
  test('states the verdict in words, not only in colour', () => {
    const { view, text } = harness();
    view.settled(
      candidate({
        impactCount: 4,
        impactFiles: 2,
        status: 'ready',
        breakingCount: 1,
        impactConfidence: 'high',
      }) as never,
    );
    assert.ok(text().includes('Affects your code'));
    assert.ok(text().includes('4 sites in 2 files'));
  });

  test('keeps the hedge when the strongest match is not a direct, imported use', () => {
    // `describeSeverity` draws this distinction deliberately; a rendering that
    // flattened it would tell someone flatly that their code is affected on
    // the strength of a textual match.
    const { view, text } = harness();
    view.settled(
      candidate({ impactCount: 1, impactFiles: 1, status: 'ready', impactConfidence: 'low' }) as never,
    );
    assert.ok(text().includes('May affect your code'));
  });

  test('shows where it is going, not only that it moved', () => {
    const { view, text } = harness();
    view.settled(candidate() as never);
    assert.ok(text().includes('18.2.0'));
    assert.ok(text().includes('18.3.1'));
  });
});

describe('the grouped report', () => {
  const affected = candidate({
    name: 'graphql',
    id: 'graphql',
    status: 'ready',
    breakingCount: 3,
    impactCount: 2,
    impactFiles: 1,
    impactConfidence: 'high',
    summary: 'Two places in this repository use an API that graphql changed.',
    plan: {
      impactSites: [{ file: 'src/schema.ts', line: 42, breakingChangeId: 'bc_1' }],
      evidence: [{ id: 'ev_1', title: 'graphql 17 release notes', url: 'https://example.test/notes' }],
      breakingChanges: [],
    },
  });

  test('leads with what has to be acted on and buries what does not', () => {
    const { view, text } = harness();
    view.report([candidate(), affected] as never, () => 'graphql');
    const out = text();
    assert.ok(out.indexOf('Affects your code') < out.indexOf('Safe to take'));
  });

  test('gives an affected package its files, its evidence and its command', () => {
    // A bare count is not enough to decide an afternoon's work with.
    const { view, text } = harness();
    view.report([affected] as never, () => 'graphql');
    const out = text();
    assert.ok(out.includes('src/schema.ts:42'));
    assert.ok(out.includes('drift outdated --upgrade graphql'));
    // The citation, whole: a terminal that cannot make it clickable prints the
    // title and the URL beside it, and both halves have to survive.
    assert.ok(
      out.split('\n').some((line) => line.trim() === '· graphql 17 release notes https://example.test/notes'),
      out,
    );
  });

  test('does not print a paragraph for every safe package', () => {
    // The whole point of sorting them is that nobody has to read them.
    const { view, text } = harness();
    view.report([candidate()] as never, () => 'react');
    const out = text();
    assert.ok(out.includes('Safe to take'));
    assert.ok(!out.includes('Safe to upgrade.'), 'the per-package summary belongs to the groups that need it');
  });

  test('says what the project’s own checks did when they were actually run', () => {
    // A prediction and a measurement read identically unless the page says
    // which it is.
    const { view, text } = harness();
    view.report(
      [
        candidate({
          name: 'left-pad',
          id: 'left-pad',
          status: 'ready',
          impactCount: 1,
          impactFiles: 1,
          verification: {
            status: 'failed',
            reason: 'the build failed',
            checks: [
              { label: 'npm run build', status: 'failed' },
              { label: 'npm run typecheck', status: 'passed' },
            ],
            failedFiles: [],
          },
        }),
      ] as never,
      () => 'left-pad',
    );
    const out = text();
    assert.ok(out.includes('npm run build failed with this installed'));
    assert.ok(out.includes('npm run typecheck passed with this installed'));
  });
});

describe('a repository with nothing to check', () => {
  test('says nothing rather than clearing zero dependencies', () => {
    // "All 0 direct dependencies are up to date" is technically true and reads
    // as a bug: there was nothing to give a clean bill of health to.
    const { view, lines } = harness();
    view.allCurrent(0);
    assert.deepEqual(lines, []);
  });

  test('but does clear a repository whose dependencies are all current', () => {
    const { view, text } = harness();
    view.allCurrent(38);
    assert.ok(text().includes('All 38 direct dependencies are up to date.'));
  });
});

describe('a terminal without the glyphs', () => {
  test('renders the same report in ASCII', () => {
    const { view, text } = harness({ unicode: false });
    view.settled(candidate() as never);
    const out = text();
    assert.ok(out.includes('->'), 'the arrow degrades rather than disappearing');
    assert.ok(!/[─-➿]/.test(out), 'no box drawing or dingbats survive');
  });
});
