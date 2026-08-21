/**
 * Drift — public API.
 *
 * Every pipeline stage is exported independently because they are genuinely
 * useful on their own: the OpenAPI differ works standalone, the type-surface
 * differ answers "did this npm upgrade change the API?" without any GitHub
 * involvement, and the detector is a general-purpose manifest diff. Keeping
 * them separable is also what makes them testable in isolation.
 */

export * from './types.js';

export { DriftConfigSchema, DEFAULT_CONFIG, riskWithinLimit, compareRisk } from './config/schema.js';
export type { AgentConfig, AgentProvider, DriftConfig, ExplicitAgentProvider } from './config/schema.js';
export { loadConfig, parseConfig, CONFIG_PATHS } from './config/load.js';

export {
  detectChanges,
  triage,
  isManifestPath,
  parserFor,
  PARSERS,
  classifyBump,
  normalizeVersion,
  isDowngrade,
  isZeroVerBreaking,
} from './detect/index.js';
export type { ManifestSnapshot, TriageResult } from './detect/index.js';

export { gatherEvidence, EVIDENCE_WEIGHTS } from './evidence/index.js';
export type { EvidenceContext } from './evidence/index.js';
export { diffSpecs, parseSpec } from './evidence/spec/openapi.js';
export type { OpenApiFinding, OpenApiChangeKind } from './evidence/spec/openapi.js';
export { SPEC_PROVIDERS, specCodeFor, computeSpecDiff } from './evidence/spec/index.js';
export type { SpecProvider, SpecOutcome, SpecDiff, SpecUnavailable, SpecChange } from './evidence/spec/index.js';
export { diffSurfaces, extractExports, fetchTypeSurface } from './evidence/type-surface.js';
export type { SurfaceApi, SurfaceChange, SurfaceEntry } from './evidence/type-surface.js';
export {
  fetchChangelog,
  fetchMigrationGuide,
  parseChangelogSections,
  sectionsBetween,
  extractBreakingPassages,
} from './evidence/changelog.js';
export { fetchRegistryInfo, parseGitHubRepo } from './evidence/registry.js';
export { fetchReleaseNotes } from './evidence/releases.js';

export { analyze, meetsConfidence, matchProse } from './analyze/index.js';
export type { AnalyzeOptions, ProseMatch } from './analyze/index.js';

export { buildIndex, unitAtLine, packageNameFromSpecifier } from './index/metarag.js';
export type { RepoIndex, FileIndex, CodeUnit, ImportRecord } from './index/metarag.js';
export { walkSourceFiles, languageOf, IGNORED_DIRECTORIES } from './index/walk.js';
export type { SourceFile, Language, WalkOptions } from './index/walk.js';

export { localize } from './localize/index.js';
export type { LocalizeOptions } from './localize/index.js';

export { buildPlan, planCommits, assessRisk, isAutoDispatchable, isTestPath, branchNameFor } from './plan/index.js';
export type { BuildPlanInput } from './plan/index.js';
export { attemptCodemod, applyCodemodTransform } from './codemod/index.js';
export type { CodemodResult, CodemodTransform } from './codemod/index.js';
export { validateFixPlan } from './fixplan/validate.js';
export type { FixPlan, FixPlanAssessment } from './fixplan/schema.js';
export { applyBuiltinCodemod, applyCommitFixPlan } from './remediation/apply.js';
export type { ApplyCodemodResult } from './remediation/apply.js';

export { dispatch, dispatchToCopilot, buildTaskPrompt, getTaskStatus, isTerminalState } from './dispatch/index.js';
export type { DispatchOptions, CopilotDispatchResult, CopilotTask } from './dispatch/index.js';

export { renderPullRequestBody, renderApprovalIssue, renderSummaryLine } from './report/markdown.js';

export { GitHubClient } from './github/client.js';
export type { GitHubClientOptions } from './github/client.js';

