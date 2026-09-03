/**
 * The runtime compatibility state machine, tested one layer at a time.
 *
 * End-to-end coverage alone is what let the old model survive: every layer
 * agreed that zero impact sites meant "fine", so an end-to-end assertion of
 * "no sites" passed while the answer being reported was wrong. Each layer is
 * therefore pinned separately here — prose parsing, declaration discovery,
 * compatibility state, localization, assessment, and severity — so a
 * regression names the layer that broke rather than the whole pipeline.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchProse, normalizeRuntimeOperator, RUNTIME_RANGE_GRAMMARS } from '../dist/analyze/index.js';
import { raisedRuntimeFloor } from '../dist/evidence/index.js';
import {
  checkRuntimeCompatibility,
  checkUnsupportedRuntimeRange,
  discoverRuntimeDeclarations,
  identifyRuntimeImage,
} from '../dist/rationale/runtime.js';
import { analyzeRuntimeRequirement, worstRuntimeState } from '../dist/rationale/compatibility.js';
import { assessUpgrade } from '../dist/rationale/assess.js';
import { severityOf, describeSeverity } from '../dist/upgrade/severity.js';
import { localizeWithRuntime } from '../dist/localize/index.js';
import { buildIndex } from '../dist/index/metarag.js';
import { createLogger } from '../dist/util/logger.js';
import { validateRuntimeCompatibilityState } from '../site/scripts/runtime-recording-validation.mjs';

const logger = createLogger('error');

function files(entries: Record<string, string>) {
  return Object.entries(entries).map(([path, content]) => ({ path, content }));
}

function sourceFiles(entries: Record<string, string>) {
  return Object.entries(entries).map(([path, content]) => ({
    path,
    language: 'config' as never,
    content,
    lineCount: content.split('\n').length,
  }));
}

function runtimeChange(runtime: string, requirement: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'runtime-change',
    dependency: 'pkg',
    kind: 'runtime-requirement' as const,
    summary: `requires ${runtime} ${requirement}`,
    remediation: 'update the declared runtime',
    symbols: [runtime],
    confidence: 'high' as const,
    citations: ['evidence'],
    runtime: { kind: 'minimum-runtime', runtime, requirement, sourceText: `${runtime} ${requirement}`, ...extra },
  } as never;
}

const baseAssessment = {
  dependency: 'pkg',
  evidence: [] as never,
  security: { checked: false, current: [], target: [], resolved: [], introduced: [], carried: [], direction: 'unknown' as const },
  maintenance: { facts: [] },
  license: { verdict: 'ok' as const, statement: 'ok', introduced: [] },
  gaps: [] as never,
  surfaceCompared: true,
};

const baseCandidate = {
  status: 'ready',
  breakingCount: 1,
  impactCount: 0,
  impactFiles: 0,
};

describe('runtime prose: every operator form the grammar accepts survives', () => {
  const dropped = (text: string) =>
    matchProse(text).find((match) => match.kind === 'runtime-requirement')?.runtime;

  test('a bare version becomes the version line it names', () => {
    assert.equal(dropped('Dropped support for Node 16')?.kind, 'unsupported-runtime-range');
    assert.equal(dropped('Dropped support for Node 16')?.requirement, '16.x');
  });

  test('">=" is preserved as the unsupported range it states, with no invented floor', () => {
    const range = dropped('Dropped support for Node >=20');
    assert.equal(range?.kind, 'unsupported-runtime-range');
    assert.equal(range?.requirement, '>=20');
    assert.equal(range && 'derivedMinimum' in range ? range.derivedMinimum : undefined, undefined);
  });

  test('">" is preserved the same way', () => {
    assert.equal(dropped('Dropped support for Node >20')?.requirement, '>20');
  });

  test('"=" and "==" normalize to one documented equality form', () => {
    assert.equal(dropped('Dropped support for Node =20')?.requirement, '=20');
    assert.equal(dropped('Dropped support for Node ==20')?.requirement, '=20');
  });

  test('Python equality normalizes to valid PEP 440 syntax', () => {
    assert.equal(dropped('Dropped support for Python ==3.10')?.requirement, '==3.10');
    assert.equal(dropped('Dropped support for Python =3.10')?.requirement, '==3.10');
    const required = matchProse('Requires Python ==3.10').find((match) => match.runtime)?.runtime;
    assert.equal(required?.requirement, '==3.10');
    assert.equal(required?.rangeParseStatus, undefined);
  });

  test('"<" and "<=" keep their exact complements as derived floors', () => {
    const lt = dropped('Dropped support for Node <18');
    assert.equal(lt?.requirement, '<18');
    assert.equal(lt && 'derivedMinimum' in lt ? lt.derivedMinimum : undefined, '>=18');
    const lte = dropped('Dropped support for Node <=16');
    assert.equal(lte && 'derivedMinimum' in lte ? lte.derivedMinimum : undefined, '>16');
  });

  test('caret and tilde stay parsed only for ecosystems Drift intentionally models', () => {
    for (const text of ['Dropped support for Node ^16', 'Dropped support for Rust ~1.75']) {
      assert.equal(dropped(text)?.rangeParseStatus, undefined, text);
    }
    for (const text of ['Dropped support for Ruby ^3.0', 'Dropped support for Ruby ~3.0', 'Dropped support for Ruby ~>3.0']) {
      assert.equal(dropped(text)?.rangeParseStatus, 'unknown', text);
    }
  });

  test('a caret against Python is flagged unparsed rather than fed to PEP 440', () => {
    // PEP 440 has no caret operator at all, and a bare `~` is not its
    // compatible-release operator (`~=` is). Evaluating these anyway produced
    // an imprecise interval that intersected almost anything, and therefore a
    // confident-looking "partial" nobody computed.
    for (const text of ['Dropped support for Python ^3.10', 'Dropped support for Python ~3.10']) {
      const range = dropped(text);
      assert.equal(range?.kind, 'unsupported-runtime-range', text);
      assert.equal(range?.rangeParseStatus, 'unknown', text);
    }
  });

  test('an unparseable upstream range yields unknown compatibility, never a partial', () => {
    const range = dropped('Dropped support for Python ^3.10')!;
    const analysis = analyzeRuntimeRequirement(
      { ...(runtimeChange('python', '^3.10') as never), runtime: range },
      files({ '.python-version': '3.12\n' }),
    );
    assert.equal(analysis?.state, 'unknown');
    assert.equal(analysis?.reason, 'unparseable');
    assert.deepEqual(analysis?.sites, []);
  });
});

describe('runtime range grammar is ecosystem-specific executable documentation', () => {
  const operators = ['', '<', '<=', '>', '>=', '=', '==', '^', '~'] as const;
  const caretAndTilde = new Set(['^', '~']);
  const runtimes = ['node', 'python', 'ruby', 'go', 'java', 'rust'] as const;

  for (const runtime of runtimes) {
    test(`${runtime}: every captured operator has an explicit result`, () => {
      assert.equal(RUNTIME_RANGE_GRAMMARS[runtime].runtime, runtime);
      for (const operator of operators) {
        const expected = caretAndTilde.has(operator) && !['node', 'rust'].includes(runtime) ? 'unknown' : 'parsed';
        assert.equal(normalizeRuntimeOperator(runtime, operator).status, expected, `${runtime} ${operator || 'bare'}`);
      }
    });
  }

  test('RubyGems pessimistic syntax stays unknown until its semantics are implemented', () => {
    assert.deepEqual(normalizeRuntimeOperator('ruby', '~>'), { status: 'unknown', operator: '~>' });
  });

  test('Python compatible-release syntax is modeled, but bare tilde is not', () => {
    assert.deepEqual(normalizeRuntimeOperator('python', '~='), { status: 'parsed', operator: '~=' });
    const range = matchProse('Requires Python ~=3.10').find((match) => match.runtime)?.runtime;
    assert.equal(range?.requirement, '~=3.10');
    assert.equal(range?.rangeParseStatus, undefined);
  });
});

describe('runtime declaration discovery: identity before unresolvability', () => {
  test('a generic dynamic CI image is not a declaration of any runtime', () => {
    const repo = files({
      '.gitlab-ci.yml': 'default:\n  image: $DEFAULT_CI_IMAGE\n',
    });
    for (const runtime of ['node', 'python', 'ruby', 'go', 'java', 'rust'] as const) {
      const found = discoverRuntimeDeclarations(repo, runtime);
      assert.deepEqual(found.resolved, [], runtime);
      assert.deepEqual(found.unresolved, [], `${runtime}: a generic image names no runtime at all`);
    }
  });

  test('a runtime-specific CI image with a dynamic tag is unresolved for that runtime only', () => {
    const repo = files({ '.gitlab-ci.yml': 'default:\n  image: node:${NODE_VERSION}\n' });
    assert.equal(discoverRuntimeDeclarations(repo, 'node').unresolved.length, 1);
    assert.equal(discoverRuntimeDeclarations(repo, 'node').unresolved[0]?.source, 'ci');
    assert.deepEqual(discoverRuntimeDeclarations(repo, 'ruby').unresolved, []);
  });

  test('a CI field whose name identifies the runtime is unresolved when its value is dynamic', () => {
    const repo = files({
      '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n',
    });
    const found = discoverRuntimeDeclarations(repo, 'node');
    assert.deepEqual(found.resolved, []);
    assert.equal(found.unresolved.length, 1);
    assert.equal(found.unresolved[0]?.runtime, 'node');
    assert.deepEqual(discoverRuntimeDeclarations(repo, 'python').unresolved, []);
  });

  test('CI runtime fields are YAML keys, not comments or script substrings', () => {
    const repo = files({
      '.github/workflows/ci.yml': [
        '# node-version: 16',
        'run: echo "node-version: 16"',
        'with:',
        '  node-version: 20',
      ].join('\n'),
      '.gitlab-ci.yml': [
        '# ruby-version: 2.7',
        'script:',
        '  - echo "ruby-version: 3.0"',
        'ruby-version: $RUBY_VERSION',
      ].join('\n'),
    });
    const node = discoverRuntimeDeclarations(repo, 'node');
    assert.deepEqual(node.resolved.map((d) => d.requirement), ['20']);
    assert.deepEqual(node.unresolved, []);
    const ruby = discoverRuntimeDeclarations(repo, 'ruby');
    assert.deepEqual(ruby.resolved, []);
    assert.equal(ruby.unresolved.length, 1);
    assert.equal(ruby.unresolved[0]?.line, 4);
  });

  test('YAML block scalar contents cannot impersonate runtime keys or images', () => {
    const repo = files({
      '.github/workflows/ci.yml': [
        'jobs:',
        '  test:',
        '    steps:',
        '      - run: |',
        '          node-version: 16',
        '          image: node:16',
        '      - run: >-',
        '          echo "python-version: 3.10"',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 20',
      ].join('\n'),
      '.gitlab-ci.yml': ['script:', '  - |', '    ruby-version: 3.0', 'image: ruby:3.3'].join('\n'),
    });

    const node = discoverRuntimeDeclarations(repo, 'node');
    assert.deepEqual(node.resolved.map((declaration) => declaration.requirement), ['20']);
    assert.equal(node.unresolved.length, 0);

    const python = discoverRuntimeDeclarations(repo, 'python');
    assert.equal(python.resolved.length, 0);
    assert.equal(python.unresolved.length, 0);

    const ruby = discoverRuntimeDeclarations(repo, 'ruby');
    assert.deepEqual(ruby.resolved.map((declaration) => declaration.requirement), ['3.3']);
    assert.equal(ruby.unresolved.length, 0);
  });

  test('a Dockerfile runtime image with a dynamic tag is unresolved; a generic base image is nothing', () => {
    const specific = discoverRuntimeDeclarations(files({ Dockerfile: 'FROM node:${NODE_VERSION}\n' }), 'node');
    assert.equal(specific.unresolved.length, 1);
    assert.equal(specific.unresolved[0]?.source, 'container');

    const generic = discoverRuntimeDeclarations(files({ Dockerfile: 'FROM $BASE_IMAGE\n' }), 'node');
    assert.deepEqual(generic.resolved, []);
    assert.deepEqual(generic.unresolved, []);
  });

  test('runtime image identity does not require a literal tag', () => {
    assert.deepEqual(identifyRuntimeImage('node:20'), { runtime: 'node', version: '20' });
    assert.deepEqual(identifyRuntimeImage('node'), { runtime: 'node' });
    assert.deepEqual(identifyRuntimeImage('node@sha256:deadbeef'), { runtime: 'node' });
    assert.equal(identifyRuntimeImage('$BASE_IMAGE'), null);

    for (const content of ['FROM node', 'FROM node@sha256:deadbeef']) {
      const found = discoverRuntimeDeclarations(files({ Dockerfile: `${content}\n` }), 'node');
      assert.deepEqual(found.resolved, []);
      assert.equal(found.unresolved.length, 1, content);
    }
    for (const content of ['image: node', 'image: node@sha256:deadbeef']) {
      const found = discoverRuntimeDeclarations(files({ '.circleci/config.yml': `${content}\n` }), 'node');
      assert.deepEqual(found.resolved, []);
      assert.equal(found.unresolved.length, 1, content);
    }
  });

  test('a dynamic package.json engines value is an unresolved Node declaration', () => {
    const found = discoverRuntimeDeclarations(
      files({ 'package.json': '{"engines":{"node":"${NODE_VERSION}"}}' }),
      'node',
    );
    assert.deepEqual(found.resolved, []);
    assert.equal(found.unresolved.length, 1);
    assert.equal(found.unresolved[0]?.source, 'manifest');
  });

  test('Maven property indirection reads the property value, but a bare java.version is surfaced unresolved, not resolved (#137)', () => {
    // `resolveMavenProperty` still substitutes `${java.version}` correctly —
    // that machinery is unchanged. What #137 changes is what happens to the
    // *result*: without a toolchain plugin tying it to the actual build JDK,
    // `<java.version>` is convention-level evidence, not an authoritative
    // pin, so it is recorded unresolved rather than resolved. See the
    // "#137: Java runtime authority vs compiler bytecode target" suite for
    // the toolchain-provisioned case, where it does resolve.
    const found = discoverRuntimeDeclarations(
      files({ 'pom.xml': '<project><properties><java.version>17</java.version></properties><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${java.version}</release></configuration></plugin></plugins></build></project>' }),
      'java',
    );
    assert.deepEqual(found.resolved, []);
    assert.equal(found.unresolved.length, 1);
    assert.equal(found.unresolved[0]?.rawText, '17');
  });

  test('#137: an unresolved compiler release/source/target is never an authoritative unresolved runtime', () => {
    // `<release>${java.version}</release>` with no `java.version` property here
    // describes emitted bytecode, not the JVM. It must not enter
    // `unresolved` — that set forces `stateOf` to `unknown` and would let
    // compiler-target uncertainty override an authoritative runtime pin.
    const inherited = discoverRuntimeDeclarations(
      files({ 'pom.xml': '<project><properties><foo>1</foo></properties><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${java.version}</release></configuration></plugin></plugins></build></project>' }),
      'java',
    );
    assert.deepEqual(inherited.resolved, []);
    assert.deepEqual(inherited.unresolved, []);

    // A toolchain-provisioned <java.version> (authoritative — see #137) that
    // resolves is unaffected by an unresolved compiler-target property
    // alongside it.
    const withAuthoritative = discoverRuntimeDeclarations(
      files({
        'pom.xml':
          '<project><properties><java.version>17</java.version></properties><build><plugins>' +
          '<plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${unset.prop}</release></configuration></plugin>' +
          '<plugin><artifactId>maven-toolchains-plugin</artifactId><configuration><toolchains><jdk><version>${java.version}</version></jdk></toolchains></configuration></plugin>' +
          '</plugins></build></project>',
      }),
      'java',
    );
    assert.deepEqual(withAuthoritative.unresolved, []);
    assert.deepEqual(withAuthoritative.resolved.map((d) => d.requirement), ['17']);
  });

  test('a dynamic Gradle toolchain version is an unresolved Java declaration', () => {
    const found = discoverRuntimeDeclarations(
      files({ 'build.gradle.kts': 'java {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(javaVersion)\n  }\n}\n' }),
      'java',
    );
    assert.deepEqual(found.resolved, []);
    assert.equal(found.unresolved.length, 1);
    assert.equal(found.unresolved[0]?.source, 'build-config');
  });

  test('a .tool-versions entry is unresolved by its recognized key, and an unrelated tool is nothing', () => {
    const found = discoverRuntimeDeclarations(
      files({ '.tool-versions': 'nodejs $NODE_VERSION\ngitleaks $GITLEAKS_VERSION\n' }),
      'node',
    );
    assert.equal(found.unresolved.length, 1);
    assert.equal(found.unresolved[0]?.source, 'tool-versions');
    assert.equal(found.unresolved[0]?.rawText, '$NODE_VERSION');
  });

  test('static declarations still resolve, unchanged', () => {
    const found = discoverRuntimeDeclarations(files({ '.nvmrc': '22.12.0\n' }), 'node');
    assert.deepEqual(found.resolved, [{ file: '.nvmrc', line: 1, requirement: '22.12.0' }]);
    assert.deepEqual(found.unresolved, []);
  });

  test('workspace precedence still shadows a root version file', () => {
    const repo = files({
      '.nvmrc': '18\n',
      'packages/api/.nvmrc': '22\n',
    });
    const found = discoverRuntimeDeclarations(repo, 'node', 'packages/api', ['packages/api', 'packages/web']);
    assert.deepEqual(found.resolved, [
      { file: 'packages/api/.nvmrc', line: 1, requirement: '22', scope: 'member' },
    ]);
  });
});

/**
 * #123: a root CI runtime pin is not automatically authoritative for every
 * workspace member. `ciJobLinesForMember` attributes each CI job to the
 * member(s) it demonstrably targets — `working-directory`, `paths`,
 * `paths-ignore` (same line or an indented multiline list), or a `run`
 * command — and a job that names no member at all is repository-wide
 * (unambiguous) only in a single-package repository. In a real monorepo, an
 * unattributed job's declaration is recorded *unresolved*: real evidence,
 * but never enough by itself to decide `compatible`/`incompatible` for a
 * member it may not even govern.
 */
