import { SUPPORTED_PLAN_SCHEMA_VERSIONS } from './digest.js';

/**
 * The machine-readable footer on a Drift approval issue.
 *
 * This footer is the only channel through which an approval carries state, so
 * it is parsed as a protocol rather than scraped as prose. The previous
 * implementation ran a single permissive regex over the whole issue body and
 * took the first `drift-commit:` it found, which meant any user could
 * manufacture a Drift approval by pasting that string into an issue they
 * opened. Every rule below exists to make a hand-written body fail.
 *
 * Rules:
 *
 *   - every key must be present, exactly once (a duplicate is a splicing
 *     attempt against a parser that takes "the first" or "the last" match, so
 *     it is rejected rather than resolved);
 *   - values are matched against their exact expected shape, anchored;
 *   - SHAs must be full 40-character hex — an abbreviated SHA is ambiguous, and
 *     the whole point here is naming one specific commit;
 *   - an unsupported schema version is refused explicitly rather than parsed
 *     optimistically under whatever the current rules happen to be.
 *
 * None of this makes the footer *authorization*. A footer proves what a plan
 * claimed to be; the collaborator permission check proves who is asking. Both
 * are required, and neither substitutes for the other.
 */

export interface ApprovalMetadata {
  schemaVersion: number;
  planId: string;
  planDigest: string;
  /** The commit the plan was computed from. Full 40-hex. */
  headSha: string;
  baseBranch: string;
}

export type MetadataParseResult =
  | { ok: true; metadata: ApprovalMetadata }
  | { ok: false; reason: string };

const KEYS = ['drift-schema', 'drift-plan', 'drift-plan-digest', 'drift-commit', 'drift-base-branch'] as const;
type MetadataKey = (typeof KEYS)[number];

/** `<!-- drift-key: value -->` on its own line. */
const MARKER = /^[ \t]*<!--[ \t]*(drift-[a-z-]+)[ \t]*:(.*?)-->[ \t]*$/gm;

const FULL_SHA = /^[0-9a-f]{40}$/;
const PLAN_ID = /^plan_[0-9a-f]{10}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Branch names that git will actually accept.
 *
 * This value is interpolated into API calls and compared against the branch a
 * plan targets, so a permissive parse here would let a crafted footer point an
 * approval somewhere unintended.
 */
function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (/[\x00-\x20~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return false;
  if (name.startsWith('-') || name.startsWith('.') || name.endsWith('.')) return false;
  if (name.endsWith('.lock')) return false;
  return true;
}

/**
 * Render the footer.
 *
 * Emitted as HTML comments so the issue reads as prose to a human while
 * carrying an exact record for the runner.
 */
export function renderApprovalMetadata(metadata: ApprovalMetadata): string {
  return [
    `<!-- drift-schema: ${metadata.schemaVersion} -->`,
    `<!-- drift-plan: ${metadata.planId} -->`,
    `<!-- drift-plan-digest: ${metadata.planDigest} -->`,
    `<!-- drift-commit: ${metadata.headSha} -->`,
    `<!-- drift-base-branch: ${metadata.baseBranch} -->`,
  ].join('\n');
}

export function parseApprovalMetadata(body: string): MetadataParseResult {
  if (!body) return { ok: false, reason: 'the issue has no body' };

  const found = new Map<string, string[]>();
  for (const match of body.matchAll(MARKER)) {
    const key = match[1]!;
    const value = (match[2] ?? '').trim();
    const existing = found.get(key);
    if (existing) existing.push(value);
    else found.set(key, [value]);
  }

  if (found.size === 0) {
    return { ok: false, reason: 'the issue has no Drift plan footer, so it is not a Drift approval issue' };
  }

  for (const key of KEYS) {
    const values = found.get(key);
    if (!values) return { ok: false, reason: `the plan footer is missing \`${key}\`` };
    if (values.length > 1) {
      return {
        ok: false,
        reason: `the plan footer declares \`${key}\` ${values.length} times; a Drift issue declares each key exactly once`,
      };
    }
    if (values[0] === '') return { ok: false, reason: `the plan footer has an empty \`${key}\`` };
  }

  const value = (key: MetadataKey): string => found.get(key)![0]!;

  const rawSchema = value('drift-schema');
  if (!/^\d+$/.test(rawSchema)) {
    return { ok: false, reason: `\`drift-schema\` must be an integer, not \`${clip(rawSchema)}\`` };
  }
  const schemaVersion = Number(rawSchema);
  if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(schemaVersion)) {
    return {
      ok: false,
      reason:
        `this issue records plan schema v${schemaVersion}, which this version of Drift cannot verify ` +
        `(it supports v${SUPPORTED_PLAN_SCHEMA_VERSIONS.join(', v')}). Re-run Drift to generate a current plan.`,
    };
  }

  const planId = value('drift-plan');
  if (!PLAN_ID.test(planId)) {
    return { ok: false, reason: `\`drift-plan\` is not a Drift plan id: \`${clip(planId)}\`` };
  }

  const planDigest = value('drift-plan-digest');
  if (!DIGEST.test(planDigest)) {
    return { ok: false, reason: '`drift-plan-digest` is not a 64-character SHA-256 digest' };
  }

  const headSha = value('drift-commit');
  if (!FULL_SHA.test(headSha)) {
    return {
      ok: false,
      reason: '`drift-commit` must be a full 40-character commit SHA; an abbreviated SHA does not name one commit unambiguously',
    };
  }

  const baseBranch = value('drift-base-branch');
  if (!isValidBranchName(baseBranch)) {
    return { ok: false, reason: `\`drift-base-branch\` is not a valid branch name: \`${clip(baseBranch)}\`` };
  }

  return { ok: true, metadata: { schemaVersion, planId, planDigest, headSha, baseBranch } };
}

