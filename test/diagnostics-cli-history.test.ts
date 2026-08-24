import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactCommand, resolveGitDir, startRunLog } from '../dist/util/diagnostics.js';

const run = promisify(execFile);

test('CLI repository commands receive typed immutable diagnostic filenames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-cli-diag-history-'));
  try {
    await run('git', ['init', '-b', 'main'], { cwd: root });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await run('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(join(root, 'file.txt'), 'hello\n');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });

    const cases = [
      { argv: ['analyze'], mode: 'quick', prefix: 'run-analyze-quick-' },
      { argv: ['analyse'], mode: 'quick', prefix: 'run-analyze-quick-' },
      { argv: ['outdated'], mode: 'quick', prefix: 'run-dev-quick-' },
      { argv: ['outdated', '--no-dev', '--verify'], mode: 'deep', prefix: 'run-runtime-deep-' },
    ] as const;

    for (const entry of cases) {
      const log = startRunLog({ command: redactCommand(entry.argv), mode: entry.mode, repoRoot: root });
      assert.ok(log.path);
      assert.match(log.path!.split(/[\\/]/).pop()!, new RegExp(`^${entry.prefix}`));
      log.finish('ok');
    }

    const logs = (await readdir(join(resolveGitDir(root), 'drift'))).filter((name) => name.endsWith('.log'));
    assert.equal(logs.length, cases.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
