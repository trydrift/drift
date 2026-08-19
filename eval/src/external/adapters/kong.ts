import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KONG_CATEGORY_MAPPING, MappingTable } from '../mapping.ts';
import { EXTERNAL_RECORD_VERSION, type ExternalCaseResult } from '../record.ts';
import type { Selectable } from '../selection.ts';
import {
  DriftConfigSchema,
  analyze,
  extractBreakingPassages,
  type BreakingChange,
  type DependencyChange,
  type Evidence,
  type Logger,
} from '../../../../dist/index.js';

/**
 * Kong's npm breaking-change corpus, against Drift's real prose interpreter.
 *
 * ## What is under test, exactly
 *
 * This corpus is prose. It records, for 5,242 real commits across 381 sampled
 * npm projects, the message the maintainer actually wrote — and for 1,519 of
 * them, a human annotator's category for the breaking change it describes. It
 * contains no consumer repositories, no version pairs and no build oracles, so
 * it cannot say anything about detection in a repository, localization, or
 * repair.
 *
 * What it *can* test is the component that turns "the upstream text says this"
 * into a `BreakingChange`, which is a real production module:
 * `extractBreakingPassages` pulls the breaking passages out of a body, and
 * `analyze` runs Drift's own prose rules over them. Both are imported from
 * `dist/`, the same build the CLI ships; nothing here reimplements a rule.
 *
 * The result is therefore explicitly a **conditional** experiment — a
 * capability ceiling for one stage — and never an end-to-end product claim.
 * Reported as one, it would be an ablation dressed up as accuracy.
 *
 * ## What the labels are actually like
 *
 * Worth stating before any number, because it decides how much a good score is
 * worth. Kong collected breaking commits by looking for a conventional-commits
 * `BREAKING CHANGE` annotation, and it shows: of RQ1's 165 positive commits,
 * 164 contain that literal marker, and of its 16,168 negatives, 29 do. The
 * binary question "does this message document a breaking change?" is therefore
 * close to solvable by `grep`, and a tool scoring well on it has demonstrated
 * very little. So `MARKER_BASELINE` computes exactly that trivial baseline and
 * the report prints it beside Drift's number — a score that a regular
 * expression matches is a score a reader should discount, and the honest way
 * to say so is to show the regular expression's score.
 *
 * The category task is the one that carries information. Every commit in it
 * already carries the marker, so recognising *that* it is breaking is free;
 * what is not free is reading "rename Context to HttpContext" as a rename and
 * "remove config reader" as a removal. That is what Drift's prose rules exist
 * to do and what this measures.
 */

export const ADAPTER_VERSION = 'kong-prose-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

/**
 * The trivial baseline, published beside the result rather than kept quiet.
 *
 * This is not Drift and is not presented as Drift. It is the score obtainable
 * by matching a conventional-commits marker, and it exists so a reader can see
 * how much of the binary task's ceiling is reachable without reading anything.
 */
export const MARKER_BASELINE = /BREAKING[ -]?CHANGES?\b|BREAKING:/i;

/**
 * Whether the commit message says anything beyond the marker itself.
 *
 * This matters more than it looks. Kong records where its annotators found each
 * change documented, and for 1,494 of 1,519 that place is the pull request or
 * issue — not the commit. Plenty of these messages are literally the four
 * characters `BREAKING CHANGE` with the description living somewhere this
 * corpus does not ship. A tool given only the message cannot read a rename out
 * of a line that does not describe one, and scoring those together with
 * messages that *do* describe the change would blend a Drift limitation with a
 * corpus limitation into one uninterpretable percentage.
 *
 * So it is recorded per case and reported as a stratum. Deliberately not used
 * as a filter: the headline stays over every mappable case, because "the
 * upstream text often does not say" is a real thing a user of Drift runs into,
 * and quietly dropping those cases would report a capability the product does
 * not have on the input it actually gets.
 */
export function statesDetail(commitMessage: string): boolean {
  const remainder = commitMessage
    .split('\n')
    .filter((line) => MARKER_BASELINE.test(line))
    .map((line) => line.replace(MARKER_BASELINE, '').replace(/^[\s:,.-]+/, '').trim())
    .join(' ')
    .trim();
  // Four words is the shortest thing that can name a symbol and say what
  // happened to it ("removed helper.isRefined, use x"). Below that there is
  // nothing for a prose rule to read.
  return remainder.split(/\s+/).filter(Boolean).length >= 4;
}

export type KongExperiment = 'rq1-documented' | 'rq2-category';

export interface KongRecord {
  id: string;
  project: string;
  commit: string;
  commitMessage: string;
  /** RQ1 only: whether developers documented a breaking change in this commit. */
  documented?: boolean;
  /** RQ2 only: the annotator's category, verbatim. */
  category?: string;
  /** RQ2 only: where the annotators found the change documented. Used to stratify, never to score. */
  documentationPlace?: string;
}

