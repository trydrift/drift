/**
 * The size an agent-facing output is allowed to be.
 *
 * Drift ships no tokenizer, and the agent on the other end could be any model.
 * So the estimate is deliberately pessimistic rather than accurate: one token
 * per three UTF-8 bytes. Claude and GPT tokenizers average closer to four bytes
 * per token on English and nearer three on paths and code, which is most of
 * what a brief contains. Over-estimating costs a few omitted sites that remain
 * one tool call away; under-estimating is the failure this exists to prevent.
 *
 * The byte ceiling is the same number stated the other way, and it is the hard
 * stop: a renderer measures its output in bytes and never exceeds it.
 */

export const BYTES_PER_TOKEN = 3;

export interface ContextBudget {
  /** Fill up to this. */
  targetTokens: number;
  /** Never exceed this, whatever must be included. */
  maxTokens: number;
}

/** The initial brief: a plan an agent can act on, not a report. */
export const AGENT_BRIEF_BUDGET: ContextBudget = { targetTokens: 1_500, maxTokens: 2_000 };

/** One finding in full, on request. */
export const FINDING_DETAIL_BUDGET: ContextBudget = { targetTokens: 1_500, maxTokens: 2_000 };

/** One page of evidence, on request. */
export const EVIDENCE_PAGE_BUDGET: ContextBudget = { targetTokens: 2_000, maxTokens: 2_500 };

/** A verification run's summary. Full logs are written to a file, never returned. */
export const VERIFICATION_BUDGET: ContextBudget = { targetTokens: 1_000, maxTokens: 1_500 };

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / BYTES_PER_TOKEN);
}

export function maxBytes(budget: ContextBudget): number {
  return budget.maxTokens * BYTES_PER_TOKEN;
}

export function targetBytes(budget: ContextBudget): number {
  return budget.targetTokens * BYTES_PER_TOKEN;
}

/**
 * Cut `text` to at most `limit` bytes at a line boundary, never mid-line.
 *
 * For material that is itself a sequence of independent lines — an evidence
 * excerpt, a log tail. A finding is never passed through this; renderers drop
 * or compact whole findings instead.
 */
export function clipLines(text: string, limit: number): { text: string; clipped: boolean } {
  if (byteLength(text) <= limit) return { text, clipped: false };
  const out: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const size = byteLength(line) + 1;
    if (used + size > limit) {
      // A first line longer than the whole limit (minified output, a
      // paragraph with no breaks) would otherwise produce nothing at all, and
      // a pager built on this would never advance.
      if (out.length === 0) out.push(clipBytes(line, limit));
      break;
    }
    out.push(line);
    used += size;
  }
  return { text: out.join('\n'), clipped: true };
}

/** At most `limit` UTF-8 bytes of `text`, never splitting a character. */
export function clipBytes(text: string, limit: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  let end = Math.max(0, limit);
  // Back off continuation bytes (10xxxxxx) so a multi-byte character is never split.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/** A single sentence-sized string, capped by characters with an ellipsis. Used for one-line fields only. */
export function capLine(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1).trimEnd()}…`;
}
