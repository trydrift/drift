import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resetPartialUnlessResuming } from './cli.ts';

/**
 * `checkpoint` only ever appends to `cases.partial.jsonl`. A fresh
 * (non-`--resume`) run that reuses a run id therefore has to clear whatever
 * an earlier attempt left behind, or a later `--resume` would silently merge
 * observations from that unrelated attempt into what it presents as one
 * continuous run.
 */

test('a fresh run clears a stale checkpoint from an earlier attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-cli-test-'));
  try {
    const partialPath = join(dir, 'cases.partial.jsonl');
    await writeFile(partialPath, '{"caseId":"stale"}\n', 'utf8');

    await resetPartialUnlessResuming(partialPath, false);

    assert.equal(existsSync(partialPath), false, 'a fresh run must not inherit an earlier attempt\'s checkpoint');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a resumed run keeps its checkpoint untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-cli-test-'));
  try {
    const partialPath = join(dir, 'cases.partial.jsonl');
    await writeFile(partialPath, '{"caseId":"kept"}\n', 'utf8');

    await resetPartialUnlessResuming(partialPath, true);

    const contents = await readFile(partialPath, 'utf8');
    assert.match(contents, /kept/, '--resume must still see the earlier attempt\'s observations');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no checkpoint present is not an error, resuming or not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-cli-test-'));
  try {
    const partialPath = join(dir, 'cases.partial.jsonl');
    await resetPartialUnlessResuming(partialPath, false);
    await resetPartialUnlessResuming(partialPath, true);
    assert.equal(existsSync(partialPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