describe('#123: CI runtime declarations are attributed to the job that owns a member', () => {
  const monorepo = ['packages/api', 'packages/web'];

  const ciWithScopedJobs = (extra = '') => `
jobs:
  web:
    defaults:
      run:
        working-directory: packages/web
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 18
  api:
    defaults:
      run:
        working-directory: packages/api
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${extra}`;

  test('working-directory: a job scoped to the target member participates', () => {
    const repo = files({ '.github/workflows/ci.yml': ciWithScopedJobs() });
    const found = discoverRuntimeDeclarations(repo, 'node', 'packages/api', monorepo);
    assert.deepEqual(found.resolved, [
      { file: '.github/workflows/ci.yml', line: 18, requirement: '22', scope: 'member' },
    ]);
  });

  test('sibling member exclusion: a job scoped to a different member never contributes a site', () => {
    const repo = files({ '.github/workflows/ci.yml': ciWithScopedJobs() });
    const found = discoverRuntimeDeclarations(repo, 'node', 'packages/api', monorepo);
    assert.ok(!found.resolved.some((d) => d.requirement === '18'));
    assert.ok(!found.unresolved.some((d) => d.rawText === '18'));
  });

  test('target-member inclusion: the concrete #123 regression — API Node 22 participates, web Node 18 never taints it', () => {
    const repo = files({
      'packages/api/.nvmrc': '22\n',
      'packages/web/.nvmrc': '18\n',
      '.github/workflows/ci.yml': ciWithScopedJobs(),
    });
    const apiAnalysis = analyzeRuntimeRequirement(runtimeChange('node', '>=20'), repo, 'packages/api', monorepo);
    assert.equal(apiAnalysis?.state, 'compatible');
    assert.ok(apiAnalysis?.declarations.every((d) => d.requirement !== '18'));
  });

  test('multiline paths: a member path on its own indented list line under `paths:` still scopes the job', () => {
    const repo = files({
      '.github/workflows/ci.yml': `
jobs:
  api:
    if: something
    paths:
      - packages/api/**
      - shared/**
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
`,
    });
    const api = discoverRuntimeDeclarations(repo, 'node', 'packages/api', monorepo);
    assert.deepEqual(api.resolved, [
      { file: '.github/workflows/ci.yml', line: 11, requirement: '22', scope: 'member' },
    ]);
    const web = discoverRuntimeDeclarations(repo, 'node', 'packages/web', monorepo);
    assert.equal(web.resolved.length, 0);
    assert.equal(web.unresolved.length, 0);
  });

  test('paths-ignore: naming a member excludes that job for that member, not the reverse', () => {
    const repo = files({
      '.github/workflows/ci.yml': `
jobs:
  docs:
    paths-ignore:
      - 'packages/api/**'
      - 'docs/**'
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 16
`,
    });
    const api = discoverRuntimeDeclarations(repo, 'node', 'packages/api', monorepo);
    assert.equal(api.resolved.length, 0);
    assert.equal(api.unresolved.length, 0);
  });

  test('repository-wide precedence: a member’s own .nvmrc overrides an untargeted repo job (#150)', () => {
    const repo = files({
      'packages/api/.nvmrc': '22\n',
      'packages/web/.nvmrc': '18\n',
      '.github/workflows/ci.yml': ciWithScopedJobs(`  lint:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 16
`),
    });
    const found = discoverRuntimeDeclarations(repo, 'node', 'packages/api', monorepo);
    // The repo-wide `lint` job's Node 16 is dropped: packages/api declares its
    // own runtime (.nvmrc 22), which takes precedence.
    assert.ok(!found.resolved.some((d) => d.requirement === '16'));
    assert.ok(!found.unresolved.some((d) => d.rawText === '16'));

    const analysis = analyzeRuntimeRequirement(runtimeChange('node', '>=20'), repo, 'packages/api', monorepo);
    assert.equal(analysis?.state, 'compatible');
  });

  test('a repo-wide job governs a member that has no runtime declaration of its own (#150)', () => {
    const repo = files({
      '.github/workflows/lint.yml': `jobs:
  lint:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 16
`,
    });
    const found = discoverRuntimeDeclarations(repo, 'node', 'packages/api', monorepo);
    assert.deepEqual(
      found.resolved.map((d) => ({ requirement: d.requirement, scope: d.scope })).filter((d) => d.requirement === '16'),
      [{ requirement: '16', scope: 'repository' }],
    );
    const analysis = analyzeRuntimeRequirement(runtimeChange('node', '>=20'), repo, 'packages/api', monorepo);
    assert.equal(analysis?.state, 'incompatible');
  });

  test('normal repository/root package behavior: a single-package repo keeps unscoped CI authoritative', () => {
    const repo = files({
      '.github/workflows/ci.yml': `
jobs:
  build:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
`,
    });
    assert.deepEqual(discoverRuntimeDeclarations(repo, 'node').resolved, [
      { file: '.github/workflows/ci.yml', line: 7, requirement: '20', scope: 'repository' },
    ]);
    // A caller that names a member but reports no siblings is the same case:
    // there is no other member the declaration could instead belong to.
    assert.deepEqual(discoverRuntimeDeclarations(repo, 'node', 'packages/api', ['packages/api']).resolved, [
      { file: '.github/workflows/ci.yml', line: 7, requirement: '20', scope: 'repository' },
    ]);
  });

  test('GitLab-style top-level jobs (no `jobs:` key): unattributed in a monorepo, still authoritative for a single package', () => {
    // GitLab CI defines jobs as arbitrary top-level keys rather than nesting
    // them under `jobs:`, so this shallow parser cannot find job boundaries
    // at all here — the same "ownership not established" case as a
    // recognized-but-unscoped job, and it must fail the same conservative way.
    const gitlabCi = files({
      '.gitlab-ci.yml': `
build-api:
  image: node:16
  script: echo hi
`,
    });
    assert.deepEqual(discoverRuntimeDeclarations(gitlabCi, 'node').resolved, [
      { file: '.gitlab-ci.yml', line: 3, requirement: '16', scope: 'repository' },
    ]);
    const monorepoFound = discoverRuntimeDeclarations(gitlabCi, 'node', 'packages/api', monorepo);
    assert.equal(monorepoFound.resolved.length, 0);
    assert.ok(monorepoFound.unresolved.some((d) => d.rawText === 'node:16'));
  });
});

