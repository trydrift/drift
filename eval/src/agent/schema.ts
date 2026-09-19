import { z } from 'zod';

/**
 * The dependency-upgrade agent benchmark: schemas.
 *
 * Three documents, and the boundary between the first two is the one that
 * matters.
 *
 *   - A **case** (`case.yml`, public) describes one real dependency upgrade:
 *     which repository, which commit *before* the bump, which commit *after*
 *     it and before anyone fixed the fallout, which dependency moved, and how
 *     the project's own checks are run. Everything in it is visible to the
 *     coding agent in principle, and nothing in it says what the fix is.
 *   - The case's **hidden** half (`hidden/hidden.yml` + files, private) holds
 *     the reference fix, the regression tests that exercise the actual
 *     breaking behaviour, and the case-specific workaround rules. None of it
 *     is ever copied into the workspace an agent runs in; the runner audits
 *     the workspace for it on every materialization.
 *   - A **trial** artifact records one agent session end to end — provenance,
 *     provider-reported usage, tool activity, the final diff, every validation
 *     layer, and why it failed if it failed — so any number downstream can be
 *     recomputed from the artifacts alone.
 *
 * The suite manifest freezes which cases a public result is over, by content
 * hash, so a case edited after a run cannot keep being cited by that run.
 */

export const AGENT_CASE_SCHEMA_VERSION = 'drift-agent-case-v1';
export const AGENT_TRIAL_SCHEMA_VERSION = 'drift-agent-trial-v1';
export const AGENT_SUMMARY_SCHEMA_VERSION = 1;

/**
 * The two experimental conditions, plus ablations.
 *
 * `baseline-lean` is the diagnostic that separates the two things the Drift
 * condition changes at once: it launches the session with the product's lean
 * tool set but gives the agent no Drift context at all. Without it, a token
 * difference cannot be attributed to either the tools or the report.
 *
 * `drift-full-tools` is the other half of that separation: Drift's report with
 * the tools the agent ships with. Held-out run 1 showed the lean tool set
 * costs accuracy and the report pays it back, so the configuration that gives
 * the report without taking the tools away is the one neither headline
 * condition measured.
 */
