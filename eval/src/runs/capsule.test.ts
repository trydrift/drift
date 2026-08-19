import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashCapsuleDir, hashPublicCapsule } from './capsule.ts';
import { publicCaseDir } from '../case/load.ts';
import { privateCaseDir } from '../case/private.ts';

/**
 * What must, and must not, invalidate a paid prediction.
 *
 * The failure this guards against is quiet: an artifact bound to `case.yml`
 * alone stays "current" while the consumer source, the upstream `.d.ts`, the
 * frozen evidence and the before-manifest all change underneath it, so an old
 * trial gets re-scored against evidence it never saw and nothing says so.
 *
 * The tests run against the real corpus rather than a toy tree, because the
 * property has to hold for the directory layout the benchmark actually has.
 */

const CASE_ID = 'npm-documented-rename';

async function capsuleCopy(): Promise<{ dir: string; baseline: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'drift-capsule-hash-'));
  const dir = join(root, 'capsule');
  await cp(publicCaseDir(CASE_ID), dir, { recursive: true });
  return { dir, baseline: await hashCapsuleDir(dir), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('the hash is deterministic and matches a byte-identical copy of the same capsule', async () => {
  const a = await capsuleCopy();
  const b = await capsuleCopy();
  try {
    assert.equal(a.baseline, await hashCapsuleDir(a.dir), 'recomputing must give the same answer');
    assert.equal(a.baseline, b.baseline, 'two copies of the same capsule must agree');
    assert.equal(a.baseline, await hashPublicCapsule(CASE_ID), 'a copy must agree with the corpus it came from');
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

const MUTATIONS: { name: string; apply: (dir: string) => Promise<void> }[] = [
  {
    name: 'consumer source',
    apply: async (dir) => {
      const path = join(dir, 'consumer', 'src', 'app.js');
      await writeFile(path, `${await readFile(path, 'utf8')}\n// a later edit\n`, 'utf8');
    },
  },
  {
    name: 'upstream .d.ts',
    apply: async (dir) => {
      const path = join(dir, 'upstream', 'new', 'index.d.ts');
      await writeFile(path, 'export declare function query(name: string): string | null;\n', 'utf8');
    },
  },
  {
    name: 'public evidence',
    apply: async (dir) => {
      const path = join(dir, 'evidence', 'CHANGELOG.md');
      await writeFile(path, `${await readFile(path, 'utf8')}\n- and one more breaking change.\n`, 'utf8');
    },
  },
  {
    name: 'before manifest',
    apply: async (dir) => {
      const path = join(dir, 'before', 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { dependencies: Record<string, string> };
      manifest.dependencies['fixture-lib'] = '0.9.0';
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    },
  },
  {
    name: 'case.yml',
    apply: async (dir) => {
      const path = join(dir, 'case.yml');
      await writeFile(path, (await readFile(path, 'utf8')).replace('ecosystem: npm', 'ecosystem: npm-edited'), 'utf8');
    },
  },
  {
    name: 'a new public file nobody declared',
    apply: async (dir) => {
      await writeFile(join(dir, 'consumer', 'src', 'extra.js'), 'export const extra = 1;\n', 'utf8');
    },
  },
  {
    name: 'a file moved to a different path with identical content',
    apply: async (dir) => {
      const from = join(dir, 'consumer', 'src', 'app.js');
      const content = await readFile(from, 'utf8');
      await rm(from);
      await writeFile(join(dir, 'consumer', 'src', 'main.js'), content, 'utf8');
    },
  },
];

for (const mutation of MUTATIONS) {
  test(`changing the ${mutation.name} invalidates an artifact bound to the old capsule`, async () => {
    const capsule = await capsuleCopy();
    try {
      await mutation.apply(capsule.dir);
      assert.notEqual(await hashCapsuleDir(capsule.dir), capsule.baseline);
    } finally {
      await capsule.cleanup();
    }
  });
}

test('regenerable and run-state directories are excluded, so an install cannot change the hash', async () => {
  const capsule = await capsuleCopy();
  try {
    await mkdir(join(capsule.dir, 'consumer', 'node_modules', 'fixture-lib'), { recursive: true });
    await writeFile(join(capsule.dir, 'consumer', 'node_modules', 'fixture-lib', 'index.js'), 'installed\n', 'utf8');
    await mkdir(join(capsule.dir, '.git'), { recursive: true });
    await writeFile(join(capsule.dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await writeFile(join(capsule.dir, '.DS_Store'), 'noise', 'utf8');

    assert.equal(await hashCapsuleDir(capsule.dir), capsule.baseline);
  } finally {
    await capsule.cleanup();
  }
});

test('private truth is structurally outside the capsule, so changing an adjudication cannot stale a prediction', async () => {
  const before = await hashPublicCapsule(CASE_ID);

  const path = join(privateCaseDir(CASE_ID), 'adjudication.yml');
  const original = await readFile(path, 'utf8');
  try {
    // A real edit of the kind adjudication is *meant* to receive: a reviewer
    // revising the accepted decision after the prediction was made. Evaluation
    // truth is allowed to improve independently of what the predictor saw, and
    // an evaluator that treated this as evidence staleness would discard the
    // very trials the correction exists to re-score.
    await writeFile(path, original.replace('groundTruthSafety: unsafe', 'groundTruthSafety: uncertain'), 'utf8');
    assert.equal(await hashPublicCapsule(CASE_ID), before);
  } finally {
    await writeFile(path, original, 'utf8');
  }
});

test('changing a hidden behavioural check does not stale a prediction either', async () => {
  const before = await hashPublicCapsule(CASE_ID);
  const path = join(privateCaseDir(CASE_ID), 'hidden', 'behaviour.mjs');
  const original = await readFile(path, 'utf8');
  try {
    await writeFile(path, `${original}\n// a stricter assertion, added later\n`, 'utf8');
    assert.equal(
      await hashPublicCapsule(CASE_ID),
      before,
      'a hidden check is ground truth, not prediction evidence — its revision is tracked by review staleness, not by capsule staleness',
    );
  } finally {
    await writeFile(path, original, 'utf8');
  }
});