describe('runtime compatibility: all four states', () => {
  const analyze = (requirement: string, repo: Record<string, string>) =>
    analyzeRuntimeRequirement(runtimeChange('node', requirement), files(repo));

  test('a declaration that satisfies the requirement is compatible, with no site', () => {
    const analysis = analyze('>=24', { '.nvmrc': '24\n' });
    assert.equal(analysis?.state, 'compatible');
    assert.equal(analysis?.reason, 'satisfies');
    assert.deepEqual(analysis?.sites, []);
    assert.match(analysis!.statement, /satisfies it/);
  });

  test('a declaration below the requirement is incompatible', () => {
    const analysis = analyze('>=24', { '.nvmrc': '22\n' });
    assert.equal(analysis?.state, 'incompatible');
    assert.equal(analysis?.reason, 'violates');
    assert.equal(analysis?.sites.length, 1);
    assert.equal(analysis?.sites[0]?.runtimeVerdict, 'incompatible');
    assert.equal(analysis?.sites[0]?.confidence, 'high');
  });

  test('a range spanning the requirement is partial, at high identity confidence', () => {
    const analysis = analyze('>=24', { 'package.json': '{"engines":{"node":">=20"}}' });
    assert.equal(analysis?.state, 'partial');
    assert.equal(analysis?.reason, 'overlaps');
    assert.equal(analysis?.sites[0]?.runtimeVerdict, 'partial');
    assert.equal(
      analysis?.sites[0]?.confidence,
      'high',
      'certainty that this is the Node declaration is a different question from what it means',
    );
    assert.match(analysis!.statement, /includes versions this requirement rejects/);
  });

  test('a dynamic declaration is unknown, with a site pointing at the real line', () => {
    const analysis = analyze('>=24', {
      '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - with:\n          node-version: ${{ matrix.node }}\n',
    });
    assert.equal(analysis?.state, 'unknown');
    assert.equal(analysis?.reason, 'dynamic');
    assert.equal(analysis?.sites.length, 1);
    assert.equal(analysis?.sites[0]?.runtimeVerdict, 'unknown');
    assert.match(analysis!.statement, /could not determine compatibility/);
  });

  test('no declaration at all is unknown, and invents no site to say so', () => {
    const analysis = analyze('>=24', { 'src/index.ts': 'export const x = 1;\n' });
    assert.equal(analysis?.state, 'unknown');
    assert.equal(analysis?.reason, 'no-declaration');
    assert.deepEqual(analysis?.sites, [], 'unknown is a state, not a place in a file');
    assert.match(analysis!.statement, /could not find an authoritative Node version declaration/);
  });

  test('an unreadable declaration value is unknown rather than silently skipped', () => {
    const analysis = analyze('>=24', { '.nvmrc': 'lts/hydrogen\n' });
    assert.equal(analysis?.state, 'unknown');
    assert.equal(analysis?.reason, 'unparseable');
  });

  test('Python equality is evaluated with PEP 440 equality semantics', () => {
    assert.equal(
      checkRuntimeCompatibility('python', [{ file: 'pyproject.toml', line: 1, requirement: '==3.10' }], '==3.10')[0]?.verdict,
      'compatible',
    );
  });

  test('an unreadable upstream Python range is unknown on both compatibility paths', () => {
    const declarations = [{ file: 'pyproject.toml', line: 1, requirement: '>=3.12' }];
    assert.equal(checkRuntimeCompatibility('python', declarations, '^3.10')[0]?.verdict, 'unknown');
    assert.equal(checkUnsupportedRuntimeRange('python', declarations, '^3.10')[0]?.verdict, 'unknown');
  });

  test('an unreadable repository Python declaration is unknown', () => {
    assert.equal(
      checkRuntimeCompatibility('python', [{ file: 'pyproject.toml', line: 1, requirement: '>=3.10,!=3.11' }], '>=3.10')[0]?.verdict,
      'unknown',
    );
  });

  test('a generic CI image cannot make an otherwise-compatible repository uncertain', () => {
    const analysis = analyzeRuntimeRequirement(
      runtimeChange('node', '>=18'),
      files({ '.nvmrc': '22\n', '.gitlab-ci.yml': 'default:\n  image: $DEFAULT_CI_IMAGE\n' }),
    );
    assert.equal(analysis?.state, 'compatible');
    assert.deepEqual(analysis?.sites, []);
  });

  test('a genuinely dynamic runtime-specific CI field still produces unknown', () => {
    const analysis = analyzeRuntimeRequirement(
      runtimeChange('ruby', '>=3.2'),
      files({ '.gitlab-ci.yml': 'default:\n  image: ruby:$RUBY_VERSION\n' }),
    );
    assert.equal(analysis?.state, 'unknown');
    assert.equal(analysis?.reason, 'dynamic');
  });

  test('the worst state across several requirements is the one that decides', () => {
    for (const [states, expected] of [
      [['compatible', 'compatible'], 'compatible'],
      [['compatible', 'unknown'], 'unknown'],
      [['compatible', 'partial'], 'partial'],
      [['unknown', 'incompatible'], 'incompatible'],
      [['partial', 'incompatible'], 'incompatible'],
    ] as const) {
      assert.equal(worstRuntimeState(states.map((state) => ({ state })) as never), expected, states.join(' + '));
    }
    assert.equal(worstRuntimeState([]), undefined, 'no requirement is not the same fact as a satisfied one');
  });
});

