import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { buildReviewPacket, renderPacket, reviewerInstruction, PROMPT_VERSION, type ReviewPacket } from './packet.ts';
import { conclusionSchema, reviewSchema, saveReview, type Review } from '../review.ts';
import { hashFixtureRevision } from '../hash.ts';
import { publicCaseDir } from '../case/load.ts';
import { privateCaseDir } from '../case/private.ts';
import type { PublicCase } from '../case/schema.ts';
import type { OracleStageArtifact } from '../artifacts/prediction.ts';
import { CLI_AGENT_SPECS } from '../../../dist/index.js';

const execFile = promisify(execFileCallback);

/**
 * Runs an independent AI reviewer over a case and records its conclusion as a
 * `Review`, append-only, with honest provenance.
 *
 * Three properties this is built to guarantee, all of which are easy to lose:
 *
 *   - The reviewer sees no Drift prediction and no other review. Each runs in a
 *     fresh process with a fresh working directory containing only its packet.
 *   - Nothing here promotes a review to ground truth. A review is one opinion;
 *     `adjudication.yml` decides, and adjudication requires either agreement or
 *     an explicit, machine-checked justification for departing from it.
 *   - Provenance is what the tool actually reported. A model version the CLI
 *     does not expose is recorded as the literal `unavailable`, never inferred
 *     from the agent's name.
 *
 * A reviewer is invoked through the same `CLI_AGENT_SPECS` registry Drift's
 * repair agents come from, so "reviewed by Codex" means the same thing here as
 * it does there.
 */

export const REVIEWER_RUNNER_VERSION = 'ai-reviewer-v1';

export interface ReviewRunOptions {
  agentId: string;
  /** `a`, `b`, `c` — distinguishes independent reviewers of the same case in the review id. */
  slot: string;
  role: 'reviewer' | 'adjudicator';
  /** For the adjudicator only: the reviews it arbitrates between. */
  priorReviews?: readonly Review[];
  observedOracles?: readonly OracleStageArtifact[];
  timeoutMs?: number;
}

export interface ReviewRunResult {
  review: Review | null;
  /** Present when the reviewer produced something unusable. The raw output is kept for inspection rather than discarded. */
  failure: { reason: string; rawOutput: string } | null;
}

