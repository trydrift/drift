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
 * Experimental conditions.
 *
 * `drift` is the condition #320 ran: the task followed by Drift's full human
 * report (`drift analyze --markdown --verify`). Its stored id stays `drift` so
 * every artifact recorded under it keeps its meaning; it is *labelled*
 * `drift-full-report` wherever conditions are compared, and the CLI accepts
 * that name. It is kept as the ablation that shows why the agent interface
 * changed, not as the product's agent path.
 *
 * `drift-agent-brief` — the task followed by the production agent brief
 * (`drift analyze --agent --verify`), with a one-sentence header.
 * `drift-mcp` — the task, a one-sentence note that Drift's MCP tools are
 * available, and the production MCP server (`drift mcp`) connected. Nothing is
 * analysed before the session; the agent calls Drift or does not.
 */
export const CONDITIONS = [
  'baseline',
  'drift',
  'drift-evidence-only',
  'drift-localization-only',
  'drift-agent-brief',
  'drift-mcp',
  'generic-orchestrated',
  'drift-orchestrated',
] as const;
export type Condition = (typeof CONDITIONS)[number];
export const conditionSchema = z.enum(CONDITIONS);

/** How each condition is named in comparisons and on the command line. */
export const CONDITION_LABELS: Record<Condition, string> = {
  baseline: 'baseline',
  drift: 'drift-full-report',
  'drift-evidence-only': 'drift-evidence-only',
  'drift-localization-only': 'drift-localization-only',
  'drift-agent-brief': 'drift-agent-brief',
  'drift-mcp': 'drift-mcp',
  'generic-orchestrated': 'generic-orchestrated',
  'drift-orchestrated': 'drift-orchestrated',
};

/** Accepts a stored id or its label (`drift-full-report` → `drift`). */
export function parseCondition(name: string): Condition {
  const byLabel = (Object.entries(CONDITION_LABELS) as [Condition, string][]).find(([, label]) => label === name);
  if (byLabel) return byLabel[0];
  const parsed = conditionSchema.safeParse(name);
  if (!parsed.success) throw new Error(`Unknown condition "${name}". Known: ${Object.values(CONDITION_LABELS).join(', ')}`);
  return parsed.data;
}

/** The two conditions the canonical summary (`latest.json`) is over. Other Drift conditions are compared separately. */
export const HEADLINE_CONDITIONS: readonly Condition[] = ['baseline', 'drift'];

/** Every condition whose trials are compared against the baseline. */
export const DRIFT_CONDITIONS: readonly Condition[] = ['drift', 'drift-agent-brief', 'drift-mcp', 'drift-evidence-only', 'drift-localization-only', 'generic-orchestrated', 'drift-orchestrated'];

/**
 * Conditions in which a controller, not the agent, owns the remediation loop:
 * several fresh agent sessions, verification run outside them.
 *
 * `generic-orchestrated` — one open session given the task and told an
 * orchestrator verifies, then the product's generic repair loop with an empty
 * plan: no findings, no units, no codemods, no replacement knowledge. What any
 * orchestrator could do without Drift's analysis.
 * `drift-orchestrated` — the product's controller over Drift's own plan:
 * deterministic tiers, bounded units, verification, scoped repairs.
 */
export const ORCHESTRATED_CONDITIONS: readonly Condition[] = ['generic-orchestrated', 'drift-orchestrated'];
export const isOrchestrated = (condition: Condition): boolean => ORCHESTRATED_CONDITIONS.includes(condition);

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
  /**
   * The session loaded a different environment from the one its condition
   * declares: an unexpected or missing MCP server, a plugin, memory. It did not
   * run the condition it is labelled as.
   */
  'environment_mismatch',
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

const tokenSplitSchema = z.object({
  grossInputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
});