describe('runtime prose: `||` disjunctions survive parsing and evaluate per branch', () => {
  // Jest 30's own `engines.node`, verbatim: four alternative ranges, any one
  // of which is a supported Node line. The old list grammar's separator was
  // comma/whitespace only, so it captured `^18.14.0` and reported the other
  // three branches as absent — and GitLab's `.nvmrc = 22.12.0`, comfortably
  // inside `^22.0.0`, was then recorded `incompatible`.
  const JEST_ENGINES = '^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0';

  test('the complete disjunction is preserved, not truncated at the first branch', () => {
    const runtime = matchProse(`requires Node.js ${JEST_ENGINES}`).find((m) => m.kind === 'runtime-requirement')?.runtime;
    assert.ok(runtime, 'produced no structured runtime requirement');
    assert.equal(runtime!.kind, 'minimum-runtime');
    assert.equal(runtime!.runtime, 'node');
    assert.equal(runtime!.requirement, JEST_ENGINES, 'every `||` branch is kept');
    assert.equal(runtime!.rangeParseStatus, undefined, 'semver defines `||`, so this is parsed');
  });

  test('the same requirement synthesized from registry `engines` metadata parses whole', () => {
    // The path GitLab actually hit: evidence synthesizes "jest@30 requires
    // Node.js <engines>." and it is parsed by the identical prose rule.
    const runtime = matchProse(`jest@30 requires Node.js ${JEST_ENGINES}.`).find(
      (m) => m.kind === 'runtime-requirement',
    )?.runtime;
    assert.equal(runtime?.requirement, JEST_ENGINES);
  });

  test('22.12.0 against the Jest disjunction is compatible, through the `^22.0.0` branch', () => {
    const analysis = analyzeRuntimeRequirement(runtimeChange('node', JEST_ENGINES), files({ '.nvmrc': '22.12.0\n' }));
    assert.equal(analysis?.state, 'compatible');
    assert.equal(analysis?.reason, 'satisfies');
    assert.deepEqual(analysis?.sites, [], 'a compatible declaration is not an impact site');
  });

  test('a Node version outside every branch is still incompatible', () => {
    // 19.x falls between `^18.14.0` (<19.0.0), `^20.0.0`, `^22.0.0` and
    // `>=24.0.0` — genuinely unsupported, and the disjunction must say so.
    const analysis = analyzeRuntimeRequirement(runtimeChange('node', JEST_ENGINES), files({ '.nvmrc': '19.0.0\n' }));
    assert.equal(analysis?.state, 'incompatible');
    assert.equal(analysis?.reason, 'violates');
    assert.equal(analysis?.sites[0]?.runtimeVerdict, 'incompatible');
  });

  test('a range that straddles one branch boundary is partial, not compatible', () => {
    const analysis = analyzeRuntimeRequirement(
      runtimeChange('node', JEST_ENGINES),
      files({ 'package.json': '{"engines":{"node":">=23.0.0"}}' }),
    );
    assert.equal(analysis?.state, 'partial', '`>=23` covers 23.x (unsupported) and 24+ (via `>=24.0.0`)');
  });

  test('a `||` against a runtime whose grammar has no disjunction is carried whole but left unknown', () => {
    // RubyGems has no `||`; PEP 440 has no `||`. The requirement text is
    // preserved in full — never truncated — but its compatibility state is
    // honestly `unknown`, exactly as a caret against Python is, rather than
    // guessed from a branch Drift cannot evaluate.
    for (const [runtime, text, expected] of [
      ['ruby', 'Requires Ruby 3.1 || 3.2', '>=3.1 || >=3.2'],
      ['python', 'Requires Python 3.9 || 3.10', '>=3.9 || >=3.10'],
    ] as const) {
      const parsed = matchProse(text).find((m) => m.kind === 'runtime-requirement')?.runtime;
      assert.equal(parsed?.requirement, expected, `${runtime}: full disjunction preserved`);
      assert.equal(parsed?.rangeParseStatus, 'unknown', `${runtime}: not evaluated as if \`||\` were defined`);
    }
  });

  test('grammar table marks disjunction support per ecosystem, semver only', () => {
    assert.equal(RUNTIME_RANGE_GRAMMARS.node.supportsDisjunction, true);
    for (const runtime of ['python', 'ruby', 'go', 'java', 'rust'] as const) {
      assert.equal(RUNTIME_RANGE_GRAMMARS[runtime].supportsDisjunction, false, runtime);
    }
  });
});

