import { join } from 'node:path';
import type { DependencyChange, Ecosystem, ImpactSite, RemediationPlan, RepoContext } from './types.js';
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
import { gatherEvidence, type ProseSource } from './evidence/index.js';
import { analyze } from './analyze/index.js';
import { buildIndex } from './index/metarag.js';
import { walkSourceFiles } from './index/walk.js';
import { localize } from './localize/index.js';
import { resolveModuleMaps } from './localize/modules.js';
import { attemptCodemod, type CodemodResult } from './codemod/index.js';
import { resolveFixPlans } from './fixplan/resolve.js';
import { defaultFixPlanCacheDir, fileSystemFixPlanCache, noFixPlanCache } from './fixplan/cache.js';
import type { FixPlanAssessment } from './fixplan/schema.js';
import { proposeFixPlanFromRecipe } from './fixplan/sandbox.js';
import { connectAnthropic } from './analyze/llm.js';
import { findCommunityRecipe } from './remediation/registry.js';
import type { CommunityRecipeCandidate } from './remediation/types.js';
import { buildPlan } from './plan/index.js';
import { buildRationale } from './rationale/index.js';
import { findNodeDeclarations, type RuntimeDeclaration } from './rationale/runtime.js';
import type { SurfaceAddition, SurfaceUnavailable } from './evidence/surface/types.js';
import type { AnalysisGap, CheckedSurface, VerificationOutcome } from './confidence/types.js';
import { behaviouralFindingKind, runBehaviouralVerification } from './verification/behavioural.js';
import { fetchedPackageEnvironment } from './verification/environment.js';
import { probeDependencyChange, type UpgradeVerification } from './verification/upgrade-probe.js';
import { applyVerificationToPlan, combineVerifications, describeVerification } from './verification/apply.js';
import { detectPackageManagers, type PackageManagerId } from './detect/package-manager.js';
import type { CheckKind } from './detect/checks.js';
import { dependencyEcosystemKey } from './util/id.js';
import { mapWithConcurrency } from './util/http.js';
import { repositoryConclusion, VERIFICATION_FAILURE_BLOCKER_PREFIX } from './report/confidence.js';

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
  | 'rationale'
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

  // Logged, not surfaced through `onProgress`: this is for someone deciding
  // where a slow scan's time actually goes — registry calls, localization,
  // the install-and-check probe — not for a caller's progress bar, which
  // wants the stage name and detail exactly as before. `stageStarted` resets
  // on every call rather than only tracking the previous stage's *own*
  // duration, because a stage can log more than once (`verify` reports every
  // phase of the probe) and each of those sub-updates deserves its own
  // interval instead of being folded into one number that hides which part
  // was actually slow.
  let stageStarted = Date.now();
  const progress = (stage: AnalysisStage, detail: string) => {
    const now = Date.now();
    logger.debug(`${stage} (+${now - stageStarted}ms): ${detail}`);
    stageStarted = now;
    onProgress?.(stage, detail);
  };

  /* Stage 1 — detect */
  progress('detect', 'Reading manifest changes');
  const snapshots = await collectManifestSnapshots(provider, repo, logger);

  if (snapshots.length === 0) {
    return empty('No dependency manifest changed in this range.');
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
    return empty('Manifests changed, but no dependency versions moved.');
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
  const prose = new Map<string, ProseSource[]>();
  // Whether a surface diff was successfully computed at all, independent of
  // whether it found anything — `additions` alone cannot answer that, because
  // a clean diff and "never computed" both leave it without an entry.
  const surfaceComputed = new Set<string>();
  // Contract documents (OpenAPI, protobuf, GraphQL) are keyed by path rather
  // than by dependency, and recorded whether or not the comparison worked: a
  // spec that was configured and could not be diffed must not look like one
  // that was diffed and found clean.
  const specChecks: CheckedSurface[] = [];

  let evidence = await gatherEvidence(actionable, {
    config,
    logger,
    githubToken,
    ...(options.env ? { env: options.env } : {}),
    readRepoFile: (path, ref) => provider.readFile(path, ref),
    ...(provider.listFiles ? { listRepoFiles: (ref: string) => provider.listFiles!(ref) } : {}),
    beforeSha: repo.beforeSha,
    afterSha: repo.afterSha,
    ...(workspace ? { workspaceRoot: workspace } : {}),
    onSurfaceComputed: (change, diff) => {
      const key = dependencyEcosystemKey(change);
      surfaceComputed.add(key);
      additions.set(key, { additions: diff.additions ?? [], locator: diff.locator });
    },
    onUnavailableSurface: (change, reason) => surfaceGaps.set(dependencyEcosystemKey(change), reason),
    onProseConsulted: (change, source) => {
      const key = dependencyEcosystemKey(change);
      prose.set(key, [...(prose.get(key) ?? []), source]);
    },
    onSpecComputed: (path, provider) =>
      specChecks.push({
        surface: 'contract-document',
        dependency: path,
        status: 'checked',
        detail: `${path} was compared between the two commits by ${provider.tool}.`,
      }),
    onUnavailableSpec: (path, reason) =>
      specChecks.push({
        surface: 'contract-document',
        dependency: path,
        status: 'unavailable',
        detail: reason.remedy ? `${reason.detail} ${reason.remedy}` : reason.detail,
      }),
  });
  logger.info(`Gathered ${evidence.length} evidence record(s)`);

  /* Stage 4 — analyze */
  progress('analyze', 'Identifying breaking changes');
  let breakingChanges = await analyze(actionable, evidence, { config, logger });
  logger.info(`Identified ${breakingChanges.length} breaking change(s)`);

  /* Stage 5 — localize */
  const impactSites: RemediationPlan['impactSites'] = [];
  // Populated below, in the same pass that reads the repository for
  // localization -- a dependency's runtime floor is a property of this
  // repository, not of any one breaking change, so it is gathered once and
  // handed to every maintenance assessment rather than re-read per change.
  let repoRuntime: RuntimeDeclaration[] = [];
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
  // Validated deterministic fix plans, and the ones that failed the gate.
  // Both are kept: "Drift tried a deterministic fix and rejected it because
  // the replacement was not attested" and "Drift never tried" are different
  // facts, and only the first is a reason to read the agent's output harder.
  const fixPlans = new Map<string, FixPlanAssessment>();
  const rejectedFixPlans = new Map<string, FixPlanAssessment>();

  if (breakingChanges.length > 0 && workspace) {
    progress('localize', 'Searching for affected code');
    const members = memberDirectories(layouts);
    // The index stays repository-wide so an import crossing a package boundary
    // still resolves; it is the *sites* that are scoped to the member whose
    // manifest moved.
    const files = await walkSourceFiles(workspace, { members });
    const index = buildIndex(files);
    repoRuntime = findNodeDeclarations(files);

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

    /* Stage 5.6 — fix plans: one validated rule per finding, applied everywhere
     *
     * Only for findings the built-in engine declined: a codemod Drift derived
     * unaided could not have been wrong by construction, so there is nothing
     * a validated plan could add to it and a model call would be spent for
     * nothing.
     *
     * Every proposal source runs through the same gate (`validateFixPlan`),
     * and the sources are ordered by cost — a cache hit is free, a recipe
     * costs a sandbox, authoring costs a model call. See `fixplan/resolve.ts`.
     */
    if (needsRecipeLookup.length > 0) {
      progress('plan', 'Resolving deterministic fix plans');

      const resolved = await resolveFixPlans({
        changes: needsRecipeLookup,
        sites: impactSites,
        evidence,
        dependencyChanges: actionable,
        fileContents,
        config,
        logger,
        cache: config.remediation.fixPlans.cache
          ? (defaultFixPlanCacheDir() ? fileSystemFixPlanCache(defaultFixPlanCacheDir()!) : noFixPlanCache())
          : noFixPlanCache(),
        client:
          config.remediation.fixPlans.enabled && config.llm.enabled
            ? ((await connectAnthropic(config, logger)) ?? undefined)
            : undefined,
        proposeFromRecipe:
          config.remediation.communityRecipes && workspace
            ? (change) =>
                proposeFixPlanFromRecipe({
                  change,
                  candidate: recipes.get(change.id),
                  dependencyChange: dependencyChangeByKey.get(`${change.workspace ?? ''}::${change.dependency}`),
                  sites: impactSites,
                  workspace,
                  headSha: repo.afterSha,
                  env: options.env,
                  logger,
                })
            : undefined,
      });

      for (const [changeId, assessment] of resolved.accepted) fixPlans.set(changeId, assessment);
      for (const [changeId, assessment] of resolved.rejected) rejectedFixPlans.set(changeId, assessment);
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
  const checkedSurfaces: CheckedSurface[] = [...specChecks];

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

    const proseRead = prose
      .get(key)
      ?.filter((source) => source.kind === 'changelog' || source.kind === 'github-release');
    checkedSurfaces.push({
      surface: 'release-notes',
      dependency: change.name,
      ecosystem: change.ecosystem,
      status: proseRead && proseRead.length > 0 ? 'checked' : 'unavailable',
      detail:
        proseRead && proseRead.length > 0
          ? `${proseRead.length} release note or changelog section(s) retrieved.`
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

  /* Stage 7 — rationale */
  progress('rationale', 'Weighing what each upgrade is worth');
  const rationale = await buildRationale(
    { changes: actionable, evidence, breakingChanges, impactSites },
    { config, logger, githubToken, additions, surfaceCompared: surfaceComputed, surfaceGaps, prose, repoRuntime },
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
    fixPlans,
  });

  progress('done', 'Analysis complete');

  // Appended after `buildPlan` rather than threaded through it: these gaps
  // describe the probing run itself (disabled, unresolvable version, sandbox
  // unavailable), not a property `collectGaps` could derive from its own
  // inputs, and they never block automatic execution on their own.
  const withGaps = behaviouralGaps.length > 0 ? { ...plan, gaps: [...plan.gaps, ...behaviouralGaps] } : plan;

  // This is where Quick Scan ends. Everything above predicts what this
  // change will do to this repository by reading what the dependency
  // published, its changelog, and a computed diff of its declarations —
  // never installing it, never running anything from it, never touching this
  // checkout's own toolchain. A caller that wants the stronger, measured
  // answer calls `deepVerify` next with this result; `analyzeRepository`
  // itself never does, so a Quick Scan is exactly that regardless of what
  // `config.verify.enabled` says.
  return { plan: withGaps, summary: summarize(withGaps) };
}

/**
 * The plan's one-line summary — shared by `analyzeRepository`'s Quick Scan
 * result and `deepVerify`'s updated one, so the two always read the same way
 * for the same shape of plan.
 *
 * The "nothing else to show" case defers to `repositoryConclusion`, which is
 * also what the Markdown report and the check-run summary use — this string
 * is what the CLI prints standalone when there is nothing to fix, so it must
 * not disagree with `resolvePlanVerdict` any more than those do.
 */
function summarize(plan: RemediationPlan): string {
  return plan.commits.length > 0
    ? `${plan.breakingChanges.length} breaking change(s), ${new Set(plan.impactSites.map((s) => s.file)).size} file(s) affected`
    : repositoryConclusion(plan);
}

/**
 * Deep Verification: install the change from a Quick Scan result and run the
 * project's own checks against it.
 *
 * Takes what `analyzeRepository` already returned rather than re-running any
 * of it — detect, evidence, analyze, localize, rationale and plan all stay
 * exactly as Quick Scan left them. This is the one function in the pipeline
 * that creates a worktree, runs a real install, and runs the project's own
 * typecheck/build/test — nothing before it in `analyzeRepository` does, and
 * nothing after it needs to.
 *
 * A no-op (returns `result` unchanged) when there is no plan, no local
 * checkout to run in, or `config.verify.enabled` is `false` — a repository
 * that has verification switched off stays off regardless of who asks.
 *
 * Never throws and never blocks: a failure to verify downgrades the plan to
 * what it already was, which is a prediction, and records why.
 */
export async function deepVerify(result: AnalysisResult, options: AnalysisOptions): Promise<AnalysisResult> {
  if (!result.plan) return result;

  const workspace = options.workspace ?? options.repo.workspace;
  let stageStarted = Date.now();
  const progress = (stage: AnalysisStage, detail: string) => {
    const now = Date.now();
    options.logger.debug(`${stage} (+${now - stageStarted}ms): ${detail}`);
    stageStarted = now;
    options.onProgress?.(stage, detail);
  };

  const verifiedPlan = await verifyPlan(result.plan, {
    ...options,
    ...(workspace ? { workspace } : {}),
    progress,
  });

  if (verifiedPlan === result.plan) return result;
  return { plan: verifiedPlan, summary: summarize(verifiedPlan) };
}

/**
 * Install the change and run the project's own checks against it.
 *
 * Off when there is no local checkout to run in — a webhook analysing a
 * repository it has never cloned can only predict, and says so by leaving
 * `plan.verification` absent rather than implying a pass.
 *
 * Never throws and never blocks: a failure to verify downgrades the plan to
 * what it already was, which is a prediction, and records why.
 */
async function verifyPlan(
  plan: RemediationPlan,
  options: AnalysisOptions & { workspace?: string; progress: (stage: AnalysisStage, detail: string) => void },
): Promise<RemediationPlan> {
  const { repo, config, workspace } = options;
  if (!config.verify.enabled || !workspace || plan.changes.length === 0) return plan;

  // One group per workspace member that actually changed, not one probe for
  // the whole commit. A commit that bumps `packages/web` and `packages/api`
  // together only ever installed and checked whichever one the old logic
  // picked first — the other package's compiler-provable findings would be
  // cleared, or its failure attributed, by a check that never ran against it.
  const groups = new Map<string, DependencyChange[]>();
  for (const change of plan.changes) {
    const dir = change.workspace ?? '';
    const existing = groups.get(dir);
    if (existing) existing.push(change);
    else groups.set(dir, [change]);
  }

  let verifiedPlan = plan;
  const parts: (UpgradeVerification | undefined)[] = [];
  const failedGroups: string[] = [];
  // Dependency changes a failure can be pinned on without ambiguity — see
  // `RemediationPlan.confirmedRegressions`. Only ever populated from a group
  // that moved exactly one dependency, so a batch of several simultaneous
  // bumps in one manifest never has its failure blamed on all of them.
  const confirmedRegressions: string[] = [];

  for (const [dir, changes] of groups) {
    const manager = await managerFor(workspace, dir, changes[0]!.ecosystem);
    if (!manager) continue;

    options.progress(
      'verify',
      `Installing the change in ${dir || 'the repository root'} and running ${config.verify.checks.join(', ')}`,
    );

    const verification = await probeDependencyChange({
      workspace,
      dir,
      packageManager: manager,
      afterSha: repo.afterSha,
      ...(repo.beforeSha ? { beforeSha: repo.beforeSha } : {}),
      kinds: config.verify.checks as CheckKind[],
      timeoutMs: config.verify.timeoutMs,
      ...(config.verify.generatedSourceGlobs.length > 0
        ? { allowedGlobs: config.verify.generatedSourceGlobs }
        : {}),
      logger: options.logger,
      ...(options.env ? { env: options.env } : {}),
      onProgress: ({ phase, detail }) => options.progress('verify', `${phase}: ${detail}`),
    });

    options.logger.info(`Verification (${dir || 'root'}): ${describeVerification(verification)}`);
    parts.push(verification);
    if (verification.status === 'failed') {
      failedGroups.push(dir || 'the repository root');
      // `probeDependencyChange` already compares against a passing baseline
      // (see `reconcileAgainstBaseline`), so `failed` here already means "this
      // check passed before and fails now" — the only thing this adds is
      // ruling out the one remaining ambiguity: several dependencies moving
      // together in the same manifest, where a red result cannot be
      // attributed to any one of them.
      if (changes.length === 1) confirmedRegressions.push(dependencyEcosystemKey(changes[0]!));
    }
    verifiedPlan = applyVerificationToPlan(verifiedPlan, verification, dir);
  }

  const combined = combineVerifications(parts);
  if (combined) verifiedPlan = { ...verifiedPlan, verification: combined };

  // A verification failure is evidence of real breakage even where static
  // analysis predicted none — the exact case a green build was supposed to
  // rule out. Without a blocker, a plan with zero predicted commits reports
  // as "not affected" and dispatch treats that as a reason to do nothing,
  // silently discarding a measured failure. Recorded as a blocker rather than
  // folded into the prediction list because nothing here identifies a
  // specific breaking change to attach it to — only that the project's own
  // checks stopped passing.
  if (failedGroups.length > 0) {
    verifiedPlan = {
      ...verifiedPlan,
      blockers: [
        ...verifiedPlan.blockers,
        `${VERIFICATION_FAILURE_BLOCKER_PREFIX}${failedGroups.join(', ')}, which static analysis did not predict. See the verification output for what broke.`,
      ],
    };
  }

  // Prose in `blockers` stops automatic dispatch (see `isAutoDispatchable`),
  // but nothing reads it to decide what a *report* says — a reader could see
  // "no incompatible change in the checked surfaces" right above a blocker
  // saying the opposite. `confirmedRegressions` is the structured half of the
  // same fact, for `resolvePlanVerdict` to fold into the verdict itself.
  if (confirmedRegressions.length > 0) {
    verifiedPlan = {
      ...verifiedPlan,
      confirmedRegressions: [...verifiedPlan.confirmedRegressions, ...confirmedRegressions],
    };
  }

  return verifiedPlan;
}

/**
 * Which tool owns `dir`, for the ecosystem that actually changed.
 *
 * A pnpm/Yarn/Bun workspace member usually carries nothing but its own
 * `package.json` — the lockfile that actually names the manager lives once,
 * at the repository root. Detecting from the member directory alone would
 * match every npm-ecosystem manager equally and settle on whichever sorts
 * first in the manager table (npm), regardless of what the repository
 * actually uses. The root's lockfile-backed identity wins unless this member
 * carries lockfile evidence of its own.
 */
async function managerFor(
  workspace: string,
  dir: string,
  ecosystem: Ecosystem,
): Promise<PackageManagerId | null> {
  const fs = nodeWorkspaceFs();
  const entries = await fs.readDirectory(dir ? join(workspace, dir) : workspace);
  if (entries.length === 0) return null;

  const atMember = detectPackageManagers({ entries }).filter((d) => d.manager.ecosystem === ecosystem);
  const ownLock = atMember.find((d) => d.fromLockfile);
  if (ownLock) return ownLock.manager.id;

  if (dir) {
    const rootEntries = await fs.readDirectory(workspace);
    const atRoot = detectPackageManagers({ entries: rootEntries }).find(
      (d) => d.manager.ecosystem === ecosystem && d.fromLockfile,
    );
    if (atRoot) return atRoot.manager.id;
  }

  return atMember[0]?.manager.id ?? null;
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

function empty(summary: string): AnalysisResult {
  return { plan: null, summary };
}
