import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureSchema } from './load.ts';
import { validateReviews } from './cli/validate.ts';
import YAML from 'yaml';

const FIXTURES_ROOT = join(process.cwd(), 'eval', 'fixtures');
const EVAL_ROOT = join(process.cwd(), 'eval');

const CIRCULAR_PATTERNS = [/regenerate.*by running.*and copying/i, /copy the prediction/i, /run drift and copy/i];

async function walkTextFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTextFiles(path)));
    } else if (/\.(md|yml|yaml|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

test('no fixture, review, or doc file instructs regenerating ground truth from a Drift prediction', async () => {
  const files = await walkTextFiles(EVAL_ROOT);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const pattern of CIRCULAR_PATTERNS) {
      assert.ok(!pattern.test(content), `${file} contains circular ground-truth language matching ${pattern}`);
    }
  }
});

test('fixture.yml rejects an unknown expected/reviewStatus field (ground truth cannot re-enter fixture.yml)', () => {
  const withExpected = {
    id: 'x',
    ecosystem: 'npm',
    dependency: 'fixture-lib',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    scenarioLabel: 'renamed-export',
    source: { repository: 'fixture-local', licence: 'MIT' },
    exposure: 'direct',
    oracles: {
      baseline: { command: 'npm test', expect: 'pass' },
      broken: { command: 'npm test', expect: 'fail' },
      repaired: { command: 'npm test', expect: 'pass' },
    },
    complexity: 'small',
    network: 'disabled',
    readiness: 'benchmark-ready',
    provenance: { kind: 'synthetic', createdAt: '2026-08-19', author: 'test' },
    // The field that must never be accepted again:
    expected: { upstreamFindings: ['sneaky:ground:truth'] },
  };
  assert.throws(() => fixtureSchema.parse(withExpected));
});

test('every benchmark-ready fixture on disk currently passes eval:review:validate', async () => {
  const problems = await validateReviews();
  const errors = problems.filter((p) => p.severity === 'error');
  assert.deepEqual(errors, [], `expected no validation errors, got: ${JSON.stringify(errors, null, 2)}`);
});

test('every fixture directory has a fixture.yml that parses under the current schema', async () => {
  const dirs = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  for (const dir of dirs.filter((d) => d.isDirectory())) {
    const body = await readFile(join(FIXTURES_ROOT, dir.name, 'fixture.yml'), 'utf8');
    assert.doesNotThrow(() => fixtureSchema.parse(YAML.parse(body)), `fixture ${dir.name} failed to parse`);
  }
});