export interface KongCorpus {
  experiment: KongExperiment;
  records: KongRecord[];
  /** Per-file sha256 of everything actually read, so a run can prove which bytes it scored. */
  sourceHashes: Record<string, string>;
}

/**
 * Loads one of the two experiments.
 *
 * RQ2's category file names a project and a commit but not the message, so it
 * is joined against the collected-commits files to recover the real prose. A
 * record whose message cannot be recovered is dropped *here*, with its count
 * returned, rather than being scored against a message it does not have.
 */
export async function loadKong(root: string, experiment: KongExperiment): Promise<KongCorpus> {
  const sourceHashes: Record<string, string> = {};
  const read = async (relative: string): Promise<string> => {
    const bytes = await readFile(join(root, relative));
    sourceHashes[relative] = createHash('sha256').update(bytes).digest('hex');
    return bytes.toString('utf8');
  };

  if (experiment === 'rq1-documented') {
    const rows = parseCsv(await read('rq1/detected_bc_are_documented.csv'));
    return {
      experiment,
      sourceHashes,
      records: rows.map((row, index) => ({
        id: `${row['project']}@${row['commit_id']}`.slice(0, 200) || `row-${index}`,
        project: row['project'] ?? '',
        commit: row['commit_id'] ?? '',
        commitMessage: row['commit_message'] ?? '',
        documented: row['document_breaking_change'] === 'yes',
      })),
    };
  }

  const annotated = parseCsv(await read('rq2-3-4/analyzed_breaking_changes.csv'));
  const messages = new Map<string, string>();
  for (const file of ['original_data/original_breaking_commits.csv', 'original_data/breaking_commits_after_removal.csv']) {
    for (const row of parseCsv(await read(file))) {
      const key = `${row['project']}@${row['commit_id']}`;
      if (!messages.has(key) && row['commit_message']) messages.set(key, row['commit_message']);
    }
  }

  const records: KongRecord[] = [];
  for (const [index, row] of annotated.entries()) {
    const key = `${row['project']}@${row['commit_id']}`;
    const message = messages.get(key);
    // No message means no prose, and scoring a prose interpreter against
    // nothing would be recording a failure the corpus caused.
    if (!message) continue;
    records.push({
      id: `${key}#${index}`,
      project: row['project'] ?? '',
      commit: row['commit_id'] ?? '',
      commitMessage: message,
      category: row['category'] ?? '',
      documentationPlace: row['documentation_place'] ?? '',
    });
  }

  return { experiment, sourceHashes, records };
}

export function kongSelectables(corpus: KongCorpus): Selectable[] {
  return corpus.records.map((record) => ({
    id: record.id,
    // Stratified by the thing that actually varies the difficulty: the
    // annotated category for RQ2, the label for RQ1. Project is second so one
    // prolific repository cannot dominate a sample.
    strata: [record.category ?? String(record.documented), record.project],
  }));
}

/**
 * Runs Drift's production prose path over one commit message.
 *
 * The two substitutions this makes are recorded rather than hidden. Kong names
 * a GitHub repository, not an npm package, so the `DependencyChange` carries
 * the repository name — the prose rules never read it, and the alternative
 * would be inventing a package name the dataset does not state. And the
 * message is supplied as `github-release` evidence, which is the
 * release-note-shaped prose source Drift's analyser weights at 0.7; a commit
 * message is not literally a release note, and calling it one is the closest
 * honest description of what it is being used as.
 */
export async function predictKong(record: KongRecord): Promise<{
  breakingChanges: BreakingChange[];
  passages: string[];
}> {
  const config = DriftConfigSchema.parse({ llm: { enabled: false } });

  const change: DependencyChange = {
    name: record.project,
    ecosystem: 'npm',
    // The corpus states no version pair — it is a commit, not an upgrade — so
    // both ends are `null`, which is what production already means by "we do
    // not know the versions" rather than a placeholder invented here.
    from: null,
    to: null,
    kind: 'runtime',
    bump: 'major',
    manifestPath: 'package.json',
  };

  const passages = extractBreakingPassages(record.commitMessage);
  const evidence: Evidence[] = [
    {
      id: `kong:${record.project}@${record.commit}`,
      source: 'github-release',
      dependency: record.project,
      url: `https://github.com/${record.project}/commit/${record.commit}`,
      title: firstLine(record.commitMessage),
      content: record.commitMessage,
      weight: 0.7,
    },
  ];

  const breakingChanges = await analyze([change], evidence, { config, logger: SILENT_LOGGER });
  return { breakingChanges, passages };
}

