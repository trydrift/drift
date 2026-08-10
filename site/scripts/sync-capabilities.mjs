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