export {
  classify,
  normalizeProposedTaxonomy,
  isLocallyUnprovable,
  taxonomyOf,
  TAXONOMY_VALUES,
} from './confidence/taxonomy.js';
export type {
  ChangeTaxonomy,
  ChangeNature,
  ChangeDetectability,
  ChangeScope,
  ChangeVisibility,
} from './confidence/taxonomy.js';
export {
  assess,
  assessUpstream,
  assessLocalImpact,
  assessVerification,
  deriveLegacyConfidence,
  deriveOverallConfidence,
  CALIBRATION_VERSION,
} from './confidence/calibrate.js';
export { bandFor, BANDS, OVERALL_LABEL } from './confidence/types.js';
export type {
  AnalysisGap,
  CheckedSurface,
  ConfidenceAssessment,
  ConfidenceBand,
  ConfidenceReason,
  ConfidenceScore,
  GapSeverity,
  GapStage,
  OverallConfidence,
  VerificationOutcome,
} from './confidence/types.js';
export {
  behaviouralFindingKind,
  literalArgsFromExcerpt,
  runBehaviouralDifferential,
  runBehaviouralVerification,
  selectBehaviouralCandidates,
} from './verification/behavioural.js';
export type {
  BehaviouralCandidateInput,
  BehaviouralEnvironment,
  BehaviouralEnvironmentPair,
  BehaviouralObservation,
  BehaviouralProbe,
  BehaviouralRunResult,
  BehaviouralVerificationResult,
  ContractKind,
  ProbeCase,
  WorkerResult,
} from './verification/behavioural.js';
export {
  fetchedPackageEnvironment,
  localPackageEnvironment,
  resolveJsEntry,
} from './verification/environment.js';
export {
  TELEMETRY_SCHEMA_VERSION,
  assertTelemetrySafe,
  buildUpgradeOutcomeEvent,
  hashInstallationId,
  sampleTelemetryEvent,
  sendTelemetryEvent,
  telemetryEnabled,
} from './telemetry.js';
export type {
  TelemetryConfig,
  TelemetryFeatureFlags,
  UpgradeOutcomeTelemetryEvent,
  UpgradeOutcomeTelemetryInput,
} from './telemetry.js';
export {
  renderGaps,
  renderCheckedSurfaces,
  renderConfidenceTable,
  renderTaxonomy,
  renderEligibility,
  verdictFor,
  verdictText,
  VERDICT_TEXT,
  reduceVerdict,
  resolvePlanVerdict,
  repositoryConclusion,
  overallConfidenceLine,
  evidenceStrengthLabel,
  bandBadge,
  scoreLabel,
} from './report/confidence.js';
export type { FindingVerdict } from './report/confidence.js';

export { resolveAgentSelection } from './agents/selection.js';
export type {
  AgentCredentialSet,
  AgentRuntimeState,
  AgentSelection,
  AgentSelectionSource,
  ResolvedAgentSelection,
  UnresolvedAgentSelection,
} from './agents/selection.js';
export {
  AgentProviderRegistry,
  createDefaultAgentProviderRegistry,
  defaultAgentProviderRegistry,
  isCloudFixAgent,
} from './agents/registry.js';
export type { AgentProviderAdapter, AgentProviderMetadata, AgentRuntimeContext } from './agents/registry.js';
export { CLI_AGENT_SPECS, CliFixAgent, failureReason, parseCodexModels } from './agents/cli.js';
export type {
  AgentAvailability,
  AgentContext,
  AgentKind,
  AgentModel,
  EffortStop,
  FixAgent,
  FixOutcome,
  FixTask,
} from './agents/types.js';
export {
  applyBuiltinCommit,
  applyFixPlanCommit,
  assessmentOf,
  createRemediationWorktree,
  removeRemediationWorktree,
  runAgentCommitsInWorktree,
  runWorktreeRemediation,
} from './remediation/worktree-runner.js';
export type {
  WorktreeAgentRunOptions,
  WorktreeAgentRunResult,
  WorktreeRemediationOptions,
  WorktreeRemediationResult,
} from './remediation/worktree-runner.js';
export { awaitTerminalCloudTask, reconcileCloudTask } from './remediation/cloud-lifecycle.js';
export type { CloudTaskReconciliation } from './remediation/cloud-lifecycle.js';
export type { CloudFixAgent, CloudTaskStatus } from './agents/types.js';
export { validateCloudChangedFiles, validateAgentWorktree } from './agents/scope.js';
export type { CloudScopeValidationOptions, CloudScopeValidationResult, ScopeValidationResult } from './agents/scope.js';

export { authorizeApproval, canApprove } from './approval/authorize.js';
export type { AuthorizeResult, ApprovalRequest, RepoPermission } from './approval/authorize.js';
export { applyApproval } from './approval/apply.js';
export type { ApprovalOutcome, ApplyApprovalOptions } from './approval/apply.js';
export { canonicalJson, canonicalPlan, planDigest, PLAN_SCHEMA_VERSION } from './approval/digest.js';
export {
  parseApprovalMetadata,
  renderApprovalMetadata,
  renderDispatchMarker,
  findPriorDispatch,
} from './approval/metadata.js';
export type { ApprovalMetadata } from './approval/metadata.js';

export { MemoryJobQueue } from './queue/memory.js';
export { SqliteJobQueue } from './queue/sqlite.js';
export { QueueWorker } from './queue/worker.js';
export type { Job, JobQueue, JobStatus, QueueStats } from './queue/types.js';

export { runPipeline } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';

export { createLogger } from './util/logger.js';
export type { Logger, LogLevel } from './util/logger.js';
export { matchGlob, matchesAny } from './util/glob.js';
export { stableId, slugify } from './util/id.js';

export { analyzeRepository } from './analysis.js';
export type { AnalysisOptions, AnalysisResult, AnalysisStage } from './analysis.js';
export type { RepoProvider, RefRange } from './repo/provider.js';
export {
  LocalGitProvider,
  inspectLocalRepo,
  lastCommitTouching,
  parseSlug,
} from './repo/local-git.js';
export type { LocalRepoInfo } from './repo/local-git.js';
