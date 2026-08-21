/**
 * What "isolated" actually means for a given trial, recorded rather than
 * asserted.
 *
 * The harness enforces a *workspace* audit: `auditWorkspaceIsolation` walks
 * the materialized directory and rejects private artifacts, a `hidden/`
 * directory, overlap with the private case root, and symlinks whose target
 * leaves the workspace. That is a real and load-bearing property, and it is
 * not the same property as "ground truth is unreachable".
 *
 * The gap is specific. An agent-bearing track runs an external process with
 * shell access inside that directory, and nothing in a directory audit stops
 * such a process from reading another path on the same host — including this
 * repository's own `eval/cases/private/`. Saying "ground truth is unreachable"
 * about that arrangement would be claiming a guarantee the code does not
 * provide, and a reader who checked would find it out in about a minute.
 *
 * So the level is a field on every artifact, with exactly one honest value:
 *
 *   `workspace-audit`  the directory handed over is audited clean, and nothing
 *                      beyond that is enforced. Private truth is not in the
 *                      workspace and *is* readable elsewhere on the host by any
 *                      process this trial started.
 *   `process-sandbox`  the trial ran under an OS-level sandbox that denies
 *                      reads outside the workspace.
 *   `container`        the trial ran in a container where the private tree is
 *                      not mounted and therefore does not exist to it.
 *
 * Only `container` and `process-sandbox` support the word "unreachable". A
 * deterministic in-process adapter starts no subprocess at all, which is a
 * stronger position than `workspace-audit` describes but is a property of that
 * adapter rather than of the environment, so it is recorded separately as
 * `spawnsSubprocesses: false` instead of being promoted to a sandbox claim
 * nobody enforced.
 */

export const ISOLATION_LEVELS = ['workspace-audit', 'process-sandbox', 'container'] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export interface IsolationRecord {
  audited: boolean;
  pathsAudited: number;
  networkPolicy: string;
  level: IsolationLevel;
  /**
   * Whether the private ground-truth tree was readable by a process this trial
   * could start. `true` under `workspace-audit` on a developer machine, and the
   * single most important thing a sceptical reader wants stated plainly.
   */
  groundTruthReadableOnHost: boolean;
  /**
   * Whether this track runs external processes at all. A track that does not
   * cannot exercise the gap above, and a report should not imply that it can.
   */
  spawnsSubprocesses: boolean;
}

/**
 * The strongest level this run can honestly claim.
 *
 * Deliberately not inferred from "is Docker installed" or any similar
 * capability probe: a sandbox that was available and not used isolates
 * nothing. The runner passes what it actually did, and the default — what
 * every run does today — is the weakest.
 */
export function isolationRecord(input: {
  pathsAudited: number;
  networkPolicy: string;
  level?: IsolationLevel;
  spawnsSubprocesses: boolean;
}): IsolationRecord {
  const level = input.level ?? 'workspace-audit';
  return {
    audited: true,
    pathsAudited: input.pathsAudited,
    networkPolicy: input.networkPolicy,
    level,
    groundTruthReadableOnHost: level === 'workspace-audit',
    spawnsSubprocesses: input.spawnsSubprocesses,
  };
}

/** One sentence a report can print verbatim. Never softened by the caller. */
export function isolationClaim(record: IsolationRecord): string {
  if (record.level === 'container') {
    return 'Ran in a container in which the private ground-truth tree is not mounted, so it does not exist to this trial.';
  }
  if (record.level === 'process-sandbox') {
    return 'Ran under an OS-level sandbox denying reads outside the workspace, so the private ground-truth tree was not readable.';
  }
  return record.spawnsSubprocesses
    ? 'Workspace audited clean of private material. No process-level isolation: this trial started external processes, and the private ground-truth tree was readable elsewhere on the host by any of them. Not prevented — recorded.'
    : 'Workspace audited clean of private material. No process-level isolation was applied; this track started no external process, so nothing it ran could have read the private tree, but that is a property of the adapter rather than an enforced boundary.';
}
