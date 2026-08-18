import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { Exec } from '../util/exec.js';
import { runWorktreeRemediation } from './worktree-runner.js';

/**
 * `drift fix`: apply a plan's commits through the same three-tier priority
 * every surface shares — Drift's own codemod, then a validated deterministic
 * fix plan, then an AI agent — in an isolated git worktree, so the
 * developer's working tree is never touched regardless of what the run does.
 *
 * The interactive step is the fix plan review. A plan is a rule plus a
 * document describing exactly what it will do to every call site, which is
 * something a developer can meaningfully accept or decline *before* anything
 * happens — unlike an agent's output, which can only be reviewed afterwards.
 * `--plan` stops after printing those documents; the default prints each one
 * and asks; `--non-interactive` applies whatever `dispositionFor` clears for
 * unattended use and leaves the rest to an agent.
 *
 * Local CLI agents now run through `worktree-runner.ts`; this file remains as
 * the compatibility entrypoint for the CLI command and legacy Copilot Cloud
 * dispatch helper.
 */

export interface FixOptions {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  logger: Logger;
  workspace: string;
  copilotToken?: string;
  /**
   * Print every fix plan document and stop without applying anything.
   *
   * The read-only half of `fix`, and the reason a plan is worth having as a
   * document rather than only as a mechanism: a developer can read exactly
   * what would happen to every call site, and to which call sites nothing
   * would happen, before granting any of it.
   */
  planOnly?: boolean;
  /** Never prompt; apply only what `dispositionFor` clears unattended. */
  nonInteractive?: boolean;
  exec?: Exec;
  ask?: (question: string, options: string[]) => Promise<string>;
}

export interface FixRunResult {
  branch: string;
  builtinResolved: number;
  fixPlanResolved: number;
  /** Fix plan documents, in plan order — printed by `--plan` and after a run. */
  documents: string[];
  /**
   * Commits still needing an agent, including ones whose fix plan was applied
   * but left residual call sites. A plan covering nine of ten sites resolves
   * nine; the tenth is real work and must not vanish because the commit
   * counted as deterministically handled.
   */
  needsAgent: CommitUnit[];
  pushed: boolean;
  worktree: string;
}

/**
 * Run the fix flow inside a disposable worktree. The caller is responsible
 * for pushing the branch (if `pushed` — i.e. anything was committed) and for
 * dispatching `needsAgent` to Copilot, then for cleanup: `teardown()` must be
 * called (in a `finally`) regardless of outcome.
 */
export async function runFix(options: FixOptions): Promise<FixRunResult & { teardown: () => Promise<void> }> {
  return runWorktreeRemediation(options);
}
