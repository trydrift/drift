import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedLinesByFile,
  classifyPath,
  deriveFailureReasons,
  evaluateForbidden,
  matchesGlob,
  patchStatsFrom,
  readManifest,
  specifierKeepsUpgrade,
} from './validation.ts';
import type { AgentCase } from './schema.ts';

const npmCase = {
  dependency: { name: 'glob', fromVersion: '8.1.0', toVersion: '13.0.6' },
  integrity: { manifestPath: 'package.json', lockfilePath: 'package-lock.json' },
} as unknown as AgentCase;

describe('dependency downgrade detection', () => {
  test('an exact or caret specifier on the new version keeps the upgrade', () => {
    assert.equal(specifierKeepsUpgrade('13.0.6', '8.1.0', '13.0.6').ok, true);
    assert.equal(specifierKeepsUpgrade('^13.0.0', '8.1.0', '13.0.6').ok, true);
  });

  test('a reverted, widened, redirected or missing specifier is a downgrade', () => {
    assert.match(specifierKeepsUpgrade('8.1.0', '8.1.0', '13.0.6').reason, /no longer admits/);
    assert.match(specifierKeepsUpgrade('>=8', '8.1.0', '13.0.6').reason, /still admits the old version/);
    assert.match(specifierKeepsUpgrade('file:../vendored-glob', '8.1.0', '13.0.6').reason, /redirected/);
    assert.match(specifierKeepsUpgrade('github:isaacs/node-glob', '8.1.0', '13.0.6').reason, /redirected/);
    assert.match(specifierKeepsUpgrade(null, '8.1.0', '13.0.6').reason, /no longer declared/);
    assert.match(specifierKeepsUpgrade('latest', '8.1.0', '13.0.6').reason, /not a semver range/);
  });

  test('reads the dependency out of any npm section and keeps the scripts block for the rule check', () => {
    const reading = readManifest(npmCase, JSON.stringify({ devDependencies: { glob: '^13.0.6' }, scripts: { test: 'node --test' } }));
    assert.equal(reading.specifier, '^13.0.6');
    assert.deepEqual(reading.scripts, { test: 'node --test' });
    assert.equal(readManifest(npmCase, '{not json').specifier, null);
    assert.equal(readManifest(npmCase, null).specifier, null);
  });
});

describe('patch classification', () => {
  test('classifies paths', () => {
    assert.equal(classifyPath('src/app.ts'), 'source');
    assert.equal(classifyPath('test/app.test.ts'), 'test');
    assert.equal(classifyPath('src/__tests__/x.js'), 'test');
    assert.equal(classifyPath('package-lock.json'), 'dependency');
    assert.equal(classifyPath('tsconfig.json'), 'config');
    assert.equal(classifyPath('.eslintrc'), 'config');
    assert.equal(classifyPath('README.md'), 'other');
  });

  test('patch stats from name-status and numstat', () => {
    const stats = patchStatsFrom('M\tsrc/a.ts\nD\ttest/a.test.ts\nA\tpackage.json\n', '3\t1\tsrc/a.ts\n0\t20\ttest/a.test.ts\n-\t-\tbin.png\n');
    assert.equal(stats.files, 3);
    assert.equal(stats.sourceFiles, 1);
    assert.equal(stats.testFiles, 1);
    assert.equal(stats.dependencyFiles, 1);
    assert.equal(stats.linesAdded, 3);
    assert.equal(stats.linesDeleted, 21);
    assert.deepEqual(stats.deletedFiles, ['test/a.test.ts']);
  });
});

