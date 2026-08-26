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
import { matchProse } from '../dist/analyze/index.js';
import { discoverRuntimeDeclarations } from '../dist/rationale/runtime.js';
import { analyzeRuntimeRequirement, worstRuntimeState } from '../dist/rationale/compatibility.js';
import { assessUpgrade } from '../dist/rationale/assess.js';
import { severityOf, describeSeverity } from '../dist/upgrade/severity.js';
import { localizeWithRuntime } from '../dist/localize/index.js';
import { buildIndex } from '../dist/index/metarag.js';
import { createLogger } from '../dist/util/logger.js';

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

  test('"<" and "<=" keep their exact complements as derived floors', () => {
    const lt = dropped('Dropped support for Node <18');
    assert.equal(lt?.requirement, '<18');
    assert.equal(lt && 'derivedMinimum' in lt ? lt.derivedMinimum : undefined, '>=18');
    const lte = dropped('Dropped support for Node <=16');
    assert.equal(lte && 'derivedMinimum' in lte ? lte.derivedMinimum : undefined, '>16');
  });

  test('caret and tilde stay parsed for the ecosystems that define them', () => {
    for (const [text, expected] of [
      ['Dropped support for Node ^16', '^16'],
      ['Dropped support for Ruby ~3.0', '~3.0'],
    ] as const) {
      const range = dropped(text);
      assert.equal(range?.requirement, expected, text);
      assert.equal(range?.rangeParseStatus, undefined, `${text} is evaluable, so it carries no unknown flag`);
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

  test('a Dockerfile runtime image with a dynamic tag is unresolved; a generic base image is nothing', () => {
    const specific = discoverRuntimeDeclarations(files({ Dockerfile: 'FROM node:${NODE_VERSION}\n' }), 'node');
    assert.equal(specific.unresolved.length, 1);
    assert.equal(specific.unresolved[0]?.source, 'container');

    const generic = discoverRuntimeDeclarations(files({ Dockerfile: 'FROM $BASE_IMAGE\n' }), 'node');
    assert.deepEqual(generic.resolved, []);
    assert.deepEqual(generic.unresolved, []);
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
    assert.equal(worstRuntimeState([{ state: 'compatible' }, { state: 'unknown' }] as never), 'unknown');
    assert.equal(worstRuntimeState([{ state: 'partial' }, { state: 'incompatible' }] as never), 'incompatible');
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
