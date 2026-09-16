import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditWorkspace } from './workspace.ts';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';

/**
 * The boundary: nothing that builds a prompt or drives the agent may read the
 * private half of a case, and no workspace handed to an agent may contain it.
 */
describe('hidden-test isolation', () => {
  test('prompt, provider and Drift-context modules never touch the hidden loader', async () => {
    const dir = import.meta.dirname;
    const files = ['task.ts', 'drift-context.ts', ...(await readdir(join(dir, 'providers'))).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join('providers', f))];
    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8');
      assert.doesNotMatch(source, /loadHidden|hiddenDir|referencePatch|hidden\.yml/, `${file} reaches private material`);
    }
  });

  test('the workspace audit rejects private-looking paths and escaping symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-agent-audit-'));
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), '');
    assert.equal(await auditWorkspace(repo, join(root, 'case')), 2);

    await mkdir(join(repo, 'hidden'));
    await assert.rejects(auditWorkspace(repo, join(root, 'case')), /private-looking path hidden/);
    await (await import('node:fs/promises')).rm(join(repo, 'hidden'), { recursive: true });

    await writeFile(join(repo, 'reference.patch'), '');
    await assert.rejects(auditWorkspace(repo, join(root, 'case')), /reference\.patch/);
    await (await import('node:fs/promises')).rm(join(repo, 'reference.patch'));

    await symlink(root, join(repo, 'escape'));
    await assert.rejects(auditWorkspace(repo, join(root, 'case')), /outside the workspace/);
  });

  test('a workspace inside the case directory is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-agent-audit-'));
    const repo = join(root, 'case', 'repo');
    await mkdir(repo, { recursive: true });
    await assert.rejects(auditWorkspace(repo, join(root, 'case')), /overlaps/);
  });
});