export const CONDITIONS = ['baseline', 'baseline-lean', 'drift', 'drift-full-tools', 'drift-brief', 'drift-evidence-only', 'drift-localization-only'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const conditionSchema = z.enum(CONDITIONS);

/** The two conditions every published result is over. Ablations are diagnostics and never enter a headline. */
export const HEADLINE_CONDITIONS: readonly Condition[] = ['baseline', 'drift'];

const checkKindSchema = z.enum(['build', 'typecheck', 'test', 'lint', 'runtime']);
export type CheckKind = z.infer<typeof checkKindSchema>;

const checkSchema = z.object({
  name: z.string().min(1),
  kind: checkKindSchema,
  command: z.string().min(1),
  /** Seconds before the check is killed and recorded as failed. */
  timeoutSeconds: z.number().int().positive().default(900),
});
export type CheckDeclaration = z.infer<typeof checkSchema>;

const gitSourceSchema = z.object({
  kind: z.literal('git'),
  /** Clone URL. Recorded verbatim in every trial. */
  repository: z.string().url(),
  licence: z.string().min(1),
  /** The consumer immediately before the dependency bump. */
  baseCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  /**
   * The consumer with the bump applied and the fallout not yet fixed — the
   * agent starts here. A real commit (a Dependabot commit, say). `null` when
   * the start state is constructed instead, see `startPatch`.
   */
  startCommit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable().default(null),
  /**
   * A patch, relative to the case directory, that turns the base tree into
   * the start tree — the manifest and lockfile bump and nothing else. Public
   * by definition: it *is* the starting state. Used when history has no
   * bump-only commit, e.g. a maintainer who bumped and fixed in one commit.
   */
  startPatch: z.string().nullable().default(null),
  /** The maintainer's own fix, when one exists. Reference only: it is never materialized. */
  fixCommit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  /** Pull request or commit URL the case was derived from, for provenance. */
  reference: z.string().default(''),
});

const fixtureSourceSchema = z.object({
  kind: z.literal('fixture'),
  /** Directory, relative to the case directory, holding `start/` and `base/`. */
  path: z.string().min(1),
  licence: z.string().min(1),
});

export type CaseSource = z.infer<typeof gitSourceSchema> | z.infer<typeof fixtureSourceSchema>;

export const caseSchema = z
  .object({
    schemaVersion: z.literal(AGENT_CASE_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    title: z.string().min(1),
    /**
     * `historical` — a real repository, a real bump, and a real fix that a
     * maintainer later wrote. `mined` — a real repository at a real commit,
     * a real published upgrade applied by the benchmark (the construction
     * swe-bump-bench and BUMP use), and a benchmark-authored reference fix.
     * `synthetic` — a consumer this project authored against a real package,
     * to develop the harness; never enters a public suite.
     */
    provenance: z.enum(['historical', 'mined', 'synthetic']),
    /**
     * Cases used while building and tuning Drift are `development`. A public
     * generalisation claim needs `held-out` cases that were not. A suite that
     * has none says so in every report.
     */
    role: z.enum(['development', 'held-out']),
    ecosystem: z.enum(['npm', 'pypi', 'maven', 'cargo', 'go', 'other']),
    source: z.discriminatedUnion('kind', [gitSourceSchema, fixtureSourceSchema]),
    /** Directory inside the repository the upgrade lands in. `''` for a single-package repository. */
    workspaceDir: z.string().default(''),
    dependency: z.object({
      name: z.string().min(1),
      /** Exact versions, never ranges. */
      fromVersion: z.string().min(1),
      toVersion: z.string().min(1),
      updateClass: z.enum(['major', 'minor', 'patch', 'other']),
      category: z.enum(['framework', 'library', 'tooling', 'runtime', 'types']),
      section: z.enum(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'other']).default('dependencies'),
    }),
    environment: z.object({
      runtime: z.string().default('unspecified'),
      packageManager: z.enum(['npm', 'pnpm', 'yarn', 'pip', 'uv', 'maven', 'gradle', 'cargo', 'go', 'other']),
      timezone: z.string().default('UTC'),
      locale: z.string().default('C'),
    }),
    commands: z.object({
      /** Installs dependencies. Run before the agent starts and again during validation. */
      install: z.string().min(1),
      installTimeoutSeconds: z.number().int().positive().default(900),
      /** The project's own checks. Every one must pass for a trial to succeed. */
      checks: z.array(checkSchema).min(1),
      /**
       * Prints the installed version of the dependency and nothing else.
       * Compared against `dependency.toVersion` during validation.
       */
      installedVersion: z.string().min(1),
    }),
    integrity: z.object({
      /** Manifest that declares the dependency, relative to `workspaceDir`. */
      manifestPath: z.string().min(1),
      /** Lockfile the install command consumes, or `null` for a project without one. */
      lockfilePath: z.string().nullable().default(null),
    }),
    /**
     * What the agent's process may reach. Both conditions always get the same
     * policy; it is recorded on every trial. `registry-and-provider` is the
     * strongest policy a live agent trial can honestly claim: the agent must
     * reach its own model provider and the package manager must reach its
     * registry. Web browsing tools are disabled separately (see `agent.webTools`).
     */
    networkPolicy: z.enum(['registry-and-provider', 'allowed']).default('registry-and-provider'),
    agent: z
      .object({
        /** Per-case wall-clock limit for one agent session. */
        timeoutSeconds: z.number().int().positive().default(1800),
      })
      .default({ timeoutSeconds: 1800 }),
    metadata: z.object({
      /** Objective descriptors only. No difficulty labels. */
      repositoryFiles: z.number().int().nonnegative().nullable().default(null),
      repositorySourceLines: z.number().int().nonnegative().nullable().default(null),
      failureMode: z.enum(['compile-time', 'runtime', 'configuration', 'mixed']),
      /** Distinct source locations the reference fix touches. */
      knownAffectedLocations: z.number().int().nonnegative(),
      migrationGuideAvailable: z.boolean(),
      /** Objective: the reference fix edits more than one file. */
      multiLocation: z.boolean(),
      notes: z.string().default(''),
    }),
  })
  .strict();

export type AgentCase = z.infer<typeof caseSchema>;

/* ---------------------------------------------------------------- */
/* Hidden half                                                       */
/* ---------------------------------------------------------------- */

const hiddenTestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** What behaviour it exercises, in the author's words. Printed in reports. */
  description: z.string().min(1),
  /** Files, relative to `hidden/`, copied into `<workspace>/.drift-hidden/` only after the agent has exited. */
  files: z.array(z.string()).default([]),
  /** Run with the workspace as cwd. Exit 0 is a pass. */
  command: z.string().min(1),
  timeoutSeconds: z.number().int().positive().default(600),
});
export type HiddenTestDeclaration = z.infer<typeof hiddenTestSchema>;

