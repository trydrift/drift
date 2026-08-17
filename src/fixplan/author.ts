import type { BreakingChange, DependencyChange, Evidence, ImpactSite } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { AnthropicLike } from '../analyze/llm.js';
import { stableId } from '../util/id.js';
import { FIX_PLAN_SCHEMA_VERSION, type FixOp, type FixPlan } from './schema.js';

/**
 * Ask a model for the rule, once.
 *
 * This is the only place in the fix plan tier a model is involved, and it is
 * deliberately the cheapest possible involvement: one call per breaking
 * change, regardless of how many call sites that change reaches. A finding
 * that bites in fifty files costs exactly what a finding that bites in one
 * costs, which is the economic argument for the whole tier — and the reason
 * the call is worth making at a higher effort than a per-site agent could
 * afford.
 *
 * What comes back is a proposal and is treated as one. Everything that makes
 * it safe happens in `validate.ts`, not here: this module does not check
 * whether the model invented an API, whether the rule is grounded in the
 * finding, or whether it converges. It parses, it normalizes, it declines
 * clearly when the model said nothing useful — and it hands the result to
 * the gate.
 *
 * The model is shown the evidence Drift retrieved and a sample of the actual
 * lines from this repository. It is not asked to recall what it knows about
 * the package, for the same reason `analyze/llm.ts` does not: a hallucinated
 * migration applied deterministically to every call site is strictly worse
 * than a hallucinated one applied by hand to one.
 */

