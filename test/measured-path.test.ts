import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMeasuredPath } from '../dist/verification/measured-path.js';
import { parseVerificationDiagnostics } from '../dist/verification/diagnostics.js';

/**
 * A measured impact site must name a real file in the repository, whatever
 * shape of tool output the parser read it from. These cases are the shapes
 * that have produced false sites, plus the legitimate ones that must survive.
 */

let checkout: string;
let outside: string;

before(async () => {
  checkout = await mkdtemp(join(tmpdir(), 'drift-measured-'));
  outside = await mkdtemp(join(tmpdir(), 'drift-outside-'));
  await mkdir(join(checkout, 'src'), { recursive: true });
  await mkdir(join(checkout, 'test'), { recursive: true });
  await mkdir(join(checkout, 'packages', 'api', 'src'), { recursive: true });
  await mkdir(join(checkout, '.git', 'drift-worktrees', 'w1', 'src'), { recursive: true });
  await writeFile(join(checkout, 'src', 'foo.ts'), 'export {};\n');
  await writeFile(join(checkout, 'test', 'files.test.js'), '\n');
  await writeFile(join(checkout, 'packages', 'api', 'src', 'index.ts'), '\n');
  await writeFile(join(checkout, '.git', 'drift-worktrees', 'w1', 'src', 'foo.ts'), '\n');
  await writeFile(join(outside, 'secret.ts'), '\n');
  await symlink(join(outside, 'secret.ts'), join(checkout, 'src', 'escape.ts'));
});

describe('resolveMeasuredPath', () => {
  test('Node test-runner output never becomes a site, though the file it mentions exists', async () => {
    const [diagnostic] = parseVerificationDiagnostics('✖ test/files.test.js (166ms)\ntest at test/files.test.js:1:1\n');
    assert.equal(diagnostic?.file, 'test at test/files.test.js', 'the parser still reads the shape; the boundary rejects it');
    assert.equal(await resolveMeasuredPath(checkout, '', diagnostic!.file), null);
  });

  test('a JavaScript stack frame never becomes a site', async () => {
    assert.deepEqual(parseVerificationDiagnostics(`    at Object.<anonymous> (${checkout}/src/foo.ts:1:2561)`), []);
    assert.equal(await resolveMeasuredPath(checkout, '', `at Object.<anonymous> (${checkout}/src/foo.ts`), null);
  });

  test('a real compiler diagnostic resolves to its repository path', async () => {
    const [diagnostic] = parseVerificationDiagnostics("src/foo.ts:12:3 - error TS2339: Property 'x' does not exist.");
    assert.equal(await resolveMeasuredPath(checkout, '', diagnostic!.file), 'src/foo.ts');
  });

  test('a member-relative path resolves under the member, and a root-relative one from the root', async () => {
    assert.equal(await resolveMeasuredPath(checkout, 'packages/api', 'src/index.ts'), 'packages/api/src/index.ts');
    assert.equal(await resolveMeasuredPath(checkout, 'packages/api', 'packages/api/src/index.ts'), 'packages/api/src/index.ts');
  });

  test('an absolute path inside the checkout is made repository-relative', async () => {
    assert.equal(await resolveMeasuredPath(checkout, '', join(checkout, 'src', 'foo.ts')), 'src/foo.ts');
  });

  test('an absolute path outside the checkout is rejected', async () => {
    assert.equal(await resolveMeasuredPath(checkout, '', join(outside, 'secret.ts')), null);
  });

  test('a symlink that leaves the checkout is rejected', async () => {
    assert.equal(await resolveMeasuredPath(checkout, '', 'src/escape.ts'), null);
  });

  test('a path into a verification worktree under .git is not a repository file', async () => {
    assert.equal(await resolveMeasuredPath(checkout, '', join(checkout, '.git', 'drift-worktrees', 'w1', 'src', 'foo.ts')), null);
  });

  test('a plausible but nonexistent relative path is rejected', async () => {
    assert.equal(await resolveMeasuredPath(checkout, '', 'src/bar.ts'), null);
    assert.equal(await resolveMeasuredPath(checkout, '', '../outside.ts'), null);
    assert.equal(await resolveMeasuredPath(checkout, '', 'src'), null, 'a directory is not a file');
  });
});
