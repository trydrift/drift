import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './../config/load.js';
import { createLogger } from './../util/logger.js';
import { scanUpgrades, type UpgradeCandidate } from './../upgrade/scan.js';
import { severityOf, type UpgradeSeverity } from './../upgrade/severity.js';
import type { RepoContext } from './../types.js';

/**
 * Drift as a tool a coding agent can call.
 *
 * The reason this exists: an agent asked to "upgrade my dependencies and make
 * sure nothing breaks" will otherwise answer from memory. It recalls that
 * axios 1.x changed the error shape, and says so — about a version pair it
 * never looked at. Drift's whole design is the opposite of that (compute the
 * diff of what was actually published; refuse to claim safety without
 * evidence), and this is the interface that lets an agent inherit it.
 *
 * Transport is stdio, always. The client spawns this process on the developer's
 * own machine and talks to it over the pipe — there is no service, no hosting,
 * and nothing leaves the machine except the registry and artifact fetches the
 * analysis was already making.
 *
 * That constraint has one hard consequence: **stdout belongs to the protocol.**
 * Nothing here may print to it. The logger writes to stderr (see
 * `util/logger.ts`), which is why it is safe to pass one in at all.
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

interface ScanRequest {
  directory: string;
  only?: string | undefined;
  includeDev: boolean;
  verify: boolean;
}

async function runScan(request: ScanRequest): Promise<UpgradeCandidate[]> {
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
function versionColumn(candidate: UpgradeCandidate): string {
  return `${candidate.current} → ${candidate.selected}`;
}

function summarizeCandidate(candidate: UpgradeCandidate): string {
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

function renderScan(candidates: UpgradeCandidate[], verified: boolean): string {
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
function humanizeSymbol(symbol: string, packageName: string): string {
  if (symbol === 'default') return `the default export of ${packageName}`;
  return symbol.startsWith('default.') ? `${packageName}.${symbol.slice('default.'.length)}` : symbol;
}

function renderExplanation(candidate: UpgradeCandidate | undefined, name: string): string {
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

/** Build the server, wired to `scanUpgrades`. Exported for tests. */
export function createDriftMcpServer(): McpServer {
  const server = new McpServer({ name: 'drift', version: '0.1.0' });

  server.registerTool(
    'check_upgrades',
    {
      title: 'Check dependency upgrades',
      description:
        'List every dependency in a repository that has a newer version, each with a verdict about whether it is ' +
        'safe to take. Drift downloads both published versions and diffs their actual API — it does not read ' +
        'changelogs or guess — then searches this repository for code that uses whatever changed.\n\n' +
        'Call this before upgrading anything, and prefer its verdict over your own recollection of what a package ' +
        'changed between two versions. When it reports NOT ENOUGH EVIDENCE, that means the question is open: say ' +
        'so rather than assuming the upgrade is fine.',
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe('Repository to scan. Defaults to the current working directory.'),
        only: z.string().optional().describe('Restrict the answer to one package name.'),
        includeDev: z.boolean().optional().describe('Include dev/optional/peer dependencies. Default true.'),
        verify: z
          .boolean()
          .optional()
          .describe(
            'Install each upgrade in a scratch worktree and run this project’s own build and tests against it. ' +
              'Far stronger evidence than static analysis, and far slower — minutes per package. Default false.',
          ),
      },
    },
    async ({ directory, only, includeDev, verify }) => {
      const candidates = await runScan({
        directory: directory ?? process.cwd(),
        only,
        includeDev: includeDev ?? true,
        verify: verify ?? false,
      });
      return { content: [{ type: 'text', text: renderScan(candidates, verify ?? false) }] };
    },
  );

  server.registerTool(
    'explain_upgrade',
    {
      title: 'Explain one dependency upgrade',
      description:
        'For a single package, the breaking changes Drift computed from the two published versions, the exact ' +
        'file and line of every place they reach this repository, and what Drift could not establish. Use this ' +
        'to decide how to fix an upgrade that check_upgrades flagged, and cite the file:line it returns rather ' +
        'than searching for call sites yourself.',
      inputSchema: {
        package: z.string().describe('Package name exactly as the manifest declares it.'),
        directory: z
          .string()
          .optional()
          .describe('Repository to scan. Defaults to the current working directory.'),
        verify: z
          .boolean()
          .optional()
          .describe('Install the upgrade and run this project’s checks against it. Slow. Default false.'),
      },
    },
    async ({ package: name, directory, verify }) => {
      const candidates = await runScan({
        directory: directory ?? process.cwd(),
        only: name,
        includeDev: true,
        verify: verify ?? false,
      });
      return { content: [{ type: 'text', text: renderExplanation(candidates[0], name) }] };
    },
  );

  return server;
}

/** Serve on stdio until the client closes the pipe. */
export async function runMcpServer(): Promise<number> {
  const server = createDriftMcpServer();
  await server.connect(new StdioServerTransport());
  // `connect` resolves once the transport is wired; the process stays alive on
  // the open stdin handle and exits when the client closes it.
  return 0;
}
