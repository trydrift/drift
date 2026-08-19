import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { publicCaseDir } from '../case/load.ts';
import { walkPaths } from '../util/walk.ts';
import type { PublicCase } from '../case/schema.ts';
import type { OracleStageArtifact } from '../artifacts/prediction.ts';

/**
 * The review packet: everything a reviewer needs, and nothing that would tell
 * them the answer.
 *
 * What goes in: the public case metadata, the two frozen upstream trees, the
 * consumer source, and the observed baseline/bump-only oracle output. That is
 * the evidence a careful engineer would have.
 *
 * What is excluded, and why each exclusion matters:
 *
 *   - Any Drift prediction. A reviewer who has seen the tool's answer is
 *     grading it, not deriving ground truth, and the agreement that results is
 *     worthless. This is why review runs before Drift, not after.
 *   - Any other reviewer's conclusion. Independence is the entire value of a
 *     second reviewer; showing them the first one produces a witness who has
 *     read the other witness's statement.
 *   - The developer's migration patch, for a repair review. It is one valid
 *     repair, and a reviewer shown it will record it as *the* expected change.
 *
 * The packet is content-addressed by the same fixture hashes the staleness
 * check uses, so a review can be tied to the exact evidence revision it saw.
 */

export const PROMPT_VERSION = 'ground-truth-v2';

export interface ReviewPacket {
  promptVersion: string;
  caseId: string;
  case: PublicCase;
  upstreamOld: { path: string; content: string }[];
  upstreamNew: { path: string; content: string }[];
  consumer: { path: string; content: string }[];
  /** Observed, never asserted. Absent when the reproducibility gate has not run. */
  observedOracles: { stage: string; expected: string; observed: string; signature: string[]; outputExcerpt: string }[];
}

const MAX_FILE_BYTES = 60_000;

export async function buildReviewPacket(
  publicCase: PublicCase,
  observedOracles: readonly OracleStageArtifact[] = [],
  root?: string,
): Promise<ReviewPacket> {
  const dir = publicCaseDir(publicCase.id, root);

  return {
    promptVersion: PROMPT_VERSION,
    caseId: publicCase.id,
    case: publicCase,
    upstreamOld: await readTree(join(dir, 'upstream', 'old')),
    upstreamNew: await readTree(join(dir, 'upstream', 'new')),
    consumer: await readTree(join(dir, 'consumer')),
    observedOracles: observedOracles.map((stage) => ({
      stage: stage.stage,
      expected: stage.expected,
      observed: stage.observed,
      signature: stage.signature,
      outputExcerpt: stage.outputExcerpt,
    })),
  };
}

async function readTree(root: string): Promise<{ path: string; content: string }[]> {
  const files = await walkPaths(root);
  const entries: { path: string; content: string }[] = [];
  for (const file of files) {
    const relative = file.slice(root.length + 1).split('\\').join('/');
    const content = await readFile(file, 'utf8').catch(() => null);
    if (content === null) continue;
    entries.push({
      path: relative,
      // Truncation is stated in the content rather than silent, so a reviewer
      // can see that they are looking at part of a file and say so in their
      // uncertainty note instead of concluding from an absence.
      content:
        content.length <= MAX_FILE_BYTES
          ? content
          : `${content.slice(0, MAX_FILE_BYTES)}\n… [truncated by the review packet at ${MAX_FILE_BYTES} bytes; ${content.length - MAX_FILE_BYTES} bytes not shown]`,
    });
  }
  return entries;
}

/**
 * The reviewer instruction.
 *
 * Written to be answerable from the packet alone. Every field a reviewer
 * cannot support from the evidence has an explicit "say you could not tell"
 * escape, because the failure mode of an AI reviewer is not refusing to
 * answer — it is answering confidently from prior knowledge of the package.
 * A benchmark whose ground truth is a model's recollection of `left-pad` is
 * measuring recall, not correctness.
 */
export function reviewerInstruction(role: 'reviewer' | 'adjudicator'): string {
  const shared = [
    'You are establishing GROUND TRUTH for a dependency-upgrade benchmark.',
    '',
    'Rules:',
    '- Use ONLY the evidence in the packet. Do not use anything you know about this package from elsewhere.',
    '- If the evidence does not settle a field, say so. `uncertain` is a correct answer and is expected on hard cases.',
    '- Never guess a replacement symbol. A rename is only a rename if the evidence shows the new symbol does what the old one did.',
    '- Judge what the upgrade does to THIS consumer, not what it does in general.',
    '',
    'Output a single YAML document and nothing else, with exactly these fields:',
    '',
    'conclusion:',
    '  dependencyChanges: ["<ecosystem>:<name>:<from>-><to>", ...]   # what a manifest diff should find',
    '  evidenceFindings: ["<dependency>:<code>:<symbol>", ...]        # upstream facts; code is a rule code such as export-removed',
    '  upstreamFindings: ["<dependency>:<symbol>:<kind>", ...]        # your INTERPRETATION; kind is one of removed-export,',
    '                                                                 # renamed-export, moved-export, signature-change,',
    '                                                                 # type-change, behaviour-change, default-change, unknown',
    '  impactSites: ["<file>:<symbol>", ...]                          # consumer code actually affected; [] if none',
    '  taxonomy: { nature: "", detectability: [], scope: "", visibility: [] }',
    '  gaps: ["<what could not be established>", ...]',
    '  groundTruthSafety: safe | unsafe | uncertain',
    '  repair:',
    '    expectedAction: repair | abstain | no-repair-needed',
    '    expectedChangedFiles: ["<file>", ...]',
    'rationale:',
    '  summary: "<one paragraph>"',
    '  findingNotes: ["<why each finding is supported by which evidence>", ...]',
    '  uncertainty: "<what you could not establish, and why>"',
    '',
    'Guidance on `expectedAction`:',
    '- `repair` only when the evidence names the replacement unambiguously and the edit is mechanical.',
    '- `abstain` when something clearly broke but the evidence does not determine the correct fix.',
    '- `no-repair-needed` when this consumer is genuinely unaffected.',
  ];

  if (role === 'adjudicator') {
    return [
      ...shared,
      '',
      'You are the ADJUDICATOR. You are given the same evidence plus two independent reviews.',
      'You have NOT been shown any tool output and must not ask for any.',
      'Where the reviews agree, adopt the agreement. Where they disagree, decide from the evidence and say which',
      'reviewer you followed and why. If the evidence cannot settle a disagreement, mark that field uncertain and',
      'add the dispute to `gaps`. Do not manufacture consensus.',
      'Add one extra top-level field:',
      'adjudication:',
      '  agreements: ["<field>", ...]',
      '  disagreements: [{ field: "", reviewerA: "", reviewerB: "", decision: "", reason: "" }]',
      '  unresolved: ["<field>", ...]',
    ].join('\n');
  }

  return [
    ...shared,
    '',
    'You are an INDEPENDENT REVIEWER. You have not been shown any tool output or any other review, and there is',
    'no answer key. Derive the conclusion yourself from the packet.',
  ].join('\n');
}

/** Serializes the packet for a reviewer. YAML rather than JSON purely for readability at this size. */
export function renderPacket(packet: ReviewPacket): string {
  return YAML.stringify(packet, { lineWidth: 0 });
}