export const agentContextSchema = z.object({
  interface: z.enum(['none', 'full-report', 'agent-brief', 'mcp', 'generic-orchestrated', 'drift-orchestrated']),
  /** What Drift placed in the initial prompt, after the task. */
  initialDriftContextChars: z.number().int().nonnegative(),
  /** `ceil(bytes / 3)`, the production brief's own estimator. Not a provider count. */
  initialDriftContextEstimatedTokens: z.number().int().nonnegative(),
  /** Calls to a Drift MCP tool, and what they returned. */
  driftToolCalls: z.number().int().nonnegative(),
  driftToolCallsByName: z.record(z.string(), z.number().int().nonnegative()),
  driftToolReturnedChars: z.number().int().nonnegative(),
  driftToolReturnedEstimatedTokens: z.number().int().nonnegative(),
  /** Error results among those calls. */
  driftToolErrors: z.number().int().nonnegative(),
  /** Breaking changes in the plan the brief was built from. `null` when no plan was computed before the session. */
  findingsInPlan: z.number().int().nonnegative().nullable(),
  findingsInInitialBrief: z.number().int().nonnegative().nullable(),
  /** Distinct finding ids the agent requested with get_finding / get_evidence. */
  findingsRetrievedOnDemand: z.number().int().nonnegative(),
  /** Upstream breaking changes the brief counted instead of listing. */
  nonLocalFindingsOmitted: z.number().int().nonnegative().nullable(),
  deterministicSitesCovered: z.number().int().nonnegative().nullable(),
  residualSitesSentToAgent: z.number().int().nonnegative().nullable(),
  /**
   * Provider usage of the main-conversation model calls up to and including
   * the one that issued the first file edit, and after it. From the
   * per-message ledger, so the CLI's auxiliary model is not in either half.
   * `null` when the session made no edit.
   */
  tokensBeforeFirstEdit: tokenSplitSchema.nullable(),
  tokensAfterFirstEdit: tokenSplitSchema.nullable(),
  /**
   * Wall-clock decomposition, in milliseconds.
   *
   * `preSessionDriftMs` — Drift's analysis before the session (full report and
   * brief conditions); 0 for baseline and MCP.
   * `sessionMs` — the coding-agent session, start to exit. For MCP it already
   * contains Drift's analysis, because `plan_upgrade` runs inside it.
   * `driftToolMs` — time between each Drift tool call and its result, from the
   * CLI's event timestamps; a part of `sessionMs`, not in addition to it.
   * `endToEndMs` — `preSessionDriftMs + sessionMs`: from the start of Drift's
   * work (or the session, where there is none) to the agent's exit. Workspace
   * setup, install and validation are the same for every condition and not in it.
   */
  timing: z
    .object({
      preSessionDriftMs: z.number().int().nonnegative(),
      sessionMs: z.number().int().nonnegative(),
      driftToolMs: z.number().int().nonnegative(),
      endToEndMs: z.number().int().nonnegative(),
    })
    .optional(),
  /**
   * Verification commands the agent ran itself (shell commands only). Broad:
   * a whole-project build, typecheck, lint or test run. Narrow: the same tools
   * pointed at specific files or tests. Absent on artifacts recorded before it
   * was measured.
   */
  agentVerification: z
    .object({
      broad: z.number().int().nonnegative(),
      narrow: z.number().int().nonnegative(),
      /** Broad commands the controller's verification guard refused. Absent before the guard existed. */
      blocked: z.number().int().nonnegative().optional(),
      broadCommands: z.array(z.string()),
    })
    .optional(),
  /** How the agent researched the dependency itself, whatever Drift gave it. */
  research: z.object({
    /** Read/Grep/Glob calls, and shell commands, that touch the upgraded package inside node_modules. */
    dependencySourceAccesses: z.number().int().nonnegative(),
    /** Shell commands that query a registry or package metadata (`npm view`, `npm info`, `yarn info`, `npm ls`). */
    registryQueries: z.number().int().nonnegative(),
    /** Accesses to a CHANGELOG, release notes or migration guide file. */
    changelogAccesses: z.number().int().nonnegative(),
  }),
});
export type AgentContextDiagnostics = z.infer<typeof agentContextSchema>;

const orchestrationSessionSchema = z.object({
  index: z.number().int().positive(),
  /** `open` — the generic condition's first, unscoped session; `unit` — a planned unit; `repair` — a repair round. */
  kind: z.enum(['open', 'unit', 'repair']),
  unitId: z.string().nullable(),
  round: z.number().int().nonnegative(),
  allowedFiles: z.array(z.string()).nullable(),
  changedFiles: z.array(z.string()),
  /** What the controller did with the session's edits. */
  outcome: z.string(),
  reasons: z.array(z.string()),
  scopeRequests: z.array(z.string()),
  agentStatus: z.string(),
  promptChars: z.number().int().nonnegative(),
  promptHash: z.string(),
  durationMs: z.number().int().nonnegative(),
  usage: usageSchema,
  toolCalls: z.number().int().nonnegative(),
  tokensBeforeFirstEdit: tokenSplitSchema.nullable(),
  tokensAfterFirstEdit: tokenSplitSchema.nullable(),
  agentVerification: z.object({ broad: z.number().int().nonnegative(), narrow: z.number().int().nonnegative(), blocked: z.number().int().nonnegative().optional(), broadCommands: z.array(z.string()) }),
  /** Whether the controller's verification guard was installed for this session. */
  verificationGuard: z.boolean().optional(),
  research: z.object({
    dependencySourceAccesses: z.number().int().nonnegative(),
    registryQueries: z.number().int().nonnegative(),
    changelogAccesses: z.number().int().nonnegative(),
  }),
  environmentFingerprint: z.string().nullable(),
});

