import { resolve } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { buildAgentBrief } from '../agent-context/brief.js';
import { evidenceDetail, findingDetail, UnknownAgentIdError } from '../agent-context/detail.js';
import { planLocalChange, type LocalPlanRequest, type LocalPlanResult } from '../agent-context/local.js';
import { renderAgentBrief } from '../agent-context/render.js';
import { runWorkingTreeChecks, type WorkingTreeCheckRequest, type WorkingTreeCheckReport } from '../agent-context/verify.js';
import { agentBriefView } from '../agent-context/view.js';

/**
 * The agent-facing half of the MCP server: a small plan first, detail on request.
 *
 * `check_upgrades` and `explain_upgrade` answer a developer deciding *whether*
 * to upgrade. These four serve an agent that has been asked to *make* an
 * upgrade work, and they are shaped by what the first paired benchmark
 * measured: an agent re-reads everything it is given on every turn, so the
 * first answer must be small and everything else must be one call away.
 *
 *   plan_upgrade    the bounded brief for the dependency change in this checkout
 *   get_finding     one finding, every site, its units and gaps
 *   get_evidence    the evidence behind one finding (narrowed), or one record (paged)
 *   verify_upgrade  the project's checks on the working tree, summarised; logs to a file
 *
 * The plan is computed once per checkout and held for the life of the server
 * process. That is not only a speed-up: once the agent edits `package.json`,
 * re-detecting "the change in this checkout" would find the agent's own edit
 * rather than the upgrade it was asked to fix.
 */

export type Planner = (request: LocalPlanRequest) => Promise<LocalPlanResult>;
export type Checker = (request: WorkingTreeCheckRequest) => Promise<WorkingTreeCheckReport>;

interface HeldPlan {
  result: LocalPlanResult & { plan: NonNullable<LocalPlanResult['plan']> };
  directory: string;
  verified: boolean;
}

export class AgentPlanSession {
  private readonly held = new Map<string, HeldPlan>();

  constructor(
    private readonly planner: Planner = planLocalChange,
    readonly checker: Checker = runWorkingTreeChecks,
  ) {}

  async plan(request: LocalPlanRequest & { refresh?: boolean }): Promise<{ held: HeldPlan | null; reused: boolean; summary: string }> {
    const directory = resolve(request.directory);
    const explicitRange = Boolean(request.before || request.after);
    const existing = this.held.get(directory);
    if (existing && !request.refresh && !explicitRange && (existing.verified || !request.verify)) {
      return { held: existing, reused: true, summary: existing.result.summary };
    }
    const result = await this.planner({ ...request, directory });
    if (!result.plan) return { held: null, reused: false, summary: result.summary };
    const held: HeldPlan = { result: result as HeldPlan['result'], directory, verified: request.verify };
    this.held.set(directory, held);
    return { held, reused: false, summary: result.summary };
  }

  get(directory: string): HeldPlan | null {
    return this.held.get(resolve(directory)) ?? null;
  }
}

const directoryArg = z.string().optional().describe('Repository root. Defaults to the current working directory.');
const formatArg = z
  .enum(['text', 'json'])
  .optional()
  .describe('text (default): compact prose. json: the same selection as flat structured fields.');

const NO_PLAN = 'No Drift plan is held for this directory yet. Call plan_upgrade first.';

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

/** JSON as both fields: a client that reads either gets the same bounded object. */
function json(value: object): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function failure(err: unknown): ToolResult {
  if (err instanceof UnknownAgentIdError) return text(err.message, true);
  return text(`Drift failed: ${(err as Error).message}`, true);
}

