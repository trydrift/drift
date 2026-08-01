import type {
  BreakingChange,
  Confidence,
  DependencyChange,
  Evidence,
  ImpactSite,
  RemediationPlan,
  RepoContext,
  RiskLevel,
} from '../types.js';
import { compareRisk, riskWithinLimit, type DriftConfig } from '../config/schema.js';
import { meetsConfidence } from '../analyze/index.js';
import { isDowngrade } from '../detect/version.js';
import { matchesAny } from '../util/glob.js';
import { stableId } from '../util/id.js';
import { planCommits } from './commits.js';

/**
 * Plan assembly: turn findings into a proposal, and decide whether Drift is
 * allowed to execute it without a human.
 *
 * `blockers` and `warnings` are the heart of this module and the reason a team
 * can leave `auto` mode on. A blocker does not discard the plan — it downgrades
 * the run to approval-required, so the work is still visible and one click from
 * proceeding. Drift's failure mode is "asks a human too often", never "edits
 * code it shouldn't have".
 */

export interface BuildPlanInput {
  repo: RepoContext;
  config: DriftConfig;
  changes: readonly DependencyChange[];
  evidence: readonly Evidence[];
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
  /** Reasons from triage, surfaced so nothing looks silently dropped. */
  skipped?: readonly { change: DependencyChange; reason: string }[];
}

