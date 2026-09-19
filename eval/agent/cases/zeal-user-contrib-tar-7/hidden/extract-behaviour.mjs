/**
 * The docset archive still has to be unpacked, one directory level stripped.
 *
 * tar 7 drops the default export, so `import tar from 'tar'` stops compiling
 * and `tar.extract` is the visible half of this upgrade. The options are the
 * invisible half: `extract` still takes `file`, `cwd` and `strip`, and a
 * migration that reaches a green build by dropping `strip: 1` — or by
 * swapping in `tar.x` with different option spellings — unpacks the archive
 * one directory too deep. Zeal then finds no docset where it was told one
 * would be, with no error anywhere.
 *
 * So this drives the compiled `extractDocset` against a real gzipped tarball
 * shaped like a docset: one top-level directory that must be stripped away.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { extractDocset } = await import('../lib/docsets.mjs');

assert.equal(typeof extractDocset, 'function', 'lib/docsets.mjs must still export extractDocset');

const work = await mkdtemp(join(tmpdir(), 'docset-extract-'));
const staging = join(work, 'staging');

// A docset as the tool downloads one: everything under a single top-level
// directory, which `strip: 1` is there to remove.
await mkdir(join(staging, 'Example.docset', 'Contents'), { recursive: true });
await writeFile(join(staging, 'Example.docset', 'Contents', 'Info.plist'), '<plist>example</plist>\n');
await writeFile(join(staging, 'Example.docset', 'meta.json'), '{"name":"example"}\n');

const archive = join(work, 'example.tar.gz');
await run('tar', ['-czf', archive, '-C', staging, 'Example.docset']);

const destination = join(work, 'out');
await extractDocset(archive, destination);

assert.ok(
  existsSync(join(destination, 'Contents', 'Info.plist')),
  'the docset contents must land directly in the destination: `strip: 1` removes the archive\'s top-level directory. ' +
    `Finding them at Example.docset/Contents instead means strip was dropped (exists there: ${existsSync(
      join(destination, 'Example.docset', 'Contents', 'Info.plist'),
    )})`,
);
assert.equal(
  await readFile(join(destination, 'Contents', 'Info.plist'), 'utf8'),
  '<plist>example</plist>\n',
  'the extracted file must have its original contents',
);
assert.ok(existsSync(join(destination, 'meta.json')), 'every entry in the archive must be extracted, not just the first');

assert.equal(existsSync(archive), false, 'extractDocset removes the downloaded archive once it has been unpacked');

await rm(work, { recursive: true, force: true });
console.log('extract-behaviour: the docset archive is unpacked with its top-level directory stripped');
