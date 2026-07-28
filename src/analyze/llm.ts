import type { BreakingChange, Confidence, DependencyChange, Evidence } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { stableId } from '../util/id.js';

/**
 * Optional LLM-assisted extraction.
 *
 * This exists to improve *recall* on prose that the rule engine cannot parse —
 * a maintainer who writes "we've reworked how clients are constructed" without
 * backticks or a recognised verb. It deliberately does not replace the rules:
 *
 *   - It runs last and never overrides a rule-derived finding.
 *   - Its output is capped at `medium` confidence, so an LLM-only finding can
 *     never by itself clear the default `minConfidence` gate for automatic
 *     dispatch. A human sees it; an agent does not act on it unattended.
 *   - It is off by default and needs no API key to run Drift.
 *
 * The model is asked to extract from supplied evidence only. It is not asked
 * to recall what it knows about the package, because a hallucinated breaking
 * change is exactly the failure mode that would make Drift untrustworthy.
 */

/** The `@anthropic-ai/sdk` surface Drift uses. Kept narrow deliberately. */
interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: { type: string; text?: string }[];
      stop_reason?: string | null;
    }>;
  };
}

interface ExtractedChange {
  summary: string;
  remediation: string;
  symbols: string[];
  kind: string;
  evidenceId: string;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One sentence stating what changed upstream and why it breaks consumers.',
          },
          remediation: {
            type: 'string',
            description: 'Imperative instructions for fixing affected call sites.',
          },
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Exact identifiers to search for in consumer code: export names, method names, option keys, endpoint paths. Empty if the evidence names none.',
          },
          kind: {
            type: 'string',
            enum: [
              'removed-export',
              'renamed-export',
              'signature-change',
              'type-change',
              'behaviour-change',
              'removed-endpoint',
              'changed-endpoint',
              'required-field-added',
              'default-change',
              'config-change',
              'runtime-requirement',
              'unknown',
            ],
          },
          evidenceId: {
            type: 'string',
            description: 'The id of the evidence excerpt this was extracted from.',
          },
        },
        required: ['summary', 'remediation', 'symbols', 'kind', 'evidenceId'],
        additionalProperties: false,
      },
    },
  },
  required: ['changes'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You extract breaking changes from dependency release notes for an automated refactoring tool.

Rules you must follow:

1. Extract ONLY what the supplied evidence states. Do not use prior knowledge about the package. If the evidence does not describe a breaking change, return an empty list. An empty list is a correct and common answer.
2. A breaking change is one that makes previously-working consumer code stop working or behave differently. New features, performance work, internal refactors, and documentation changes are NOT breaking.
3. \`symbols\` must be identifiers that would literally appear in consumer source code. Never put prose, descriptions, or package names there. If the evidence describes a change without naming an identifier, return an empty \`symbols\` array rather than inventing one.
4. \`evidenceId\` must be copied exactly from the evidence block the finding came from.
5. Do not restate a change that is already listed under "Already found" — those are handled.
6. Write \`remediation\` as instructions to an engineer, describing what to change. Do not speculate about replacements the evidence does not mention; say the replacement is unknown instead.`;

export interface LlmOptions {
  config: DriftConfig;
  logger: Logger;
}

export async function extractWithLlm(
  changes: readonly DependencyChange[],
  evidence: readonly Evidence[],
  alreadyFound: readonly BreakingChange[],
  options: LlmOptions,
): Promise<BreakingChange[]> {
  const { config, logger } = options;

  const apiKey = process.env[config.llm.apiKeyEnv];
  if (!apiKey) {
    logger.warn(
      `llm.enabled is true but ${config.llm.apiKeyEnv} is not set; skipping LLM extraction. The rule-based analyser still ran.`,
    );
    return [];
  }

  const client = await loadClient(apiKey, logger);
  if (!client) return [];

  // Prose only. Computed evidence is already fully structured, and re-reading
  // it through a model could only add noise or drop findings.
  const prose = evidence.filter(
    (e) => !e.findings?.length && e.source !== 'semver-heuristic' && e.source !== 'registry-metadata',
  );
  if (prose.length === 0) return [];

  const results: BreakingChange[] = [];

  for (const change of changes) {
    const relevant = prose.filter((e) => e.dependency === change.name);
    if (relevant.length === 0) continue;

    try {
      const extracted = await callModel(client, config, change, relevant, alreadyFound);
      results.push(...toBreakingChanges(extracted, change.name, relevant));
    } catch (err) {
      // A model outage must never fail a run; the rules already produced output.
      logger.warn(`LLM extraction failed for ${change.name}: ${(err as Error).message}`);
    }
  }

  return results;
}

/**
 * Load the Anthropic SDK on demand.
 *
 * It is an optional dependency: Drift's core path is deterministic and must
 * install and run without it. A missing package is a clear, actionable message
 * rather than a crash.
 */
async function loadClient(apiKey: string, logger: Logger): Promise<AnthropicLike | null> {
  // The specifier is held in a variable so TypeScript resolves it at runtime
  // rather than at build time — the package legitimately may not be installed.
  const specifier = '@anthropic-ai/sdk';
  try {
    const mod = (await import(specifier)) as {
      default: new (opts: { apiKey: string }) => AnthropicLike;
    };
    return new mod.default({ apiKey });
  } catch {
    logger.warn(
      'llm.enabled is true but @anthropic-ai/sdk is not installed. Run `npm install @anthropic-ai/sdk` or set llm.enabled: false.',
    );
    return null;
  }
}

async function callModel(
  client: AnthropicLike,
  config: DriftConfig,
  change: DependencyChange,
  evidence: readonly Evidence[],
  alreadyFound: readonly BreakingChange[],
): Promise<ExtractedChange[]> {
  const known = alreadyFound
    .filter((c) => c.dependency === change.name)
    .map((c) => `- ${c.summary}`)
    .join('\n');

  const blocks = evidence
    .map(
      (e) =>
        `<evidence id="${e.id}" source="${e.source}" title="${escapeXml(e.title)}">\n${truncate(e.content, 6000)}\n</evidence>`,
    )
    .join('\n\n');

  const prompt = [
    `Dependency: ${change.name} (${change.ecosystem})`,
    `Version change: ${change.from} → ${change.to} (${change.bump})`,
    '',
    known ? `Already found by deterministic rules — do not repeat these:\n${known}\n` : '',
    'Evidence:',
    blocks,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.messages.create({
    model: config.llm.model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: config.llm.effort,
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  // Safety classifiers can decline; `content` is empty or partial in that case.
  if (response.stop_reason === 'refusal') return [];

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) return [];

  try {
    const parsed = JSON.parse(text) as { changes?: ExtractedChange[] };
    return Array.isArray(parsed.changes) ? parsed.changes : [];
  } catch {
    return [];
  }
}

function toBreakingChanges(
  extracted: readonly ExtractedChange[],
  dependency: string,
  evidence: readonly Evidence[],
): BreakingChange[] {
  const validIds = new Set(evidence.map((e) => e.id));

  return extracted
    // Enforce the citation invariant: a finding whose evidence id we cannot
    // verify is dropped, not downgraded. Unverifiable provenance is exactly
    // what Drift refuses to put in front of a reviewer.
    .filter((c) => validIds.has(c.evidenceId))
    .filter((c) => c.summary?.trim())
    .map((c) => ({
      id: stableId('bc', dependency, 'llm', c.summary),
      dependency,
      kind: normalizeKind(c.kind),
      summary: c.summary.trim(),
      remediation: c.remediation?.trim() || `Review usages of ${dependency} and update them.`,
      symbols: (c.symbols ?? []).filter(isPlausibleSymbol),
      // Capped at medium by construction — see the module comment.
      confidence: 'medium' as Confidence,
      citations: [c.evidenceId],
    }));
}

/**
 * Reject "symbols" that are clearly prose.
 *
 * Without this, a sentence fragment becomes a search term and the localizer
 * reports matches all over the repo — the fastest possible way to lose a
 * reviewer's trust.
 */
function isPlausibleSymbol(symbol: string): boolean {
  const s = symbol.trim();
  if (!s || s.length > 80) return false;
  if (/\s/.test(s) && !s.startsWith('/')) return false;
  return /^[/@]?[\w$][\w$./{}-]*$/.test(s);
}

const KNOWN_KINDS = new Set([
  'removed-export',
  'renamed-export',
  'signature-change',
  'type-change',
  'behaviour-change',
  'removed-endpoint',
  'changed-endpoint',
  'required-field-added',
  'default-change',
  'config-change',
  'runtime-requirement',
]);

function normalizeKind(kind: string): BreakingChange['kind'] {
  return KNOWN_KINDS.has(kind) ? (kind as BreakingChange['kind']) : 'unknown';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
