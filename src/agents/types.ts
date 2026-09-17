import type { CommitUnit, RemediationPlan } from '../types.js';

export type SessionEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface TaskActivityInput {
  kind:
    | 'status'
    | 'thinking'
    | 'read'
    | 'edit'
    | 'create'
    | 'search'
    | 'bash'
    | 'prompt'
    | 'patch'
    | 'tokens'
    | 'diff'
    | 'error';
  title: string;
  detail?: string;
  input?: string;
  output?: string;
  file?: string;
  added?: number;
  removed?: number;
  lines?: { kind: 'add' | 'del' | 'context'; text: string }[];
  links?: string[];
}

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

export interface AgentCapabilities {
  execution: 'workspace' | 'cloud';
  /** Cloud adapters may be pollable; workspace agents complete in-process. */
  canAwaitCompletion: boolean;
  /** Whether Drift can inspect the complete result before accepting it. */
  canInspectResult: boolean;
}

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
   * This model's own effort scale, when it differs from its subscription's.
   *
   * The composer's dial is drawn from this, so a model that cannot honour a
   * stop never offers one.
   */
  efforts?: readonly EffortStop[];
}

/**
 * One position on an agent's effort dial.
 *
 * Every provider names its own reasoning budget, and the panel uses that name
 * rather than inventing a house vocabulary: Claude's top stop is Ultracode,
 * Codex's is Extra High, and a developer reading either should see the word
 * their subscription uses. `value` is the ordinal Drift stores and passes back;
 * `label` and `detail` are the provider's.
 */
export interface EffortStop {
  value: SessionEffort;
  label: string;
  /** What this position actually does to the model. */
  detail: string;
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
  /** Trade tokens for latency, where the agent offers that. */
  fast?: boolean;
  /**
   * What the project's own toolchain says is broken, right now, after the
   * upgrade — already grouped and counted.
   *
   * Everything else in this prompt is Drift's prediction: evidence read from a
   * changelog, impact sites matched against a type surface. This is the one
   * section that is measured rather than inferred, which makes it the strongest
   * thing here and worth stating separately from the analysis it confirms — or
   * contradicts, which is at least as useful.
   *
   * Absent when no checks ran or the tree already compiled.
   */
  diagnostics?: string;
  /**
   * A previous attempt the developer rejected, and what they said about it.
   *
   * Present only on a retry. This is the difference between "try again" and
   * "try again, differently": without the rejected diff the agent has no way to
   * know what it did last time, and re-running the identical prompt reliably
   * produces the identical answer — which is the single most frustrating thing
   * a tool can do to someone who has just said it got it wrong.
   */
  revision?: RevisionRequest;
  /**
   * Drift's own verification failed after earlier edits, and this session is
   * a fresh, bounded attempt at what still fails.
   *
   * Set only by the remediation controller. It replaces a conversation that
   * would otherwise carry every earlier build log: the next session gets the
   * grouped failure, the edits already made to the files in scope, and nothing
   * else from before.
   */
  repair?: RepairRequest;
  /**
   * Who runs the project's broad verification for this session. `controller`
   * means Drift does, after the session; an agent that supports it is then
   * prevented from running whole-project checks itself (see
   * `verification-guard.ts`), not merely asked not to.
   */
  verificationOwner?: 'controller' | 'agent';
}

export interface RepairRequest {
  /** Which repair round this is, starting at 1. */
  round: number;
  /** The failing checks, already digested for a prompt. */
  failures: string;
  /** Edits already applied to the files in scope, so they are neither redone nor undone blindly. */
  previousDiff?: string;
  /** Why Drift discarded the previous session's edits for this work, when it did. */
  previousRejection?: string;
}

export interface RevisionRequest {
  /** What the developer asked for, verbatim. Never paraphrased. */
  guidance: string;
  /** The diff of the attempt being rejected, so it is not repeated. */
  previousDiff?: string;
  /** Which attempt this is, starting at 2. */
  attempt: number;
}

export type FixStatus = 'applied' | 'no-changes' | 'failed' | 'delegated';