const OPS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  items: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: {
          kind: { const: 'rename-identifier' },
          from: { type: 'string', description: 'The old bare identifier, exactly as it appears in code.' },
          to: { type: 'string', description: 'The new bare identifier.' },
        },
        required: ['kind', 'from', 'to'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: 'rename-member' },
          from: { type: 'string', description: 'The old member name, without the dot or the receiver.' },
          to: { type: 'string' },
        },
        required: ['kind', 'from', 'to'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: 'replace-import-path' },
          from: { type: 'string', description: 'The old module specifier, exactly as written between the quotes.' },
          to: { type: 'string' },
        },
        required: ['kind', 'from', 'to'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: 'insert-argument' },
          callee: { type: 'string', description: 'The function being called, e.g. `connect` or `client.connect`.' },
          index: { type: 'integer', minimum: 0, maximum: 8, description: '0-based position in the argument list.' },
          text: {
            type: 'string',
            description:
              'A literal only: a quoted string, a number, a boolean, null, or a flat object literal. Never a function call or an expression.',
          },
        },
        required: ['kind', 'callee', 'index', 'text'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: 'wrap-call' },
          callee: { type: 'string' },
          wrapper: { type: 'string', enum: ['await', 'new'] },
        },
        required: ['kind', 'callee', 'wrapper'],
        additionalProperties: false,
      },
    ],
  },
} as const;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    applicable: {
      type: 'boolean',
      description:
        'False when this migration cannot be expressed as the listed operations. Answering false is correct and common.',
    },
    migration: { type: 'string', description: 'One sentence stating the migration, for a human reviewer.' },
    rationale: {
      type: 'string',
      description: 'Why this is the correct fix, quoting the evidence. Two sentences at most.',
    },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of the evidence blocks that state this replacement. Copy them exactly.',
    },
    ops: OPS_SCHEMA,
  },
  required: ['applicable', 'migration', 'rationale', 'citations', 'ops'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You write migration rules for an automated refactoring tool.

You are given one breaking change in a dependency, the evidence that documents it, and a sample of the real lines in a repository that use the affected API. You return a small set of mechanical operations that, applied to those lines, complete the migration.

The tool applies your operations itself, deterministically, to every affected line in the repository. It does not run your code and it does not ask you again. Your operations are also validated before use, and rejected outright if they fail any of the rules below — so a rejected answer helps nobody.

Rules you must follow:

1. Use ONLY the operations in the schema. If this migration needs anything else — restructuring a call, splitting a statement, introducing a variable, changing more than one line at a time — set \`applicable\` to false and return an empty rationale for why. That is a correct and common answer, and it hands the work to a per-site agent, which is the right outcome for a change that is not mechanical.
2. Every name you introduce must appear in the supplied evidence. Do not use prior knowledge about this package to name a replacement API. If the evidence does not say what the new name is, set \`applicable\` to false. An invented replacement will be applied to every call site in the repository, which is worse than no fix at all.
3. Your operations must be grounded in the symbols this finding names. Do not fix anything else you happen to notice.
4. \`rename-identifier\` matches bare identifiers only and never a member after a dot. \`rename-member\` matches members after a dot only. Choose based on how the sample lines actually read; if both forms appear, return both operations.
5. \`insert-argument\` text must be a literal. Never a function call, never an expression, never a lambda.
6. Operations are applied in the order you list them, to each line, and must converge: applying them twice must give the same result as applying them once.
7. Prefer fewer operations. A migration needing more than about three is usually not mechanical, and \`applicable: false\` is the better answer.`;

export interface AuthorOptions {
  change: BreakingChange;
  dependencyChange?: DependencyChange;
  evidence: readonly Evidence[];
  sites: readonly ImpactSite[];
  /** Contents of every file named by `sites`, as localization read them. */
  fileContents: ReadonlyMap<string, string>;
  config: DriftConfig;
  logger: Logger;
  /** Injected for tests, exactly as `analyze/llm.ts` injects it. */
  client?: AnthropicLike;
}

/**
 * How many distinct call-site lines the model is shown.
 *
 * Enough to see the shapes the API is used in, few enough that a finding
 * reaching a thousand lines costs the same as one reaching twelve. Sampling
 * is by *distinct line text* rather than by site, because a hundred
 * identical `connect(url)` lines teach the model nothing a single one does
 * not — and the ones that differ are exactly the ones worth spending the
 * budget on.
 */
const MAX_SAMPLE_LINES = 24;

export async function authorFixPlan(options: AuthorOptions): Promise<FixPlan | null> {
  const { change, evidence, sites, fileContents, config, logger } = options;

  const client = options.client;
  if (!client) return null;

  const samples = sampleLines(change, sites, fileContents);
  if (samples.length === 0) {
    logger.debug(`No readable call sites for ${change.id}; not authoring a fix plan.`);
    return null;
  }

  const cited = evidence.filter((record) => change.citations.includes(record.id));
  if (cited.length === 0) {
    logger.debug(`${change.id} cites no retrievable evidence; not authoring a fix plan.`);
    return null;
  }

  let response;
  try {
    response = await client.messages.create({
      model: config.llm.model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: config.llm.effort,
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      },
      messages: [{ role: 'user', content: buildPrompt(change, options.dependencyChange, cited, samples) }],
    });
  } catch (err) {
    // A model outage must never fail a run: the finding simply falls through
    // to the tier below, which is where it would have gone anyway.
    logger.warn(`Could not author a fix plan for ${change.dependency}: ${(err as Error).message}`);
    return null;
  }

  // Every path below returns "no plan", so every path below says why. A
  // silently absent plan and a declined one are different facts, and the
  // second is the one that means the tier is working as designed.
  if (response.stop_reason === 'refusal') {
    logger.warn(`The model declined to author a fix plan for ${change.dependency}.`);
    return null;
  }

  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) {
    logger.warn(
      `The model returned no text when asked for a fix plan for ${change.dependency}${
        response.stop_reason ? ` (stop reason: ${response.stop_reason})` : ''
      }.`,
    );
    return null;
  }

  let parsed: {
    applicable?: boolean;
    migration?: string;
    rationale?: string;
    citations?: string[];
    ops?: unknown[];
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn(`The model's fix plan for ${change.dependency} was not readable as JSON (${(err as Error).message}).`);
    return null;
  }

  if (parsed.applicable === false) {
    logger.info(
      `No mechanical fix plan for ${change.dependency}: ${parsed.rationale?.trim() || 'the model judged this migration not expressible as a rule'}. Falling back to a per-site agent.`,
    );
    return null;
  }

  const ops = normalizeOps(parsed.ops ?? []);
  if (ops.length === 0) {
    logger.info(`The model proposed no usable operations for ${change.dependency}; falling back to a per-site agent.`);
    return null;
  }

  return buildPlan({
    change,
    dependencyChange: options.dependencyChange,
    migration: parsed.migration?.trim() || change.summary,
    rationale: parsed.rationale?.trim() || '',
    citations: (parsed.citations ?? []).filter((id) => typeof id === 'string'),
    ops,
    provenance: {
      author: 'model',
      model: config.llm.model,
      authoredAt: new Date().toISOString(),
    },
  });
}

/**
 * Assemble a plan document and give it its content-derived id.
 *
 * Shared by every proposal source — the model above, the recipe path, the
 * built-in engine — so the id is computed one way and two sources arriving
 * at the same rule for the same migration produce the same id. That is what
 * makes the cache in `cache.ts` a shared artefact rather than a per-run memo.
 */
