import type { CommitUnit, RemediationPlan } from '../../../src/types.js';
import type { SessionEffort } from '../session.js';

/**
 * The fix-agent abstraction.
 *
 * Drift does not ship a model and does not want your API key. It drives
 * whatever AI you already have — Copilot, Claude, Codex, Gemini, a local
 * Ollama, or GitHub's cloud agent — because you have already chosen one, paid
 * for it, and decided you trust it.
 *
 * Agents fall into three kinds, and the difference is *who edits the files*:
 *
 *   in-editor  The model returns text; Drift applies the edits through the
 *              workspace API, so every change lands in VS Code's undo stack.
 *   cli        An agent binary edits the working tree itself. Drift hands it
 *              the plan and reads the result back out of git.
 *   cloud      The work happens on GitHub. Drift gets a pull request back.
 */

export type AgentKind = 'in-editor' | 'cli' | 'cloud';

export interface AgentAvailability {
  available: boolean;
  /** Shown in the picker when unavailable — must say how to fix it. */
  reason?: string;
  /** e.g. the resolved model name or binary version. */
  detail?: string;
  /** Local signals such as installed VS Code extensions or signed-in account state. */
  signals?: string[];
}

/**
 * One model inside one subscription.
 *
 * A subscription is not a model: a developer paying for Claude has Opus, Sonnet
 * and Haiku, and a Copilot seat carries whatever families GitHub is currently
 * offering. Collapsing those into a single "Claude" row throws away the choice
 * that actually changes the result, so every agent that has models lists them.
 */
export interface AgentModel {
  /** Passed to the backend verbatim. */
  id: string;
  label: string;
  detail?: string;
  /**
   * Effort stops this model can honour, weakest first.
   *
   * The composer's slider is drawn from this, so a model with no reasoning
   * control never offers a stop that would do nothing.
   */
  efforts?: SessionEffort[];
}

export interface FileSnapshot {
  /** Workspace-relative, `/`-separated. */
  path: string;
  content: string;
}

export interface FileEdit {
  path: string;
  /** Full replacement content. */
  content: string;
}

/** A file, folder, or selection the developer pointed the agent at. */
export interface AttachedContext {
  kind: 'file' | 'folder' | 'package' | 'selection';
  label: string;
  /** Workspace-relative path, package name, or `file:from-to`. */
  value: string;
  /** Contents, for attachments small enough to inline. */
  content?: string;
}

export interface FixTask {
  plan: RemediationPlan;
  /** The single commit unit being worked on. One concern at a time. */
  commit: CommitUnit;
  workspaceRoot: string;
  /** Current contents of the files this commit is scoped to. */
  files: FileSnapshot[];
  /** Extra repository conventions from settings. */
  customInstructions?: string;
  /**
   * Context the developer attached in the panel.
   *
   * Reference material, not scope: an attachment tells the agent where to look
   * for a convention or a helper, and never widens which files it may edit.
   */
  context?: AttachedContext[];
  /** The model chosen inside this agent's subscription, if it has any. */
  model?: string;
  /** How hard the developer asked this model to think. */
  effort?: SessionEffort;
}

export type FixStatus = 'applied' | 'no-changes' | 'failed' | 'delegated';

export interface FixOutcome {
  status: FixStatus;
  /** Populated by in-editor agents; CLI agents edit the tree directly. */
  edits?: FileEdit[];
  message: string;
  /** Cloud agents return where the work is happening. */
  url?: string;
  /** Anything the agent flagged as unresolved. Surfaced prominently. */
  warnings?: string[];
}

export interface AgentContext {
  /** Streams human-readable progress into the UI. */
  report: (message: string) => void;
  /**
   * Put a question to the developer and wait for the answer.
   *
   * A coding agent working unsupervised has exactly two options at a genuine
   * fork: guess, or ask. Guessing is how a dependency fix quietly changes
   * behaviour. Asking costs one click, so Drift makes asking available to every
   * agent that can express a question.
   *
   * Resolves to an empty string if the developer walks away, which agents should
   * treat as "make the safe choice and flag it".
   */
  ask?: (question: string, options?: string[]) => Promise<string>;
  /** Cancelled when the user aborts. Agents must honour it. */
  signal: AbortSignal;
}

