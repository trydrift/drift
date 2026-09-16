import type { ParsedStream } from './providers/claude-code.ts';
import type { AgentContextDiagnostics, Condition } from './schema.ts';

/**
 * What Drift put into an agent's context, what the agent pulled from Drift,
 * and where the agent's tokens went — computed from the session's own event
 * stream, so it can be recomputed from the stored `.stream.jsonl.gz`.
 *
 * Token figures here are the provider's per-call usage from the message
 * ledger (deduplicated by message id), split at the model call that issued
 * the first file edit. They cover the main conversation model only; the CLI's
 * auxiliary model appears in the session total but in neither half.
 */

export const DRIFT_MCP_SERVER_NAME = 'drift';
const DRIFT_TOOL_PREFIX = `mcp__${DRIFT_MCP_SERVER_NAME}__`;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DETAIL_TOOLS = new Set(['get_finding', 'get_evidence']);

/** The production brief's own estimator, so initial context and tool returns are measured the same way. */
export const estimatedTokens = (chars: string | number): number =>
  Math.ceil((typeof chars === 'string' ? Buffer.byteLength(chars, 'utf8') : chars) / 3);

export function interfaceFor(condition: Condition): AgentContextDiagnostics['interface'] {
  if (condition === 'baseline') return 'none';
  if (condition === 'drift-agent-brief') return 'agent-brief';
  if (condition === 'drift-mcp') return 'mcp';
  return 'full-report';
}

export interface BriefStats {
  findingsInPlan: number;
  findingsInInitialBrief: number;
  nonLocalFindingsOmitted: number;
  deterministicSitesCovered: number;
  residualSitesSentToAgent: number;
}

export function agentContextDiagnostics(args: {
  condition: Condition;
  parsed: ParsedStream;
  /** The Drift text placed after the task; empty for the baseline. */
  preamble: string;
  brief: BriefStats | null;
  /** The plan's breaking-change count for conditions that computed one before the session. */
  findingsInPlan: number | null;
  dependency: string;
  /** Drift's analysis before the session, in ms; 0 when there was none. */
  preSessionDriftMs?: number;
  /** The session's own wall-clock duration, in ms. */
  sessionMs?: number;
}): AgentContextDiagnostics {
  const { parsed } = args;

  const driftCalls = parsed.toolUses.filter((use) => use.name.startsWith(DRIFT_TOOL_PREFIX));
  const byName: Record<string, number> = {};
  let returnedChars = 0;
  let errors = 0;
  const retrieved = new Set<string>();
  let driftToolMs = 0;
  for (const call of driftCalls) {
    const name = call.name.slice(DRIFT_TOOL_PREFIX.length);
    byName[name] = (byName[name] ?? 0) + 1;
    const result = parsed.toolResults.get(call.id);
    returnedChars += result?.chars ?? 0;
    if (call.at !== null && result?.at != null && result.at >= call.at) driftToolMs += result.at - call.at;
    if (result?.isError) errors += 1;
    if (DETAIL_TOOLS.has(name)) {
      for (const key of ['id', 'finding']) {
        const value = call.input[key];
        if (typeof value === 'string' && value) retrieved.add(value);
      }
    }
  }

  const firstEdit = parsed.toolUses.find((use) => EDIT_TOOLS.has(use.name));
  const primaryModel = parsed.init?.model ?? parsed.ledger[0]?.model ?? null;
  const split = (from: number, to: number) => {
    let gross = 0;
    let uncached = 0;
    let calls = 0;
    for (let i = from; i < to; i += 1) {
      const entry = parsed.ledger[i]!;
      if (primaryModel && entry.model !== primaryModel) continue;
      const u = entry.usage;
      const input = u.input_tokens ?? 0;
      const read = u.cache_read_input_tokens ?? 0;
      const created = u.cache_creation_input_tokens ?? 0;
      gross += input + read + created;
      uncached += input + created;
      calls += 1;
    }
    return { grossInputTokens: gross, uncachedInputTokens: uncached, modelCalls: calls };
  };

  return {
    interface: interfaceFor(args.condition),
    initialDriftContextChars: args.preamble.length,
    initialDriftContextEstimatedTokens: args.preamble ? estimatedTokens(args.preamble) : 0,
    driftToolCalls: driftCalls.length,
    driftToolCallsByName: byName,
    driftToolReturnedChars: returnedChars,
    driftToolReturnedEstimatedTokens: estimatedTokens(returnedChars),
    driftToolErrors: errors,
    findingsInPlan: args.brief?.findingsInPlan ?? args.findingsInPlan,
    findingsInInitialBrief: args.brief?.findingsInInitialBrief ?? null,
    findingsRetrievedOnDemand: retrieved.size,
    nonLocalFindingsOmitted: args.brief?.nonLocalFindingsOmitted ?? null,
    deterministicSitesCovered: args.brief?.deterministicSitesCovered ?? null,
    residualSitesSentToAgent: args.brief?.residualSitesSentToAgent ?? null,
    tokensBeforeFirstEdit: firstEdit ? split(0, firstEdit.ledgerIndex + 1) : null,
    tokensAfterFirstEdit: firstEdit ? split(firstEdit.ledgerIndex + 1, parsed.ledger.length) : null,
    timing: {
      preSessionDriftMs: Math.max(0, Math.round(args.preSessionDriftMs ?? 0)),
      sessionMs: Math.max(0, Math.round(args.sessionMs ?? 0)),
      driftToolMs: Math.round(driftToolMs),
      endToEndMs: Math.max(0, Math.round((args.preSessionDriftMs ?? 0) + (args.sessionMs ?? 0))),
    },
    research: researchSignals(parsed, args.dependency),
  };
}

/**
 * Whether the agent went and read the dependency itself.
 *
 * Deliberately narrow and literal, so a count means one thing: a Read, Grep or
 * Glob whose path or pattern names `node_modules/<dependency>`, a shell command
 * that does, a registry query, or a changelog/release-notes/migration file.
 * Reading this repository's own code is not research and is not counted.
 */
export function researchSignals(parsed: ParsedStream, dependency: string): AgentContextDiagnostics['research'] {
  const packagePath = `node_modules/${dependency}`;
  let dependencySourceAccesses = 0;
  let registryQueries = 0;
  let changelogAccesses = 0;
  for (const use of parsed.toolUses) {
    const text = Object.values(use.input)
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (use.name === 'Bash' || use.name === 'Read' || use.name === 'Grep' || use.name === 'Glob') {
      if (text.includes(packagePath)) dependencySourceAccesses += 1;
      if (/\b(changelog|release[-_ ]?notes|history\.md|migrat\w*\.md|upgrad\w*\.md)\b/i.test(text)) changelogAccesses += 1;
    }
    if (use.name === 'Bash' && /\b(npm|pnpm|yarn)\s+(view|info|show|ls|list|why|explain)\b/.test(text)) registryQueries += 1;
  }
  return { dependencySourceAccesses, registryQueries, changelogAccesses };
}