/**
 * Case-specific rules that catch an illegitimate "fix". Deliberately not a
 * global blocklist: a `@ts-ignore` is a legitimate edit in most repositories
 * and an illegitimate one on the exact line the upgrade broke, and only the
 * case author knows which.
 */
const forbiddenRuleSchema = z.discriminatedUnion('kind', [
  /** The diff must not touch these paths (CI config, the validation scripts, fixtures). */
  z.object({ kind: z.literal('path-unchanged'), paths: z.array(z.string()).min(1), description: z.string().min(1) }),
  /** These files must still exist (the feature was migrated, not deleted). */
  z.object({ kind: z.literal('file-present'), paths: z.array(z.string()).min(1), description: z.string().min(1) }),
  /** After the run, files matching `glob` must not contain `pattern` (a regular expression). */
  z.object({ kind: z.literal('pattern-absent'), glob: z.string().min(1), pattern: z.string().min(1), description: z.string().min(1) }),
  /** The diff must not *add* a line matching `pattern` to files matching `glob`. */
  z.object({ kind: z.literal('pattern-not-added'), glob: z.string().min(1), pattern: z.string().min(1), description: z.string().min(1) }),
  /** The manifest's scripts block, which the checks invoke, must be unchanged. */
  z.object({ kind: z.literal('manifest-scripts-unchanged'), manifestPath: z.string().min(1), description: z.string().min(1) }),
  /** No file matching the test globs may be deleted. */
  z.object({ kind: z.literal('no-test-deletions'), globs: z.array(z.string()).min(1), description: z.string().min(1) }),
]);
export type ForbiddenRule = z.infer<typeof forbiddenRuleSchema>;

export const hiddenSchema = z
  .object({
    schemaVersion: z.literal(AGENT_CASE_SCHEMA_VERSION),
    caseId: z.string(),
    /** A known-correct migration, as a unified diff against the start commit. Used only by admission and diagnostics. */
    referencePatch: z.string().min(1),
    /** Where the reference fix came from. */
    referencePatchOrigin: z.enum(['maintainer', 'benchmark-author']),
    tests: z.array(hiddenTestSchema).min(1),
    forbidden: z.array(forbiddenRuleSchema).default([]),
    /**
     * Symbols the breaking change is about (as the upstream package names
     * them). Used only for the pipeline diagnostic "did Drift identify the
     * relevant breaking change?", never for scoring.
     */
    expectedSymbols: z.array(z.string()).default([]),
    notes: z.string().default(''),
  })
  .strict();
export type HiddenDeclaration = z.infer<typeof hiddenSchema>;

export interface HiddenTest extends Omit<HiddenTestDeclaration, 'files'> {
  /** Path relative to the workspace -> content. */
  files: Record<string, string>;
}

