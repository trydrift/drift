#!/usr/bin/env node
/**
 * Regenerate `docs/support.md` from the capability data.
 *
 * Run via `npm run docs:support`. A test asserts the checked-in file matches
 * this output, so forgetting to run it fails the build rather than shipping a
 * table that quietly overstates what Drift does.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderSupportMatrix } from '../dist/report/support.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'docs', 'support.md');

await writeFile(target, renderSupportMatrix(), 'utf8');
console.log(`Wrote ${target}`);