export function registerAgentTools(server: McpServer, session: AgentPlanSession = new AgentPlanSession()): AgentPlanSession {
  server.registerTool(
    'plan_upgrade',
    {
      title: 'Plan the fix for a dependency upgrade',
      description:
        'Start here when asked to make a dependency upgrade work. Returns a short plan (under 2,000 tokens) for the ' +
        'dependency change already in this checkout — a bumped manifest, committed or not: the findings that reach ' +
        'this repository with file:line locations, what to change, protected paths, the checks to run, and what Drift ' +
        'could not establish. Upstream changes with no located usage are counted, not listed.\n\n' +
        'Drift has already compared the published versions and searched this repository, so use the plan as your ' +
        'starting scope rather than reading the package changelog or API yourself. Every id in it resolves with ' +
        'get_finding or get_evidence. By default Drift also installs the change in a scratch worktree and runs this ' +
        "project's checks, which adds a minute or more and turns predicted locations into measured compiler errors. " +
        'The plan is computed once and reused on later calls, so your own manifest edits do not replace it.',
      inputSchema: {
        directory: directoryArg,
        before: z.string().optional().describe('Commit before the dependency change. Default: auto-detected.'),
        after: z.string().optional().describe('Commit after the change. Default: auto-detected (an uncommitted manifest edit, else the last commit touching a manifest).'),
        verify: z.boolean().optional().describe("Install the change in a scratch worktree and run this project's checks. Default true."),
        refresh: z.boolean().optional().describe('Re-analyse instead of returning the plan computed earlier. Default false.'),
        format: formatArg,
      },
    },
    async ({ directory, before, after, verify, refresh, format }) => {
      try {
        const outcome = await session.plan({
          directory: directory ?? process.cwd(),
          ...(before ? { before } : {}),
          ...(after ? { after } : {}),
          verify: verify ?? true,
          refresh: refresh ?? false,
        });
        if (!outcome.held) return text(outcome.summary);
        const { plan, config, checks } = outcome.held.result;
        const brief = buildAgentBrief(plan, { config, availableChecks: checks });
        if (format === 'json') return json(agentBriefView(brief).view);
        const rendered = renderAgentBrief(brief, { retrieval: 'mcp' });
        return text(outcome.reused ? `${rendered.text}\n\n(Plan computed earlier in this session; pass refresh: true to re-analyse.)` : rendered.text);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'get_finding',
    {
      title: 'One finding from the Drift plan',
      description:
        'One finding by id (`bc_…` or `measured:…`, as plan_upgrade lists them): every located site with its code excerpt, ' +
        'the required change, before/after signatures, the execution unit, protected files, related findings and gaps. ' +
        'Also resolves upstream changes the plan counted but did not list. Bounded to about 2,000 tokens.',
      inputSchema: {
        id: z.string().describe('Finding id from plan_upgrade.'),
        directory: directoryArg,
        format: formatArg,
      },
    },
    async ({ id, directory, format }) => {
      const held = session.get(directory ?? process.cwd());
      if (!held) return text(NO_PLAN, true);
      try {
        const detail = findingDetail(held.result.plan, id, { config: held.result.config });
        return format === 'json' ? json(detail.data) : text(detail.text);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'get_evidence',
    {
      title: 'Evidence behind a Drift finding',
      description:
        'The upstream evidence for one finding — narrowed to the lines naming its symbols, not the whole record — or ' +
        'one evidence record by id (`ev_…`), paged with offset for long release notes. For a measured finding, the ' +
        'failing check output. Use this instead of fetching changelogs or package sources yourself. Bounded to about 2,500 tokens per call.',
      inputSchema: {
        finding: z.string().optional().describe('Finding id; returns only the evidence it cites.'),
        evidence: z.string().optional().describe('Evidence id (`ev_…`); returns that record.'),
        offset: z.number().int().min(0).optional().describe('Character offset for the next page of a long record.'),
        directory: directoryArg,
        format: formatArg,
      },
    },
    async ({ finding, evidence, offset, directory, format }) => {
      const held = session.get(directory ?? process.cwd());
      if (!held) return text(NO_PLAN, true);
      try {
        const detail = evidenceDetail(held.result.plan, {
          ...(finding ? { findingId: finding } : {}),
          ...(evidence ? { evidenceId: evidence } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });
        return format === 'json' ? json(detail.data) : text(detail.text);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'verify_upgrade',
    {
      title: "Run this project's checks on the working tree",
      description:
        "Runs this project's own build, typecheck and test commands in the working tree as it is now (your edits " +
        'included) and returns pass/fail per check with the first compiler errors, plus whether each upgraded ' +
        'dependency is still declared at its new version. Full output is written to log files whose paths are ' +
        'returned instead of being printed. Takes as long as the checks take.',
      inputSchema: {
        directory: directoryArg,
        only: z.array(z.string()).optional().describe('Run only checks whose command contains one of these, e.g. ["build"].'),
        timeoutSeconds: z.number().int().min(10).max(3600).optional().describe('Per-check timeout. Default 600.'),
      },
    },
    async ({ directory, only, timeoutSeconds }) => {
      const root = directory ?? process.cwd();
      try {
        const held = session.get(root);
        const report = await session.checker({
          directory: root,
          ...(only?.length ? { only } : {}),
          ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}),
          ...(held ? { changes: held.result.plan.changes.filter((c) => c.source !== 'lockfile') } : {}),
        });
        return text(report.text);
      } catch (err) {
        return failure(err);
      }
    },
  );

  return session;
}
