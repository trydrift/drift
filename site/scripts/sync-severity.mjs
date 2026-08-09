#!/usr/bin/env node
/**
 * Copy the core verdict module into the site.
 *
 * The site must reach exactly the verdict the extension reaches — the first
 * version of this page reimplemented the rules and got them wrong in the way
 * that matters most, collapsing "a hundred upstream changes, none of which are
 * yours" into a generic pass. A TypeScript path alias to `../src` type-checks
 * but does not bundle: the file sits outside the Next project root, and
 * Turbopack will not reach across that boundary.
 *
 * So it is copied, on every build and every dev start. The copy is committed so
 * a fresh checkout type-checks before anything runs, and regenerated before
 * anything is bundled, which means a stale copy has a lifetime of zero builds.
 * `severity.ts` is dependency-free by design — that is stated in the file
 * itself — which is what makes copying it safe.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'src', 'upgrade', 'severity.ts');
const target = join(here, '..', 'src', 'lib', 'severity.ts');

const banner = `/*
 * GENERATED — do not edit.
 *
 * A verbatim copy of \`src/upgrade/severity.ts\` from the Drift core package,
 * refreshed by \`site/scripts/sync-severity.mjs\` before every build and dev
 * start. Edit the original; this file is overwritten.
 */

`;

const body = await readFile(source, 'utf8');
const next = banner + body;

// Only write when it actually changed: an unconditional write touches the mtime
// on every dev start, which is enough to make the watcher rebuild in a loop.
const current = await readFile(target, 'utf8').catch(() => null);
if (current !== next) {
  await writeFile(target, next, 'utf8');
  process.stderr.write('[sync-severity] updated src/lib/severity.ts\n');
}
