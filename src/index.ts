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
export type { DriftConfig } from './config/schema.js';
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
export { diffSpecs, parseSpec } from './evidence/openapi.js';
export type { OpenApiFinding, OpenApiChangeKind } from './evidence/openapi.js';
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

export { dispatch, dispatchToCopilot, buildTaskPrompt, getTaskStatus, isTerminalState } from './dispatch/index.js';
export type { DispatchOptions, CopilotDispatchResult, CopilotTask } from './dispatch/index.js';

export { renderPullRequestBody, renderApprovalIssue, renderSummaryLine } from './report/markdown.js';

export { GitHubClient } from './github/client.js';
export type { GitHubClientOptions } from './github/client.js';

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
