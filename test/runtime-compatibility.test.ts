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

  test('Maven property indirection resolves in-file, and is unresolved only when the property is absent', () => {
    const resolved = discoverRuntimeDeclarations(
      files({ 'pom.xml': '<project><properties><java.version>17</java.version></properties><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${java.version}</release></configuration></plugin></plugins></build></project>' }),
      'java',
    );
    assert.deepEqual(resolved.unresolved, []);
    assert.deepEqual(resolved.resolved.map((d) => d.requirement), ['17']);

    const inherited = discoverRuntimeDeclarations(
      files({ 'pom.xml': '<project><properties><foo>1</foo></properties><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${java.version}</release></configuration></plugin></plugins></build></project>' }),
      'java',
    );
    assert.deepEqual(inherited.resolved, []);
    assert.equal(inherited.unresolved.length, 1);
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

  test('workspace precedence still shadows a root version file but keeps repository-wide CI', () => {
    const repo = files({
      '.nvmrc': '18\n',
      'packages/api/.nvmrc': '22\n',
      '.github/workflows/ci.yml': '        node-version: 20\n',
    });
    const found = discoverRuntimeDeclarations(repo, 'node', 'packages/api', ['packages/api', 'packages/web']);
    assert.deepEqual(found.resolved.map((d) => d.file).sort(), ['.github/workflows/ci.yml', 'packages/api/.nvmrc']);
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

describe('runtime severity: unresolved compatibility can never render as safe', () => {
  test('runtime unknown with zero sites is unchecked, not upstream-only', () => {
    const candidate = { ...baseCandidate, runtimeCompatibility: 'unknown' as const };
    assert.equal(severityOf(candidate), 'unchecked');
    assert.doesNotMatch(describeSeverity(candidate), /none used here|Safe for your code/);
  });

  test('runtime partial with zero sites is unchecked, not upstream-only', () => {
    assert.equal(severityOf({ ...baseCandidate, runtimeCompatibility: 'partial' }), 'unchecked');
  });

  test('runtime partial with a site hedges rather than stating the code is affected', () => {
    const candidate = {
      ...baseCandidate,
      impactCount: 1,
      impactFiles: 1,
      impactConfidence: 'high' as const,
      runtimeCompatibility: 'partial' as const,
    };
    assert.equal(severityOf(candidate), 'affected');
    assert.match(describeSeverity(candidate), /^May affect your code/);
  });

  test('a proven-unused symbol-level change is still allowed to be upstream-only', () => {
    const candidate = { ...baseCandidate, recommendation: 'safe-to-upgrade' };
    assert.equal(severityOf(candidate), 'upstream-only');
    assert.match(describeSeverity(candidate), /none used here/);
  });

  test('runtime compatible does not block upstream-only', () => {
    assert.equal(severityOf({ ...baseCandidate, runtimeCompatibility: 'compatible' }), 'upstream-only');
  });
});

describe('runtime recording validator consumes recorded structure', () => {
  const recorded = (overrides: Record<string, unknown> = {}) => ({
    name: 'pkg',
    runtimeCompatibility: 'unknown',
    recommendation: 'upgrade-after-review',
    severity: 'unchecked',
    independentActionableFindingCount: 0,
    breakingCount: 1,
    impactCount: 0,
    breaking: [{ kind: 'runtime-requirement' }],
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

  test('unknown with zero sites and upstream changes is valid when severity is unchecked', () => {
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
