#!/usr/bin/env node
/**
 * The claims in the READMEs and docs, checked against the code that makes them.
 *
 * The release gate already carried an inline check for two stale *identity*
 * strings. That was the right instinct aimed at the smallest possible target:
 * the failures that actually shipped were claims about behaviour, not about a
 * name. The README advertised VS Code pull request creation via a
 * `drift.pullRequest` command the extension has never contributed, and told a
 * reader to export `GITHUB_TOKEN` in a section titled "try it with zero
 * permissions".
 *
 * So this checks the claims that can be checked mechanically:
 *
 *  - every `drift <command>` shown is one the CLI's own usage text accepts;
 *  - every `drift.<identifier>` shown is one the extension's manifest declares;
 *  - no stale identity strings (the original check, kept);
 *  - "unchecked" is never presented as "safe" or "up to date", which is the one
 *    thing Drift's whole verdict vocabulary exists to prevent.
 *
 * What it cannot check — whether a paragraph describing the Action's approval
 * default is *true* — is left to review. The point is that the mechanical
 * claims never quietly rot while attention is on the prose ones.
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Docs whose claims are public: the two READMEs and everything under docs/. */
async function documents() {
  const files = [join(repoRoot, 'README.md'), join(repoRoot, 'extension', 'README.md')];

  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.md')) files.push(path);
    }
  };
  await walk(join(repoRoot, 'docs'));
  await walk(join(repoRoot, 'extension', 'media'));

  return files;
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

/** Every `drift.*` identifier the extension's manifest declares. */
async function extensionIdentifiers() {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'extension', 'package.json'), 'utf8'));
  const contributes = manifest.contributes ?? {};
  return new Set([
    ...(contributes.commands ?? []).map((entry) => entry.command),
    ...Object.keys(contributes.configuration?.properties ?? {}),
    ...Object.values(contributes.views ?? {}).flat().map((entry) => entry.id),
    ...(contributes.walkthroughs ?? []).flatMap((entry) => [
      entry.id,
      ...(entry.steps ?? []).map((step) => step.id),
    ]),
  ]);
}

/**
 * Text a document presents as a command, not as prose.
 *
 * Only backtick spans and fenced blocks count. `drift` is also an English verb
 * and these documents use it as one; matching bare words would flag ordinary
 * sentences and teach everyone to ignore the check.
 */
function codeSpans(markdown) {
  const spans = [];
  for (const match of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    spans.push(...match[1].split('\n'));
  }
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) spans.push(match[1]);
  return spans;
}

const cli = await cliCommands();
const contributed = await extensionIdentifiers();

if (cli.size === 0) throw new Error('Parsed no commands out of src/cli.ts — the parser needs updating.');
if (contributed.size === 0) throw new Error('Parsed no identifiers out of the extension manifest.');

const identity = [
  ['RodolpheKouyoumdjian', /RodolpheKouyoumdjian/i],
  ['drift-dev (old org)', /drift-dev\/drift/],
];

/**
 * Wording that turns a gap into a pass.
 *
 * `unchecked` exists as a verdict because "we could not check this" and "this
 * is fine" are different facts, and the whole product argument collapses if the
 * documentation blurs them back together.
 */
const softening = [
  /unchecked[^.\n]{0,40}\b(safe|up to date|fine|clean|passed?)\b/gi,
  /\b(safe|up to date)\b[^.\n]{0,20}\bunchecked\b/gi,
  /\bnot verified\b[^.\n]{0,30}\b(safe|up to date)\b/gi,
];

/**
 * The sentences that put the two words together in order to hold them apart.
 *
 * "unchecked is not clean" and "unchecked — never as up to date" are the
 * documentation doing exactly the right thing, and a check that flagged them
 * would be a check nobody could keep passing honestly.
 */
const denial = /\b(not|never|rather than|isn't|is not|instead of|n['’]t)\b/i;

const failures = [];

for (const path of await documents()) {
  const where = relative(repoRoot, path);
  const text = await readFile(path, 'utf8');

  for (const [label, pattern] of identity) {
    if (pattern.test(text)) failures.push(`${where}: still references ${label}.`);
  }

  for (const pattern of softening) {
    for (const match of text.matchAll(pattern)) {
      if (denial.test(match[0])) continue;
      failures.push(
        `${where}: presents an unchecked result as a pass — "${match[0].trim()}". ` +
          `A gap is reported as a gap, never softened.`,
      );
    }
  }

  for (const span of codeSpans(text)) {
    const command = /^(?:\$ )?drift ([a-z][a-z-]*)/.exec(span.trim());
    if (command && !cli.has(command[1])) {
      failures.push(
        `${where}: documents \`drift ${command[1]}\`, which the CLI does not have. ` +
          `Usage lists: ${[...cli].sort().join(', ')}.`,
      );
    }

    for (const match of span.matchAll(/\bdrift\.[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*/g)) {
      const id = match[0];
      // `drift.yml` is a config file, `drift.drift` the Marketplace item id.
      if (/\.(yml|yaml|json|js|ts|tsx|md)$/.test(id) || id === 'drift.drift') continue;
      if (!contributed.has(id)) {
        failures.push(`${where}: names \`${id}\`, which the extension manifest does not declare.`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`check-docs: ${failures.length} stale claim(s)\n`);
  for (const failure of [...new Set(failures)]) console.error(`  ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('check-docs: every documented command and identifier exists, and no gap is sold as a pass.');
