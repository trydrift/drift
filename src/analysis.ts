import type { DependencyChange, ImpactSite, RemediationPlan, RepoContext } from './types.js';
import type { DriftConfig } from './config/schema.js';
import type { Logger } from './util/logger.js';
import type { RepoProvider } from './repo/provider.js';
import { detectChanges, isManifestPath, triage, type ManifestSnapshot } from './detect/index.js';
import {
  detectWorkspaces,
  labelWorkspaces,
  memberDirectories,
  nodeWorkspaceFs,
  type WorkspaceLayout,
} from './detect/workspace.js';
import { discoverNestedProjects } from './detect/nested.js';
import { gatherEvidence } from './evidence/index.js';
import { analyze } from './analyze/index.js';
import { buildIndex } from './index/metarag.js';
import { walkSourceFiles } from './index/walk.js';
import { localize } from './localize/index.js';
import { resolveModuleMaps } from './localize/modules.js';
import { attemptCodemod, type CodemodResult } from './codemod/index.js';
import { findCommunityRecipe } from './remediation/registry.js';
import type { CommunityRecipeCandidate } from './remediation/types.js';
import { buildPlan } from './plan/index.js';
import { buildRationale } from './rationale/index.js';
import type { SurfaceAddition, SurfaceUnavailable } from './evidence/surface/types.js';
import type { AnalysisGap, CheckedSurface, VerificationOutcome } from './confidence/types.js';
import { behaviouralFindingKind, runBehaviouralVerification } from './verification/behavioural.js';
import { fetchedPackageEnvironment } from './verification/environment.js';
import { dependencyEcosystemKey } from './util/id.js';
import { mapWithConcurrency } from './util/http.js';
import { auditCurrentUsage, type AuditResult } from './audit/index.js';
import type { SourceFile } from './index/walk.js';
import type { RepoIndex } from './index/metarag.js';

/**
 * Stages 1–7: everything up to, but not including, acting.
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
  /** Environment to use for local ecosystem diffing tools. */
  env?: NodeJS.ProcessEnv;
  /** Reports coarse progress, for editor UI. */
  onProgress?: (stage: AnalysisStage, detail: string) => void;
}

export type AnalysisStage =
  | 'detect'
  | 'triage'
  | 'evidence'
  | 'analyze'
  | 'localize'
  | 'verify'
  | 'audit'
  | 'rationale'
  | 'plan'
  | 'done';

export interface AnalysisResult {
  /** `null` when no dependency change was found worth analysing. */
  plan: RemediationPlan | null;
  summary: string;
  /**
   * What is already broken against the versions installed today.
   *
   * Independent of `plan`, and deliberately not folded into it: a plan is a
   * proposal about a version move, and these findings are not about a move at
   * all. They are also present whether or not any manifest changed, which is
   * why `plan` can be `null` while this is populated — a repository where
   * nothing was bumped this week can still be a repository whose code stopped
   * matching its lockfile months ago.
   *
   * Absent when no checkout was available to search, or when the audit was
   * switched off in `drift.yml`.
   */
  audit?: AuditResult;
}

