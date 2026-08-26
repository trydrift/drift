import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNodeCompatibility,
  checkPythonCompatibility,
  checkRuntimeCompatibility,
  findRuntimeDeclarations,
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

  test('member undefined (no workspace context) keeps every declaration, unscoped', () => {
    const files = [
      { path: 'packages/api/.nvmrc', content: '20.19.0' },
      { path: 'packages/worker/.nvmrc', content: '18.0.0' },
      { path: '.nvmrc', content: '22.6.0' },
    ];
    assert.deepEqual(findNodeDeclarations(files), [
      { file: 'packages/api/.nvmrc', line: 1, requirement: '20.19.0' },
      { file: 'packages/worker/.nvmrc', line: 1, requirement: '18.0.0' },
      { file: '.nvmrc', line: 1, requirement: '22.6.0' },
    ]);
  });
});

describe('scoping a runtime declaration to the workspace that owns it', () => {
  const allMembers = ['', 'packages/api', 'packages/worker'];

  test('a non-root member sees its own declaration', () => {
    const files = [{ path: 'packages/api/.nvmrc', content: '20.19.0' }];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: 'packages/api/.nvmrc', line: 1, requirement: '20.19.0' },
    ]);
  });

  test('a non-root member does not see a sibling member’s declaration', () => {
    const files = [{ path: 'packages/worker/.nvmrc', content: '18.0.0' }];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), []);
  });

  test('a non-root member still sees a repo-global CI workflow declaration', () => {
    const files = [
      {
        path: '.github/workflows/ci.yml',
        content: ['jobs:', '  test:', '    steps:', "      - uses: actions/setup-node@v5", '        with:', "          node-version: '22'"].join('\n'),
      },
    ];
    const declarations = findNodeDeclarations(files, 'packages/api', allMembers);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].file, '.github/workflows/ci.yml');
  });

  test('a non-root member still sees a root-level declaration', () => {
    const files = [{ path: '.nvmrc', content: '22.6.0' }];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: '.nvmrc', line: 1, requirement: '22.6.0' },
    ]);
  });

  test("a member's own .nvmrc shadows the root's, the way nvm/asdf actually resolve one", () => {
    const files = [
      { path: '.nvmrc', content: '18' },
      { path: 'packages/api/.nvmrc', content: '20' },
    ];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: 'packages/api/.nvmrc', line: 1, requirement: '20' },
    ]);
  });

  test("a member's own .tool-versions shadows the root's", () => {
    const files = [
      { path: '.tool-versions', content: 'nodejs 18' },
      { path: 'packages/api/.tool-versions', content: 'nodejs 20' },
    ];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: 'packages/api/.tool-versions', line: 1, requirement: '20' },
    ]);
  });

  test('a repo-global CI workflow still applies even when a member has its own .nvmrc', () => {
    // Unlike a version-pin file, CI is not shadowed: a root workflow may
    // build/test every member, and a member's own runtime pin says nothing
    // about what CI actually runs with.
    const files = [
      { path: 'packages/api/.nvmrc', content: '20' },
      { path: '.github/workflows/ci.yml', content: "          node-version: '18'" },
    ];
    const declarations = findNodeDeclarations(files, 'packages/api', allMembers);
    assert.deepEqual(new Set(declarations.map((d) => d.file)), new Set(['packages/api/.nvmrc', '.github/workflows/ci.yml']));
  });

  test('the root workspace (member === "") does not inherit a sibling’s .nvmrc', () => {
    const files = [{ path: 'packages/worker/.nvmrc', content: '18.0.0' }];
    assert.deepEqual(findNodeDeclarations(files, '', allMembers), []);
  });

  test('the root workspace (member === "") does not inherit a sibling’s .python-version', () => {
    const files = [{ path: 'packages/worker/.python-version', content: '3.9' }];
    assert.deepEqual(findPythonDeclarations(files, '', allMembers), []);
  });

  test('the root workspace still sees its own root-level declaration', () => {
    const files = [{ path: '.nvmrc', content: '22.6.0' }];
    assert.deepEqual(findNodeDeclarations(files, '', allMembers), [
      { file: '.nvmrc', line: 1, requirement: '22.6.0' },
    ]);
  });

  test('the root workspace still sees a repo-global CI workflow declaration', () => {
    const files = [
      { path: '.github/workflows/ci.yml', content: "          node-version: '22'" },
    ];
    assert.equal(findNodeDeclarations(files, '', allMembers).length, 1);
  });

  test('a root package.json engines field does not leak into a sibling member when the root is itself a member', () => {
    // The root directory being a registered workspace member (allMembers
    // includes '') means memberOf() attributes root-owned files to '' rather
    // than null, the same as any other member's own files. A root package
    // manifest describes the root package's own runtime, not the whole
    // repository's, so it must not be treated as global the way a root
    // .nvmrc or CI workflow is.
    const files = [{ path: 'package.json', content: JSON.stringify({ engines: { node: '>=18' } }) }];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), []);
  });

  test('the root package still sees its own package.json engines field', () => {
    const files = [{ path: 'package.json', content: JSON.stringify({ engines: { node: '>=18' } }) }];
    assert.deepEqual(findNodeDeclarations(files, '', allMembers), [
      { file: 'package.json', line: 1, requirement: '>=18' },
    ]);
  });

  test('a root pyproject.toml requires-python does not leak into a sibling member', () => {
    const files = [
      { path: 'pyproject.toml', content: ['[project]', 'requires-python = ">=3.9"'].join('\n') },
    ];
    assert.deepEqual(findPythonDeclarations(files, 'packages/api', allMembers), []);
  });

  test('a root-level .nvmrc still applies globally even when the root is itself a member', () => {
    const files = [{ path: '.nvmrc', content: '18.18.0' }];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: '.nvmrc', line: 1, requirement: '18.18.0' },
    ]);
  });

  test('with no member list supplied, scoping is skipped rather than guessed at', () => {
    const files = [{ path: 'packages/worker/.nvmrc', content: '18.0.0' }];
    // `member` is known ('packages/api') but `allMembers` was never gathered —
    // falls back to the original unscoped behavior rather than assuming every
    // other file belongs to a sibling.
    assert.deepEqual(findNodeDeclarations(files, 'packages/api'), [
      { file: 'packages/worker/.nvmrc', line: 1, requirement: '18.0.0' },
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

  test('.python-version reads every version pyenv lists, not just the first line', () => {
    // Pyenv accepts multiple versions in this file, one per line or several
    // whitespace-separated on one line, and treats `#`-prefixed lines as
    // comments. Reading only the first line can miss an older version this
    // repository still builds and runs on.
    const files = [{ path: '.python-version', content: ['3.11', '# a comment', '3.8 3.9', ''].join('\n') }];
    assert.deepEqual(findPythonDeclarations(files), [
      { file: '.python-version', line: 1, requirement: '3.11' },
      { file: '.python-version', line: 3, requirement: '3.8' },
      { file: '.python-version', line: 3, requirement: '3.9' },
    ]);
  });

  test('a stray older .python-version entry fails a raised floor even though the first line is compatible', () => {
    const files = [{ path: '.python-version', content: '3.11\n3.8' }];
    const declarations = findPythonDeclarations(files);
    const results = checkPythonCompatibility(declarations, '>=3.10');
    assert.deepEqual(
      results.map((r) => r.verdict),
      ['compatible', 'incompatible'],
    );
  });

  test('setup.py ignores a commented-out python_requires', () => {
    const files = [
      {
        path: 'setup.py',
        content: [
          'from setuptools import setup',
          '',
          '# python_requires=">=2.7"  (legacy, dropped)',
          'setup(',
          '    name="demo",',
          ')',
        ].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), []);
  });

  test('setup.py ignores a python_requires-looking assignment that is not an argument to setup()', () => {
    const files = [
      {
        path: 'setup.py',
        content: [
          'from setuptools import setup',
          '',
          '# Not actually passed to setup() below -- a leftover from a refactor.',
          'python_requires = ">=2.7"',
          '',
          'setup(',
          '    name="demo",',
          ')',
        ].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), []);
  });

  test('a real setup() call followed by an unrelated helper.setup() call still uses the real one', () => {
    // The bug: taking the literal "last setup( in the file" without excluding
    // a member call on some unrelated object picked up `helper.setup(...)`
    // instead of the actual package declaration.
    const files = [
      {
        path: 'setup.py',
        content: [
          'from setuptools import setup',
          '',
          'setup(',
          '    name="demo",',
          '    python_requires=">=3.10",',
          ')',
          '',
          'helper.setup(other="thing")',
        ].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'setup.py', line: 5, requirement: '>=3.10' }]);
  });

  test('a setuptools.setup(...) call is recognised the same as a bare setup(...) call', () => {
    const files = [
      {
        path: 'setup.py',
        content: ['import setuptools', '', 'setuptools.setup(', '    python_requires=">=3.11",', ')'].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'setup.py', line: 4, requirement: '>=3.11' }]);
  });

  test('a string argument containing a close paren does not truncate the call early', () => {
    // The bug: a bare character-count paren scan treated the ")" inside
    // "(details)" as closing the whole setup() call, silently dropping every
    // keyword argument after it -- python_requires included.
    const files = [
      {
        path: 'setup.py',
        content: [
          'from setuptools import setup',
          '',
          'setup(',
          '    name="demo",',
          '    long_description="See the docs (details here) for more.",',
          '    python_requires=">=3.11",',
          ')',
        ].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'setup.py', line: 6, requirement: '>=3.11' }]);
  });

  test('a triple-quoted string argument containing a close paren does not truncate the call early', () => {
    const files = [
      {
        path: 'setup.py',
        content: [
          'from setuptools import setup',
          '',
          'setup(',
          '    name="demo",',
          '    long_description="""',
          '    See the docs (and this parenthetical) for details.',
          '    """,',
          '    python_requires=">=3.9",',
          ')',
        ].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'setup.py', line: 8, requirement: '>=3.9' }]);
  });

  test('an entirely commented-out setup() call is never read as the declaration', () => {
    const files = [
      {
        path: 'setup.py',
        content: [
          '# setup(',
          '#     name="demo",',
          '#     python_requires=">=2.7",',
          '# )',
        ].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), []);
  });

  test('setup.py still finds python_requires when the setup() call spans multiple lines with other kwargs', () => {
    const files = [
      {
        path: 'setup.py',
        content: [
          'from setuptools import setup',
          '',
          'setup(',
          '    name="demo",',
          '    version="1.0",',
          '    python_requires=">=3.10",',
          '    packages=["demo"],',
          ')',
        ].join('\n'),
      },
    ];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'setup.py', line: 6, requirement: '>=3.10' }]);
  });

  test('reads runtime.txt, stripping the "python-" prefix some platforms use', () => {
    const files = [{ path: 'runtime.txt', content: 'python-3.11.4' }];
    assert.deepEqual(findPythonDeclarations(files), [{ file: 'runtime.txt', line: 1, requirement: '3.11.4' }]);
  });
});

