import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitDir, startRunLog } from '../dist/util/diagnostics.js';

const run = promisify(execFile);

test('existing vscode analyze operations retain a new typed log on every run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-vscode-history-'));
  try {
    await run('git', ['init', '-b', 'main'], { cwd: root });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await run('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(join(root, 'file.txt'), 'hello\n');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-m', 'initial'], { cwd: root });

    const first = startRunLog({ command: 'vscode: drift.analyze', mode: 'quick', repoRoot: root });
    first.finish('ok');
    const second = startRunLog({ command: 'vscode: drift.analyze', mode: 'quick', repoRoot: root });
    second.finish('ok');

    assert.ok(first.path);
    assert.ok(second.path);
    assert.notEqual(first.path, second.path);
    assert.match(first.path!.split(/[\\/]/).pop()!, /^run-analyze-/);
    assert.match(second.path!.split(/[\\/]/).pop()!, /^run-analyze-/);

    const dir = join(resolveGitDir(root), 'drift');
    const logs = (await readdir(dir)).filter((name) => name.endsWith('.log')).sort();
    assert.equal(logs.length, 2);
    for (const name of logs) {
      const contents = await readFile(join(dir, name), 'utf8');
      assert.match(contents, /type: analyze/);
      assert.match(contents, /mode: quick/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