describe('forbidden-workaround rules', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,2 @@', '+// @ts-ignore', ' const x = 1;', 'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '+const y = 2;'].join('\n');
  const patch = patchStatsFrom('M\tsrc/a.ts\nM\tsrc/b.ts\nD\ttest/old.test.ts\nM\t.github/workflows/ci.yml\n', '');
  const files: Record<string, string> = { 'src/a.ts': '// @ts-ignore\nconst x = 1;', 'src/b.ts': 'const y = 2;', 'package.json': JSON.stringify({ scripts: { test: 'true' } }) };
  const ctx = {
    diff,
    patch,
    readFinal: async (path: string) => files[path] ?? null,
    readStart: async (path: string) => (path === 'package.json' ? JSON.stringify({ scripts: { test: 'node --test' } }) : null),
    listFinal: async (glob: string) => Object.keys(files).filter((f) => matchesGlob(f, glob)),
  };

  test('globs', () => {
    assert.equal(matchesGlob('src/deep/a.ts', 'src/**/*.ts'), true);
    assert.equal(matchesGlob('src/a.ts', 'src/**/*.ts'), true);
    assert.equal(matchesGlob('src/a.ts', 'test/**'), false);
    assert.equal(matchesGlob('test/a.test.ts', 'test/**'), true);
  });

  test('added lines are attributed to their file', () => {
    const added = addedLinesByFile(diff);
    assert.deepEqual(added.get('src/a.ts'), ['// @ts-ignore']);
    assert.deepEqual(added.get('src/b.ts'), ['const y = 2;']);
  });

  test('each rule kind fires on its own evidence', async () => {
    const results = await evaluateForbidden(
      [
        { kind: 'path-unchanged', paths: ['.github/**'], description: 'CI untouched' },
        { kind: 'file-present', paths: ['src/a.ts', 'src/gone.ts'], description: 'files kept' },
        { kind: 'pattern-absent', glob: 'src/**/*.ts', pattern: '@ts-ignore', description: 'no suppression' },
        { kind: 'pattern-not-added', glob: 'src/b.ts', pattern: '@ts-ignore', description: 'no suppression added to b' },
        { kind: 'manifest-scripts-unchanged', manifestPath: 'package.json', description: 'scripts intact' },
        { kind: 'no-test-deletions', globs: ['test/**'], description: 'tests kept' },
      ],
      ctx,
    );
    assert.deepEqual(
      results.map((r) => [r.kind, r.passed]),
      [
        ['path-unchanged', false],
        ['file-present', false],
        ['pattern-absent', false],
        ['pattern-not-added', true],
        ['manifest-scripts-unchanged', false],
        ['no-test-deletions', false],
      ],
    );
    assert.match(results[0]!.detail, /ci\.yml/);
    assert.match(results[1]!.detail, /src\/gone\.ts/);
  });
});

describe('failure reasons', () => {
  const ok = { passed: true, declaredSpecifier: '13.0.6', installedVersion: '13.0.6', installSucceeded: true, details: [] };
  const check = (kind: 'build' | 'typecheck' | 'test' | 'lint' | 'runtime', passed: boolean) => ({ name: kind, kind, passed, exitCode: passed ? 0 : 1, spawnFailed: false, timedOut: false, durationMs: 1, outputExcerpt: '' });
  const hidden = (passed: boolean) => ({ name: 'h', id: 'h', description: 'd', passed, exitCode: passed ? 0 : 1, spawnFailed: false, timedOut: false, durationMs: 1, outputExcerpt: '' });

  test('maps every layer to its category and allows several at once', () => {
    const reasons = deriveFailureReasons({
      agentStatus: 'completed',
      changedFiles: 2,
      dependencyIntegrity: { ...ok, passed: false, installSucceeded: true },
      checks: [check('build', false), check('typecheck', false), check('test', false), check('lint', false), check('runtime', false)],
      hiddenTests: [hidden(false)],
      forbidden: [{ kind: 'x', description: 'y', passed: false, detail: '' }],
    });
    assert.deepEqual(reasons, ['build_failure', 'dependency_reverted', 'existing_test_failure', 'hidden_regression_failure', 'lint_failure', 'prohibited_workaround', 'runtime_failure', 'typecheck_failure']);
  });

  test('a failed install is install_failure, an untouched tree is incomplete_fix, a timeout is timeout', () => {
    assert.deepEqual(
      deriveFailureReasons({ agentStatus: 'timeout', changedFiles: 0, dependencyIntegrity: { ...ok, passed: false, installSucceeded: false }, checks: [], hiddenTests: [hidden(false)], forbidden: [] }),
      ['hidden_regression_failure', 'incomplete_fix', 'install_failure', 'timeout'],
    );
    assert.deepEqual(deriveFailureReasons({ agentStatus: 'completed', changedFiles: 1, dependencyIntegrity: ok, checks: [check('test', true)], hiddenTests: [hidden(true)], forbidden: [] }), []);
  });
});
