import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { FixAgent } from '../agents/types.js';
import type { Logger } from '../util/logger.js';
import { execCommand, type Exec } from '../util/exec.js';
import { runRemediationController, type ControllerRecord } from './controller.js';
import { createProjectVerifier, detectRemediationChecks, measureBaseline } from './verifier.js';
import type { WorktreeAgentRunResult } from './worktree-runner.js';

/**
 * The `remediation.loop: verified` path for a Drift-created worktree: discover
 * the checks, measure them at the pre-upgrade commit, install, and run the
 * controller. Returns the same shape as `runAgentCommitsInWorktree` so the CLI
 * and dispatch surfaces handle both modes alike, plus the controller's record.
 */
export async function runVerifiedAgentRemediation(options: {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  worktree: string;
  commits: readonly CommitUnit[];
  agent: FixAgent;
  logger: Logger;
  exec?: Exec;
}): Promise<WorktreeAgentRunResult & { record: ControllerRecord }> {
  const exec = options.exec ?? execCommand;
  // One member's checks. A plan spanning several members verifies the first
  // member it changed; the record says which checks ran.
  const dir = options.plan.changes.find((change) => change.workspace)?.workspace ?? '';
  const checks = await detectRemediationChecks(options.worktree, dir);

  let verifier = null;
  if (checks.length > 0) {
    options.logger.info(`Measuring ${checks.length} check(s) before the upgrade, so failures it did not cause are not handed to an agent.`);
    const baseline = await measureBaseline({ root: options.worktree, ref: options.repo.beforeSha, dir, checks, exec });
    if (baseline.installFailure) options.logger.warn(`The pre-upgrade baseline could not install cleanly: ${baseline.installFailure}`);
    verifier = createProjectVerifier({ root: options.worktree, dir, checks, baseline: baseline.outcomes, coverageBaseline: baseline.coverage, exec, installFirst: true });
  } else {
    options.logger.warn('No checks were found to verify the fix; each unit runs once, unverified.');
  }

  const record = await runRemediationController({
    root: options.worktree,
    plan: options.plan,
    config: options.config,
    agent: options.agent,
    verifier,
    logger: options.logger,
    commits: options.commits,
    exec,
  });

  const accepted = new Set(record.sessions.filter((session) => session.status === 'accepted').map((session) => session.unitId));
  const verified = record.termination === 'verified';
  const resolved = options.commits.filter((commit) => verified || accepted.has(commit.id));
  const unresolved = verified
    ? []
    : options.commits
        .filter((commit) => !resolved.includes(commit))
        .map((commit) => ({ commit, message: `${record.termination}: ${record.terminationDetail}` }));
  if (!verified && record.verifications.length > 0 && unresolved.length === 0 && options.commits[0]) {
    unresolved.push({ commit: options.commits[0], message: `Verification did not pass (${record.termination}: ${record.terminationDetail}).` });
  }
  return { resolved, unresolved, committed: record.sessions.some((session) => session.status === 'accepted'), record };
}