describe('#110: registry runtime metadata becomes a canonical runtime requirement', () => {
  test('raisedRuntimeFloor only fires on an introduced or genuinely raised floor', () => {
    assert.deepEqual(raisedRuntimeFloor(null, { name: 'Node.js', requirement: '>=20' }), {
      runtime: 'Node.js',
      requirement: '>=20',
    });
    assert.deepEqual(
      raisedRuntimeFloor({ name: 'Node.js', requirement: '>=16' }, { name: 'Node.js', requirement: '>=20' }),
      { runtime: 'Node.js', requirement: '>=20' },
    );
    assert.equal(
      raisedRuntimeFloor({ name: 'Node.js', requirement: '>=20' }, { name: 'Node.js', requirement: '>=20' }),
      null,
      'unchanged floor is not news',
    );
    assert.equal(
      raisedRuntimeFloor({ name: 'Node.js', requirement: '>=20' }, { name: 'Node.js', requirement: '>=16' }),
      null,
      'a lowered floor is not a breaking condition',
    );
  });

  test('target-metadata-only floors parse into a runtime-requirement for every supported family', () => {
    for (const [display, canonical, requirement] of [
      ['Node.js', 'node', '>=20'],
      ['Python', 'python', '>=3.11'],
      ['Ruby', 'ruby', '>=3.2'],
      ['Go', 'go', '>=1.23'],
      ['Java', 'java', '>=17'],
      ['Rust', 'rust', '>=1.75'],
    ] as const) {
      const floor = raisedRuntimeFloor(null, { name: display, requirement });
      assert.ok(floor, `${display} floor recognized`);
      const [match] = matchProse(`pkg@2.0.0 requires ${floor!.runtime} ${floor!.requirement}.`);
      assert.ok(match, `${display} sentence parses`);
      assert.equal(match.kind, 'runtime-requirement');
      assert.equal(match.runtime?.runtime, canonical);
      assert.equal(match.runtime?.requirement, requirement);
    }
  });
});