describe('shared runtime declaration discovery across supported runtimes', () => {
  const cases = [
    {
      runtime: 'node', requirement: '>=24', compatibleRequirement: '>=18',
      file: { path: '.nvmrc', content: '22' }, expected: '22',
    },
    {
      runtime: 'python', requirement: '>=3.13', compatibleRequirement: '>=3.10',
      file: { path: 'Containerfile', content: 'FROM python:3.11-slim' }, expected: '3.11',
    },
    {
      runtime: 'ruby', requirement: '>=3.4', compatibleRequirement: '>=3.2',
      file: { path: '.ruby-version', content: '3.3' }, expected: '3.3',
    },
    {
      runtime: 'go', requirement: '>=1.25', compatibleRequirement: '>=1.22',
      file: { path: 'go.mod', content: 'module example.com/demo\n\ngo 1.23\ntoolchain go1.24.1\n' }, expected: '1.23',
    },
    {
      runtime: 'java', requirement: '>=21', compatibleRequirement: '>=17',
      file: { path: 'Dockerfile', content: 'FROM eclipse-temurin:17-jdk' }, expected: '17',
    },
    {
      runtime: 'rust', requirement: '>=1.90', compatibleRequirement: '>=1.80',
      file: { path: 'rust-toolchain', content: '1.82' }, expected: '1.82',
    },
  ] as const;

  for (const fixture of cases) {
    test(`${fixture.runtime}: discovers declarations and distinguishes compatible from incompatible`, () => {
      const declarations = findRuntimeDeclarations([fixture.file], fixture.runtime);
      assert.ok(declarations.some((declaration) => declaration.requirement === fixture.expected));
      assert.ok(checkRuntimeCompatibility(fixture.runtime, declarations, fixture.requirement).some((result) => result.verdict !== 'compatible'));
      assert.ok(checkRuntimeCompatibility(fixture.runtime, declarations, fixture.compatibleRequirement).every((result) => result.verdict === 'compatible'));
    });
  }

  test('discovers static manifests, containers, and GitHub Actions declarations for every runtime', () => {
    const fixtures = [
      ['node', 'package.json', '{"engines":{"node":">=20"}}', '>=20'],
      ['python', 'setup.cfg', '[options]\npython_requires = >=3.10', '>=3.10'],
      ['python', '.github/workflows/ci.yml', 'python-version: "3.12"', '3.12'],
      ['ruby', 'Gemfile', "ruby '3.3.1'", '3.3.1'],
      ['ruby', 'demo.gemspec', "spec.required_ruby_version = '>= 3.2'", '>= 3.2'],
      ['ruby', 'Dockerfile', 'FROM ruby:3.3-slim', '3.3'],
      ['go', 'Dockerfile', 'FROM golang:1.24-alpine', '1.24'],
      ['go', '.github/workflows/ci.yml', 'go-version: "1.24"', '1.24'],
      ['java', 'pom.xml', '<maven.compiler.release>21</maven.compiler.release>', '21'],
      ['java', 'build.gradle.kts', 'languageVersion = JavaLanguageVersion.of(21)', '21'],
      ['java', '.github/workflows/ci.yml', 'java-version: "21"', '21'],
      ['rust', 'rust-toolchain.toml', '[toolchain]\nchannel = "1.84"', '1.84'],
      ['rust', 'Cargo.toml', '[package]\nrust-version = "1.81"', '1.81'],
      ['rust', 'Dockerfile', 'FROM rust:1.82-slim', '1.82'],
      ['rust', '.github/workflows/ci.yml', 'toolchain: "1.83"', '1.83'],
    ] as const;
    for (const [runtime, path, content, expected] of fixtures) {
      assert.ok(
        findRuntimeDeclarations([{ path, content }], runtime).some((declaration) => declaration.requirement === expected),
        `${runtime} ${path}`,
      );
    }
  });

  test('reuses container image recognition for GitLab and CircleCI YAML', () => {
    const fixtures = [
      ['node', '.gitlab-ci.yml', 'test:\n  image: node:18\n  script: npm test', '18'],
      ['python', '.circleci/config.yml', 'jobs:\n  test:\n    docker:\n      - image: cimg/python:3.11\n', '3.11'],
      ['java', '.gitlab-ci.yml', 'image: "eclipse-temurin:21-jdk"', '21'],
    ] as const;

    for (const [runtime, path, content, expected] of fixtures) {
      assert.deepEqual(findRuntimeDeclarations([{ path, content }], runtime), [
        { file: path, line: content.split('\n').findIndex((line) => line.includes('image:')) + 1, requirement: expected },
      ]);
    }
  });

  test("GitLab's map-form image (`image:` / `name:`) is recognized like the scalar form", () => {
    const content = 'test:\n  image:\n    name: node:18\n    entrypoint: [""]\n  script: npm test';
    assert.deepEqual(findRuntimeDeclarations([{ path: '.gitlab-ci.yml', content }], 'node'), [
      { file: '.gitlab-ci.yml', line: 3, requirement: '18' },
    ]);
  });

  test('a `services:` entry never becomes the job runtime image, in either scalar or map form', () => {
    const scalarService = 'test:\n  services:\n    - name: postgres:16\n  script: npm test';
    assert.deepEqual(findRuntimeDeclarations([{ path: '.gitlab-ci.yml', content: scalarService }], 'node'), []);

    // A bare `name:` job key (unrelated to any image) must not be mistaken for one either.
    const bareName = 'test:\n  name: build-job\n  script: npm test';
    assert.deepEqual(findRuntimeDeclarations([{ path: '.gitlab-ci.yml', content: bareName }], 'node'), []);
  });

  test('runtime ownership never crosses version files or .tool-versions keys', () => {
    const files = [
      { path: '.nvmrc', content: '18' },
      { path: '.ruby-version', content: '3.1' },
      { path: 'go.mod', content: 'go 1.22' },
      { path: '.tool-versions', content: 'nodejs 20\npython 3.11\nruby 3.3\ngolang 1.24\njava temurin-21\nrust 1.82' },
    ];
    assert.deepEqual(findRuntimeDeclarations(files, 'node').map((declaration) => declaration.file), ['.nvmrc', '.tool-versions']);
    assert.deepEqual(findRuntimeDeclarations(files, 'ruby').map((declaration) => declaration.file), ['.ruby-version', '.tool-versions']);
    assert.deepEqual(findRuntimeDeclarations(files, 'python').map((declaration) => declaration.file), ['.tool-versions']);
    assert.deepEqual(findRuntimeDeclarations(files, 'go').map((declaration) => declaration.file), ['go.mod', '.tool-versions']);
  });

  test('shared discovery preserves workspace ownership and repository-global CI', () => {
    const files = [
      { path: 'packages/api/.ruby-version', content: '3.3' },
      { path: 'packages/web/.ruby-version', content: '2.7' },
      { path: '.github/workflows/ci.yml', content: 'ruby-version: "3.2"' },
    ];
    assert.deepEqual(
      findRuntimeDeclarations(files, 'ruby', 'packages/api', ['', 'packages/api', 'packages/web']).map((declaration) => declaration.file),
      ['packages/api/.ruby-version', '.github/workflows/ci.yml'],
    );
  });

  test('root package manifests do not leak into sibling workspaces for any runtime', () => {
    const members = ['', 'packages/api'];
    const manifests = [
      ['ruby', 'Gemfile', "ruby '2.7'"],
      ['ruby', 'demo.gemspec', "spec.required_ruby_version = '>=2.7'"],
      ['go', 'go.mod', 'go 1.20'],
      ['java', 'pom.xml', '<maven.compiler.release>17</maven.compiler.release>'],
      ['java', 'build.gradle', 'sourceCompatibility = 17'],
      ['rust', 'Cargo.toml', '[package]\nrust-version = "1.70"'],
    ] as const;
    for (const [runtime, path, content] of manifests) {
      assert.deepEqual(findRuntimeDeclarations([{ path, content }], runtime, 'packages/api', members), [], `${runtime} ${path}`);
    }
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

  test('an installed version with no runtime requirement is still checked when the target introduces one (Node incompatible)', () => {
    // Regression: describeRuntimeChange() used to return immediately when
    // `before` was undefined, before ever calling checkNodeCompatibility --
    // so a newly-introduced floor was never verified against this
    // repository's own declaration, even when Drift had gathered one.
    const result = assessMaintenance({
      ...base,
      currentVersion: { ...version('unused', 'Node.js'), runtime: null },
      targetVersion: version('>=22', 'Node.js'),
      repoRuntime: [{ file: '.nvmrc', line: 1, requirement: '18.0.0' }],
    });
    const fact = result.facts.find((f) => /requires Node\.js/.test(f.statement));
    assert.equal(fact.concerning, true);
    assert.equal(fact.polarity, 'blocks');
    assert.match(fact.statement, /does not satisfy it: \.nvmrc/);
  });

  test('an installed version with no runtime requirement, target introduces a floor this repository already meets (Node compatible)', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: { ...version('unused', 'Node.js'), runtime: null },
      targetVersion: version('>=22', 'Node.js'),
      repoRuntime: [{ file: '.nvmrc', line: 1, requirement: '22.6.0' }],
    });
    const fact = result.facts.find((f) => /requires Node\.js/.test(f.statement));
    assert.equal(fact.concerning, false);
    assert.equal(fact.polarity, 'context');
    assert.match(fact.statement, /already satisfies it \(\.nvmrc\)/);
  });

  test('an installed version with no runtime requirement is checked when the target introduces one (Python incompatible)', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: { ...version('unused', 'Python'), runtime: null },
      targetVersion: version('>=3.11', 'Python'),
      pythonRuntime: [{ file: '.python-version', line: 1, requirement: '3.9' }],
    });
    const fact = result.facts.find((f) => /requires Python/.test(f.statement));
    assert.equal(fact.concerning, true);
    assert.equal(fact.polarity, 'blocks');
    assert.match(fact.statement, /does not satisfy it: \.python-version/);
  });

  test('an installed version with no runtime requirement, target introduces a Python floor this repository already meets', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: { ...version('unused', 'Python'), runtime: null },
      targetVersion: version('>=3.11', 'Python'),
      pythonRuntime: [{ file: '.python-version', line: 1, requirement: '3.11' }],
    });
    const fact = result.facts.find((f) => /requires Python/.test(f.statement));
    assert.equal(fact.concerning, false);
    assert.equal(fact.polarity, 'context');
  });

  test('runtime facts verified as incompatible or partial carry polarity blocks; verified-compatible and unverified do not', () => {
    const incompatible = assessMaintenance({
      ...base,
      currentVersion: version('^18.18.0 || ^20.9.0 || >=21.1.0'),
      targetVersion: version('^20.19.0 || ^22.13.0 || >=24'),
      repoRuntime: [{ file: '.nvmrc', line: 1, requirement: '18.18.0' }],
    }).facts.find((f) => /Node\.js version changed/.test(f.statement));
    assert.equal(incompatible.polarity, 'blocks');

    const partial = assessMaintenance({
      ...base,
      currentVersion: version('^18.18.0 || ^20.9.0 || >=21.1.0'),
      targetVersion: version('^20.19.0 || ^22.13.0 || >=24'),
      repoRuntime: [{ file: 'package.json', line: 1, requirement: '>=22.6.0' }],
    }).facts.find((f) => /Node\.js version changed/.test(f.statement));
    assert.equal(partial.polarity, 'blocks');

    const unverified = assessMaintenance({
      ...base,
      currentVersion: version('^18.18.0 || ^20.9.0 || >=21.1.0'),
      targetVersion: version('^20.19.0 || ^22.13.0 || >=24'),
    }).facts.find((f) => /Node\.js version changed/.test(f.statement));
    assert.equal(unverified.polarity, 'context');
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