export interface FixOutcome {
  status: FixStatus;
  /** Populated by in-editor agents; CLI agents edit the tree directly. */
  edits?: FileEdit[];
  message: string;
  /** Cloud agents return where the work is happening. */
  url?: string;
  handle?: CloudAgentHandle;
  /** Anything the agent flagged as unresolved. Surfaced prominently. */
  warnings?: string[];
  /**
   * Files the agent said it needs and was not allowed to edit, with why.
   *
   * The agent is told to stop and ask rather than widen its own scope. The
   * controller decides whether to grant them in a fresh session.
   */
  scopeRequests?: ScopeRequest[];
  /** The provider's session id, when it reports one. For observability only. */
  sessionId?: string;
}

export interface ScopeRequest {
  path: string;
  reason: string;
}

export interface CloudAgentHandle {
  provider: string;
  id: string;
  state: string;
  branch: string;
  url?: string;
  capabilities: AgentCapabilities;
}

export interface CloudTaskStatus {
  state: string;
  pullRequestUrl?: string;
}

export interface CloudAgentTaskRef {
  provider: string;
  id: string;
  state?: string;
  branch?: string;
  url?: string;
}

export interface AgentContext {
  /** Streams human-readable progress into the UI. */
  report: (message: string) => void;
  /**
   * Report one thing the agent did, already named.
   *
   * `report` hands over a line and lets the caller classify it, which is the
   * right shape for an agent whose output is unstructured prose. It is the
   * wrong shape for one whose output is not: Codex writes blocks, and only the
   * code reading that stream knows where a block starts, that four lines of
   * output belong under the command above them, or that a paragraph of
   * reasoning is one event rather than six. An agent that knows says so here
   * instead of throwing the structure away and hoping a line classifier
   * rebuilds it.
   */
  activity?: (activity: TaskActivityInput) => void;
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
  readonly capabilities: AgentCapabilities;
  /** Whether a model id typed by hand is worth offering. */
  readonly acceptsCustomModel?: boolean;
  /**
   * Whether `listModels` reports what this install can actually reach.
   *
   * True only when the list was read from the agent's own record rather than
   * written down here. It is the difference between "Drift has not heard of
   * that model" and "this subscription cannot use it", and only the second is
   * grounds for clearing a choice the developer made.
   */
  readonly rosterIsAuthoritative?: boolean;
  /**
   * This subscription's effort scale, in its own vocabulary.
   *
   * Absent means the backend has no reasoning control at all, and the composer
   * then hides the dial rather than showing one that does nothing.
   */
  readonly efforts?: readonly EffortStop[];
  detect(): Promise<AgentAvailability>;
  /** The models available inside this subscription. Absent means "just the one". */
  listModels?(): Promise<AgentModel[]>;
  run(task: FixTask, ctx: AgentContext): Promise<FixOutcome>;
}

export interface CloudFixAgent extends FixAgent {
  readonly capabilities: AgentCapabilities & { execution: 'cloud' };
  status(task: CloudAgentTaskRef): Promise<CloudTaskStatus | null>;
  isTerminalState(state: string): boolean;
}

/* ------------------------------------------------------------------ */
/* Shared prompt construction                                          */
/* ------------------------------------------------------------------ */

export interface FixTaskSemantics {
  plan: RemediationPlan;
  commit: CommitUnit;
  files: readonly FileSnapshot[];
  customInstructions?: string;
  context?: readonly AttachedContext[];
  diagnostics?: string;
  revision?: RevisionRequest;
  repair?: RepairRequest;
}

export function buildFixTask(task: FixTask): FixTaskSemantics {
  return {
    plan: task.plan,
    commit: task.commit,
    files: task.files,
    customInstructions: task.customInstructions,
    context: task.context,
    diagnostics: task.diagnostics,
    revision: task.revision,
    repair: task.repair,
  };
}

/**
 * The whole prompt a workspace CLI agent receives: the commit prompt, the
 * unit's own instructions, and an optional reasoning sentence. One function so
 * every caller that starts a session — the CLI agent and any harness that
 * drives a session itself — sends the same text.
 */
export function composeAgentPrompt(task: FixTask, thinking = ''): string {
  return [buildFixPrompt(task), '', '## Your task', '', task.commit.instructions, ...(thinking ? ['', thinking] : [])].join('\n');
}

/** Compatibility name for commit-scoped agents. */
export function buildFixPrompt(task: FixTask): string {
  return renderCommitAgentPrompt(buildFixTask(task));
}