export function buildPlan(input: BuildPlanInput): RemediationPlan {
  const { repo, config, changes, evidence, breakingChanges, impactSites } = input;

  const commits = planCommits({ breakingChanges, impactSites, config });
  const risk = assessRisk(changes, breakingChanges, impactSites);
  const { blockers, warnings } = evaluateGuardrails(input, commits, risk);

  return {
    id: stableId('plan', repo.owner, repo.repo, repo.afterSha),
    branchName: branchNameFor(config, changes, repo.afterSha),
    baseBranch: repo.baseBranch,
    headSha: repo.afterSha,
    changes: [...changes],
    evidence: [...evidence],
    breakingChanges: [...breakingChanges],
    impactSites: [...impactSites],
    commits,
    risk,
    blockers,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Branch naming.
 *
 * Encodes the dependency and version move so the branch is self-describing in
 * a branch list, and labels the analysed commit so a re-run against a different
 * commit never collides with an open Drift PR.
 */
export function branchNameFor(
  config: DriftConfig,
  changes: readonly DependencyChange[],
  afterSha: string,
): string {
  const prefix = config.remediation.branchPrefix;
  const suffix = `commit-${afterSha.slice(0, 7)}`;

  if (changes.length === 1) {
    const change = changes[0]!;
    const name = branchPart(change.name.replace('@', '').replace('/', '-'), 30);
    const from = branchPart(change.from ?? 'new', 16);
    const to = branchPart(change.to ?? 'removed', 16);
    return `${prefix}${name}-${from}-to-${to}-${suffix}`;
  }

  return `${prefix}deps-${changes.length}-updates-${suffix}`;
}

function branchPart(input: string, maxLength: number): string {
  const part = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[./]+$/g, '')
    .replace(/^-+|-+$/g, '');
  return part.slice(0, maxLength).replace(/[.-]+$/g, '') || 'change';
}

/**
 * Aggregate risk.
 *
 * Risk is driven by what Drift is being asked to *change*, not by how alarming
 * the upstream release sounds. A major bump with two well-understood renames
 * is lower risk than a minor bump that silently altered behaviour in code
 * Drift can only partly see.
 */
export function assessRisk(
  changes: readonly DependencyChange[],
  breakingChanges: readonly BreakingChange[],
  impactSites: readonly ImpactSite[],
): RiskLevel {
  if (breakingChanges.length === 0 || impactSites.length === 0) return 'none';

  let risk: RiskLevel = 'low';
  const raise = (level: RiskLevel) => {
    if (compareRisk(level, risk) > 0) risk = level;
  };

  const fileCount = new Set(impactSites.map((s) => s.file)).size;
  if (fileCount > 5 || impactSites.length > 20) raise('medium');
  if (fileCount > 20 || impactSites.length > 75) raise('high');

  for (const change of breakingChanges) {
    // Behaviour changes are the dangerous class: the code still compiles, so
    // neither the type checker nor an agent's smoke test will catch a wrong fix.
    if (change.kind === 'behaviour-change' || change.kind === 'default-change') raise('high');
    if (change.kind === 'unknown') raise('medium');
    if (change.confidence === 'low') raise('medium');
  }

  for (const change of changes) {
    if (change.bump === 'major') raise('medium');
    if (isDowngrade(change.from, change.to)) raise('high');
  }

  // Test files being touched is a warning sign worth escalating: the fix may
  // be adjusting the test rather than the code the test protects.
  if (impactSites.some((s) => isTestPath(s.file))) raise('medium');

  return risk;
}

interface GuardrailResult {
  blockers: string[];
  warnings: string[];
}

function evaluateGuardrails(
  input: BuildPlanInput,
  commits: readonly { files: string[] }[],
  risk: RiskLevel,
): GuardrailResult {
  const { config, changes, evidence, breakingChanges, impactSites, skipped = [] } = input;
  const guardrails = config.guardrails;

  const blockers: string[] = [];
  const warnings: string[] = [];

  const touchedFiles = [...new Set(commits.flatMap((c) => c.files))];

  if (touchedFiles.length > guardrails.maxFilesChanged) {
    blockers.push(
      `This plan would touch ${touchedFiles.length} files, above the \`maxFilesChanged\` limit of ${guardrails.maxFilesChanged}. A change this wide should be read by a person before an agent starts editing.`,
    );
  }

  if (changes.length > guardrails.maxDependenciesPerRun) {
    blockers.push(
      `${changes.length} dependencies moved in one commit, above the \`maxDependenciesPerRun\` limit of ${guardrails.maxDependenciesPerRun}. Batched upgrades make it hard to attribute a regression to the dependency that caused it.`,
    );
  }

  const protectedHits = touchedFiles.filter((f) => matchesAny(guardrails.protectedPaths, f));
  if (protectedHits.length > 0) {
    blockers.push(
      `Impact sites fall inside protected paths: ${protectedHits.slice(0, 5).join(', ')}${protectedHits.length > 5 ? `, +${protectedHits.length - 5} more` : ''}. Drift will not direct an agent to edit these.`,
    );
  }

  const alwaysApprove = changes.filter((c) => matchesAny(config.alwaysApprove, c.name));
  if (alwaysApprove.length > 0) {
    blockers.push(
      `${alwaysApprove.map((c) => c.name).join(', ')} matched \`alwaysApprove\` in drift.yml.`,
    );
  }

  if (guardrails.requireEvidence) {
    const withoutRealEvidence = changes.filter((change) => {
      const records = evidence.filter((e) => e.dependency === change.name);
      return records.every((e) => e.source === 'semver-heuristic' || e.source === 'registry-metadata');
    });

    if (withoutRealEvidence.length > 0 && breakingChanges.length > 0) {
      blockers.push(
        `No changelog, release notes, or API diff could be retrieved for ${withoutRealEvidence.map((c) => c.name).join(', ')}. Drift will not dispatch a fix based on a version number alone.`,
      );
    }
  }

  const belowConfidence = breakingChanges.filter(
    (c) => !meetsConfidence(c.confidence, guardrails.minConfidence),
  );
  if (belowConfidence.length > 0) {
    // A warning, not a blocker: the plan still contains higher-confidence
    // changes worth acting on, and the low-confidence ones are labelled as
    // such in the report so a reviewer can weigh them.
    warnings.push(
      `${belowConfidence.length} finding(s) are below the \`minConfidence\` threshold of \`${guardrails.minConfidence}\` and are flagged for human judgement rather than treated as established.`,
    );
  }

  if (!riskWithinLimit(risk, config.maxAutoRisk)) {
    blockers.push(
      `Assessed risk is \`${risk}\`, above the \`maxAutoRisk\` ceiling of \`${config.maxAutoRisk}\`.`,
    );
  }

  const testSites = impactSites.filter((s) => isTestPath(s.file));
  if (testSites.length > 0) {
    warnings.push(
      `${testSites.length} impact site(s) are in test files. Confirm the fix updates tests to match the new API rather than weakening what they assert.`,
    );
  }

  const changesWithoutSites = breakingChanges.filter(
    (c) => !impactSites.some((s) => s.breakingChangeId === c.id),
  );
  if (changesWithoutSites.length > 0) {
    warnings.push(
      `${changesWithoutSites.length} breaking change(s) were identified upstream but no usage was found in this repository. They are listed for awareness and no commit was planned for them.`,
    );
  }

  for (const entry of skipped) {
    warnings.push(`Skipped \`${entry.change.name}\`: ${entry.reason}.`);
  }

  return { blockers, warnings };
}

/** Heuristic test-path detection across the ecosystems Drift supports. */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec|specs|e2e|integration_tests)\//.test(lower) ||
    /\.(test|spec)\.[jt]sx?$/.test(lower) ||
    /(^|\/)test_[^/]+\.py$/.test(lower) ||
    /_test\.(py|go|rb)$/.test(lower) ||
    /_spec\.rb$/.test(lower) ||
    /Test\.java$/.test(path) ||
    /Tests?\.kt$/.test(path)
  );
}

/** True when the plan is safe to dispatch without asking a human. */
export function isAutoDispatchable(plan: RemediationPlan, config: DriftConfig): boolean {
  if (config.mode !== 'auto') return false;
  if (plan.blockers.length > 0) return false;
  if (plan.commits.length === 0) return false;
  return riskWithinLimit(plan.risk, config.maxAutoRisk);
}

export function highestConfidence(changes: readonly BreakingChange[]): Confidence {
  if (changes.some((c) => c.confidence === 'high')) return 'high';
  if (changes.some((c) => c.confidence === 'medium')) return 'medium';
  return 'low';
}

export * from './commits.js';
