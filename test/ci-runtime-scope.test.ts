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
