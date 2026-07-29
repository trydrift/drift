import type { RemediationPlan, RepoContext } from './types.js';
import type { DriftConfig } from './config/schema.js';
import type { Logger } from './util/logger.js';
import type { RepoProvider } from './repo/provider.js';
import { detectChanges, isManifestPath, triage, type ManifestSnapshot } from './detect/index.js';
import { gatherEvidence } from './evidence/index.js';
import { analyze } from './analyze/index.js';
import { buildIndex } from './index/metarag.js';
import { walkSourceFiles } from './index/walk.js';
import { localize } from './localize/index.js';
import { buildPlan } from './plan/index.js';

/**
 * Stages 1–6: everything up to, but not including, acting.
 *
 * Split out from the full pipeline so the analysis can run anywhere — a CI
 * runner, a webhook server, or an editor with no credentials at all. Nothing
 * in here writes, pushes, or dispatches; the worst it can do is read files and
 * fetch public metadata.
 *
 * That separation is what lets the VS Code extension analyse a workspace the
 * moment it opens, without asking anyone to sign in to anything.
 */

export interface AnalysisOptions {
  repo: RepoContext;
  config: DriftConfig;
  logger: Logger;
  provider: RepoProvider;
  /** Local checkout to index. Without one, localization is unavailable. */
  workspace?: string;
  /** Optional token, used only to raise public GitHub API rate limits. */
  githubToken?: string;
  /** Reports coarse progress, for editor UI. */
  onProgress?: (stage: AnalysisStage, detail: string) => void;
}

export type AnalysisStage =
  | 'detect'
  | 'triage'
  | 'evidence'
  | 'analyze'
  | 'localize'
  | 'plan'
  | 'done';

export interface AnalysisResult {
  /** `null` when no dependency change was found worth analysing. */
  plan: RemediationPlan | null;
  summary: string;
}

export async function analyzeRepository(options: AnalysisOptions): Promise<AnalysisResult> {
  const { repo, config, logger, provider, githubToken, onProgress } = options;
  const workspace = options.workspace ?? repo.workspace;

  const progress = (stage: AnalysisStage, detail: string) => {
    logger.debug(`${stage}: ${detail}`);
    onProgress?.(stage, detail);
  };

  /* Stage 1 — detect */
  progress('detect', 'Reading manifest changes');
  const snapshots = await collectManifestSnapshots(provider, repo, logger);

  if (snapshots.length === 0) {
    return empty('No dependency manifest changed in this range.');
  }

  const changes = detectChanges(snapshots);
  logger.info(`Detected ${changes.length} dependency change(s)`);

  if (changes.length === 0) {
    return empty('Manifests changed, but no dependency versions moved.');
  }

  /* Stage 2 — triage */
  const { actionable, skipped } = triage(changes, config);
  for (const entry of skipped) logger.info(`Skipping ${entry.change.name}: ${entry.reason}`);

  if (actionable.length === 0) {
    return empty(
      `${changes.length} dependency change(s) found, none matching the analysis criteria in drift.yml.`,
    );
  }
  progress('triage', `${actionable.length} change(s) to analyse`);

  /* Stage 3 — evidence */
  progress('evidence', `Gathering evidence for ${actionable.map((c) => c.name).join(', ')}`);
  const evidence = await gatherEvidence(actionable, {
    config,
    logger,
    githubToken,
    readRepoFile: (path, ref) => provider.readFile(path, ref),
    beforeSha: repo.beforeSha,
    afterSha: repo.afterSha,
  });
  logger.info(`Gathered ${evidence.length} evidence record(s)`);

  /* Stage 4 — analyze */
  progress('analyze', 'Identifying breaking changes');
  const breakingChanges = await analyze(actionable, evidence, { config, logger });
  logger.info(`Identified ${breakingChanges.length} breaking change(s)`);

  /* Stage 5 — localize */
  let impactSites: RemediationPlan['impactSites'] = [];

  if (breakingChanges.length > 0 && workspace) {
    progress('localize', 'Searching for affected code');
    const files = await walkSourceFiles(workspace);
    const index = buildIndex(files);
    impactSites = localize(breakingChanges, actionable, index, files, { logger });
    logger.info(`Found ${impactSites.length} impact site(s)`);
  } else if (breakingChanges.length > 0) {
    logger.warn('No local checkout available; affected code cannot be located.');
  }

  /* Stage 6 — plan */
  progress('plan', 'Building the remediation plan');
  const plan = buildPlan({
    repo,
    config,
    changes: actionable,
    evidence,
    breakingChanges,
    impactSites,
    skipped,
  });

  progress('done', 'Analysis complete');

  return {
    plan,
    summary:
      plan.commits.length > 0
        ? `${plan.breakingChanges.length} breaking change(s), ${new Set(plan.impactSites.map((s) => s.file)).size} file(s) affected`
        : 'No code in this repository is affected by these dependency changes.',
  };
}

async function collectManifestSnapshots(
  provider: RepoProvider,
  repo: RepoContext,
  logger: Logger,
): Promise<ManifestSnapshot[]> {
  const changed = await provider.changedFiles();
  const manifests = changed.filter(isManifestPath);
  if (manifests.length === 0) return [];

  logger.debug(`Changed manifests: ${manifests.join(', ')}`);

  const snapshots = await Promise.all(
    manifests.map(async (path) => {
      const [before, after] = await Promise.all([
        provider.readFile(path, repo.beforeSha),
        provider.readFile(path, repo.afterSha),
      ]);
      return { path, before, after };
    }),
  );

  return snapshots.filter((s) => s.before !== null || s.after !== null);
}

function empty(summary: string): AnalysisResult {
  return { plan: null, summary };
}