describe('#137: Java runtime authority vs compiler bytecode target', () => {
  const pom = (properties: string, compilerTarget: string, extraPlugins = '') =>
    `<project><properties>${properties}</properties><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${compilerTarget}</release></configuration></plugin>${extraPlugins}</plugins></build></project>`;

  const toolchainsPlugin =
    '<plugin><artifactId>maven-toolchains-plugin</artifactId><configuration><toolchains><jdk><version>${java.version}</version></jdk></toolchains></configuration></plugin>';

  test('Case 1: <release>8</release> + an authoritative CI/toolchain JDK 17 + upstream Java >=11 is compatible (release is never suggested for edit)', () => {
    const analysis = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({
        'pom.xml': pom('<foo>1</foo>', '8'),
        '.github/workflows/ci.yml': 'jobs:\n  build:\n    steps:\n      - uses: actions/setup-java@v4\n        with:\n          java-version: 17\n',
      }),
    );
    assert.equal(analysis?.state, 'compatible');
    assert.ok(!analysis?.declarations.some((d) => d.requirement === '8'), 'the compiler release target must never participate as a runtime declaration');
  });

  test('Case 2: Gradle sourceCompatibility/targetCompatibility=8 + an authoritative CI JDK 17 + upstream Java >=11 is compatible', () => {
    const analysis = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({
        'build.gradle': 'sourceCompatibility = 8\ntargetCompatibility = 8\n',
        '.github/workflows/ci.yml': 'jobs:\n  build:\n    steps:\n      - uses: actions/setup-java@v4\n        with:\n          java-version: 17\n',
      }),
    );
    assert.equal(analysis?.state, 'compatible');
    assert.ok(!analysis?.declarations.some((d) => d.requirement === '8'), 'sourceCompatibility/targetCompatibility must never participate as a runtime declaration');
  });

  test('Case 3: an authoritative actual JDK 8 + upstream Java >=11 is incompatible/actionable', () => {
    const analysis = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({ '.github/workflows/ci.yml': 'jobs:\n  build:\n    steps:\n      - uses: actions/setup-java@v4\n        with:\n          java-version: 8\n' }),
    );
    assert.equal(analysis?.state, 'incompatible');
    assert.equal(analysis?.reason, 'violates');
    assert.equal(analysis?.sites.length, 1);
  });

  test('Case 4: a bare <java.version> with no toolchain evidence is never a definite runtime edit, but is surfaced conservatively', () => {
    const compatibleShaped = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({ 'pom.xml': pom('<java.version>17</java.version>', '${unset.prop}') }),
    );
    assert.equal(compatibleShaped?.state, 'unknown');
    assert.equal(compatibleShaped?.reason, 'dynamic');
    assert.equal(compatibleShaped?.unresolved.length, 1);
    assert.equal(compatibleShaped?.unresolved[0]?.rawText, '17');

    const incompatibleShaped = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({ 'pom.xml': pom('<java.version>8</java.version>', '${unset.prop}') }),
    );
    // Never promoted to a false `incompatible` either — the whole point is
    // that Drift does not know, in either direction, without more evidence.
    assert.equal(incompatibleShaped?.state, 'unknown');
    assert.notEqual(incompatibleShaped?.state, 'incompatible');
  });

  test('Case 5: <java.version> provisioned by an explicit Maven Toolchains plugin block participates as authoritative evidence', () => {
    const compatible = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({ 'pom.xml': pom('<java.version>17</java.version>', '${unset.prop}', toolchainsPlugin) }),
    );
    assert.equal(compatible?.state, 'compatible');
    assert.equal(compatible?.reason, 'satisfies');

    const incompatible = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({ 'pom.xml': pom('<java.version>8</java.version>', '${unset.prop}', toolchainsPlugin) }),
    );
    assert.equal(incompatible?.state, 'incompatible');
    assert.equal(incompatible?.reason, 'violates');
  });

  test('a compiler target alone (no java.version property at all) does not establish definite runtime compatibility', () => {
    const analysis = analyzeRuntimeRequirement(
      runtimeChange('java', '>=11'),
      files({ 'pom.xml': pom('<foo>1</foo>', '17') }),
    );
    assert.equal(analysis?.state, 'unknown');
    assert.notEqual(analysis?.state, 'compatible');
  });
});