export interface ScoreKongInput {
  record: KongRecord;
  experiment: KongExperiment;
  prediction: { breakingChanges: BreakingChange[]; passages: string[] };
  datasetVersion: string;
  sourceHash: string;
  durationMs: number;
}

export function scoreKong(input: ScoreKongInput): ExternalCaseResult {
  const { record, prediction } = input;
  const predictedPositive = prediction.breakingChanges.length > 0;
  const kinds = [...new Set(prediction.breakingChanges.map((change) => change.kind))].sort();

  const base = {
    schemaVersion: EXTERNAL_RECORD_VERSION as typeof EXTERNAL_RECORD_VERSION,
    caseId: record.id,
    provenance: {
      dataset: 'kong',
      datasetVersion: input.datasetVersion,
      recordId: `${record.project}@${record.commit}`,
      repository: `https://github.com/${record.project}`,
      commit: record.commit,
      baseCommit: null,
      dependency: record.project,
      fromVersion: null,
      toVersion: null,
      packageManager: 'npm',
      requiredRuntime: null,
      oracleCommand: null,
      containerImage: null,
      sourceHash: input.sourceHash,
      extra: {
        // The exact bytes scored, so a reader can check the message against
        // GitHub themselves rather than taking the dataset's word for it.
        commitMessageSha256: createHash('sha256').update(record.commitMessage).digest('hex'),
        ...(record.documentationPlace ? { documentationPlace: record.documentationPlace } : {}),
        markerBaselinePredictsBreaking: String(MARKER_BASELINE.test(record.commitMessage)),
        // The stratum, not a filter. See `statesDetail`.
        messageStatesDetail: String(statesDetail(record.commitMessage)),
      },
    },
    prediction: {
      breakingChangeKinds: kinds,
      breakingChangeCount: prediction.breakingChanges.length,
      symbols: prediction.breakingChanges.flatMap((change) => change.symbols ?? []),
      breakingPassages: prediction.passages,
    } as Record<string, unknown>,
    // Top-level, beside `outcomes` rather than inside `prediction`, because a
    // confusion matrix needs the prediction and the label as two independent
    // facts. Deriving one from an `outcomes` correctness flag is how a correct
    // rejection ends up counted as a detection.
    predictedPositive,
    durationMs: input.durationMs,
  };

  if (input.experiment === 'rq1-documented') {
    const positive = record.documented === true;
    return {
      ...base,
      truth: {
        label: positive ? 'documents-breaking-change' : 'no-documented-breaking-change',
        mappedTo: positive ? 'breaking' : 'not-breaking',
        mappingStatus: 'exact',
        mappingNote: '',
        polarity: positive ? 'positive' : 'negative',
      },
      // Only the positives contribute to a recall; the negatives are what make
      // precision computable, and they are carried through `polarity` rather
      // than by inverting this flag, which would make a correct rejection look
      // like a detection.
      outcomes: positive ? { detectedBreaking: predictedPositive } : {},
      excluded: null,
    };
  }

  const mapping = KONG_CATEGORY_MAPPING.lookup(record.category ?? '');
  const categoryScorable = MappingTable.scorable(mapping.status);

  /*
   * Two questions, and only one of them depends on the mapping.
   *
   * Every record in RQ2 is a breaking change a human annotated as one, so
   * "did Drift read a breaking change out of this prose?" is answerable
   * whatever category Kong assigned. Excluding an unmappable record outright —
   * which this used to do — threw away that answer along with the category one,
   * and shrank the detection denominator from 1,511 to 483 for a reason that
   * has nothing to do with detection.
   */
  return {
    ...base,
    truth: {
      label: record.category ?? '',
      mappedTo: mapping.drift,
      mappingStatus: mapping.status,
      mappingNote: mapping.note,
      polarity: 'positive',
    },
    outcomes: {
      detectedBreaking: predictedPositive,
      // Correct when the mapped kind is among what Drift produced. Not "the
      // first one": a message describing several changes legitimately yields
      // several findings, and requiring the annotated one to come first would
      // score a richer analysis as wrong for ordering reasons.
      ...(categoryScorable
        ? { categoryCorrect: mapping.drift !== null && (kinds as string[]).includes(mapping.drift) }
        : {}),
    },
    excluded: null,
  };
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

/**
 * A CSV reader that survives this corpus.
 *
 * Commit messages are embedded whole, so records span many physical lines and
 * contain quotes, commas and CRLF. Written here rather than pulled in as a
 * dependency because the harness ships no CSV parser and this is the only
 * place that needs one — and because a wrong parse would silently shift every
 * label by one column, which is the kind of error a benchmark must not have.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const body = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((entry) => entry.length > 1 || (entry[0] ?? '').trim().length > 0)
    .map((entry) => Object.fromEntries(header.map((name, index) => [name, entry[index] ?? ''])));
}
