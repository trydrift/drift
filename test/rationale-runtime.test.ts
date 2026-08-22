import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNodeCompatibility,
  checkPythonCompatibility,
  findNodeDeclarations,
  findPythonDeclarations,
} from '../dist/rationale/index.js';
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

  test('a workspace scope excludes a sibling workspace’s own declaration', () => {
    const files = [
      { path: 'packages/api/.nvmrc', content: '20.19.0' },
      { path: 'packages/worker/.nvmrc', content: '18.0.0' },
      { path: '.nvmrc', content: '22.6.0' },
    ];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api'), [
      { file: 'packages/api/.nvmrc', line: 1, requirement: '20.19.0' },
      { file: '.nvmrc', line: 1, requirement: '22.6.0' },
    ]);
  });
});

describe("finding this repository's own Python declarations", () => {
  test('reads requires-python out of pyproject.toml’s [project] table', () => {
    const files = [
      {
        path: 'pyproject.toml',
        content: ['[project]', 'name = "demo"', 'requires-python = ">=3.9"', '', '[tool.poetry]', 'name = "demo"'].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'pyproject.toml', line: 3, requirement: '>=3.9' }]);
  });

  test('a requires-python-looking key outside [project] is not read as the declaration', () => {
    const files = [
      {
        path: 'pyproject.toml',
        content: ['[tool.other]', 'requires-python = ">=2.7"', '', '[project]', 'name = "demo"'].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), []);
  });

  test('reads python_requires out of setup.cfg’s [options] section', () => {
    const files = [
      { path: 'setup.cfg', content: ['[metadata]', 'name = demo', '', '[options]', 'python_requires = >=3.8,<4'].join('\n') },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'setup.cfg', line: 5, requirement: '>=3.8,<4' }]);
  });

  test('reads only a literal python_requires keyword argument out of setup.py', () => {
    const files = [
      {
        path: 'setup.py',
        content: ['from setuptools import setup', '', 'setup(', '    name="demo",', '    python_requires=">=3.10",', ')'].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'setup.py', line: 5, requirement: '>=3.10' }]);
  });

  test('a computed python_requires in setup.py is left out rather than evaluated', () => {
    const files = [{ path: 'setup.py', content: 'setup(python_requires=MIN_PYTHON)' }];
    assert.deepEqual(findPythonDeclarations(files), []);
  });

  test('reads .python-version as a pin', () => {
    const files = [{ path: '.python-version', content: '3.11\n' }];
    assert.deepEqual(findPythonDeclarations(files), [{ file: '.python-version', line: 1, requirement: '3.11' }]);
  });

  test('reads runtime.txt, stripping the "python-" prefix some platforms use', () => {
    const files = [{ path: 'runtime.txt', content: 'python-3.11.4' }];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'runtime.txt', line: 1, requirement: '3.11.4' }]);
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

describe('checking this repository against a raised Python requirement', () => {
  test('a floor entirely inside the new range is compatible', () => {
    const results = checkPythonCompatibility([{ file: 'pyproject.toml', line: 1, requirement: '>=3.11' }], '>=3.9');
    assert.equal(results[0].verdict, 'compatible');
  });

  test('a floor with no overlap at all is incompatible', () => {
    const results = checkPythonCompatibility([{ file: '.python-version', line: 1, requirement: '3.6' }], '>=3.9');
    assert.equal(results[0].verdict, 'incompatible');
  });

  test('a declared floor that admits versions the new floor rejects is only partial, not compatible', () => {
    const results = checkPythonCompatibility([{ file: 'pyproject.toml', line: 1, requirement: '>=3.8' }], '>=3.9,<4');
    assert.equal(results[0].verdict, 'partial');
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

  test('a raised Python floor is verified automatically, the same way Node is', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=3.8', 'Python'),
      targetVersion: version('>=3.9', 'Python'),
      pythonRuntime: [{ file: 'pyproject.toml', line: 3, requirement: '>=3.11' }],
    });
    const fact = result.facts.find((f) => /Python version changed/.test(f.statement));
    assert.equal(fact.concerning, false);
    assert.match(fact.statement, /already satisfies it \(pyproject\.toml\)/);
  });

  test('a Python floor this repository falls short of is concerning, and names the file', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=3.6', 'Python'),
      targetVersion: version('>=3.9', 'Python'),
      pythonRuntime: [{ file: '.python-version', line: 1, requirement: '3.6' }],
    });
    const fact = result.facts.find((f) => /Python version changed/.test(f.statement));
    assert.equal(fact.concerning, true);
    assert.match(fact.statement, /does not satisfy it: \.python-version/);
  });

  test('a Python bump is never checked against this repository’s Node declarations', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=3.8', 'Python'),
      targetVersion: version('>=3.9', 'Python'),
      repoRuntime: [{ file: 'package.json', line: 1, requirement: '>=3.9' }],
    });
    const fact = result.facts.find((f) => /Python version changed/.test(f.statement));
    assert.match(fact.statement, /Check this against the runtimes this repository builds and deploys on/);
  });
});
