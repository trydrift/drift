import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadConfig } from '../config/load.js';
import { createLogger } from '../util/logger.js';
import { scanUpgrades, type UpgradeCandidate } from './scan.js';
import { severityOf, type UpgradeSeverity } from './severity.js';
import type { RepoContext } from '../types.js';

/**
 * One scan, rendered for a reader who is not looking at a terminal.
 *
 * Shared by `drift explain` and by the MCP tools, which need the same two
 * answers in the same words: what upgrades are pending and what each verdict
 * means, and — for one package — what changed and where it lands. The CLI's
 * own `outdated` view is a different thing: it is a live table with colour and
 * a status line, written for someone watching it fill in.
 */

/** Ordered worst-first, which is the order a reader should meet them in. */
const SEVERITY_ORDER: UpgradeSeverity[] = [
  'affected',
  'verification-failed',
  'review-required',
  'runtime-unresolved',
  'localization-incomplete',
  'evidence-missing',
  'upstream-only',
  'clean',
  'pending',
  'error',
];

/**
 * What each severity means, in the words an agent should repeat to a developer.
 *
 * Deliberately not the CLI's own labels: those are written to be read beside a
 * colour and a glyph in a table. These have to survive being quoted on their
 * own, in the middle of a sentence, by a model that did not see the table.
 */
const SEVERITY_HEADINGS: Record<UpgradeSeverity, string> = {
  affected: 'BREAKS THIS CODE — a breaking change with located call sites in this repository',
  'verification-failed': 'BREAKS THIS CODE — measured: this project’s own checks passed before the upgrade and fail after it',
  'runtime-unresolved': 'NEEDS REVIEW — the new version’s runtime requirement could not be reconciled with this project’s',
  clean: 'SAFE TO TAKE — no incompatible change found in the surfaces Drift checked',
  'upstream-only': 'SAFE FOR THIS REPO — the library broke compatibility, but nothing here uses what changed',
  'review-required': 'NEEDS REVIEW — a real breaking change that reaches this code',
  'localization-incomplete': 'NEEDS REVIEW — a real breaking change, and Drift could not finish searching this repo',
  'evidence-missing': 'NOT ENOUGH EVIDENCE — Drift could not establish whether this is safe. Do not assume it is.',
  pending: 'NOT ANALYSED',
  error: 'FAILED TO ANALYSE',
};

export interface ScanRequest {
  directory: string;
  only?: string | undefined;
  includeDev: boolean;
  verify: boolean;
}

export async function runScan(request: ScanRequest): Promise<UpgradeCandidate[]> {
  const workspace = resolve(request.directory);
  // Quiet by default: `error` still reaches stderr, where a client shows it as
  // server output, and nothing routine competes with the protocol on stdout.
  const logger = createLogger('error');

  const { config } = await loadConfig(async (candidate) => {
    try {
      return await readFile(resolve(workspace, candidate), 'utf8');
    } catch {
      return null;
    }
  });

  const repo: RepoContext = {
    owner: 'local',
    repo: 'workspace',
    baseBranch: 'HEAD',
    beforeSha: 'HEAD',
    afterSha: 'HEAD',
    workspace,
  };

  const result = await scanUpgrades({
    root: workspace,
    repo,
    config,
    logger,
    breadth: { includeDev: request.includeDev, maxSites: 40, maxPackages: 0 },
    // Off unless asked for. Deep verification installs the upgrade and runs the
    // project's own build and tests, which is minutes per package — far past
    // what a tool call should cost by default. The tool description says so, so
    // an agent can choose to pay it.
    verify: { enabled: request.verify && config.verify.enabled },
  });

  // `clean` here is the scan's own "already current" state, not a verdict.
  const candidates = result.candidates.filter((candidate) => candidate.selected !== candidate.current);
  if (!request.only) return candidates;
  const wanted = request.only.toLowerCase();
  return candidates.filter((candidate) => candidate.name.toLowerCase() === wanted);
}

/** `express  4.18.2 → 5.1.0` padded into a column, without depending on a table renderer. */
export function versionColumn(candidate: UpgradeCandidate): string {
  return `${candidate.current} → ${candidate.selected}`;
}

export function summarizeCandidate(candidate: UpgradeCandidate): string {
  const facts: string[] = [];
  if (candidate.breakingCount > 0) {
    facts.push(`${candidate.breakingCount} breaking change${candidate.breakingCount === 1 ? '' : 's'} upstream`);
  }
  if (candidate.impactCount > 0) {
    facts.push(
      `${candidate.impactCount} site${candidate.impactCount === 1 ? '' : 's'} in ${candidate.impactFiles} file${candidate.impactFiles === 1 ? '' : 's'}`,
    );
  }
  if (candidate.gaps.length > 0) facts.push(candidate.gaps[0]!);
  return facts.length > 0 ? facts.join('; ') : candidate.summary;
}