/**
 * The marker recording that a plan was already acted on.
 *
 * Posted as a comment by Drift once dispatch succeeds. Keyed by digest rather
 * than plan id, because the id is only as specific as the commit — two
 * different plans for one commit share an id but never a digest.
 */
export function renderDispatchMarker(params: {
  planDigest: string;
  branchName: string;
  taskId?: string;
  pullRequestNumber?: number;
}): string {
  const parts = [`<!-- drift-dispatched: ${params.planDigest} -->`, `<!-- drift-dispatched-branch: ${params.branchName} -->`];
  if (params.taskId) parts.push(`<!-- drift-dispatched-task: ${params.taskId} -->`);
  if (params.pullRequestNumber !== undefined) {
    parts.push(`<!-- drift-dispatched-pr: ${params.pullRequestNumber} -->`);
  }
  return parts.join('\n');
}

export interface PriorDispatch {
  planDigest: string;
  branchName?: string;
  taskId?: string;
  pullRequestNumber?: number;
}

/**
 * Find a previous dispatch of this exact plan among the issue's comments.
 *
 * Only comments Drift itself posted are considered — otherwise anyone could
 * suppress a legitimate approval by posting a forged marker, turning an
 * idempotency mechanism into a denial-of-service one.
 */
export function findPriorDispatch(
  comments: readonly { body?: string | null; authorIsDrift: boolean }[],
  planDigest: string,
): PriorDispatch | null {
  for (const comment of comments) {
    if (!comment.authorIsDrift || !comment.body) continue;
    const digest = /<!--\s*drift-dispatched:\s*([0-9a-f]{64})\s*-->/.exec(comment.body)?.[1];
    if (digest !== planDigest) continue;

    const branchName = /<!--\s*drift-dispatched-branch:(.+?)-->/.exec(comment.body)?.[1]?.trim();
    const taskId = /<!--\s*drift-dispatched-task:(.+?)-->/.exec(comment.body)?.[1]?.trim();
    const pr = /<!--\s*drift-dispatched-pr:\s*(\d+)\s*-->/.exec(comment.body)?.[1];

    return {
      planDigest: digest,
      ...(branchName ? { branchName } : {}),
      ...(taskId ? { taskId } : {}),
      ...(pr ? { pullRequestNumber: Number(pr) } : {}),
    };
  }
  return null;
}

/** Keep rejected values short and inert when echoed back into an issue comment. */
function clip(value: string): string {
  const flat = value.replace(/[`\r\n]/g, ' ').trim();
  return flat.length <= 40 ? flat : `${flat.slice(0, 40)}…`;
}