/**
 * Render the prompt for a single commit/unit agent run.
 *
 * The semantics come from `buildFixTask`; this renderer is allowed to be
 * commit-shaped because workspace agents are executed and validated one unit
 * at a time.
 */
export function renderCommitAgentPrompt(task: FixTaskSemantics): string {
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
    // Stated either way. An absent replacement line reads as "go and find
    // one", which is how an agent ends up reading the package's source for
    // an answer Drift already had — or inventing one Drift never had.
    lines.push(
      change.replacementSymbols?.length
        ? `- Replacement: ${change.replacementSymbols.join(', ')}`
        : '- Replacement: none established by the evidence. Do not invent one; if the fix needs one, take it from the installed package\'s own type declarations.',
    );
    if (change.before) lines.push('', 'Before:', '```', change.before.slice(0, 800), '```');
    if (change.after) lines.push('', 'After:', '```', change.after.slice(0, 800), '```');
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

  // Placed after the evidence and before the rules, because it is the section
  // that settles disagreements between them. Drift's impact analysis says what
  // it expects to break; this says what the compiler actually reports. Where
  // they differ, the compiler is right.
  if (task.diagnostics?.trim()) {
    sections.push(
      [
        '## What the project\'s own checks report right now',
        '',
        'These ran against the tree you are about to edit, after the dependency',
        'versions moved. Unlike everything above, this is measured rather than',
        'predicted — where it disagrees with the analysis, believe this.',
        '',
        'Diagnostics are grouped by root cause with a count. A problem reported',
        'many times is one problem: find what it shares before editing any',
        'individual site, and do not work through occurrences one by one.',
        '',
        'Some of these may have nothing to do with the upgrade. Fixing unrelated',
        'pre-existing errors is out of scope — leave them alone.',
        '',
        task.diagnostics.trim(),
      ].join('\n'),
    );
  }

  if (task.repair) {
    const lines = [
      `## What still fails (repair round ${task.repair.round})`,
      '',
      'Earlier edits for this upgrade have already been applied. Drift then ran',
      "the project's checks itself, and these failures remain. Fix these, and",
      'only these. A failure that has nothing to do with the upgrade — an',
      'environment problem, something that was already broken — is not yours to',
      'fix: say so and leave it.',
      '',
      task.repair.failures.trim(),
    ];
    if (task.repair.previousRejection?.trim()) {
      lines.push(
        '',
        'The previous session\'s edits for this were discarded by Drift\'s validation, so the files are as they were before it. Why:',
        '',
        '```',
        task.repair.previousRejection.trim().slice(0, 2000),
        '```',
        '',
        'Make the fix without repeating what was rejected.',
      );
    }
    if (task.repair.previousDiff?.trim()) {
      lines.push(
        '',
        'Edits already applied to the files in scope, for context. They are in the',
        'files now; build on them rather than redoing them:',
        '',
        '```diff',
        task.repair.previousDiff.trim().slice(0, 12_000),
        '```',
      );
    }
    sections.push(lines.join('\n'));
  }

  const upgraded = plan.changes.map((c) => c.name);
  // The commit's own grant, not the snapshots: a file the unit may create does
  // not exist yet and has no snapshot, and leaving it off this list would
  // forbid the edit the unit exists to make.
  const scope = [...new Set([...(commit.allowedFiles?.length ? commit.allowedFiles : commit.files), ...task.files.map((f) => f.path)])];

  sections.push(
    [
      '## Rules',
      '',
      `0. You may edit ONLY these ${scope.length} file${scope.length === 1 ? '' : 's'} — nothing else, including`,
      '   generated/bundled output, lockfiles, or a file you notice is *also*',
      '   broken by this upgrade. This is enforced after you finish: an edit to',
      '   any other file throws out this whole commit\'s work. If the real fix',
      '   needs a file outside this list (a new file included), do not edit it:',
      `   end your reply with one line per file, \`${SCOPE_REQUEST_MARKER} <path> | <why>\`,`,
      '   and Drift will decide whether to grant it in a new session.',
      `   In scope: ${scope.join(', ')}`,
      '1. Change ONLY what is required for this specific fix. No refactoring,',
      '   renaming, reformatting, or tidying of code you happen to pass by.',
      `2. Do NOT change, revert, or downgrade the upgraded dependenc${upgraded.length === 1 ? 'y' : 'ies'}${upgraded.length ? ` (${upgraded.join(', ')})` : ''}.`,
      '   A companion package that must move with the upgrade (a plugin or',
      '   peer the new version requires) may be changed only when its manifest',
      '   is in scope above.',
      '3. Do NOT weaken, skip, or delete tests to make them pass, lower coverage',
      '   thresholds, or relax compiler strictness. Update a test to exercise',
      '   the new API while asserting the same behaviour.',
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
      '7. Drift runs this repository\'s own build, typecheck, and test commands',
      '   itself once every commit in this run has landed. Do not run the full',
      '   test suite, a full build, or other broad verification yourself — it',
      '   duplicates what is about to run anyway and this is the slowest part',
      '   of a fix. A narrow, targeted check on a file you just edited (a single',
      '   test, a syntax check) is fine when you are unsure; a full `npm test`',
      '   or `npm run build` is not.',
      '8. What changed upstream is stated above. Do not re-derive it from the',
      "   dependency's changelog, registry metadata, or source; open the installed",
      '   package only for a detail this prompt does not give you.',
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

  // Last, and deliberately so. Everything above is Drift's reasoning about what
  // *should* be done; this is a human saying what was actually wrong with the
  // attempt they just read. Where the two disagree, the human wins, and putting
  // this section last is how that precedence is expressed in a prompt.
  if (task.revision?.guidance.trim()) {
    const lines = [
      '## The developer rejected your previous attempt',
      '',
      `This is attempt ${task.revision.attempt}. A previous attempt was reviewed by`,
      'the developer and turned down. What they said:',
      '',
      // Fenced, because this is untrusted free text from outside the prompt and
      // must read as data rather than as further instructions.
      '```',
      task.revision.guidance.trim(),
      '```',
      '',
      'Take this as decisive. It outranks every inference above, including the',
      'evidence and the impact analysis — those describe what Drift expected,',
      'and this describes what a human who read your output actually wants.',
      '',
      'Do not simply reproduce your previous attempt with cosmetic differences.',
      'If the guidance means the right change is smaller than you made, make the',
      'smaller one. If it means no change is correct here, make none and say so.',
    ];

    if (task.revision.previousDiff?.trim()) {
      lines.push(
        '',
        'The attempt that was rejected, as a diff. The files above have already',
        'been restored to their state *before* it, so you are editing the',
        'original, not this:',
        '',
        '```diff',
        task.revision.previousDiff.trim().slice(0, 20_000),
        '```',
      );
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Render a whole-plan cloud task.
 *
 * Cloud agents work asynchronously on a branch, so their protocol is
 * plan-shaped rather than commit-shaped. It still receives the same evidence,
 * scope, repository conventions, and safety rules.
 */
export function renderPlanAgentPrompt(task: FixTaskSemantics): string {
  return renderCommitAgentPrompt(task);
}

/** Marker format used to get whole files back from a text-completion model. */
export const FILE_BEGIN = '=== DRIFT FILE:';
export const FILE_END = '=== DRIFT END ===';

/** Marker a model uses to hand a decision back to the developer. */
export const QUESTION_MARKER = '=== DRIFT QUESTION:';

/** Marker a model uses to ask for a file outside its scope instead of editing it. */
export const SCOPE_REQUEST_MARKER = '=== DRIFT SCOPE REQUEST:';

/** Every well-formed scope request in an agent's output, deduplicated by path. */
export function parseScopeRequests(output: string): ScopeRequest[] {
  const requests = new Map<string, ScopeRequest>();
  for (const raw of output.split(/\r?\n/)) {
    const index = raw.indexOf(SCOPE_REQUEST_MARKER);
    if (index < 0) continue;
    const [path, ...reason] = raw.slice(index + SCOPE_REQUEST_MARKER.length).split('|');
    const cleaned = path?.trim().replace(/^[`'"]|[`'"]$/g, '');
    if (!cleaned || requests.has(cleaned)) continue;
    requests.set(cleaned, { path: cleaned, reason: reason.join('|').trim().slice(0, 300) });
  }
  return [...requests.values()];
}

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
