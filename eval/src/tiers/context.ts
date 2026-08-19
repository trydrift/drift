import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { MaterializedCase } from '../case/materialize.ts';
import type { PublicCase } from '../case/schema.ts';
import type { RepairArtifact } from '../artifacts/prediction.ts';
import type { CommitUnit, DriftConfig, Logger, RemediationPlan } from '../../../dist/index.js';

const execFile = promisify(execFileCallback);

/**
 * What every repair track receives, and what every repair track returns.
 *
 * Tracks are separate because Drift's repair mechanisms are genuinely
 * different products with different failure modes, and one pooled "repair
 * accuracy" number would make it impossible to tell apart: poor detection, a
 * correct abstention, a bad generated rule, a correct rule the policy
 * declined, and an agent that timed out. Those five need five different fixes.
 *
 * Every track receives the plan that *detection* actually produced, never a
 * hand-built one, so a repair result is always a statement about the whole
 * chain up to it. The one exception is the conditional/capability track, which
 * is explicitly marked `experimentMode: 'conditional'` in its artifact and
 * which the evaluator refuses to fold into end-to-end metrics.
 */

export interface RepairContext {
  publicCase: PublicCase;
  workspace: MaterializedCase;
  /** The production plan from `runEndToEndDetection`. Tracks read its commit units; they never rebuild it. */
  plan: RemediationPlan;
  config: DriftConfig;
  logger: Logger;
  /** Appended to by tracks that shell out, for the artifact's observable-command record. */
  observedCommands: string[];
}

export interface TrackOutcome {
  repair: RepairArtifact;
  /** Model/agent provenance a live track discovered at run time. Deterministic tracks return nothing. */
  provenance?: Partial<{
    agentId: string;
    agentLabel: string;
    provider: string;
    model: string;
    modelVersion: string;
    agentCliVersion: string;
    promptVersion: string;
    promptHash: string;
    effort: string;
    fastMode: string;
  }>;
}

/** An empty, nothing-attempted repair artifact, so no track has to hand-build the not-attempted shape. */
export function notAttempted(reason: RepairArtifact['notAttemptedReason']): RepairArtifact {
  return {
    attempted: false,
    notAttemptedReason: reason,
    resolvedByTier: [],
    patch: '',
    changedFiles: [],
    scopeEscapeFiles: [],
    scopeValidationReasons: [],
    patchStats: { files: 0, hunks: 0, addedLines: 0, removedLines: 0 },
    residualImpactSites: 0,
  };
}

/**
 * Turns the materialized consumer into a real git repository.
 *
 * Required by the agent tracks and not a benchmark contrivance: Drift's
 * production agent path runs the agent inside a disposable `git worktree` and
 * then reads the result back out of git, precisely so the developer's tree is
 * never touched and so an agent's edits can be validated *before* being
 * accepted. Benchmarking that path without git would mean benchmarking a
 * different, weaker path than the one users get.
 *
 * Returns the commit SHA to use as `RepoContext.afterSha`.
 */
export async function initWorkspaceRepo(root: string): Promise<string> {
  await execFile('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'bench@drift.invalid'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Drift Benchmark'], { cwd: root });
  await execFile('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  await execFile('git', ['add', '-A'], { cwd: root });
  await execFile('git', ['commit', '--quiet', '-m', 'benchmark: bump-only consumer state'], { cwd: root });
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  return stdout.trim();
}

/** Unified diff of a worktree against a ref — the same `git diff` production reads an agent's result from. */
export async function diffAgainst(root: string, ref: string): Promise<string> {
  const { stdout } = await execFile('git', ['diff', ref, '--'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Repo-relative paths a worktree changed against a ref. */
export async function changedFilesAgainst(root: string, ref: string): Promise<string[]> {
  const { stdout } = await execFile('git', ['diff', '--name-only', ref, '--'], { cwd: root });
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

/**
 * Files a repair touched that its own commit units never declared they would.
 *
 * This is Drift's plan disobeying Drift's plan — a production-safety failure,
 * and distinct from "changed a file the benchmark's ground truth did not
 * expect", which is a disagreement about truth and belongs in the evaluator.
 * Computed identically for every track so the two can never be conflated by
 * one track implementing it differently.
 */
export function scopeEscapes(changedFiles: readonly string[], commits: readonly CommitUnit[]): string[] {
  const allowed = new Set(commits.flatMap((commit) => (commit.allowedFiles?.length ? commit.allowedFiles : commit.files)));
  return changedFiles.filter((file) => !allowed.has(file)).sort();
}