export const orchestrationSchema = z.object({
  kind: z.enum(['generic', 'drift']),
  sessions: z.array(orchestrationSessionSchema),
  controller: z.object({
    termination: z.string(),
    terminationDetail: z.string(),
    repairRounds: z.number().int().nonnegative(),
    outOfScopeRejections: z.number().int().nonnegative(),
    workaroundRejections: z.number().int().nonnegative(),
    grantedFiles: z.array(z.string()),
    deniedScopeRequests: z.array(z.string()),
    needsHuman: z.array(z.object({ unitId: z.string(), files: z.array(z.string()), reason: z.string() })),
    verifications: z.array(
      z.object({
        round: z.number().int().nonnegative(),
        /** A clean install from the lockfile preceded the checks. Absent before it existed. */
        fresh: z.boolean().optional(),
        passed: z.boolean(),
        fingerprint: z.string(),
        durationMs: z.number().int().nonnegative(),
        installed: z.boolean(),
        failures: z.number().int().nonnegative(),
        preexisting: z.number().int().nonnegative(),
        checks: z.array(z.object({ label: z.string(), kind: z.string(), status: z.string(), durationMs: z.number().int().nonnegative(), failures: z.number().int().nonnegative() })),
        sideEffectsReverted: z.array(z.string()),
      }),
    ),
  }),
  checks: z.array(z.string()),
  units: z.object({
    /** Commit units in Drift's plan (0 for the generic condition). */
    total: z.number().int().nonnegative(),
    resolvedByCodemod: z.number().int().nonnegative(),
    resolvedByFixPlan: z.number().int().nonnegative(),
    sentToAgent: z.number().int().nonnegative(),
    skippedProtected: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
    /** Plan units that needed at least one repair session. */
    requiringRepair: z.number().int().nonnegative(),
  }),
  /** Drift's analysis summary for the Drift condition; `null` for generic. */
  analysis: z
    .object({
      breakingChanges: z.number().int().nonnegative(),
      impactSites: z.number().int().nonnegative(),
      commits: z.number().int().nonnegative(),
      verificationStatus: z.string().nullable(),
    })
    .nullable(),
  timing: z.object({
    analysisMs: z.number().int().nonnegative(),
    deterministicMs: z.number().int().nonnegative(),
    baselineMeasurementMs: z.number().int().nonnegative(),
    agentMs: z.number().int().nonnegative(),
    controllerVerificationMs: z.number().int().nonnegative(),
    endToEndMs: z.number().int().nonnegative(),
  }),
  /** The agent-time budget: the case's session timeout, shared by every session. */
  agentBudgetMs: z.number().int().nonnegative(),
  budgetExhausted: z.boolean(),
});
export type OrchestrationRecord = z.infer<typeof orchestrationSchema>;

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
    /** The trial's preassigned slot in the counterbalanced design. Absent on artifacts recorded before it existed. */
    schedule: z
      .object({ design: z.string(), block: z.number().int().nonnegative(), row: z.number().int().nonnegative(), position: z.number().int().positive() })
      .optional(),
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
        /** Everything the session reported loading. Absent on artifacts recorded before it was captured. */
        environment: z
          .object({
            tools: z.array(z.string()),
            mcpServers: z.array(z.object({ name: z.string(), status: z.string() })),
            skills: z.array(z.string()),
            slashCommands: z.array(z.string()),
            agents: z.array(z.string()),
            plugins: z.array(z.string()),
            memoryPaths: z.array(z.string()),
            outputStyle: z.string().nullable(),
            apiKeySource: z.string().nullable(),
            /** Hash of the environment without Drift's MCP server and tools. Equal across conditions of one experiment. */
            fingerprint: z.string(),
          })
          .nullable()
          .optional(),
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
     * What Drift put into the agent's context and what the agent pulled from
     * it. Absent on artifacts recorded before this block existed (#320's
     * runs); computed from the stream and the plan for every later trial.
     */
    agentContext: agentContextSchema.optional(),
    /** Present for orchestrated conditions: every session, the controller's record, and where the time went. */
    orchestration: orchestrationSchema.optional(),
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
    /** Absent on manifests recorded before these settings were written down. */
    scheduleDesign: z.string().optional(),
    cleanEnvironment: z.string().optional(),
    webTools: z.string().optional(),
    maxBudgetUsd: z.number().nullable().optional(),
    maxTurns: z.number().int().nullable().optional(),
    driftVerify: z.boolean().optional(),
    caseIds: z.array(z.string()),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    notes: z.string(),
  })
  .strict();
export type RunManifest = z.infer<typeof runManifestSchema>;
