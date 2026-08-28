import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPythonCompatibility,
  discoverRuntimeDeclarations,
  findRuntimeDeclarations,
} from '../dist/rationale/index.js';

/**
 * A `${{ matrix.<key> }}` runtime value whose GitHub Actions job defines that
 * matrix key statically is not dynamic evidence — Drift can enumerate the
 * versions. Leaving the consumer in `unresolved` alongside them was the bug:
 * a single surviving `unresolved` entry forces the whole runtime verdict to
 * `unknown` (`stateOf`), so a Scrapy-style `python-version: ${{ matrix.python
 * }}` made every compatible Python-floor bump read as `Not Verified`.
 *
 * One resolver, driven only by the consumer field name, works for every
 * runtime in `CI_RUNTIME_FIELD_NAMES`.
 */

const WORKFLOW = '.github/workflows/ci.yml';
const discover = (
  content: string,
  runtime: Parameters<typeof discoverRuntimeDeclarations>[1],
  member?: string,
  allMembers?: string[],
) => discoverRuntimeDeclarations([{ path: WORKFLOW, content }], runtime, member, allMembers);

const lineOf = (content: string, needle: string) =>
  content.split('\n').findIndex((line) => line.includes(needle)) + 1;

describe('static GitHub Actions matrices resolve to concrete runtime declarations', () => {
  const cases = [
    ['node', 'node-version', '20', '22'],
    ['python', 'python-version', '3.10', '3.13'],
    ['ruby', 'ruby-version', '3.2', '3.3'],
    ['go', 'go-version', '1.22', '1.24'],
    ['java', 'java-version', '17', '21'],
    ['rust', 'toolchain', '1.80', '1.82'],
  ] as const;

  for (const [runtime, field, a, b] of cases) {
    test(`${field}: \${{ matrix.runtime }} resolves against the job's static matrix`, () => {
      const content = [
        'jobs:',
        '  test:',
        '    strategy:',
        '      matrix:',
        '        runtime:',
        `          - "${a}"`,
        `          - "${b}"`,
        '    steps:',
        '      - uses: actions/setup@v1',
        '        with:',
        `          ${field}: \${{ matrix.runtime }}`,
      ].join('\n');

      const { resolved, unresolved } = discover(content, runtime);

      assert.deepEqual(
        resolved.map((r) => r.requirement).sort(),
        [a, b].sort(),
        `${runtime}: concrete declarations`,
      );
      // Each resolved declaration points at the matrix literal that produced it.
      assert.equal(resolved.find((r) => r.requirement === a)!.line, lineOf(content, `"${a}"`));
      assert.equal(resolved.find((r) => r.requirement === b)!.line, lineOf(content, `"${b}"`));
      // The consumer expression left nothing behind in `unresolved`.
      assert.deepEqual(unresolved, [], `${runtime}: consumer is not unresolved`);
    });
  }

  test('an arbitrary matrix key name is not tied to the runtime field name', () => {
    const content = [
      'jobs:',
      '  build:',
      '    strategy:',
      '      matrix:',
      '        whatever: ["20", "22"]',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: ${{ matrix.whatever }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['20', '22']);
    assert.deepEqual(unresolved, []);
  });

  test('include-only matrix', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - node-version: "20"',
      '            os: ubuntu-latest',
      '          - node-version: "22"',
      '            os: windows-latest',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.node-version }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['20', '22']);
    assert.equal(resolved.find((r) => r.requirement === '20')!.line, lineOf(content, '"20"'));
    assert.deepEqual(unresolved, []);
  });

  test('base matrix plus include adds the include value to the domain', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        node-version: ["20", "22"]',
      '        include:',
      '          - node-version: "24"',
      '            experimental: true',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.node-version }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['20', '22', '24']);
    assert.deepEqual(unresolved, []);
  });

  test('a static exclude that leaves the value reachable keeps it in the domain', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest, windows-latest]',
      '        node-version: ["20", "22"]',
      '        exclude:',
      '          - os: windows-latest',
      '            node-version: "20"',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.node-version }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    // ubuntu-latest / 20 still exists, so "20" survives.
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['20', '22']);
    assert.deepEqual(unresolved, []);
  });

  test('a static exclude that removes every combination of a value drops it', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest, windows-latest]',
      '        node-version: ["20", "22"]',
      '        exclude:',
      '          - node-version: "20"',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.node-version }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['22']);
    assert.deepEqual(unresolved, []);
  });

  test('two jobs sharing a matrix key resolve only against their own job', () => {
    const content = [
      'jobs:',
      '  old:',
      '    strategy:',
      '      matrix:',
      '        runtime: ["18"]',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.runtime }}',
      '  current:',
      '    strategy:',
      '      matrix:',
      '        runtime: ["20", "22"]',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.runtime }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['18', '20', '22']);
    assert.deepEqual(unresolved, []);
    // "18" is only ever attributed inside job `old`; "20"/"22" only inside `current`.
    const currentJobLine = lineOf(content, '  current:');
    assert.ok(resolved.find((r) => r.requirement === '18')!.line < currentJobLine);
    assert.ok(resolved.filter((r) => r.requirement !== '18').every((r) => r.line > currentJobLine));
  });

  test('repeated matrix combinations are evaluated once', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - python: "3.10"',
      '            toxenv: mypy',
      '          - python: "3.10"',
      '            toxenv: mypy-tests',
      '    steps:',
      '      - with:',
      '          python-version: ${{ matrix.python }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'python');
    assert.deepEqual(resolved.map((r) => r.requirement), ['3.10']);
    assert.deepEqual(unresolved, []);
  });
});