export interface FixAgent {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: AgentKind;
  /** Whether a model id typed by hand is worth offering. */
  readonly acceptsCustomModel?: boolean;
  detect(): Promise<AgentAvailability>;
  /** The models available inside this subscription. Absent means "just the one". */
  listModels?(): Promise<AgentModel[]>;
  run(task: FixTask, ctx: AgentContext): Promise<FixOutcome>;
}

/* ------------------------------------------------------------------ */
/* Shared prompt construction                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the instruction text handed to any agent.
 *
 * Deliberately identical across every backend. The prompt carries the evidence
 * inline so the model does not have to recall the package's API, the exact
 * impact sites so it does not have to search, and the prohibitions that cover
 * an unsupervised agent's predictable failure modes.
 */
export function buildFixPrompt(task: FixTask): string {
  const { plan, commit } = task;
  const evidenceById = new Map(plan.evidence.map((e) => [e.id, e]));
  const changes = plan.breakingChanges.filter((c) => commit.breakingChangeIds.includes(c.id));

  const sections: string[] = [];

  sections.push(
    [
      'You are fixing code that a dependency upgrade broke.',
      '',
      'The dependency versions have ALREADY been updated. Your job is to update',
      "this repository's own code so it works with the new version.",
      '',
      `Dependencies that moved: ${plan.changes
        .map((c) => `${c.name} ${c.from ?? '—'} → ${c.to ?? '—'}`)
        .join(', ')}`,
    ].join('\n'),
  );

  for (const change of changes) {
    const lines = [`## ${change.summary}`, ''];
    lines.push(`- Package: ${change.dependency}`);
    lines.push(`- Kind: ${change.kind}`);
    lines.push(`- Confidence: ${change.confidence}`);
    if (change.symbols.length) lines.push(`- Symbols: ${change.symbols.join(', ')}`);
    lines.push('');
    lines.push(`**Required fix:** ${change.remediation}`);
    lines.push('');

    for (const id of change.citations) {
      const evidence = evidenceById.get(id);
      if (!evidence) continue;
      lines.push(`Evidence — ${evidence.title}:`);
      lines.push('```');
      lines.push(evidence.content.slice(0, 1200));
      lines.push('```');
      if (evidence.url) lines.push(`Source: ${evidence.url}`);
      lines.push('');
    }

    const sites = plan.impactSites.filter((s) => s.breakingChangeId === change.id);
    if (sites.length) {
      lines.push('Known locations (verify each; there may be others):');
      for (const site of sites.slice(0, 30)) {
        const where = site.enclosingSymbol ? ` in ${site.enclosingSymbol}` : '';
        lines.push(`- ${site.file}:${site.line}${where} — ${site.excerpt}`);
      }
      lines.push('');
    }

    sections.push(lines.join('\n'));
  }

  sections.push(
    [
      '## Rules',
      '',
      '1. Change ONLY what is required for this specific fix. No refactoring,',
      '   renaming, reformatting, or tidying of code you happen to pass by.',
      '2. Do NOT change dependency versions in any manifest or lockfile.',
      '3. Do NOT weaken, skip, or delete tests to make them pass. Update a test',
      '   to exercise the new API while asserting the same behaviour.',
      '4. If you cannot determine the correct fix for a location, leave it alone',
      '   and add a `TODO(drift):` comment explaining what is unresolved. A',
      '   flagged unknown is useful; a confident guess is not.',
      '5. Do not invent APIs. If the evidence names no replacement, say so.',
      '6. If a decision genuinely needs the developer — two valid migrations, a',
      '   behaviour change only they can rule on — ask instead of guessing. Emit',
      `   \`${QUESTION_MARKER} <your question> | <option> | <option>\` as the first`,
      '   line of your reply, output nothing else, and stop. You will be asked',
      '   again with the answer. Use this sparingly; a question that the evidence',
      '   already answers wastes the developer\'s attention.',
    ].join('\n'),
  );

  if (task.customInstructions?.trim()) {
    sections.push(`## Repository conventions\n\n${task.customInstructions.trim()}`);
  }

  if (task.context?.length) {
    const lines = [
      '## Context the developer attached',
      '',
      'Reference material. Read it to match this codebase, but do NOT edit any of',
      'it — the files in scope for this commit are listed above and nowhere else.',
      '',
    ];

    for (const entry of task.context) {
      lines.push(`### ${entry.kind}: ${entry.value}`);
      if (entry.content) {
        lines.push('```');
        lines.push(entry.content.slice(0, 4000));
        lines.push('```');
      }
      lines.push('');
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/** Marker format used to get whole files back from a text-completion model. */
export const FILE_BEGIN = '=== DRIFT FILE:';
export const FILE_END = '=== DRIFT END ===';

/** Marker a model uses to hand a decision back to the developer. */
export const QUESTION_MARKER = '=== DRIFT QUESTION:';

export interface AgentQuestion {
  text: string;
  options: string[];
}

/**
 * Pull a question out of a model response.
 *
 * Only honoured when the model produced no file blocks — a reply containing
 * both edits and a question has already made the decision it claims to be
 * asking about, and the edits are the honest signal.
 */
export function parseQuestion(text: string): AgentQuestion | null {
  if (text.includes(FILE_BEGIN)) return null;

  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(QUESTION_MARKER));
  if (!line) return null;

  const [question, ...options] = line
    .slice(QUESTION_MARKER.length)
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!question) return null;
  return { text: question, options };
}

export function buildEditProtocolInstructions(files: readonly FileSnapshot[]): string {
  return [
    '## Output format',
    '',
    'Return the COMPLETE new contents of every file you change, using exactly',
    'this format and nothing else outside the blocks:',
    '',
    `${FILE_BEGIN} path/to/file.ts`,
    '<the entire file, from first line to last>',
    FILE_END,
    '',
    'Rules for the output:',
    '- Emit a block ONLY for files you actually changed.',
    '- Never abbreviate. Never write "... rest unchanged ...". The block',
    '  replaces the whole file, so anything you omit is deleted.',
    '- If no change is needed anywhere, reply with exactly: NO CHANGES NEEDED',
    '',
    `Files in scope:\n${files.map((f) => `- ${f.path}`).join('\n')}`,
  ].join('\n');
}

/**
 * Parse whole-file blocks out of a model response.
 *
 * Tolerant of the usual model habits — stray prose around the blocks, an
 * accidental markdown fence wrapping the content — because rejecting a
 * near-correct response outright would mean discarding real work.
 */
export function parseFileBlocks(text: string): FileEdit[] {
  const edits: FileEdit[] = [];
  const lines = text.split('\n');

  let current: { path: string; body: string[] } | null = null;

  for (const line of lines) {
    const start = line.trimStart().startsWith(FILE_BEGIN)
      ? line.trimStart().slice(FILE_BEGIN.length).trim().replace(/=+$/, '').trim()
      : null;

    if (start !== null) {
      current = { path: start, body: [] };
      continue;
    }

    if (current && line.trimStart().startsWith(FILE_END)) {
      edits.push({ path: current.path, content: stripFence(current.body).join('\n') });
      current = null;
      continue;
    }

    if (current) current.body.push(line);
  }

  return edits.filter((e) => e.path && e.content.trim().length > 0);
}

/** Drop a markdown fence if the model wrapped the file body in one. */
function stripFence(body: string[]): string[] {
  const first = body.findIndex((l) => l.trim() !== '');
  if (first === -1) return body;

  if (!body[first]!.trim().startsWith('```')) return body;

  const last = body.map((l) => l.trim()).lastIndexOf('```');
  if (last <= first) return body;

  return body.slice(first + 1, last);
}

export function saysNoChanges(text: string): boolean {
  return /^\s*NO CHANGES NEEDED\s*$/im.test(text.trim());
}
