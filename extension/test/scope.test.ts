import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateAgentWorktree } from '../src/scope.js';
import type { CommitUnit } from '../../src/types.js';

const unit = (allowedFiles: string[]): CommitUnit => ({
  id: 'unit-1',
  order: 1,
  message: 'fix changed API',
  body: '',
  files: allowedFiles,
  allowedFiles,
  allowedSymbols: [],
  breakingChangeIds: [],
  instructions: '',
  dependsOn: [],
  dependencyReasons: [],
  executionLayer: 0,
  expectedChecks: [],
  invalidationTriggers: [],
});

describe('validating agent worktree scope', () => {
  let root = '';
  let baseline = '';

  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drift-scope-'));
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Drift Test']);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src/app.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'test/app.test.ts'), "import assert from 'node:assert';\nassert.equal(1, 1);\n");
    git(['add', '.']);
    git(['commit', '-m', 'baseline']);
    baseline = git(['rev-parse', 'HEAD']).trim();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('accepts edits contained in allowed files', async () => {
    writeFileSync(join(root, 'src/app.ts'), 'export const value = 2;\n');

    const result = await validateAgentWorktree({ root, baselineRef: baseline, commit: unit(['src/app.ts']) });

    assert.equal(result.ok, true);
    assert.deepEqual(result.changed.map((entry) => entry.path), ['src/app.ts']);
  });

  test('rejects an out-of-scope untracked file', async () => {
    writeFileSync(join(root, 'src/app.ts'), 'export const value = 2;\n');
    writeFileSync(join(root, 'src/extra.ts'), 'export const extra = true;\n');

    const result = await validateAgentWorktree({ root, baselineRef: baseline, commit: unit(['src/app.ts']) });

    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /outside this unit's allowed files/);
  });

  test('rejects a rename into a protected workflow path', async () => {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    git(['mv', 'src/app.ts', '.github/workflows/build.yml']);

    const result = await validateAgentWorktree({
      root,
      baselineRef: baseline,
      commit: unit(['src/app.ts', '.github/workflows/build.yml']),
    });

    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /protected path \.github\/workflows\/build\.yml/);
  });

  test('rejects symlink edits', async () => {
    rmSync(join(root, 'src/app.ts'));
    symlinkSync('/tmp/outside-drift-scope', join(root, 'src/app.ts'));

    const result = await validateAgentWorktree({ root, baselineRef: baseline, commit: unit(['src/app.ts']) });

    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /symlink/);
  });

  test('rejects workflow and lockfile edits unless explicitly in scope', async () => {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'name: ci\n');
    writeFileSync(join(root, 'package-lock.json'), '{}\n');

    const result = await validateAgentWorktree({ root, baselineRef: baseline, commit: unit(['src/app.ts']) });

    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /workflow path/);
    assert.match(result.reasons.join('\n'), /lockfile/);
  });

  test('rejects likely secret additions', async () => {
    writeFileSync(join(root, 'src/app.ts'), "export const token = 'secret_token = \"12345678901234567890\"';\n");

    const result = await validateAgentWorktree({ root, baselineRef: baseline, commit: unit(['src/app.ts']) });

    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /secret value/);
  });

  test('rejects test weakening when configured', async () => {
    writeFileSync(join(root, 'test/app.test.ts'), "test.skip('kept quiet', () => {});\n");

    const result = await validateAgentWorktree({
      root,
      baselineRef: baseline,
      commit: unit(['test/app.test.ts']),
      forbidTestWeakening: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /skipped or todo test|removed an assertion/);
  });
});
