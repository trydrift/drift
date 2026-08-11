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

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const siteSrc = join(here, '..', 'src');

/** The `args` strings from the site's animated terminal. */
async function terminalCommands() {
  const source = await readFile(join(siteSrc, 'components', 'terminal.tsx'), 'utf8');
  const block = /const COMMANDS: Command\[\] = \[([\s\S]*?)\];/.exec(source);
  if (!block) throw new Error('Could not find the COMMANDS list in terminal.tsx');

  return [...block[1].matchAll(/args:\s*"([^"]+)"/g)].map((match) => match[1].split(/\s+/)[0]);
}

/** Every source file the site's copy can live in. */
async function siteSources() {
  const files = [];

  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      // `.json` recordings are skipped: they are captured output, a record of
      // what a real run printed, not copy anyone can fix by editing it.
      if (/\.(tsx?|mdx?)$/.test(entry.name)) files.push(path);
    }
  };

  await walk(siteSrc);
  return files;
}

/**
 * Text the page renders as a command rather than as prose.
 *
 * The distinction matters because `drift` is also an English verb, and this
 * codebase uses it as one ("a chance to drift a few frames out"). Matching
 * bare words would flag that sentence and teach everyone to ignore the check.
 * So only text the site has itself marked as code counts: a backtick span, a
 * `<code>` element, or a string literal that begins with the binary's name.
 */
function commandLikeText(source) {
  const snippets = [];
  for (const pattern of [
    /`([^`\n]*)`/g,
    /<code[^>]*>([^<]*)<\/code>/g,
    /["']((?:\$ )?drift [^"'\n]*)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) snippets.push(match[1]);
  }
  return snippets;
}

/**
 * Every `drift <something>` the site presents as a runnable command.
 *
 * The original check guarded one array in `terminal.tsx`, because that array
 * was where the invented command had been found. But copy moves: a command
 * named in a hero, a card, or a caption is exactly as public a claim as one in
 * the replay, and would have gone unchecked.
 */
async function writtenCommands() {
  const found = new Map();

  for (const path of await siteSources()) {
    const source = await readFile(path, 'utf8');
    for (const snippet of commandLikeText(source)) {
      // `/drift apply` is the Action's issue comment, not a CLI command.
      const match = /^(?:\$ )?drift ([a-z][a-z-]*)/.exec(snippet.trim());
      if (match && !found.has(match[1])) found.set(match[1], path);
    }
  }

  return found;
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

/**
 * Every `drift.*` identifier the extension actually contributes.
 *
 * The root README advertised a `drift.pullRequest` command; no such command
 * has ever existed. An identifier is the most checkable claim documentation
 * can make — it either appears in the manifest or it does not — so there is no
 * excuse for one going stale.
 */
async function extensionIdentifiers() {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, 'extension', 'package.json'), 'utf8'),
  );
  return new Set([
    ...(manifest.contributes?.commands ?? []).map((entry) => entry.command),
    ...Object.keys(manifest.contributes?.configuration?.properties ?? {}),
    ...(manifest.contributes?.views?.drift ?? []).map((entry) => entry.id),
    ...(manifest.contributes?.walkthroughs ?? []).map((entry) => entry.id),
  ]);
}

/**
 * `drift.<something>` references written into the site's copy.
 *
 * `drift.yml` is a config file and `drift.drift` is the Marketplace item id —
 * neither is an identifier the manifest declares, and both are correct where
 * they appear, so they are excluded by shape rather than by an allowlist that
 * would have to grow.
 */
async function referencedIdentifiers() {
  const found = new Map();

  for (const path of await siteSources()) {
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/\bdrift\.[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*/g)) {
      const id = match[0];
      if (/\.(yml|yaml|json|js|ts|tsx|md)$/.test(id)) continue;
      if (id === 'drift.drift') continue;
      if (!found.has(id)) found.set(id, path);
    }
  }

  return found;
}

const cli = await cliCommands();

if (cli.size === 0) {
  console.error('check-commands: parsed no commands out of src/cli.ts — the parser needs updating.');
  process.exit(1);
}

const failures = [];

const terminal = await terminalCommands();
const written = await writtenCommands();
const shown = new Map(written);
for (const command of terminal) if (!shown.has(command)) shown.set(command, 'terminal.tsx');

const invented = [...shown].filter(([command]) => !cli.has(command));
if (invented.length > 0) {
  failures.push(
    `The site advertises ${invented.length} CLI command(s) that do not exist:\n` +
      invented.map(([command, where]) => `  drift ${command}  (${where})`).join('\n') +
      `\nThe CLI's usage text lists: ${[...cli].sort().join(', ')}.`,
  );
}

const contributed = await extensionIdentifiers();
const referenced = await referencedIdentifiers();
const missing = [...referenced].filter(([id]) => !contributed.has(id));
if (missing.length > 0) {
  failures.push(
    `The site names ${missing.length} extension identifier(s) the manifest does not declare:\n` +
      missing.map(([id, where]) => `  ${id}  (${where})`).join('\n') +
      `\nCheck extension/package.json's contributes block.`,
  );
}

if (failures.length > 0) {
  console.error(`check-commands:\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}

console.log(
  `check-commands: all ${shown.size} CLI command(s) and ${referenced.size} extension identifier(s) ` +
    `shown on the site exist.`,
);