export interface HiddenMaterial extends Omit<HiddenDeclaration, 'tests' | 'referencePatch'> {
  tests: HiddenTest[];
  referencePatch: string;
}

/* ---------------------------------------------------------------- */
/* Suite manifest                                                    */
/* ---------------------------------------------------------------- */

export const suiteSchema = z
  .object({
    suite: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** `draft` suites may change; a `frozen` suite's case hashes are compared on every run and every aggregation. */
    status: z.enum(['draft', 'frozen']),
    description: z.string().default(''),
    frozenAt: z.string().nullable().default(null),
    /** Runs per condition the suite was designed for. A published result must meet it. */
    runsPerCondition: z.number().int().positive(),
    cases: z.array(
      z.object({
        id: z.string(),
        /** Content hash of `case.yml` and the hidden half, as admitted. */
        caseHash: z.string(),
        admittedAt: z.string(),
        driftCommit: z.string(),
      }),
    ),
    /** Every case ever removed, with why and when. Nothing is deleted silently. */
    removed: z
      .array(z.object({ id: z.string(), reason: z.string().min(1), date: z.string() }))
      .default([]),
    /** Every change to a case's validation after trials were recorded against it, with why. */
    changes: z
      .array(z.object({ date: z.string(), cases: z.array(z.string()), change: z.string().min(1), reason: z.string().min(1) }))
      .default([]),
  })
  .strict();
export type SuiteManifest = z.infer<typeof suiteSchema>;

/* ---------------------------------------------------------------- */
/* Trial artifact                                                    */
/* ---------------------------------------------------------------- */