export async function runAiReview(
  publicCase: PublicCase,
  options: ReviewRunOptions,
  root = process.cwd(),
): Promise<ReviewRunResult> {
  const spec = CLI_AGENT_SPECS.find((candidate) => candidate.id === options.agentId);
  if (!spec) return { review: null, failure: { reason: `No agent spec for ${options.agentId}.`, rawOutput: '' } };

  const packet = await buildReviewPacket(publicCase, options.observedOracles ?? [], root);
  const prompt = buildPrompt(packet, options);
  const promptHash = createHash('sha256').update(prompt).digest('hex');

  // A fresh, empty directory per reviewer. The agent has shell access, and a
  // reviewer that could reach the repository could read the adjudication it is
  // supposed to be deriving independently.
  const sandbox = await mkdtemp(join(tmpdir(), `drift-review-${publicCase.id}-`));
  let rawOutput = '';

  try {
    await writeFile(join(sandbox, 'packet.yml'), renderPacket(packet), 'utf8');

    const args = spec.buildArgs(prompt);
    const result = await execFile(spec.command, args, {
      cwd: sandbox,
      timeout: options.timeoutMs ?? 600_000,
      maxBuffer: 1 << 26,
      env: { ...process.env },
    }).catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
    }));

    rawOutput = `${result.stdout}\n${result.stderr}`;
    const parsed = parseReviewOutput(rawOutput);
    if (!parsed) return { review: null, failure: { reason: 'The reviewer produced no parseable YAML conclusion.', rawOutput } };

    const caseYaml = await readCaseYaml(publicCase.id, root);
    const review = reviewSchema.parse({
      id: `${options.agentId}-${new Date().toISOString().slice(0, 10)}-${publicCase.id}-${options.slot}`,
      fixtureId: publicCase.id,
      createdAt: new Date().toISOString(),
      reviewer: {
        type: 'ai',
        name: spec.label,
        provider: spec.label,
        model: observed(rawOutput, /^\s*model:\s*(\S+)\s*$/m),
        modelVersion: 'unavailable',
        toolVersion: observed(rawOutput, /^(?:OpenAI\s+)?Codex\s+v(\S+)\s*$/m),
      },
      reviewedRevision: await hashFixtureRevision(publicCaseDir(publicCase.id, root), caseYaml),
      evidence: {
        files: [...packet.upstreamOld, ...packet.upstreamNew, ...packet.consumer].map((entry) => entry.path),
        commands: packet.observedOracles.map((stage) => `${stage.stage}: ${stage.observed}`),
        artifacts: ['packet.yml'],
        notes: `Independent ${options.role} run by ${REVIEWER_RUNNER_VERSION}; no Drift prediction and no other review were shown.`,
      },
      conclusion: conclusionSchema.parse(parsed.conclusion),
      rationale: {
        summary: String(parsed.rationale?.summary ?? ''),
        findingNotes: (parsed.rationale?.findingNotes ?? []).map(String),
        uncertainty: String(parsed.rationale?.uncertainty ?? ''),
      },
      status: 'reviewed',
      reviewOf: (options.priorReviews ?? []).map((review) => review.id),
      promptVersion: PROMPT_VERSION,
      promptHash,
    });

    await saveReview(review, join(root, 'eval', 'cases', 'private'));
    return { review, failure: null };
  } catch (err) {
    return { review: null, failure: { reason: (err as Error).message, rawOutput } };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function buildPrompt(packet: ReviewPacket, options: ReviewRunOptions): string {
  const sections = [reviewerInstruction(options.role), '', '## Evidence packet', '', '```yaml', renderPacket(packet), '```'];

  if (options.role === 'adjudicator' && options.priorReviews?.length) {
    sections.push('', '## Independent reviews to adjudicate', '');
    for (const [index, review] of options.priorReviews.entries()) {
      sections.push(
        `### Reviewer ${String.fromCharCode(65 + index)} (${review.reviewer.name})`,
        '',
        '```yaml',
        YAML.stringify({ conclusion: review.conclusion, rationale: review.rationale }, { lineWidth: 0 }),
        '```',
        '',
      );
    }
  }

  return sections.join('\n');
}

/**
 * Extracts the YAML document from an agent transcript.
 *
 * Agents narrate. The last fenced YAML block is taken rather than the first,
 * because a model that revises itself puts the final answer last, and a bare
 * parse of the whole transcript would fail on the prose around it.
 */
export function parseReviewOutput(output: string): { conclusion: unknown; rationale?: { summary?: unknown; findingNotes?: unknown[]; uncertainty?: unknown } } | null {
  const candidates = fencedBlocks(output).reverse();
  candidates.push(output);

  for (const candidate of candidates) {
    try {
      const parsed = YAML.parse(candidate) as { conclusion?: unknown; rationale?: never } | null;
      if (parsed && typeof parsed === 'object' && 'conclusion' in parsed && parsed.conclusion) {
        return parsed as { conclusion: unknown; rationale?: never };
      }
    } catch {
      // Not this block. A narrating agent emits code fences that are not the answer.
    }
  }
  return null;
}

/**
 * Fenced blocks, paired by scanning lines rather than by one regex.
 *
 * A regex pairing is wrong here in a way that is easy to miss: it happily
 * treats the *closing* fence of a non-YAML block as the opening of the next
 * one, so a transcript that shows a code snippet before its answer yields a
 * body starting with the ```yaml line and fails to parse. Blocks are paired
 * by toggling on each fence line instead, which is what a fence actually is.
 */
function fencedBlocks(output: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of output.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (current === null) current = [];
      else {
        blocks.push(current.join('\n'));
        current = null;
      }
      continue;
    }
    current?.push(line);
  }
  // An unterminated final fence still carries an answer often enough to try.
  if (current !== null && current.length > 0) blocks.push(current.join('\n'));

  return blocks;
}

/** A value the tool actually printed, or the literal `unavailable`. Never inferred. */
function observed(output: string, pattern: RegExp): string {
  return pattern.exec(output)?.[1] ?? 'unavailable';
}

async function readCaseYaml(caseId: string, root: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(publicCaseDir(caseId, root), 'case.yml'), 'utf8');
}

export { privateCaseDir };