describe('runtime localization emits sites only for concrete locations', () => {
  const localize = (requirement: string, repo: Record<string, string>) => {
    const src = sourceFiles(repo);
    return localizeWithRuntime(
      [runtimeChange('node', requirement)],
      [{ name: 'pkg', ecosystem: 'npm' as never, from: '1.0.0', to: '2.0.0', kind: 'runtime' as const, bump: 'major' as const, manifestPath: 'package.json' }],
      buildIndex(src),
      src,
      { logger },
    );
  };

  test('incompatible emits an actionable site', () => {
    const { sites } = localize('>=24', { '.nvmrc': '22\n' });
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.runtimeVerdict, 'incompatible');
  });

  test('partial emits a partial-state site', () => {
    const { sites } = localize('>=24', { 'package.json': '{"engines":{"node":">=20"}}' });
    assert.equal(sites[0]?.runtimeVerdict, 'partial');
  });

  test('no declaration produces an unknown analysis and zero sites', () => {
    const { sites, runtimeAnalyses } = localize('>=24', { 'src/a.ts': 'export const x = 1;\n' });
    assert.deepEqual(sites, []);
    assert.equal(runtimeAnalyses.length, 1);
    assert.equal(runtimeAnalyses[0]?.state, 'unknown');
  });
});

describe('runtime assessment: partial and unknown are review, never safe or migration', () => {
  const assess = (analysis: Record<string, unknown>, sites: unknown[] = []) =>
    assessUpgrade({
      ...baseAssessment,
      breakingChanges: [runtimeChange('node', '>=24')] as never,
      impactSites: sites as never,
      runtimeAnalyses: [{ changeId: 'runtime-change', runtime: 'node', declarations: [], unresolved: [], sites: [], statement: 'stated', ...analysis }] as never,
    });

  const site = (verdict: string, confidence = 'high') => ({
    breakingChangeId: 'runtime-change',
    file: '.nvmrc',
    line: 1,
    excerpt: '22',
    matchedSymbol: 'node',
    confidence,
    runtimeVerdict: verdict,
  });

  test('incompatible at high confidence can headline as Migration required', () => {
    const result = assess({ state: 'incompatible', reason: 'violates' }, [site('incompatible')]);
    assert.equal(result.recommendation, 'manual-migration-required');
  });

  test('partial at high confidence is Upgrade after review', () => {
    const result = assess({ state: 'partial', reason: 'overlaps' }, [site('partial')]);
    assert.equal(result.recommendation, 'upgrade-after-review');
  });

  test('unknown at high identity confidence is Upgrade after review', () => {
    const result = assess({ state: 'unknown', reason: 'dynamic' }, [site('unknown', 'high')]);
    assert.equal(result.recommendation, 'upgrade-after-review');
  });

  test('unknown at low confidence is Upgrade after review', () => {
    const result = assess({ state: 'unknown', reason: 'dynamic' }, [site('unknown', 'low')]);
    assert.equal(result.recommendation, 'upgrade-after-review');
  });

  test('no declaration cannot be safe, and never claims the repository does not use it', () => {
    const result = assess({ state: 'unknown', reason: 'no-declaration' });
    assert.equal(result.recommendation, 'upgrade-after-review');
    assert.equal(result.runtimeCompatibility, 'unknown');
    assert.equal(
      result.reasons.some((reason) => /none of which this repository uses/.test(reason)),
      false,
      result.reasons.join(' | '),
    );
  });

  test('compatible may still contribute to safe when the other evidence supports it', () => {
    const result = assess({ state: 'compatible', reason: 'satisfies' });
    assert.equal(result.recommendation, 'safe-to-upgrade');
  });
});

describe('#133: reasons are rendered from the completed runtime-analysis set', () => {
  const changeA = { ...(runtimeChange('node', '>=18') as Record<string, unknown>), id: 'rt-a' };
  const changeB = { ...(runtimeChange('python', '>=3.10') as Record<string, unknown>), id: 'rt-b' };

  test('a missing second analysis makes the aggregate unknown and is explained to the developer', () => {
    const result = assessUpgrade({
      ...baseAssessment,
      breakingChanges: [changeA, changeB] as never,
      impactSites: [] as never,
      // Only the first requirement was analyzed; the second never completed.
      runtimeAnalyses: [
        {
          changeId: 'rt-a',
          runtime: 'node',
          requirement: '>=18',
          state: 'compatible',
          reason: 'satisfies',
          declarations: [],
          unresolved: [],
          sites: [],
          statement: 'Upstream requires Node >=18; this repository satisfies it.',
        },
      ] as never,
    });

    assert.equal(result.runtimeCompatibility, 'unknown');
    assert.equal(result.recommendation, 'upgrade-after-review');
    assert.ok(
      result.reasons.some((reason) => /could not complete runtime compatibility analysis/i.test(reason)),
      result.reasons.join(' | '),
    );
  });
});