export const FAILURE_REASONS = [
  'dependency_reverted',
  'install_failure',
  'build_failure',
  'typecheck_failure',
  'existing_test_failure',
  'lint_failure',
  'runtime_failure',
  'hidden_regression_failure',
  'prohibited_workaround',
  'timeout',
  'agent_error',
  /** The agent finished without changing any file. Objective, never inferred from prose. */
  'incomplete_fix',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
export const failureReasonSchema = z.enum(FAILURE_REASONS);

export const INFRASTRUCTURE_FAILURES = [
  /** The start state could not be materialized or installed on this machine. */
  'setup_failure',
  /** The agent binary could not be started, or the provider refused the session before any work happened. */
  'agent_launch_failure',
  /** The provider returned an API error (rate limit, outage, authentication). */
  'provider_error',
  /** A validation command could not be executed (missing interpreter, spawn error). */
  'validation_unavailable',
  /** The harness itself threw. */
  'runner_error',
] as const;
export type InfrastructureFailure = (typeof INFRASTRUCTURE_FAILURES)[number];

export const usageSchema = z.object({
  /**
   * The headline: every token the provider reports having processed as model
   * input across the whole session, cache hits included. Sum over every model
   * the session used of `inputTokens + cacheReadInputTokens +
   * cacheCreationInputTokens`.
   */
  grossInputTokens: z.number().int().nonnegative(),
  /** Secondary: input tokens the provider did not serve from cache (`inputTokens + cacheCreationInputTokens`). */
  uncachedInputTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Distinct model responses observed in the session's event stream. */
  modelCalls: z.number().int().nonnegative(),
  byModel: z.record(
    z.string(),
    z.object({
      inputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheCreationTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
  /** Which provider record the headline was read from. */
  source: z.enum(['result-model-usage', 'event-ledger']),
  /** Gross input tokens re-summed from the per-message ledger, for the cross-check. */
  ledgerGrossInputTokens: z.number().int().nonnegative(),
  /** Whether the ledger agrees with the provider's own cumulative record for the primary model. */
  ledgerAgreesWithResult: z.boolean().nullable(),
  costUsd: z.number().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

export const toolMetricsSchema = z.object({
  toolCalls: z.number().int().nonnegative(),
  byTool: z.record(z.string(), z.number().int().nonnegative()),
  fileReads: z.number().int().nonnegative(),
  uniqueFilesRead: z.number().int().nonnegative(),
  searches: z.number().int().nonnegative(),
  shellCommands: z.number().int().nonnegative(),
  edits: z.number().int().nonnegative(),
  webRequests: z.number().int().nonnegative(),
  subagentCalls: z.number().int().nonnegative(),
  /** How the counts were made, printed in every report. */
  counting: z.string(),
});
export type ToolMetrics = z.infer<typeof toolMetricsSchema>;

export const patchStatsSchema = z.object({
  files: z.number().int().nonnegative(),
  sourceFiles: z.number().int().nonnegative(),
  testFiles: z.number().int().nonnegative(),
  configFiles: z.number().int().nonnegative(),
  dependencyFiles: z.number().int().nonnegative(),
  otherFiles: z.number().int().nonnegative(),
  linesAdded: z.number().int().nonnegative(),
  linesDeleted: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  deletedFiles: z.array(z.string()),
});
export type PatchStats = z.infer<typeof patchStatsSchema>;

const commandOutcomeSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  /** `null` when the command could not be started at all. */
  exitCode: z.number().int().nullable(),
  spawnFailed: z.boolean(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  outputExcerpt: z.string(),
});

export const validationSchema = z.object({
  dependencyIntegrity: z.object({
    passed: z.boolean(),
    declaredSpecifier: z.string().nullable(),
    installedVersion: z.string().nullable(),
    /** Whether the case's install command succeeded against the agent's final tree. */
    installSucceeded: z.boolean(),
    details: z.array(z.string()),
  }),
  checks: z.array(commandOutcomeSchema.extend({ kind: checkKindSchema })),
  hiddenTests: z.array(commandOutcomeSchema.extend({ id: z.string(), description: z.string() })),
  forbidden: z.array(z.object({ kind: z.string(), description: z.string(), passed: z.boolean(), detail: z.string() })),
  success: z.boolean(),
  failureReasons: z.array(failureReasonSchema),
});
export type ValidationResult = z.infer<typeof validationSchema>;

export const trialSchema = z
  .object({
    schemaVersion: z.literal(AGENT_TRIAL_SCHEMA_VERSION),
    trialId: z.string(),
    runId: z.string(),
    suite: z.string(),
    caseId: z.string(),
    caseHash: z.string(),
    condition: conditionSchema,
    repetition: z.number().int().positive(),
    /** Position of this trial in the run's schedule, so temporal ordering is auditable. */
    scheduleIndex: z.number().int().nonnegative(),
    metadata: z.object({
      repository: z.string(),
      baseCommit: z.string(),
      startCommit: z.string(),
      /** Hash of the tree the agent started from, so two trials can be shown to have started identically. */
      startTreeHash: z.string(),
      driftCommit: z.string(),
      driftTreeDirty: z.boolean(),
      driftVersion: z.string(),
      dependency: z.object({ name: z.string(), fromVersion: z.string(), toVersion: z.string() }),
      provider: z.string(),
      agentCliVersion: z.string(),
      requestedModel: z.string(),
      /** As the provider reported it. `unavailable` until the session itself said so. */
      confirmedModel: z.string(),
      requestedEffort: z.string(),
      os: z.string(),
      node: z.string(),
      networkPolicy: z.string(),
      agentConfiguration: z.object({
        permissionMode: z.string(),
        disallowedTools: z.array(z.string()),
        cleanEnvironment: z.string(),
        /** Tools the session actually had, from the provider's init record. */
        tools: z.array(z.string()),
        mcpServers: z.array(z.string()),
        argv: z.array(z.string()),
      }),
      startedAt: z.string(),
      endedAt: z.string(),
      timeoutSeconds: z.number().int().positive(),
      budget: z.object({ maxBudgetUsd: z.number().nullable(), maxTurns: z.number().int().nullable() }),
      taskHash: z.string(),
      promptHash: z.string(),
      promptChars: z.number().int().nonnegative(),
    }),
    context: z.object({
      kind: z.enum(['none', 'drift']),
      /** The exact text handed to the agent after the task. Empty for the baseline. */
      preamble: z.string(),
      preambleHash: z.string(),
      driftAnalysisMs: z.number().int().nonnegative().nullable(),
      driftCommand: z.string().nullable(),
      /** Whether Drift's analysis ran to completion. A failure is a product outcome and is recorded, not excluded. */
      driftStatus: z.enum(['not-applicable', 'completed', 'no-plan', 'failed']),
      driftFailure: z.string().nullable(),
      driftPlan: z
        .object({
          breakingChanges: z.number().int().nonnegative(),
          impactSites: z.number().int().nonnegative(),
          impactFiles: z.array(z.string()),
          symbols: z.array(z.string()),
          verdict: z.string(),
          verificationStatus: z.string().nullable(),
          evidenceSources: z.number().int().nonnegative(),
        })
        .nullable(),
    }),
    agent: z.object({
      status: z.enum(['completed', 'timeout', 'error', 'launch-failure', 'provider-error']),
      exitCode: z.number().int().nullable(),
      terminalReason: z.string().nullable(),
      resultSubtype: z.string().nullable(),
      apiErrorStatus: z.number().int().nullable(),
      numTurns: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
      apiDurationMs: z.number().int().nullable(),
      finalMessage: z.string(),
      permissionDenials: z.number().int().nonnegative(),
    }),
    usage: usageSchema,
    tools: toolMetricsSchema,
    patch: patchStatsSchema.extend({
      diff: z.string(),
      diffTruncated: z.boolean(),
      diffHash: z.string(),
    }),
    validation: validationSchema,
    validity: z.object({
      /** Counted in every rate iff true. */
      valid: z.boolean(),
      infrastructureFailure: z.enum(INFRASTRUCTURE_FAILURES).nullable(),
      detail: z.string().nullable(),
    }),
    diagnostics: z.object({
      /** Drift's breaking-change symbols intersect the case's expected symbols. `null` when not applicable. */
      driftIdentifiedBreakingChange: z.boolean().nullable(),
      /** Drift's impact-site files intersect the reference patch's source files. */
      driftIdentifiedLocalCode: z.boolean().nullable(),
      /** Files the agent changed that the reference patch also changed. Diagnostic only, never a score. */
      referencePatchFileOverlap: z.number().int().nonnegative().nullable(),
      referencePatchFiles: z.number().int().nonnegative().nullable(),
    }),
    timing: z.object({
      materializeMs: z.number().int().nonnegative(),
      installMs: z.number().int().nonnegative(),
      contextMs: z.number().int().nonnegative(),
      agentMs: z.number().int().nonnegative(),
      validationMs: z.number().int().nonnegative(),
      totalMs: z.number().int().nonnegative(),
    }),
    /**
     * Present when the artifact's diff-derivable rules were re-evaluated
     * against a later revision of the case. The original outcome is kept.
     */
    rescore: z
      .object({
        rescoredAt: z.string(),
        previousCaseHash: z.string(),
        previousSuccess: z.boolean(),
        previousFailureReasons: z.array(failureReasonSchema),
        rulesReevaluated: z.array(z.string()),
      })
      .optional(),
  })
  .strict();

export type TrialArtifact = z.infer<typeof trialSchema>;

export const runManifestSchema = z
  .object({
    version: z.literal('drift-agent-run-v1'),
    runId: z.string(),
    suite: z.string(),
    suiteStatus: z.string(),
    createdAt: z.string(),
    command: z.string(),
    driftCommit: z.string(),
    driftTreeDirty: z.boolean(),
    provider: z.string(),
    requestedModel: z.string(),
    requestedEffort: z.string(),
    agentCliVersion: z.string(),
    runsPerCondition: z.number().int().positive(),
    conditions: z.array(conditionSchema),
    caseIds: z.array(z.string()),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    notes: z.string(),
  })
  .strict();
export type RunManifest = z.infer<typeof runManifestSchema>;
