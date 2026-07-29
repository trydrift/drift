import type { DispatchResult, RemediationPlan, RepoContext } from './types.js';
import type { DriftConfig } from './config/schema.js';
import type { Logger } from './util/logger.js';
import type { GitHubClient } from './github/client.js';
import { detectChanges, isManifestPath, triage, type ManifestSnapshot } from './detect/index.js';
import { gatherEvidence } from './evidence/index.js';
import { analyze } from './analyze/index.js';
import { buildIndex } from './index/metarag.js';
import { walkSourceFiles } from './index/walk.js';
import { localize } from './localize/index.js';
import { buildPlan } from './plan/index.js';
import { dispatch } from './dispatch/index.js';
import { renderSummaryLine } from './report/markdown.js';

/**
 * The Drift pipeline.
 *
 * Seven stages, each a pure-ish transform over the domain model:
 *
 *   detect -> triage -> evidence -> analyze -> localize -> plan -> dispatch
 *
 * The ordering encodes the central discipline: Drift establishes *what
 * actually changed upstream* (evidence) and *where it bites here* (localize)
 * before it decides anything, and it decides before it acts. Nothing reaches a
 * coding agent that could not be traced back to a citation and a line number.
 *
 * Any stage may legitimately produce nothing, and an empty result is a valid
 * answer rather than a failure — most dependency bumps genuinely do not break
 * the consumer, and saying so quickly is a feature.
 */

export interface PipelineOptions {
  repo: RepoContext;
  config: DriftConfig;
  logger: Logger;
  github: GitHubClient;
  /** User-scoped token for the Copilot agent API. */
  copilotToken?: string;
  /** Analyse and report without creating branches, issues, or tasks. */
  dryRun?: boolean;
  /** A human approved this plan via `/drift apply`. */
  approved?: boolean;
  /** Local checkout to index. Falls back to `repo.workspace`. */
  workspace?: string;
}

export interface PipelineResult {
  plan: RemediationPlan | null;
  dispatch: DispatchResult;
  summary: string;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { repo, config, logger, github, copilotToken, dryRun, approved } = options;
  const workspace = options.workspace ?? repo.workspace;

  /* Stage 1 — detect ---------------------------------------------------- */

  const changes = await logger.group('Drift: detecting dependency changes', async () => {
    const snapshots = await collectManifestSnapshots(github, repo, logger);
    if (snapshots.length === 0) {
      logger.info('No manifest or lockfile changed in this push.');
      return [];
    }
    const detected = detectChanges(snapshots);
    logger.info(`Detected ${detected.length} dependency change(s) across ${snapshots.length} manifest(s)`);
    return detected;
  });

  if (changes.length === 0) {
    return emptyResult('No dependency changes detected in this push.');
  }

  /* Stage 2 — triage ---------------------------------------------------- */

  const { actionable, skipped } = triage(changes, config);
  for (const entry of skipped) {
    logger.info(`Skipping ${entry.change.name}: ${entry.reason}`);
  }

  if (actionable.length === 0) {
    return emptyResult(
      `Found ${changes.length} dependency change(s), none of which met the analysis criteria in drift.yml.`,
    );
  }
  logger.info(`Analysing ${actionable.length} dependency change(s)`);

  /* Stage 3 — evidence -------------------------------------------------- */

  const evidence = await logger.group('Drift: gathering evidence', async () => {
    const records = await gatherEvidence(actionable, {
      config,
      logger,
      githubToken: undefined,
      readRepoFile: (path, ref) => github.readFile(repo, path, ref),
      beforeSha: repo.beforeSha,
      afterSha: repo.afterSha,
    });
    logger.info(`Gathered ${records.length} evidence record(s)`);
    return records;
  });

  /* Stage 4 — analyze --------------------------------------------------- */

  const breakingChanges = await logger.group('Drift: identifying breaking changes', async () => {
    const found = await analyze(actionable, evidence, { config, logger });
    logger.info(
      found.length === 0
        ? 'No breaking changes identified from the available evidence.'
        : `Identified ${found.length} breaking change(s)`,
    );
    return found;
  });

  /* Stage 5 — localize -------------------------------------------------- */

  const impactSites = await logger.group('Drift: locating affected code', async () => {
    if (breakingChanges.length === 0) return [];
    if (!workspace) {
      // Without a checkout there is nothing to search. This is a real
      // limitation of the webhook runner and is surfaced, not hidden.
      logger.warn(
        'No local checkout available, so affected code cannot be located. Run Drift as a GitHub Action (with actions/checkout) for full analysis.',
      );
      return [];
    }

    const files = await walkSourceFiles(workspace);
    const index = buildIndex(files);
    logger.info(
      `Indexed ${index.stats.fileCount} file(s), ${index.stats.unitCount} code unit(s), ${index.stats.totalLines} line(s)`,
    );

    const sites = localize(breakingChanges, actionable, index, files, { logger });
    logger.info(
      `Found ${sites.length} impact site(s) across ${new Set(sites.map((s) => s.file)).size} file(s)`,
    );
    return sites;
  });

  /* Stage 6 — plan ------------------------------------------------------ */

  const plan = buildPlan({
    repo,
    config,
    changes: actionable,
    evidence,
    breakingChanges,
    impactSites,
    skipped,
  });

  logger.info(renderSummaryLine(plan));
  for (const blocker of plan.blockers) logger.warn(`Blocker: ${blocker}`);

  /* Stage 7 — dispatch -------------------------------------------------- */

  const result = await logger.group('Drift: dispatching', () =>
    dispatch({ repo, plan, config, github, logger, copilotToken, dryRun, approved }),
  );

  logger.info(result.message);

  return { plan, dispatch: result, summary: result.message };
}

/**
 * Read every changed manifest at both commits.
 *
 * Both sides are needed because a dependency change is a *diff*: the new
 * manifest alone cannot tell us which version a package moved from, and
 * without that there is no version range to gather evidence for.
 */
async function collectManifestSnapshots(
  github: GitHubClient,
  repo: RepoContext,
  logger: Logger,
): Promise<ManifestSnapshot[]> {
  const changedFiles = await github.changedFiles(repo);
  const manifests = changedFiles.filter(isManifestPath);

  if (manifests.length === 0) return [];
  logger.debug(`Changed manifests: ${manifests.join(', ')}`);

  const snapshots = await Promise.all(
    manifests.map(async (path) => {
      const [before, after] = await Promise.all([
        github.readFile(repo, path, repo.beforeSha),
        github.readFile(repo, path, repo.afterSha),
      ]);
      return { path, before, after };
    }),
  );

  return snapshots.filter((s) => s.before !== null || s.after !== null);
}

function emptyResult(message: string): PipelineResult {
  return {
    plan: null,
    dispatch: { status: 'skipped', planId: 'none', message },
    summary: message,
  };
}
