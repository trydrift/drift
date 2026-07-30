/**
 * Line diffing, for review UI.
 *
 * Drift needs to show a developer exactly what an agent changed, hunk by hunk,
 * and let them keep or undo each one individually. That needs a real diff, not
 * a "this file changed" flag — so this is a plain LCS line diff, grouped into
 * hunks, with the line ranges on *both* sides recorded.
 *
 * Both ranges matter. The modified range says where to draw the CodeLens and
 * which lines to replace when undoing; the baseline range says where to splice
 * accepted lines when keeping. Keeping one hunk must not disturb the line
 * numbers of the others, and recording both sides is what makes that possible.
 */

export interface Hunk {
  /** Stable within a single diff of a file: `${baselineStart}-${start}`. */
  id: string;
  /** 0-based, half-open range in the current (modified) text. */
  start: number;
  end: number;
  /** 0-based, half-open range in the baseline text. */
  baselineStart: number;
  baselineEnd: number;
  /** Lines as they are now. */
  modifiedLines: string[];
  /** Lines as they were before the agent ran. */
  baselineLines: string[];
}

export interface FileDiffStat {
  added: number;
  removed: number;
}

/**
 * Above this many lines the quadratic LCS table stops being worth it, and a
 * generated file that big is not something anyone reviews hunk by hunk anyway.
 * Past the limit the whole file becomes a single hunk, which still keeps and
 * undoes correctly — just with less granularity.
 */
const MAX_LCS_LINES = 3000;

export function splitLines(text: string): string[] {
  return text.split('\n');
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}

export function diffHunks(baseline: string, modified: string): Hunk[] {
  if (baseline === modified) return [];

  const a = splitLines(baseline);
  const b = splitLines(modified);

  // Trim the common head and tail first. In practice an agent touches a few
  // lines of a long file, so this alone usually brings the LCS table down to a
  // handful of rows.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const aCore = a.slice(head, a.length - tail);
  const bCore = b.slice(head, b.length - tail);

  if (aCore.length === 0 && bCore.length === 0) return [];

  if (aCore.length > MAX_LCS_LINES || bCore.length > MAX_LCS_LINES) {
    return [makeHunk(head, head + bCore.length, head, head + aCore.length, bCore, aCore)];
  }

  return groupHunks(alignment(aCore, bCore), head, a, b);
}

export function diffStat(baseline: string, modified: string): FileDiffStat {
  let added = 0;
  let removed = 0;
  for (const hunk of diffHunks(baseline, modified)) {
    added += hunk.modifiedLines.length;
    removed += hunk.baselineLines.length;
  }
  return { added, removed };
}

export function statOf(hunks: readonly Hunk[]): FileDiffStat {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    added += hunk.modifiedLines.length;
    removed += hunk.baselineLines.length;
  }
  return { added, removed };
}

type Op = { kind: 'equal' | 'insert' | 'delete' };

/** Standard LCS backtrack, emitting an op per line of the merged sequence. */
function alignment(a: readonly string[], b: readonly string[]): Op[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + (j + 1)]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + (j + 1)]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal' });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + (j + 1)]!) {
      ops.push({ kind: 'delete' });
      i += 1;
    } else {
      ops.push({ kind: 'insert' });
      j += 1;
    }
  }

  while (i < a.length) {
    ops.push({ kind: 'delete' });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: 'insert' });
    j += 1;
  }

  return ops;
}

/**
 * Turn an op stream into hunks.
 *
 * Only runs separated by a single unchanged line are merged. Two edits touching
 * the same statement are one decision as far as a reviewer is concerned, but the
 * window stays deliberately narrow: merging across more context would fuse, say,
 * an import change and a call-site change into one hunk, and those are exactly
 * the two things a reviewer wants to accept independently.
 */
function groupHunks(ops: readonly Op[], offset: number, a: readonly string[], b: readonly string[]): Hunk[] {
  const CONTEXT_MERGE = 1;
  const hunks: Hunk[] = [];

  let aLine = offset;
  let bLine = offset;
  let open: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null;
  let equalRun = 0;

  const flush = () => {
    if (!open) return;
    hunks.push(
      makeHunk(
        open.bStart,
        open.bEnd,
        open.aStart,
        open.aEnd,
        b.slice(open.bStart, open.bEnd),
        a.slice(open.aStart, open.aEnd),
      ),
    );
    open = null;
  };

  for (const op of ops) {
    if (op.kind === 'equal') {
      equalRun += 1;
      if (open && equalRun > CONTEXT_MERGE) flush();
      aLine += 1;
      bLine += 1;
      continue;
    }

    if (!open) {
      open = { aStart: aLine, aEnd: aLine, bStart: bLine, bEnd: bLine };
    } else if (equalRun > 0) {
      // Absorb the short equal run into the open hunk so its ranges stay contiguous.
      open.aEnd = aLine;
      open.bEnd = bLine;
    }
    equalRun = 0;

    if (op.kind === 'delete') {
      aLine += 1;
      open.aEnd = aLine;
    } else {
      bLine += 1;
      open.bEnd = bLine;
    }
  }

  flush();
  return hunks;
}

function makeHunk(
  start: number,
  end: number,
  baselineStart: number,
  baselineEnd: number,
  modifiedLines: string[],
  baselineLines: string[],
): Hunk {
  return {
    id: `${baselineStart}-${start}`,
    start,
    end,
    baselineStart,
    baselineEnd,
    modifiedLines,
    baselineLines,
  };
}

/** Baseline text with `hunk`'s new lines spliced in — i.e. that hunk accepted. */
export function acceptInBaseline(baseline: string, hunk: Hunk): string {
  const lines = splitLines(baseline);
  lines.splice(hunk.baselineStart, hunk.baselineEnd - hunk.baselineStart, ...hunk.modifiedLines);
  return joinLines(lines);
}

/** Current text with `hunk` reverted to its baseline lines — i.e. that hunk undone. */
export function revertInCurrent(current: string, hunk: Hunk): string {
  const lines = splitLines(current);
  lines.splice(hunk.start, hunk.end - hunk.start, ...hunk.baselineLines);
  return joinLines(lines);
}