export function buildPlan(input: {
  change: BreakingChange;
  dependencyChange?: DependencyChange;
  migration: string;
  rationale: string;
  citations: string[];
  ops: FixOp[];
  provenance: FixPlan['provenance'];
}): FixPlan {
  const { change, dependencyChange, ops } = input;
  const fromVersion = dependencyChange?.from ?? null;
  const toVersion = dependencyChange?.to ?? null;

  return {
    schemaVersion: FIX_PLAN_SCHEMA_VERSION,
    // Over the migration, never over the repository: two repositories hitting
    // the same upstream break compute the same id.
    id: stableId(
      'fp',
      change.dependency,
      fromVersion ?? '',
      toVersion ?? '',
      change.kind,
      [...change.symbols].sort().join(','),
      JSON.stringify(ops),
    ),
    breakingChangeId: change.id,
    dependency: change.dependency,
    fromVersion,
    toVersion,
    changeKind: change.kind,
    migration: input.migration,
    rationale: input.rationale,
    ops,
    citations: input.citations,
    provenance: input.provenance,
  };
}

/**
 * Keep only the ops that are structurally well-formed enough to be worth
 * validating.
 *
 * Not a safety check — `validate.ts` is the safety check, and it re-examines
 * everything here. This exists so a malformed entry in an otherwise good
 * answer does not throw, and so the gate receives typed ops rather than
 * arbitrary JSON.
 */
function normalizeOps(raw: readonly unknown[]): FixOp[] {
  const ops: FixOp[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const op = entry as Record<string, unknown>;

    switch (op.kind) {
      case 'rename-identifier':
      case 'rename-member':
      case 'replace-import-path':
        if (typeof op.from === 'string' && typeof op.to === 'string') {
          ops.push({ kind: op.kind, from: op.from.trim(), to: op.to.trim() });
        }
        break;
      case 'insert-argument':
        if (typeof op.callee === 'string' && typeof op.text === 'string' && Number.isInteger(op.index)) {
          ops.push({
            kind: 'insert-argument',
            callee: op.callee.trim(),
            index: op.index as number,
            text: op.text.trim(),
          });
        }
        break;
      case 'wrap-call':
        if (typeof op.callee === 'string' && (op.wrapper === 'await' || op.wrapper === 'new')) {
          ops.push({ kind: 'wrap-call', callee: op.callee.trim(), wrapper: op.wrapper });
        }
        break;
      default:
        break;
    }
  }

  return ops;
}

/** Distinct call-site lines, capped — see `MAX_SAMPLE_LINES`. */
function sampleLines(
  change: BreakingChange,
  sites: readonly ImpactSite[],
  fileContents: ReadonlyMap<string, string>,
): { file: string; line: number; text: string }[] {
  const seen = new Set<string>();
  const samples: { file: string; line: number; text: string }[] = [];

  for (const site of sites) {
    if (site.breakingChangeId !== change.id) continue;
    if (samples.length >= MAX_SAMPLE_LINES) break;

    const content = fileContents.get(site.file);
    if (content === undefined) continue;
    const text = content.split('\n')[site.line - 1];
    if (text === undefined) continue;

    const key = text.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    samples.push({ file: site.file, line: site.line, text });
  }

  return samples;
}

function buildPrompt(
  change: BreakingChange,
  dependencyChange: DependencyChange | undefined,
  cited: readonly Evidence[],
  samples: readonly { file: string; line: number; text: string }[],
): string {
  const blocks = cited
    .map(
      (record) =>
        `<evidence id="${record.id}" source="${record.source}" title="${escapeXml(record.title)}">\n${truncate(record.content, 4000)}\n</evidence>`,
    )
    .join('\n\n');

  const lines = samples.map((sample) => `${sample.file}:${sample.line}\n${sample.text}`).join('\n\n');

  return [
    `Dependency: ${change.dependency}`,
    dependencyChange ? `Version change: ${dependencyChange.from} → ${dependencyChange.to}` : '',
    `Breaking change (${change.kind}): ${change.summary}`,
    change.before ? `Declaration before: ${change.before}` : '',
    change.after ? `Declaration after: ${change.after}` : '',
    change.symbols.length ? `Affected symbols: ${change.symbols.join(', ')}` : '',
    change.replacementSymbols?.length ? `Known replacements: ${change.replacementSymbols.join(', ')}` : '',
    '',
    'Evidence:',
    blocks,
    '',
    `Real lines in this repository that use the affected API (${samples.length} distinct shapes):`,
    lines,
  ]
    .filter(Boolean)
    .join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
