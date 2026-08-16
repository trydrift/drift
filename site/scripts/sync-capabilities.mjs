#!/usr/bin/env node
/**
 * Generate the site's copy of the capability matrix.
 *
 * The page makes a claim about every ecosystem Drift supports, and a claim
 * about how *well* it supports each. Both have to come from the same place the
 * CLI's own answers come from, or the page becomes marketing that decays —
 * and it decays in one direction, because nobody ever forgets to delete a
 * capability they lost.
 *
 * `src/detect/capabilities.ts` cannot be copied the way `severity.ts` is: it
 * imports the `Ecosystem` union from the core's type module, and a verbatim
 * copy would drag the whole type graph across a project boundary Turbopack
 * will not reach over. So it is *evaluated* here instead, at build time, and
 * what lands in the site is plain data with no imports at all — the same
 * levels, the same notes, the same computed tier, in a file that could be
 * checked by hand against `docs/support.md`.
 *
 * Run before every build and dev start, and the output is committed, so a
 * fresh checkout type-checks before anything runs and a stale copy has a
 * lifetime of zero builds.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const compiled = join(repoRoot, 'dist', 'detect', 'capabilities.js');
const target = join(here, '..', 'src', 'lib', 'capabilities.ts');

if (!existsSync(compiled)) {
  // The site can be built from a checkout where the core has not been compiled
  // — CI builds them separately, and a contributor editing CSS should not need
  // to run tsc first. The committed copy is what ships in that case.
  process.stderr.write('[sync-capabilities] dist/ not built; keeping the committed copy\n');
  process.exit(0);
}

const core = await import(compiled);

const rows = core.ECOSYSTEM_CAPABILITIES.map((capability) => ({
  ecosystem: capability.ecosystem,
  label: capability.label,
  tier: core.tierFor(capability.ecosystem),
  localizationBasis: capability.localizationBasis,
  files: capability.files,
  managers: capability.managers,
  support: Object.fromEntries(
    core.CAPABILITY_STAGES.map((stage) => [
      stage,
      {
        level: capability.support[stage].level,
        ...(capability.support[stage].note ? { note: capability.support[stage].note } : {}),
        ...(capability.support[stage].requires
          ? { requires: capability.support[stage].requires }
          : {}),
      },
    ]),
  ),
}));

const source = `/*
 * GENERATED — do not edit.
 *
 * Written by \`site/scripts/sync-capabilities.mjs\` from
 * \`src/detect/capabilities.ts\` in the Drift core, before every build and dev
 * start. Edit the original; this file is overwritten.
 */

export type SupportLevel = "full" | "partial" | "none";
export type SupportTier = ${core.ECOSYSTEM_CAPABILITIES.length > 0 ? '"deep" | "strong" | "working" | "limited"' : 'never'};
export type LocalizationBasis = "declared" | "published" | "convention";

export interface StageSupport {
  level: SupportLevel;
  note?: string;
  requires?: string;
}

export interface EcosystemCapability {
  ecosystem: string;
  label: string;
  tier: SupportTier;
  localizationBasis: LocalizationBasis;
  files: string[];
  managers: string[];
  support: Record<string, StageSupport>;
}

export const CAPABILITY_STAGES = ${JSON.stringify(core.CAPABILITY_STAGES)} as const;

export const STAGE_LABEL: Record<string, string> = ${JSON.stringify(core.STAGE_LABEL, null, 2)};

export const TIER_DESCRIPTION: Record<SupportTier, string> = ${JSON.stringify(core.TIER_DESCRIPTION, null, 2)};

export const ECOSYSTEM_CAPABILITIES: EcosystemCapability[] = ${JSON.stringify(rows, null, 2)};
`;

const current = await readFile(target, 'utf8').catch(() => null);
if (current !== source) {
  await writeFile(target, source, 'utf8');
  process.stderr.write('[sync-capabilities] updated src/lib/capabilities.ts\n');
}

await checkSpelledCount(rows.length);

/**
 * The one claim the generated matrix does not cover: the count, spelled out in
 * prose.
 *
 * "sixteen ecosystems" is a marketing claim like any other, and it is the kind
 * that decays silently — adding a seventeenth ecosystem is a good day, and
 * nobody grepping for a numeral would find the word. It decays in the direction
 * that matters, too: the page would keep undercounting what Drift actually
 * does. So the prose is checked against the data that generated the matrix, and
 * a mismatch fails the build with the word to change.
 */
async function checkSpelledCount(count) {
  const SPELLED = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
    'nineteen', 'twenty',
  ];
  const expected = SPELLED[count];
  if (!expected) return; // Past twenty, the prose will have been rewritten anyway.

  // Any other spelled number immediately before "ecosystem"/"supported"/"are",
  // which is how every one of these sentences is built today.
  const stale = new RegExp(`\\b(?!${expected}\\b)(${SPELLED.join('|')})\\b(?=[^.\\n]{0,40}\\becosystems?\\b)`, 'gi');

  const files = await sourceFiles(join(here, '..', 'src'));
  const wrong = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(stale)) {
      wrong.push(`${file.slice(repoRoot.length + 1)}: "${match[1]}" should be "${expected}"`);
    }
  }

  if (wrong.length > 0) {
    process.stderr.write(
      `[sync-capabilities] the page claims the wrong number of ecosystems (there are ${count}):\n` +
        wrong.map((w) => `  ${w}\n`).join(''),
    );
    process.exit(1);
  }
}

async function sourceFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
