import type { BreakingChange, ImpactSite } from '../types.js';

/**
 * Deterministic codemods: mechanical fixes computed by code, never by a model.
 *
 * Scope is deliberately narrow, on purpose, in the same spirit as
 * `analyze/rules.ts` restricting prose rules to backtick-quoted identifiers:
 * a codemod here must be able to prove its own correctness by construction.
 * The only category that clears that bar today is a clean rename — one old
 * identifier, one new identifier, both plain identifiers with no dotted
 * member access, no import path, no punctuation — so a word-boundary replace
 * cannot silently rewrite something else that happens to share a substring.
 *
 * Matching follows `localize/index.ts`'s own word-boundary convention rather
 * than a per-language parser: Drift indexes a dozen ecosystems with the same
 * line-based approach precisely so no stage needs a bespoke AST for each one,
 * and a codemod that only ran for TypeScript would undercut the point of
 * putting it in the shared pipeline at all.
 *
 * This is why a codemod's edits are never trusted blindly: they still go
 * through the same scope validation and verification as an agent's output.
 * The lower cost comes from skipping the *generation* step for the cases this
 * module can resolve outright, not from a lower safety bar.
 */

/** A rule and its parameters — not a snapshot of any particular file. */
export interface CodemodTransform {
  ruleId: 'rename-identifier';
  from: string;
  to: string;
}

export interface CodemodEdit {
  file: string;
  before: string;
  after: string;
}

export interface CodemodResult {
  transform: CodemodTransform;
  /**
   * A preview computed against the file contents `attemptCodemod` was given,
   * for the report and the commit message. Not what a consumer should apply —
   * see `applyCodemodTransform`.
   */
  edits: CodemodEdit[];
  /** How many of the change's own impact sites this codemod actually touched. */
  sitesResolved: number;
}

const PLAIN_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Attempt a deterministic fix for one breaking change.
 *
 * `fileContents` must already hold the content of every file named by `sites`
 * — callers source it from the same in-memory read localization used, so this
 * never touches disk and stays a pure function over what the pipeline already
 * had in hand.
 *
 * Returns `null` when the change is not a plain rename, when either symbol
 * is not a plain identifier, or when nothing in the named files actually
 * matched. "Declined to act" is a first-class outcome here, not an error —
 * the caller's fallback is simply to hand the finding to an agent as before.
 */
export function attemptCodemod(
  change: BreakingChange,
  sites: readonly ImpactSite[],
  fileContents: ReadonlyMap<string, string>,
): CodemodResult | null {
  if (change.kind !== 'renamed-export') return null;
  if (change.symbols.length !== 1) return null;

  const from = change.symbols[0]!;
  const to = change.replacementSymbols?.[0];
  if (!to) return null;
  if (!PLAIN_IDENTIFIER.test(from) || !PLAIN_IDENTIFIER.test(to)) return null;
  if (from === to) return null;

  const transform: CodemodTransform = { ruleId: 'rename-identifier', from, to };
  const files = [...new Set(sites.map((site) => site.file))];
  const edits: CodemodEdit[] = [];
  let sitesResolved = 0;

  for (const file of files) {
    const before = fileContents.get(file);
    if (before === undefined) continue;

    const after = applyCodemodTransform(before, transform);
    if (after === before) continue;

    edits.push({ file, before, after });
    sitesResolved += sites.filter((site) => site.file === file).length;
  }

  if (edits.length === 0) return null;

  return { transform, edits, sitesResolved };
}

/**
 * Apply a codemod transform to file content, fresh.
 *
 * Deliberately re-derived from the rule and its parameters rather than
 * replayed from a stored `before`/`after` snapshot: a plan can be applied
 * well after analysis, and after earlier commit units have already changed
 * the tree. Re-applying the rule against whatever the file actually contains
 * right now is what makes the second, third, and Nth application correct,
 * not just the first — the same reason `advanceBase` in the extension's fix
 * flow gives every batch a fresh snapshot instead of reusing the run's
 * original one.
 */
export function applyCodemodTransform(
  content: string,
  transform: { ruleId: string; from: string; to: string },
): string {
  switch (transform.ruleId) {
    case 'rename-identifier':
      return renameIdentifier(content, transform.from, transform.to);
    default:
      return content;
  }
}

/**
 * Replace every whole-word occurrence of `from` with `to`, line by line,
 * skipping comment-only lines exactly as `localize` skips them when deciding
 * whether a line counts as an impact site — a line this module would not have
 * reported as a match is not one it should be editing either.
 */
function renameIdentifier(source: string, from: string, to: string): string {
  const matcher = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g');
  return source
    .split('\n')
    .map((line) => (isCommentOnly(line) ? line : line.replace(matcher, to)))
    .join('\n');
}

function isCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