describe('genuinely dynamic matrix and non-matrix expressions stay unresolved', () => {
  test('a matrix dimension built from an expression cannot be proven', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        runtime: ${{ fromJSON(inputs.runtimes) }}',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.runtime }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved, []);
    assert.ok(unresolved.length > 0);
    assert.equal(unresolved[0].rawText, '${{ matrix.runtime }}');
  });

  test('a non-matrix GitHub expression is still unresolved', () => {
    const content = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - with:',
      '          node-version: ${{ inputs.node }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved, []);
    assert.ok(unresolved.length > 0);
    assert.equal(unresolved[0].rawText, '${{ inputs.node }}');
  });

  test('a matrix reference wrapped in a fallback expression is not the exact shape', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        go: ["1.24"]',
      '    steps:',
      '      - with:',
      "          go-version: ${{ matrix.go || '1.23' }}",
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'go');
    assert.deepEqual(resolved, []);
    assert.ok(unresolved.length > 0);
  });

  test('an unevaluatable exclude entry leaves the consumer unresolved', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        node-version: ["20", "22"]',
      '        exclude:',
      '          - node-version: ${{ env.SKIP }}',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.node-version }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node');
    assert.deepEqual(resolved, []);
    assert.ok(unresolved.length > 0);
  });
});

describe('matrix resolution does not weaken workspace ownership', () => {
  const members = ['', 'packages/api', 'packages/web'];

  test('an ambiguous monorepo job keeps its resolved matrix values non-authoritative', () => {
    const content = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        node-version: ["20", "22"]',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.node-version }}',
    ].join('\n');
    // The job names no member: ownership is not established in a real monorepo.
    assert.deepEqual(findRuntimeDeclarations([{ path: WORKFLOW, content }], 'node', 'packages/api', members), []);
    const { resolved, unresolved } = discover(content, 'node', 'packages/api', members);
    assert.deepEqual(resolved, []);
    assert.ok(unresolved.length > 0, 'the matrix values are still recorded, as unresolved evidence');
  });

  test('a job scoped to the analyzed member resolves its matrix normally', () => {
    const content = [
      'jobs:',
      '  api:',
      '    defaults:',
      '      run:',
      '        working-directory: packages/api',
      '    strategy:',
      '      matrix:',
      '        node-version: ["20", "22"]',
      '    steps:',
      '      - with:',
      '          node-version: ${{ matrix.node-version }}',
    ].join('\n');
    const { resolved, unresolved } = discover(content, 'node', 'packages/api', members);
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['20', '22']);
    assert.deepEqual(unresolved, []);
  });
});

describe('Scrapy regression: a static Python matrix no longer forces `unknown`', () => {
  const content = [
    'jobs:',
    '  tests:',
    '    strategy:',
    '      matrix:',
    '        python-version:',
    '          - "3.14"',
    '          - "3.10"',
    '          - "3.13"',
    '    steps:',
    '      - uses: actions/setup-python@v5',
    '        with:',
    '          python-version: ${{ matrix.python-version }}',
  ].join('\n');

  test('the matrix versions become resolved declarations, consumer not unresolved', () => {
    const { resolved, unresolved } = discover(content, 'python');
    assert.deepEqual(resolved.map((r) => r.requirement).sort(), ['3.10', '3.13', '3.14']);
    assert.deepEqual(unresolved, []);
  });

  test('a compatible Python floor is compatible, not unknown', () => {
    const { resolved } = discover(content, 'python');
    for (const floor of ['>=3.9', '>=3.10']) {
      const verdicts = checkPythonCompatibility(resolved, floor).map((r) => r.verdict);
      assert.ok(!verdicts.includes('unknown'), `${floor}: no unknown`);
      assert.ok(verdicts.every((v) => v === 'compatible'), `${floor}: all compatible`);
    }
  });

  test('only the genuinely incompatible concrete version is incompatible', () => {
    const { resolved } = discover(content, 'python');
    const results = checkPythonCompatibility(resolved, '>=3.11');
    assert.equal(results.find((r) => r.requirement === '3.10')!.verdict, 'incompatible');
    for (const version of ['3.13', '3.14']) {
      const verdict = results.find((r) => r.requirement === version)!.verdict;
      assert.ok(verdict !== 'incompatible' && verdict !== 'unknown', `${version}: ${verdict}`);
    }
  });
});
