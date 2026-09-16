import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { runScan, renderScan, renderExplanation } from '../upgrade/explain.js';
import { runInstalledCheck, renderInstalledCheck } from '../upgrade/run-installed-check.js';
import { AgentPlanSession, registerAgentTools } from './agent-tools.js';

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

/**
 * The version an agent's client shows beside "drift" in its list of servers.
 *
 * Read from the package rather than written here. A hardcoded string is one
 * more thing every release has to remember, and this one was forgotten: it
 * still said 0.1.0 while the published CLI was 0.1.5, so every editor that
 * connected was told a version that had not existed for five releases.
 */
function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Build the server, wired to `scanUpgrades`. Exported for tests.
 *
 * `session` holds the agent tools' plans; tests pass one with a fixture
 * planner so the protocol can be exercised without running an analysis.
 */
export function createDriftMcpServer(session?: AgentPlanSession): McpServer {
  const server = new McpServer({ name: 'drift', version: serverVersion() });

  server.registerTool(
    'check_upgrades',
    {
      title: 'Check dependency upgrades',
      description:
        'List every dependency in a repository that has a newer version, each with a verdict about whether it is ' +
        'safe to take. Drift inspects the published artifacts and release evidence available for both versions, ' +
        'computes API changes where supported, then searches this repository for code that uses whatever changed. ' +
        'It keeps evidence gaps explicit instead of treating missing evidence as safety.\n\n' +
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

  server.registerTool(
    'check_installed',
    {
      title: 'Check this code against the versions installed',
      description:
        'Whether this repository is already wrong about the dependency versions it has on disk — not whether an ' +
        'upgrade would break it. Drift reads the API of each installed version and checks every name the code ' +
        'imports against it, so an import naming something that version does not export is an error that exists ' +
        'right now, with no upgrade involved.\n\n' +
        'Use this when a build fails on a missing export, after a lockfile changed, or before blaming code you ' +
        'did not touch. It reports what it could not check and why, and a clean result means every name imported ' +
        'exists — not that the package is used correctly, since it does not follow member access through an ' +
        'imported object.',
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe('Repository to check. Defaults to the current working directory.'),
        only: z.string().optional().describe('Restrict the check to one package name.'),
        includeDev: z.boolean().optional().describe('Include dev/optional/peer dependencies. Default true.'),
      },
    },
    async ({ directory, only, includeDev }) => {
      const run = await runInstalledCheck({
        directory: directory ?? process.cwd(),
        ...(only ? { only } : {}),
        includeDev: includeDev ?? true,
      });
      return { content: [{ type: 'text', text: renderInstalledCheck(run) }] };
    },
  );

  registerAgentTools(server, session);

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