describe('runtime severity: unresolved compatibility can never render as safe', () => {
  test('runtime unknown with zero sites is explicitly runtime unresolved', () => {
    const candidate = { ...baseCandidate, runtimeCompatibility: 'unknown' as const };
    assert.equal(severityOf(candidate), 'runtime-unresolved');
    assert.doesNotMatch(describeSeverity(candidate), /none used here|Safe for your code/);
  });

  test('runtime partial with zero sites is explicitly runtime unresolved', () => {
    assert.equal(severityOf({ ...baseCandidate, runtimeCompatibility: 'partial' }), 'runtime-unresolved');
  });

  test('runtime partial with a site is review-only rather than affected', () => {
    const candidate = {
      ...baseCandidate,
      impactCount: 1,
      impactFiles: 1,
      // The one site is the runtime declaration itself — held for review, not
      // an actionable API hit.
      runtimeDeclarationSiteCount: 1,
      impactConfidence: 'high' as const,
      runtimeCompatibility: 'partial' as const,
    };
    assert.equal(severityOf(candidate), 'runtime-unresolved');
    assert.doesNotMatch(describeSeverity(candidate), /affect your code/i);
  });

  test('an independent API impact survives an unresolved runtime on the same candidate', () => {
    // 3 impact sites: 2 high-confidence API hits + 1 runtime declaration under
    // an unknown result. The unresolved runtime must not zero the API impact.
    const candidate = {
      ...baseCandidate,
      impactCount: 3,
      impactFiles: 2,
      runtimeDeclarationSiteCount: 1,
      impactConfidence: 'high' as const,
      runtimeCompatibility: 'unknown' as const,
    };
    assert.equal(severityOf(candidate), 'affected');
    assert.match(describeSeverity(candidate), /Affects your code/);
  });

  test('a low-confidence API hit is review-only, never a false all-clear', () => {
    const candidate = {
      ...baseCandidate,
      breakingCount: 1,
      impactCount: 1,
      impactFiles: 1,
      actionableImpactCount: 0,
      actionableImpactFiles: 0,
      impactConfidence: 'low' as const,
    };
    assert.equal(severityOf(candidate), 'review-required');
    const line = describeSeverity(candidate);
    assert.doesNotMatch(line, /none used here|Safe for your code|Not verified/);
    assert.match(line, /Review required/);
  });

  test('a zero-hit API change without verification is review-required, not a false all-clear', () => {
    // A clean recommendation from a completed localization is not proof the
    // symbol is unused — structural typing, wrappers, generated code and
    // dynamic dispatch all evade a syntactic search. Only an isolated
    // verification pass earns `upstream-only`.
    const candidate = { ...baseCandidate, recommendation: 'safe-to-upgrade' };
    assert.equal(severityOf(candidate), 'review-required');
    assert.doesNotMatch(describeSeverity(candidate), /none used here|Safe for your code/);
    assert.equal(
      severityOf({ ...candidate, verification: { status: 'passed', checks: [] } }),
      'upstream-only',
    );
  });

  test('runtime compatible with no API break renders upstream-only; an unverified API break does not', () => {
    // runtimeAnalyses present → the lone breaking change is the runtime one,
    // resolved compatible: genuine affirmative evidence.
    assert.equal(
      severityOf({
        ...baseCandidate,
        runtimeCompatibility: 'compatible',
        runtimeAnalyses: [{ state: 'compatible' as const, reason: 'declared-compatible' }],
      }),
      'upstream-only',
    );
    // No runtimeAnalyses → the breaking change is an API one with no site and
    // nothing verified: review-required.
    assert.equal(severityOf({ ...baseCandidate, runtimeCompatibility: 'compatible' }), 'review-required');
  });
});

describe('runtime recording validator consumes recorded structure', () => {
  const recorded = (overrides: Record<string, unknown> = {}) => ({
    name: 'pkg',
    runtimeCompatibility: 'unknown',
    recommendation: 'upgrade-after-review',
    severity: 'runtime-unresolved',
    independentActionableFindingCount: 0,
    breakingCount: 1,
    impactCount: 0,
    breaking: [{ kind: 'runtime-requirement', id: 'runtime-change', runtime: { runtime: 'node' } }],
    runtimeAnalyses: [{
      changeId: 'runtime-change',
      runtime: 'node',
      state: 'unknown',
      reason: 'no-declaration',
      siteCount: 0,
      declarationCount: 0,
      unresolvedCount: 0,
    }],
    ...overrides,
  });

  test('unknown with zero sites and upstream changes is valid when severity is runtime-unresolved', () => {
    assert.doesNotThrow(() => validateRuntimeCompatibilityState(recorded(), 'fixture'));
  });

  test('unknown cannot record upstream-only severity', () => {
    assert.throws(() => validateRuntimeCompatibilityState(recorded({ severity: 'upstream-only' }), 'fixture'), /severity upstream-only/);
  });

  test('partial cannot be safe-to-upgrade', () => {
    assert.throws(() => validateRuntimeCompatibilityState(recorded({
      runtimeCompatibility: 'partial',
      recommendation: 'safe-to-upgrade',
      runtimeAnalyses: [{ changeId: 'runtime-change', runtime: 'node', state: 'partial', reason: 'overlaps', siteCount: 1, declarationCount: 1, unresolvedCount: 0 }],
    }), 'fixture'), /safe-to-upgrade/);
  });

  test('compatible requires an actual declaration', () => {
    assert.throws(() => validateRuntimeCompatibilityState(recorded({
      runtimeCompatibility: 'compatible',
      recommendation: 'safe-to-upgrade',
      severity: 'upstream-only',
      runtimeAnalyses: [{ changeId: 'runtime-change', runtime: 'node', state: 'compatible', reason: 'satisfies', siteCount: 0, declarationCount: 0, unresolvedCount: 0 }],
    }), 'fixture'), /without an actual declaration/);
  });

  test('no-declaration can never be compatible', () => {
    assert.throws(() => validateRuntimeCompatibilityState(recorded({
      runtimeCompatibility: 'compatible',
      severity: 'upstream-only',
      runtimeAnalyses: [{ changeId: 'runtime-change', runtime: 'node', state: 'compatible', reason: 'no-declaration', siteCount: 0, declarationCount: 0, unresolvedCount: 0 }],
    }), 'fixture'), /compatible for reason no-declaration/);
  });

  test('dynamic requires at least one unresolved declaration', () => {
    assert.throws(() => validateRuntimeCompatibilityState(recorded({
      runtimeAnalyses: [{ changeId: 'runtime-change', runtime: 'node', state: 'unknown', reason: 'dynamic', siteCount: 1, declarationCount: 0, unresolvedCount: 0 }],
    }), 'fixture'), /without an unresolved declaration/);
  });
});