export async function analyzeRepository(options: AnalysisOptions): Promise<AnalysisResult> {
  const { repo, config, logger, provider, githubToken, onProgress } = options;
  const workspace = options.workspace ?? repo.workspace;

  const progress = (stage: AnalysisStage, detail: string) => {
    logger.debug(`${stage}: ${detail}`);
    onProgress?.(stage, detail);
  };

  /**
   * The present-tense audit, which is independent of everything below it.
   *
   * Every early return in this function means "nothing moved, so there is
   * nothing to plan" — and none of them mean "so this repository is fine".
   * Running the audit through the same helper on every exit path is what keeps
   * a repository whose manifests were untouched this week from being told it is
   * clean when its code stopped matching its own lockfile long ago.
   *
   * `shared` is the file walk and index localization has already paid for, when
   * it got that far. Re-walking the repository is the single most expensive
   * thing either stage does, and doing it twice in one run buys nothing.
   */
  const runAudit = async (shared?: {
    files: readonly SourceFile[];
    index: RepoIndex;
  }): Promise<AuditResult | undefined> => {
    if (!config.audit.enabled || !workspace) return undefined;

    progress('audit', 'Checking this code against the versions installed today');
    try {
      return await auditCurrentUsage({
        root: workspace,
        repo,
        config,
        logger,
        ...(githubToken ? { githubToken } : {}),
        ...(options.env ? { env: options.env } : {}),
        includeDev: config.audit.includeDev,
        maxSites: config.audit.maxSites,
        maxPackages: config.audit.maxPackages,
        ...(shared ?? {}),
      });
    } catch (err) {
      // The audit answers a different question from the plan, so it must never
      // be able to take the plan down with it.
      logger.warn(`Audit of installed versions failed: ${(err as Error).message}`);
      return undefined;
    }
  };

  /* Stage 1 — detect */
  progress('detect', 'Reading manifest changes');
  const snapshots = await collectManifestSnapshots(provider, repo, logger);

  if (snapshots.length === 0) {
    return empty('No dependency manifest changed in this range.', await runAudit());
  }

  // Workspace layout, before triage, so every downstream stage knows which
  // package a change belongs to rather than treating the checkout as one thing.
  const declaredLayouts = workspace ? await detectWorkspaces(workspace, nodeWorkspaceFs()) : [];

  // Plenty of repositories are multi-project without ever declaring it through
  // a workspace protocol — a root package plus a sibling `extension/` or `cli/`
  // with its own manifest. Left unaccounted for, a bump in one is localized as
  // though the whole checkout were a single package, the same cross-package
  // false positive workspace detection above exists to prevent.
  const nestedLayouts: WorkspaceLayout[] = workspace
    ? (await discoverNestedProjects(workspace, nodeWorkspaceFs(), memberDirectories(declaredLayouts))).map((p) => ({
        kind: 'undeclared-nested' as const,
        ecosystem: p.ecosystem,
        declaredIn: p.manifestPath,
        members: [{ dir: p.dir, name: null, ecosystem: p.ecosystem }],
      }))
    : [];
  const layouts = [...declaredLayouts, ...nestedLayouts];

  if (layouts.length > 0) {
    logger.info(
      `Workspace: ${layouts.map((l) => `${l.kind} (${l.members.length} member(s))`).join(', ')}`,
    );
  }

  const changes = labelWorkspaces(detectChanges(snapshots), layouts);

  if (changes.length === 0) {
    return empty('Manifests changed, but no dependency versions moved.', await runAudit());
  }

  logger.info(`Detected ${changes.length} dependency change(s)`);

  /* Stage 2 — triage */
  const { actionable, skipped } = triage(changes, config);
  for (const entry of skipped) logger.info(`  - ${entry.change.name}: skipped — ${entry.reason}`);

  if (actionable.length === 0) {
    return empty(
      changes.length === 1
        ? `The 1 dependency change found doesn't match the analysis criteria in drift.yml (see reason above).`
        : `None of the ${changes.length} dependency changes found match the analysis criteria in drift.yml (see reasons above).`,
      await runAudit(),
    );
  }
  progress('triage', `${actionable.length} change(s) to analyse`);

  /* Stage 3 — evidence */
  progress('evidence', `Gathering evidence for ${actionable.map((c) => c.name).join(', ')}`);

  // Kept alongside the evidence rather than inside it: what a computed diff
  // *added*, and why one could not be produced, are both facts about the run
  // that the rationale stage needs and that no BreakingChange should carry.
  //
  // Keyed by `dependencyEcosystemKey`, not `change.name` — in a monorepo, two
  // workspace members can depend on the same package at different versions,
  // and (rarer, but real) a workspace can carry the same name in two
  // ecosystems at once. A name-only key would let one silently stand in for
  // the other's computed diff.
  const additions = new Map<string, { additions: SurfaceAddition[]; locator: string }>();
  const surfaceGaps = new Map<string, SurfaceUnavailable>();
  // Whether a surface diff was successfully computed at all, independent of
  // whether it found anything — `additions` alone cannot answer that, because
  // a clean diff and "never computed" both leave it without an entry.
  const surfaceComputed = new Set<string>();

  let evidence = await gatherEvidence(actionable, {
    config,
    logger,
    githubToken,
    ...(options.env ? { env: options.env } : {}),
    readRepoFile: (path, ref) => provider.readFile(path, ref),
    beforeSha: repo.beforeSha,
    afterSha: repo.afterSha,
    ...(workspace ? { workspaceRoot: workspace } : {}),
    onSurfaceComputed: (change, diff) => {
      const key = dependencyEcosystemKey(change);
      surfaceComputed.add(key);
      additions.set(key, { additions: diff.additions ?? [], locator: diff.locator });
    },
    onUnavailableSurface: (change, reason) => surfaceGaps.set(dependencyEcosystemKey(change), reason),
  });
  logger.info(`Gathered ${evidence.length} evidence record(s)`);

  /* Stage 4 — analyze */
  progress('analyze', 'Identifying breaking changes');
  let breakingChanges = await analyze(actionable, evidence, { config, logger });
  logger.info(`Identified ${breakingChanges.length} breaking change(s)`);

  /* Stage 5 — localize */
  const impactSites: RemediationPlan['impactSites'] = [];
  // Whether the search actually happened, which is a different fact from
  // whether it found anything. Without this the plan cannot tell a reader that
  // zero impact sites meant "not searched".
  const localizationRan = Boolean(workspace);

  // Populated in the same pass as localization, since it needs the same
  // in-memory file contents localization already read — reading the
  // repository a second time just for this would be redundant I/O for no
  // benefit. Keyed by `BreakingChange.id` so `buildPlan` can attach a fix to
  // exactly the commit unit(s) that finding ends up in.
  const codemods = new Map<string, CodemodResult>();
  // Community recipe candidates are matched (never executed) in the same
  // pass, for every finding a codemod could not resolve — see
  // `src/remediation/registry.ts`. Keyed the same way as `codemods` so
  // `buildPlan` can attach them to the same commit unit(s).
  const recipes = new Map<string, CommunityRecipeCandidate>();

  // Hoisted so the audit can reuse the walk and the index rather than paying
  // for the repository's largest read a second time in the same run.
  let indexed: { files: readonly SourceFile[]; index: RepoIndex } | undefined;

  if (breakingChanges.length > 0 && workspace) {
    progress('localize', 'Searching for affected code');
    const members = memberDirectories(layouts);
    // The index stays repository-wide so an import crossing a package boundary
    // still resolves; it is the *sites* that are scoped to the member whose
    // manifest moved.
    const files = await walkSourceFiles(workspace, { members });
    const index = buildIndex(files);
    indexed = { files, index };

    // What each package calls itself in source, read from the artefact the
    // registry published. Resolved once for the whole run — every dependency
    // that moved, concurrently — because the alternative is one round trip per
    // breaking change against packages that repeat across findings.
    const moduleMaps = await resolveModuleMaps(actionable, { logger });

    for (const [member, changesHere] of groupByMember(actionable)) {
      const ids = new Set(changesHere.map((c) => c.name));
      // `b.workspace === member` matters as much as the name: two members can
      // depend on the same package, and without it this member's search would
      // also pick up — and search for — the other member's findings.
      const relevant = breakingChanges.filter((b) => ids.has(b.dependency) && b.workspace === member);
      if (relevant.length === 0) continue;
      impactSites.push(
        ...localize(relevant, changesHere, index, files, { logger, member, moduleMaps }),
      );
    }

    logger.info(`Found ${impactSites.length} impact site(s)`);

    /* Stage 5.5 — codemod: deterministic fixes where they can be proven safe
     *
     * Every edit a codemod makes is anchored to one of the impact sites just
     * localized above — never to "everywhere this word appears in the file" —
     * so a codemod's result set is a subset of what localization already
     * proved was relevant to this exact finding. Reuses the same in-memory
     * file contents `localize` just read; no extra I/O.
     */
    const sitesByChange = new Map<string, ImpactSite[]>();
    for (const site of impactSites) {
      const existing = sitesByChange.get(site.breakingChangeId);
      if (existing) existing.push(site);
      else sitesByChange.set(site.breakingChangeId, [site]);
    }

    const fileContents = new Map(files.map((f) => [f.path, f.content]));
    const dependencyChangeByKey = new Map(
      actionable.map((c) => [`${c.workspace ?? ''}::${c.name}`, c] as const),
    );

    // Findings the built-in codemod engine declined, in case community
    // recipes are enabled — the built-in fix always wins when both could
    // apply, so there is no reason to query a registry for one it already
    // resolved.
    const needsRecipeLookup: typeof breakingChanges = [];
    for (const change of breakingChanges) {
      const sitesHere = sitesByChange.get(change.id);
      if (!sitesHere || sitesHere.length === 0) continue;

      const result = attemptCodemod(change, sitesHere, fileContents);
      if (result) codemods.set(change.id, result);
      else needsRecipeLookup.push(change);
    }

    // A community recipe requires a real network call to a third-party
    // registry, unlike the built-in codemod check above — so, unlike that
    // check, this only runs when the operator has explicitly opted in.
    // Bounded concurrency keeps a slow registry from serializing an
    // otherwise-fast analysis; `findCommunityRecipe` itself never throws.
    if (config.remediation.communityRecipes && needsRecipeLookup.length > 0) {
      const found = await mapWithConcurrency(needsRecipeLookup, 4, async (change) => {
        const dependencyChange = dependencyChangeByKey.get(`${change.workspace ?? ''}::${change.dependency}`);
        return [change.id, await findCommunityRecipe(change, dependencyChange)] as const;
      });
      for (const [changeId, recipe] of found) {
        if (recipe) recipes.set(changeId, recipe);
      }
    }
  } else if (breakingChanges.length > 0) {
    logger.warn('No local checkout available; affected code cannot be located.');
  }

  /* Stage 6 — verify (behavioural, experimental and off by default) */
  const behaviouralGaps: AnalysisGap[] = [];
  // Fed into `buildPlan` as `VerificationOutcome[]` so a behavioural probe
  // that actually ran moves the verification-confidence dimension the same
  // way a build or test outcome would — without this, `assessVerification`
  // never sees the probing happened at all and stays at `band: 'none'`
  // regardless of how much behavioural evidence was gathered.
  const verificationOutcomes: VerificationOutcome[] = [];
  let behaviouralRan = false;

  if (config.verification.behavioural.enabled && breakingChanges.length > 0 && impactSites.length > 0) {
    progress('verify', 'Probing dependency behaviour for reachable findings');
    behaviouralRan = true;

    const verification = await runBehaviouralVerification({
      config,
      breakingChanges,
      dependencyChanges: actionable,
      impactSites,
      resolveEnvironments: async (change) => {
        if (!change.from || !change.to) return null;
        const [oldEnvironment, newEnvironment] = await Promise.all([
          fetchedPackageEnvironment('old', change.name, change.from),
          fetchedPackageEnvironment('new', change.name, change.to),
        ]);
        return oldEnvironment && newEnvironment ? { oldEnvironment, newEnvironment } : null;
      },
    });

    for (const reason of verification.gaps) {
      behaviouralGaps.push({
        stage: 'verify',
        surface: 'behavioural-diff',
        reason,
        severity: 'minor',
        automaticExecution: 'none',
        remediation: 'Behavioural probing is experimental; see `verification.behavioural` in drift.yml.',
      });
    }

    if (verification.evidence.length > 0) {
      evidence = [...evidence, ...verification.evidence];
      breakingChanges = breakingChanges.map((change) => {
        const extra = verification.citationsByChangeId.get(change.id);
        return extra?.length ? { ...change, citations: [...change.citations, ...extra] } : change;
      });
      logger.info(`Behavioural probing added ${verification.evidence.length} observation(s) of evidence`);

      // `citationsByChangeId` maps change -> evidence ids it cites; inverted
      // here to evidence -> the change(s) it actually bears on, so an outcome
      // can be scoped to the exact finding rather than every finding that
      // happens to share its dependency and workspace.
      const changeIdsByEvidenceId = new Map<string, string[]>();
      for (const [changeId, evidenceIds] of verification.citationsByChangeId) {
        for (const evidenceId of evidenceIds) {
          const list = changeIdsByEvidenceId.get(evidenceId);
          if (list) list.push(changeId);
          else changeIdsByEvidenceId.set(evidenceId, [changeId]);
        }
      }

      for (const record of verification.evidence) {
        const detail = record.findings?.[0]?.detail ?? '';
        const kind = behaviouralFindingKind(detail);
        verificationOutcomes.push({
          name: `behavioural:${record.dependency}`,
          command: 'drift verify --behavioural (bounded differential probe)',
          // `probe-unavailable` is a harness limitation, not a check that ran —
          // recorded as `unavailable` so it costs nothing rather than reading
          // as a check that silently confirmed nothing.
          status: kind === 'probe-unavailable' ? 'unavailable' : 'passed',
          detail,
          // Scoped to the dependency (and workspace) this probe actually
          // exercised — kept as a fallback for callers that only check that —
          // and, when known, to the exact breaking change(s) it cited, so a
          // probe of one symbol cannot raise verification confidence for a
          // different finding on the same dependency. See `assessAll` in
          // `plan/index.ts`.
          dependency: record.dependency,
          workspace: record.workspace,
          breakingChangeIds: changeIdsByEvidenceId.get(record.id) ?? [],
        });
      }
    }
  }

  // What was looked at, and how it went. Recorded so the report can say which
  // surfaces were genuinely checked rather than leaving a reader to assume
  // that everything not mentioned was fine.
  const checkedSurfaces: CheckedSurface[] = [];

  if (config.verification.behavioural.enabled) {
    checkedSurfaces.push({
      surface: 'behavioural-diff',
      status: behaviouralRan ? 'checked' : 'skipped',
      detail: behaviouralRan
        ? 'Old and new dependency code were run against generated and observed inputs and compared.'
        : 'No breaking change had a local impact site to probe, so behavioural probing did not run.',
    });
  }

  for (const change of actionable) {
    const key = dependencyEcosystemKey(change);
    // `e.dependency` alone repeats the monorepo collision this key exists to
    // avoid; require the workspace to match too, falling back to name-only
    // when neither evidence nor the change carries a workspace (the common,
    // single-package case, where the two conditions are equivalent).
    const records = evidence.filter((e) => e.dependency === change.name && e.workspace === change.workspace);
    const gap = surfaceGaps.get(key);

    // A diff that ran and found nothing is `checked`, same as one that found
    // findings — `surfaceComputed` is what distinguishes "computed and clean"
    // from "never computed", which `records.some(findings)` alone could not:
    // both look identical (no findings) from that side.
    const computed = surfaceComputed.has(key) || records.some((e) => e.findings?.length);
    checkedSurfaces.push({
      surface: 'api-surface',
      dependency: change.name,
      ecosystem: change.ecosystem,
      status: gap ? 'unavailable' : computed ? 'checked' : 'unavailable',
      detail: gap
        ? gap.reason
        : computed
          ? 'A computed diff of the published API surface was produced.'
          : 'No computed API diff was available for this ecosystem or version pair.',
    });

    const prose = records.filter((e) => e.source === 'changelog' || e.source === 'github-release');
    checkedSurfaces.push({
      surface: 'release-notes',
      dependency: change.name,
      ecosystem: change.ecosystem,
      status: prose.length > 0 ? 'checked' : 'unavailable',
      detail:
        prose.length > 0
          ? `${prose.length} release note or changelog section(s) retrieved.`
          : 'No changelog or release notes could be retrieved.',
    });
  }

  checkedSurfaces.push({
    surface: 'localization',
    status: localizationRan ? 'checked' : 'skipped',
    detail: localizationRan
      ? `Searched the files importing each changed dependency; ${impactSites.length} affected location(s).`
      : 'No checkout was available, so this repository was not searched.',
  });

  /* Stage 6.5 — audit: what is already wrong, regardless of what moved */
  const audit = await runAudit(indexed);

  /* Stage 7 — rationale */
  progress('rationale', 'Weighing what each upgrade is worth');
  const rationale = await buildRationale(
    { changes: actionable, evidence, breakingChanges, impactSites },
    { config, logger, githubToken, additions, surfaceGaps },
  );

  /* Stage 8 — plan */
  progress('plan', 'Building the remediation plan');
  const plan = buildPlan({
    repo,
    config,
    changes: actionable,
    evidence,
    breakingChanges,
    impactSites,
    rationale,
    skipped,
    localizationRan,
    verification: verificationOutcomes,
    checkedSurfaces,
    codemods,
    recipes,
  });

  progress('done', 'Analysis complete');

  // Appended after `buildPlan` rather than threaded through it: these gaps
  // describe the probing run itself (disabled, unresolvable version, sandbox
  // unavailable), not a property `collectGaps` could derive from its own
  // inputs, and they never block automatic execution on their own.
  const finalPlan = behaviouralGaps.length > 0 ? { ...plan, gaps: [...plan.gaps, ...behaviouralGaps] } : plan;

  return {
    plan: finalPlan,
    summary:
      plan.commits.length > 0
        ? `${plan.breakingChanges.length} breaking change(s), ${new Set(plan.impactSites.map((s) => s.file)).size} file(s) affected`
        : 'No code in this repository is affected by these dependency changes.',
    ...(audit ? { audit } : {}),
  };
}

/**
 * Group changes by the workspace member that declared them.
 *
 * `undefined` — a repository with no workspace — is one group with no boundary,
 * which is the single-package behaviour unchanged.
 */
function groupByMember(
  changes: readonly DependencyChange[],
): [string | undefined, DependencyChange[]][] {
  const groups = new Map<string | undefined, DependencyChange[]>();
  for (const change of changes) {
    const key = change.workspace;
    const list = groups.get(key) ?? [];
    list.push(change);
    groups.set(key, list);
  }
  return [...groups.entries()];
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

function empty(summary: string, audit?: AuditResult): AnalysisResult {
  return { plan: null, summary, ...(audit ? { audit } : {}) };
}
