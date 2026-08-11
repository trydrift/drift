#!/usr/bin/env node
/**
 * Every CLI command the site shows must be one the CLI actually has.
 *
 * The terminal component carried a comment promising exactly this, directly
 * above a list containing `drift audit` — a command that had been removed.
 * That is the worst kind of stale copy: a confident claim of accuracy attached
 * to something inaccurate, on the page whose entire argument is that Drift
 * does not decorate.
 *
 * A comment cannot enforce anything, so this does. It reads the command list
 * out of the site and the command list out of `src/cli.ts`'s own usage text,
 * and fails if the site names one the CLI does not accept. Wired into the
 * site's build, so the page cannot ship advertising a command that no longer
 * exists.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** The `args` strings from the site's animated terminal. */
async function siteCommands() {
  const source = await readFile(join(here, '..', 'src', 'components', 'terminal.tsx'), 'utf8');
  const block = /const COMMANDS: Command\[\] = \[([\s\S]*?)\];/.exec(source);
  if (!block) throw new Error('Could not find the COMMANDS list in terminal.tsx');

  return [...block[1].matchAll(/args:\s*"([^"]+)"/g)].map((match) => match[1].split(/\s+/)[0]);
}

/**
 * The commands the CLI documents in its own usage text.
 *
 * Parsed from `USAGE` rather than from the `switch`, because usage is what a
 * user is told exists, and a command missing from it is its own bug.
 */
async function cliCommands() {
  const source = await readFile(join(repoRoot, 'src', 'cli.ts'), 'utf8');
  const usage = /const USAGE = `([\s\S]*?)`\.trim\(\);/.exec(source);
  if (!usage) throw new Error('Could not find the USAGE string in src/cli.ts');

  const lines = usage[1].split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Usage:');
  if (start < 0) throw new Error('Could not find the Usage: block in src/cli.ts');

  const found = new Set();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const match = /^\s+drift\s+([a-z-]+)/.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

const site = await siteCommands();
const cli = await cliCommands();

if (cli.size === 0) {
  console.error('check-commands: parsed no commands out of src/cli.ts — the parser needs updating.');
  process.exit(1);
}

const invented = site.filter((command) => !cli.has(command));

if (invented.length > 0) {
  console.error(
    `check-commands: the site advertises ${invented.length} command(s) the CLI does not have: ` +
      `${invented.join(', ')}.\n` +
      `The CLI's usage text lists: ${[...cli].sort().join(', ')}.\n` +
      `Fix site/src/components/terminal.tsx, or add the command to the CLI.`,
  );
  process.exit(1);
}

console.log(`check-commands: all ${site.length} command(s) shown on the site exist in the CLI.`);
