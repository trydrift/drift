import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNodeCompatibility,
  checkPythonCompatibility,
  checkRuntimeCompatibility,
  discoverRuntimeDeclarations,
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
      { file: 'packages/api/.nvmrc', line: 1, requirement: '20.19.0', scope: 'member' },
    ]);
  });

  test('a non-root member does not see a sibling member’s declaration', () => {
    const files = [{ path: 'packages/worker/.nvmrc', content: '18.0.0' }];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), []);
  });

  test('a non-root member sees an untargeted CI job as a repository-wide, authoritative declaration (#150)', () => {
    // `test:` names no member and carries no `working-directory`/`paths`
    // filter, so it checks out the whole repository and runs. Per #150 that
    // is a *repository* scope — it governs every member, including this one —
    // not the ambiguous non-verdict the old #123 model produced.
    const files = [
      {
        path: '.github/workflows/ci.yml',
        content: ['jobs:', '  test:', '    steps:', "      - uses: actions/setup-node@v5", '        with:', "          node-version: '22'"].join('\n'),
      },
    ];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: '.github/workflows/ci.yml', line: 6, requirement: '22', scope: 'repository' },
    ]);
    const discovery = discoverRuntimeDeclarations(files, 'node', 'packages/api', allMembers);
    assert.equal(discovery.resolved.length, 1);
    assert.deepEqual(discovery.unresolved, []);
  });

  test('a non-root member still sees a root-level declaration', () => {
    const files = [{ path: '.nvmrc', content: '22.6.0' }];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: '.nvmrc', line: 1, requirement: '22.6.0', scope: 'repository' },
    ]);
  });

  test("a member's own .nvmrc shadows the root's, the way nvm/asdf actually resolve one", () => {
    const files = [
      { path: '.nvmrc', content: '18' },
      { path: 'packages/api/.nvmrc', content: '20' },
    ];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: 'packages/api/.nvmrc', line: 1, requirement: '20', scope: 'member' },
    ]);
  });

  test("a member's own .tool-versions shadows the root's", () => {
    const files = [
      { path: '.tool-versions', content: 'nodejs 18' },
      { path: 'packages/api/.tool-versions', content: 'nodejs 20' },
    ];
    assert.deepEqual(findNodeDeclarations(files, 'packages/api', allMembers), [
      { file: 'packages/api/.tool-versions', line: 1, requirement: '20', scope: 'member' },
    ]);
  });

  test('a member’s own .nvmrc takes precedence over a repository-wide CI job (#150)', () => {
    // Precedence: member-specific > repository-wide. `packages/api/.nvmrc`
    // resolves; the untargeted repo-wide CI job (Node 18) is dropped for this
    // member because the member declares its own runtime.
    const files = [
      { path: 'packages/api/.nvmrc', content: '20' },
      { path: '.github/workflows/ci.yml', content: 'jobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n' + "          node-version: '18'" },
    ];
    const discovery = discoverRuntimeDeclarations(files, 'node', 'packages/api', allMembers);
    assert.deepEqual(discovery.resolved, [
      { file: 'packages/api/.nvmrc', line: 1, requirement: '20', scope: 'member' },
    ]);
    assert.deepEqual(discovery.unresolved, []);
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
      { file: '.nvmrc', line: 1, requirement: '22.6.0', scope: 'member' },
    ]);
  });

  test('the root workspace sees an unattributed CI workflow as evidence, not a resolved pin, in a real monorepo (#123)', () => {
    const files = [
      { path: '.github/workflows/ci.yml', content: "          node-version: '22'" },
    ];
    assert.deepEqual(findNodeDeclarations(files, '', allMembers), []);
    const discovery = discoverRuntimeDeclarations(files, 'node', '', allMembers);
    assert.equal(discovery.unresolved.length, 1);
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
      { file: 'package.json', line: 1, requirement: '>=18', scope: 'member' },
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
      { file: '.nvmrc', line: 1, requirement: '18.18.0', scope: 'repository' },
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

describe('#123: CI runtime declarations are attributed to the job that owns a workspace', () => {
  const allMembers = ['', 'packages/api', 'packages/web'];
  // Normal top-level GitHub Actions indentation: `jobs:` at column 0, job keys
  // at two spaces, each job scoped to its package via
  // defaults.run.working-directory.
  const workflow = [
    'name: CI',
    'on: [push]',
    'jobs:',
    '  api:',
    '    runs-on: ubuntu-latest',
    '    defaults:',
    '      run:',
    '        working-directory: packages/api',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    '',
    '  web:',
    '    runs-on: ubuntu-latest',
    '    defaults:',
    '      run:',
    '        working-directory: packages/web',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 18',
  ].join('\n');
  const files = [{ path: '.github/workflows/ci.yml', content: workflow }];

  test('packages/api sees Node 22 and not Node 18', () => {
    const declarations = findNodeDeclarations(files, 'packages/api', allMembers);
    const versions = declarations.map((d) => d.requirement);
    assert.deepEqual(versions, ['22']);
    assert.ok(!versions.includes('18'), 'the web job must not contaminate the api workspace');
  });

  test('packages/web sees Node 18 and not Node 22', () => {
    const declarations = findNodeDeclarations(files, 'packages/web', allMembers);
    const versions = declarations.map((d) => d.requirement);
    assert.deepEqual(versions, ['18']);
    assert.ok(!versions.includes('22'), 'the api job must not contaminate the web workspace');
  });

  test('a job with no workspace selector is repository-wide: it governs every member (#150)', () => {
    // A `.github/workflows` job with no `working-directory`/`paths` filter
    // checks out and runs against the whole repository, so per #150 it is a
    // repository-scoped, authoritative declaration for every member. (A job
    // that is really one package's is expected to say so with a selector —
    // the api/web tests above cover that.)
    const global = [
      'jobs:',
      '  lint:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 20',
    ].join('\n');
    const lintFile = [{ path: '.github/workflows/lint.yml', content: global }];
    assert.deepEqual(findNodeDeclarations(lintFile, 'packages/api', allMembers), [
      { file: '.github/workflows/lint.yml', line: 7, requirement: '20', scope: 'repository' },
    ]);
    const discovery = discoverRuntimeDeclarations(lintFile, 'node', 'packages/api', allMembers);
    assert.equal(discovery.resolved.length, 1);
    assert.deepEqual(discovery.unresolved, []);
  });

  test('a job with no workspace selector at all is repository-wide when there is no sibling it could instead belong to', () => {
    const global = [
      'jobs:',
      '  lint:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 20',
    ].join('\n');
    const lintFile = [{ path: '.github/workflows/lint.yml', content: global }];
    // Single-package repository: no workspace context at all.
    assert.deepEqual(findNodeDeclarations(lintFile).map((d) => d.requirement), ['20']);
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

  test('a computed python_requires in setup.py remains an unresolved declaration', () => {
    const files = [{ path: 'setup.py', content: 'setup(python_requires=MIN_PYTHON)' }];
    assert.deepEqual(findPythonDeclarations(files), []);
    const discovery = discoverRuntimeDeclarations(files, 'python');
    assert.equal(discovery.unresolved.length, 1);
    assert.equal(discovery.unresolved[0]?.rawText, 'MIN_PYTHON');
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
      // #137: a bare <java.version> is convention-level evidence, not an
      // authoritative pin — see the dedicated "#137" describe block for that
      // distinction. Toolchain-provisioning it here keeps this test's own
      // purpose (declaration discovery works across every manifest surface)
      // unaffected by that change.
      [
        'java',
        'pom.xml',
        '<project><properties><java.version>21</java.version></properties><build><plugins>' +
          '<plugin><artifactId>maven-toolchains-plugin</artifactId><configuration><toolchains><jdk><version>${java.version}</version></jdk></toolchains></configuration></plugin>' +
          '</plugins></build></project>',
        '21',
      ],
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

  test('Java bytecode targets are not mistaken for the runtime JVM', () => {
    assert.deepEqual(
      findRuntimeDeclarations([{ path: 'pom.xml', content: '<maven.compiler.release>8</maven.compiler.release>' }], 'java'),
      [],
    );
    assert.deepEqual(
      findRuntimeDeclarations([{ path: 'build.gradle', content: 'sourceCompatibility = 8\ntargetCompatibility = 8' }], 'java'),
      [],
    );
  });

  test('reuses container image recognition for GitLab and CircleCI YAML', () => {
    const fixtures = [
      ['node', '.gitlab-ci.yml', 'test:\n  image: node:18\n  script: npm test', '18'],
      ['python', '.circleci/config.yml', 'jobs:\n  test:\n    docker:\n      - image: cimg/python:3.11\n', '3.11'],
      ['java', '.gitlab-ci.yml', 'image: "eclipse-temurin:21-jdk"', '21'],
    ] as const;

    for (const [runtime, path, content, expected] of fixtures) {
      assert.deepEqual(findRuntimeDeclarations([{ path, content }], runtime), [
        {
          file: path,
          line: content.split('\n').findIndex((line) => line.includes('image:')) + 1,
          requirement: expected,
          scope: 'repository',
        },
      ]);
    }
  });

  test("GitLab's map-form image (`image:` / `name:`) is recognized like the scalar form", () => {
    const content = 'test:\n  image:\n    name: node:18\n    entrypoint: [""]\n  script: npm test';
    assert.deepEqual(findRuntimeDeclarations([{ path: '.gitlab-ci.yml', content }], 'node'), [
      { file: '.gitlab-ci.yml', line: 3, requirement: '18', scope: 'repository' },
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

  test('runtime-specific manifest positions never disappear when their values are computed', () => {
    const fixtures = [
      ['node', 'package.json', '{"engines":{"node":42}}'],
      ['python', 'setup.py', 'setup(python_requires=MIN_PYTHON)'],
      ['ruby', 'Gemfile', 'ruby RUBY_VERSION'],
      ['ruby', 'demo.gemspec', 'spec.required_ruby_version = RUBY_VERSION'],
    ] as const;
    for (const [runtime, path, content] of fixtures) {
      const discovery = discoverRuntimeDeclarations([{ path, content }], runtime);
      assert.deepEqual(discovery.resolved, [], `${runtime} ${path}`);
      assert.equal(discovery.unresolved.length, 1, `${runtime} ${path}`);
    }
  });

  test('shared discovery preserves workspace ownership; a sibling’s pin never crosses over (#123)', () => {
    const files = [
      { path: 'packages/api/.ruby-version', content: '3.3' },
      { path: 'packages/web/.ruby-version', content: '2.7' },
      { path: '.github/workflows/ci.yml', content: 'ruby-version: "3.2"' },
    ];
    const members = ['', 'packages/api', 'packages/web'];
    assert.deepEqual(
      findRuntimeDeclarations(files, 'ruby', 'packages/api', members).map((declaration) => declaration.file),
      ['packages/api/.ruby-version'],
    );
    // #160 precedence: `packages/api` has its own member-scoped pin, so the
    // unattributable (ambiguous) CI line is outranked and does not drag the
    // member's authoritative result to `unknown`.
    const discovery = discoverRuntimeDeclarations(files, 'ruby', 'packages/api', members);
    assert.deepEqual(
      discovery.resolved.map((d) => d.file),
      ['packages/api/.ruby-version'],
    );
    assert.deepEqual(discovery.unresolved, []);
  });

  test('with no member-specific pin, an ambiguous CI declaration still governs and stays unknown (#123)', () => {
    const files = [
      { path: 'packages/api/.ruby-version', content: '3.3' },
      { path: 'packages/web/.ruby-version', content: '2.7' },
      { path: '.github/workflows/ci.yml', content: 'ruby-version: "3.2"' },
    ];
    const members = ['', 'packages/api', 'packages/web'];
    // The root workspace declares no Ruby version of its own; the only thing
    // left is the unattributable CI line, which must remain unresolved.
    const discovery = discoverRuntimeDeclarations(files, 'ruby', '', members);
    assert.deepEqual(discovery.resolved, []);
    assert.equal(discovery.unresolved.length, 1);
    assert.equal(discovery.unresolved[0].file, '.github/workflows/ci.yml');
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

  test('a declaration this cannot parse as a range comes back unknown, not misjudged and not dropped', () => {
    // Dropping it (which this used to do) makes an unreadable declaration
    // indistinguishable from a repository that never wrote one — and the
    // caller then reads the resulting empty list as compatibility.
    assert.deepEqual(
      checkNodeCompatibility([{ file: 'Dockerfile', line: 1, requirement: 'lts' }], '>=22.13.0'),
      [{ file: 'Dockerfile', line: 1, requirement: 'lts', verdict: 'unknown' }],
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

describe('the runtime-requirement maintenance fact (#110: states the upstream fact only)', () => {
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

  // Maintenance no longer runs its own Node/Python compatibility check. It
  // states the upstream fact as plain context; the repository verdict —
  // satisfied, violated, partial, unknown, and whether it blocks — belongs to
  // the canonical RuntimeRequirementAnalysis that every runtime metadata bump
  // now flows through.

  test('a changed floor is stated as context, never a repository verdict', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=14'),
      targetVersion: version('>=18'),
    });
    const fact = result.facts.find((f) => /Node\.js version changed/.test(f.statement));
    assert.ok(fact);
    assert.equal(fact.statement, 'The required Node.js version changed from >=14 to >=18.');
    assert.equal(fact.polarity, 'context');
    assert.equal(fact.concerning, false);
    assert.doesNotMatch(fact.statement, /satisfies it|does not satisfy|Check this against/);
  });

  test('an introduced floor is stated as "The target version requires ..."', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: { ...version('unused', 'Node.js'), runtime: null },
      targetVersion: version('>=22', 'Node.js'),
    });
    const fact = result.facts.find((f) => /requires Node\.js/.test(f.statement));
    assert.ok(fact);
    assert.equal(fact.statement, 'The target version requires Node.js >=22.');
    assert.equal(fact.polarity, 'context');
    assert.equal(fact.concerning, false);
  });

  test('the repository declaration is never consulted, whatever it says', () => {
    const shortfall = assessMaintenance({
      ...base,
      currentVersion: version('>=14'),
      targetVersion: version('>=22'),
      repoRuntime: [{ file: '.nvmrc', line: 1, requirement: '18.0.0' }],
    });
    const clears = assessMaintenance({
      ...base,
      currentVersion: version('>=14'),
      targetVersion: version('>=22'),
      repoRuntime: [{ file: '.nvmrc', line: 1, requirement: '24.0.0' }],
    });
    for (const result of [shortfall, clears]) {
      const fact = result.facts.find((f) => /Node\.js version changed/.test(f.statement));
      assert.ok(fact);
      assert.equal(fact.polarity, 'context');
      assert.equal(fact.concerning, false);
      assert.doesNotMatch(fact.statement, /\.nvmrc|satisfies|does not satisfy|Check this/);
    }
  });

  test('an unchanged floor produces no fact', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=18'),
      targetVersion: version('>=18'),
    });
    assert.equal(result.facts.some((f) => /Node\.js/.test(f.statement)), false);
  });

  test('a non-Node runtime bump is stated the same plain way', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=1.20', 'Go'),
      targetVersion: version('>=1.23', 'Go'),
      repoRuntime: [{ file: 'package.json', line: 1, requirement: '>=22.13.0' }],
    });
    const fact = result.facts.find((f) => /Go version changed/.test(f.statement));
    assert.ok(fact);
    assert.equal(fact.statement, 'The required Go version changed from >=1.20 to >=1.23.');
    assert.equal(fact.polarity, 'context');
  });

  test('a Python bump is stated as context, not checked against declarations', () => {
    const result = assessMaintenance({
      ...base,
      currentVersion: version('>=3.6', 'Python'),
      targetVersion: version('>=3.9', 'Python'),
      pythonRuntime: [{ file: '.python-version', line: 1, requirement: '3.6' }],
    });
    const fact = result.facts.find((f) => /Python version changed/.test(f.statement));
    assert.ok(fact);
    assert.equal(fact.polarity, 'context');
    assert.equal(fact.concerning, false);
    assert.doesNotMatch(fact.statement, /\.python-version|satisfies|does not satisfy|Check this/);
  });
});
