import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeCompatibility, findNodeDeclarations } from '../dist/rationale/index.js';
import { assessMaintenance } from '../dist/rationale/index.js';

describe("finding this repository's own Node.js declarations", () => {
  test('reads engines.node out of package.json', () => {
    const files = [{ path: 'package.json', content: JSON.stringify({ engines: { node: '>=22.6.0' } }) }];
    const declarations = findNodeDeclarations(files);
    assert.deepEqual(declarations, [{ file: 'package.json', line: 1, requirement: '>=22.6.0' }]);
  });

  test('a package.json with no engines field declares nothing', () => {
    const files = [{ path: 'package.json', content: JSON.stringify({ name: 'x' }) }];
    assert.deepEqual(findNodeDeclarations(files), []);
  });

  test('reads .nvmrc and .node-version, stripping a leading "v"', () => {
    const files = [
      { path: '.nvmrc', content: 'v22.6.0\n' },
      { path: 'packages/api/.node-version', content: '20.19.0' },
    ];
    assert.deepEqual(findNodeDeclarations(files), [
      { file: '.nvmrc', line: 1, requirement: '22.6.0' },
      { file: 'packages/api/.node-version', line: 1, requirement: '20.19.0' },
    ]);
  });

  test('reads the node-version pin out of a GitHub Actions workflow', () => {
    const files = [
      {
        path: '.github/workflows/ci.yml',
        content: ['jobs:', '  test:', '    steps:', "      - uses: actions/setup-node@v5", '        with:', "          node-version: '22'"].join('\n'),
      },
    ];
    const declarations = findNodeDeclarations(files);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].requirement, '22');
    assert.equal(declarations[0].file, '.github/workflows/ci.yml');
  });

  test('a matrix expression that resolves to no literal version is left out, not guessed at', () => {
    const files = [
      { path: '.github/workflows/ci.yml', content: '          node-version: ${{ matrix.node }}' },
    ];
    assert.deepEqual(findNodeDeclarations(files), []);
  });

  test('reads the node base image tag out of a Dockerfile', () => {
    const files = [{ path: 'Dockerfile', content: ['FROM node:22.6.0-slim', 'RUN npm ci'].join('\n') }];
    assert.deepEqual(findNodeDeclarations(files), [{ file: 'Dockerfile', line: 1, requirement: '22.6.0' }]);
  });

  test('files outside the known runtime-config surfaces are ignored', () => {
    const files = [{ path: 'src/index.ts', content: 'engines.node = "22"' }];
    assert.deepEqual(findNodeDeclarations(files), []);
  });
});

describe('checking this repository against a raised requirement', () => {
  test('a floor entirely inside the new range is compatible', () => {
    const results = checkNodeCompatibility(
      [{ file: 'package.json', line: 1, requirement: '>=24.0.0' }],
      '^20.19.0 || ^22.13.0 || >=24',
    );
    assert.equal(results[0].verdict, 'compatible');
  });

  test('a floor with no overlap at all is incompatible', () => {
    const results = checkNodeCompatibility(
      [{ file: '.nvmrc', line: 1, requirement: '16.0.0' }],
      '^20.19.0 || ^22.13.0 || >=24',
    );
    assert.equal(results[0].verdict, 'incompatible');
  });

  test('a declared floor that admits versions the new floor rejects is only partial, not compatible', () => {
    const results = checkNodeCompatibility(
      [{ file: 'package.json', line: 1, requirement: '>=22.6.0' }],
      '^20.19.0 || ^22.13.0 || >=24',
    );
    assert.equal(results[0].verdict, 'partial');
  });

  test('a declaration this cannot parse as a range is left out, not misjudged', () => {
    assert.deepEqual(
      checkNodeCompatibility([{ file: 'Dockerfile', line: 1, requirement: 'lts' }], '>=22.13.0'),
      [],
    );
  });
});

describe('the runtime-requirement maintenance fact', () => {
  const base = {
    name: 'pkg',
    ecosystem: 'npm',
    from: '1.0.0',
    to: '2.0.0',
    registry: null,
    repository: null,
  };

  const version = (requirement, name = 'Node.js') => ({
    version: 'v',
    license: null,
    releasedAt: null,
    runtime: { name, requirement },
    dependencies: [],
    withdrawn: null,
  });

  test('a repository that already clears the new floor is told so, not asked to check', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('^18.18.0 || ^20.9.0 || >=21.1.0'),
      targetVersion: version('^20.19.0 || ^22.13.0 || >=24'),
      repoRuntime: [{ file: 'package.json', line: 1, requirement: '>=24.0.0' }],
    });
    const fact = result.facts.find((f) => /Node\.js version changed/.test(f.statement));
    assert.equal(fact.concerning, false);
    assert.match(fact.statement, /already satisfies it \(package\.json\)/);
  });

  test('a repository that falls short is told which file, and it is concerning', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('^18.18.0 || ^20.9.0 || >=21.1.0'),
      targetVersion: version('^20.19.0 || ^22.13.0 || >=24'),
      repoRuntime: [{ file: '.nvmrc', line: 1, requirement: '18.18.0' }],
    });
    const fact = result.facts.find((f) => /Node\.js version changed/.test(f.statement));
    assert.equal(fact.concerning, true);
    assert.match(fact.statement, /does not satisfy it: \.nvmrc/);
  });

  test('with nothing gathered, it falls back to asking the reader to check', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('^18.18.0 || ^20.9.0 || >=21.1.0'),
      targetVersion: version('^20.19.0 || ^22.13.0 || >=24'),
    });
    const fact = result.facts.find((f) => /Node\.js version changed/.test(f.statement));
    assert.match(fact.statement, /Check this against the runtimes this repository builds and deploys on/);
  });

  test("a non-Node runtime bump is never checked against this repository's Node declarations", () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=1.20', 'Go'),
      targetVersion: version('>=1.23', 'Go'),
      repoRuntime: [{ file: 'package.json', line: 1, requirement: '>=22.13.0' }],
    });
    const fact = result.facts.find((f) => /Go version changed/.test(f.statement));
    assert.match(fact.statement, /Check this against the runtimes this repository builds and deploys on/);
  });
});