export function renderScan(candidates: UpgradeCandidate[], verified: boolean): string {
  if (candidates.length === 0) {
    return 'Every dependency Drift could check is already at its selected version. Nothing to upgrade.';
  }

  const grouped = new Map<UpgradeSeverity, UpgradeCandidate[]>();
  for (const candidate of candidates) {
    const severity = severityOf(candidate);
    const bucket = grouped.get(severity);
    if (bucket) bucket.push(candidate);
    else grouped.set(severity, [candidate]);
  }

  const width = Math.max(...candidates.map((candidate) => candidate.name.length));
  const lines: string[] = [
    `${candidates.length} dependenc${candidates.length === 1 ? 'y has' : 'ies have'} a newer version.`,
    verified
      ? 'Verified: each upgrade was installed in a scratch worktree and this project’s own checks were run against it.'
      : 'Static analysis only — no build was run. Ask for verify:true to install each upgrade and run this project’s checks.',
    '',
  ];

  for (const severity of SEVERITY_ORDER) {
    const bucket = grouped.get(severity);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`${SEVERITY_HEADINGS[severity]} (${bucket.length})`);
    for (const candidate of bucket) {
      lines.push(`  ${candidate.name.padEnd(width)}  ${versionColumn(candidate)}  — ${summarizeCandidate(candidate)}`);
    }
    lines.push('');
  }

  lines.push(
    'Call explain_upgrade with a package name for the changed symbols, the exact call sites, and the evidence behind them.',
  );
  return lines.join('\n');
}

/**
 * `default.sync` reads as `glob.sync`.
 *
 * A package published through `export =` or `export default` names its API
 * `default` — correct, and the only name localization can bind, but not a
 * string any developer has ever typed. The importing file picks its own name
 * for the module, and the package name is the one it almost always picks.
 */
export function humanizeSymbol(symbol: string, packageName: string): string {
  if (symbol === 'default') return `the default export of ${packageName}`;
  return symbol.startsWith('default.') ? `${packageName}.${symbol.slice('default.'.length)}` : symbol;
}

export function renderExplanation(candidate: UpgradeCandidate | undefined, name: string): string {
  if (!candidate) {
    return `Drift found no pending upgrade for "${name}" in this repository. It may already be current, or not be a direct dependency.`;
  }

  const lines: string[] = [
    `${candidate.name}  ${versionColumn(candidate)}  (${candidate.ecosystem}, declared in ${candidate.manifestPath})`,
    '',
    `Verdict: ${SEVERITY_HEADINGS[severityOf(candidate)]}`,
    candidate.summary,
    '',
  ];

  const plan = candidate.plan;
  const breaking = plan?.breakingChanges ?? [];
  if (breaking.length > 0) {
    lines.push(`Breaking changes upstream (${breaking.length}):`);
    for (const change of breaking.slice(0, 25)) {
      const shown = change.symbols.slice(0, 3).map((symbol) => humanizeSymbol(symbol, candidate.name));
      lines.push(`  [${change.kind}] ${shown.join(', ') || change.summary}`);
      if (change.summary && change.symbols.length > 0) lines.push(`      ${change.summary}`);
    }
    if (breaking.length > 25) lines.push(`  … and ${breaking.length - 25} more.`);
    lines.push('');
  }

  const sites = plan?.impactSites ?? [];
  if (sites.length > 0) {
    lines.push(`Where it reaches this repository (${sites.length}):`);
    for (const site of sites.slice(0, 40)) {
      const kind = site.siteKind === 'manifest' ? ' [dependency declaration, not a call site]' : '';
      lines.push(`  ${site.file}:${site.line}  ${humanizeSymbol(site.matchedSymbol, candidate.name)}${kind}`);
      if (site.excerpt) lines.push(`      ${site.excerpt.trim()}`);
    }
    if (sites.length > 40) lines.push(`  … and ${sites.length - 40} more.`);
    lines.push('');
  } else if (breaking.length > 0) {
    lines.push(
      'Drift found no call site for these changes in this repository. That is not proof there is none —',
      'localization is a search, and it can miss dynamic dispatch, re-exports and inferred types.',
      '',
    );
  }

  if (candidate.gaps.length > 0) {
    lines.push('What Drift could not establish:');
    for (const gap of candidate.gaps) lines.push(`  - ${gap}`);
  }

  return lines.join('\n');
}

