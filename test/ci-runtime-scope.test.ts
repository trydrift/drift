import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRuntimeRequirement } from '../dist/rationale/compatibility.js';

/**
 * #150 — repository-wide CI vs package-member CI.
 *
 * PR #143 fixed static matrix parsing, but Scrapy still lost its Python
 * runtime declarations because the repo root and `docs/` are separate
 * workspace members and the root's GitHub Actions Python matrix was treated
 * as *ambiguous* for the `docs` member rather than *repository-scoped*.
 *
 * A `.github/workflows` job with no member-specific `working-directory`/`paths`
 * targeting checks out and runs against the whole repository, so it governs
 * every member. A job that explicitly runs inside a member governs only that
 * member. An unresolved structure stays ambiguous.
 */

const files = (entries: Record<string, string>) =>
  Object.entries(entries).map(([path, content]) => ({ path, content }));

const pythonChange = (requirement: string) =>
  ({
    id: 'rt',
    dependency: 'pkg',
    kind: 'runtime-requirement' as const,
    summary: `requires python ${requirement}`,
    remediation: 'bump python',
    symbols: ['python'],
    confidence: 'high' as const,
    citations: ['e'],
    runtime: { kind: 'minimum-runtime', runtime: 'python', requirement, sourceText: `python ${requirement}` },
  }) as never;

const ROOT_MATRIX_WORKFLOW = `name: CI
on: [push]
jobs:
  tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.9", "3.10", "3.11", "3.12"]
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.python-version }}
`;

describe('#150: repository-wide CI governs every workspace member', () => {
  const members = ['', 'docs'];
  const repo = files({
    'pyproject.toml': '[project]\nname = "scrapy"\n',
    'docs/pyproject.toml': '[project]\nname = "scrapy-docs"\n',
    '.github/workflows/tests.yml': ROOT_MATRIX_WORKFLOW,
  });

  test('the root Python matrix satisfies a >=3.9 requirement for the root member', () => {
    const analysis = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, '', members);
    assert.equal(analysis?.state, 'compatible');
  });

  test('the root Python matrix also satisfies it for the docs child member', () => {
    const analysis = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, 'docs', members);
    assert.equal(analysis?.state, 'compatible', 'repo-wide CI is not dropped merely because docs is a separate member');
    assert.ok(
      analysis?.declarations.every((d) => d.scope === 'repository'),
      'the declarations are repository-scoped',
    );
  });

  test('a genuinely incompatible floor is still incompatible for the child member', () => {
    const analysis = analyzeRuntimeRequirement(pythonChange('>=3.13'), repo, 'docs', members);
    assert.equal(analysis?.state, 'incompatible');
  });

  test('repo-wide CI is not duplicated once per member in the rendered declarations', () => {
    const analysis = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, 'docs', members);
    // Exactly the four matrix versions, once each — not eight (one set per member).
    assert.deepEqual(
      [...new Set(analysis?.declarations.map((d) => d.requirement))].sort(),
      ['3.10', '3.11', '3.12', '3.9'],
    );
    assert.equal(analysis?.declarations.length, 4);
  });
});

describe('#150: the inverse — one package’s CI must not prove another’s', () => {
  const members = ['', 'packages/api', 'packages/web'];
  const repo = files({
    'packages/api/pyproject.toml': '[project]\nname = "api"\n',
    'packages/web/pyproject.toml': '[project]\nname = "web"\n',
    '.github/workflows/api.yml': `jobs:
  api:
    defaults:
      run:
        working-directory: packages/api
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: "3.8"
`,
  });

  test('the api job (working-directory: packages/api) does not decide web', () => {
    const web = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, 'packages/web', members);
    // web has no runtime declaration of its own and the only CI job is scoped
    // to api, so web's compatibility is genuinely unknown — never proven by
    // api's Python 3.8.
    assert.equal(web?.state, 'unknown');
  });

  test('the api job does decide api itself', () => {
    const api = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, 'packages/api', members);
    assert.equal(api?.state, 'incompatible');
  });
});

/**
 * #160 — scope must be represented consistently for every declaration used by
 * precedence, resolved or unresolved. The four cases below are the spec's
 * required regressions.
 */
describe('#160: runtime declaration scope and precedence', () => {
  // Case 1 — an inherited root version file must not cause a repository-wide
  // CI matrix to be discarded for a child member merely because its scope was
  // never assigned.
  test('Case 1: inherited root .python-version + repo CI matrix, evaluating docs', () => {
    const members = ['', 'docs'];
    const repo = files({
      '.python-version': '3.11\n',
      '.github/workflows/tests.yml': ROOT_MATRIX_WORKFLOW,
    });
    const analysis = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, 'docs', members);
    // Both the inherited root file and the repo CI matrix are repository-scoped
    // for `docs`; neither is member-specific, so the CI matrix is not dropped.
    assert.equal(analysis?.state, 'compatible');
    assert.ok(
      analysis?.declarations.some((d) => d.file === '.github/workflows/tests.yml'),
      'the repository CI matrix survived',
    );
    assert.ok(analysis?.declarations.every((d) => d.scope === 'repository'));
  });

  // Case 2 — an explicit member-scoped declaration decides compatibility
  // without an unrelated repository / ambiguous declaration contaminating it.
  test('Case 2: an explicit member declaration beats a lower-precedence ambiguous CI line', () => {
    const members = ['', 'packages/api', 'packages/web'];
    const repo = files({
      'packages/api/.python-version': '3.8\n',
      // A recognised CI runtime pin this shallow parser cannot slice into jobs
      // -> ambiguous / unresolved ownership.
      '.gitlab-ci.yml': 'image: "python:3.12"\n',
    });
    const api = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, 'packages/api', members);
    // packages/api pins Python 3.8 for itself; >=3.9 is incompatible, and the
    // unrelated ambiguous 3.12 line must not turn that into `unknown`.
    assert.equal(api?.state, 'incompatible');
    assert.deepEqual(
      api?.declarations.map((d) => d.file),
      ['packages/api/.python-version'],
    );
    assert.equal(api?.unresolved.length, 0, 'the ambiguous CI line is outranked, not left to force unknown');
  });

  // Case 3 — no member-specific declaration: the repository-wide CI declaration
  // still governs the child member.
  test('Case 3: repository-wide CI governs a child member with no declaration of its own', () => {
    const members = ['', 'packages/api'];
    const repo = files({ '.github/workflows/tests.yml': ROOT_MATRIX_WORKFLOW });
    const analysis = analyzeRuntimeRequirement(pythonChange('>=3.13'), repo, 'packages/api', members);
    assert.equal(analysis?.state, 'incompatible');
    assert.ok(analysis?.declarations.every((d) => d.scope === 'repository'));
  });

  // Case 4 — a job that targets one sibling must never prove another.
  test('Case 4: an api-targeted CI job leaves web unknown', () => {
    const members = ['', 'packages/api', 'packages/web'];
    const repo = files({
      '.github/workflows/ci.yml': [
        'jobs:',
        '  api:',
        '    defaults:',
        '      run:',
        '        working-directory: packages/api',
        '    steps:',
        '      - uses: actions/setup-python@v5',
        '        with:',
        '          python-version: "3.8"',
      ].join('\n'),
    });
    const web = analyzeRuntimeRequirement(pythonChange('>=3.9'), repo, 'packages/web', members);
    assert.equal(web?.state, 'unknown');
  });
});
