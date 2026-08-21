import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublicCase } from '../case/schema.ts';
import type { MaterializedCase } from '../case/materialize.ts';
import { CASE_AFTER_REF, CASE_BEFORE_REF, CaseRepoProvider } from './case-repo-provider.ts';
import { installNpmFetchStub } from './npm-fetch-stub.ts';
import { toDetectionArtifact, type PlanLike } from './detection-artifact.ts';
import type { DetectionArtifact } from '../artifacts/prediction.ts';
import {
  DriftConfigSchema,
  analyzeRepository,
  buildPlan,
  resolvePlanVerdict,
  verdictFor,
  type DriftConfig,
  type Logger,
  type RemediationPlan,
  type RepoContext,
} from '../../../dist/index.js';
import { clearHttpCache } from '../../../dist/util/http.js';
import { clearTypeSurfaceCache } from '../../../dist/evidence/type-surface.js';

/**
 * The user-facing headline detection adapter.
 *
 * This runs `analyzeRepository()` — the actual production orchestrator, the
 * same entry point the CLI, the GitHub Action, the webhook runner and the VS
 * Code extension all call — over a benchmark `RepoProvider`. It never
 * constructs a `DependencyChange`. Everything before evidence gathering is
 * therefore under measurement rather than assumed correct:
 *
 *   manifest snapshot collection · detectChanges · workspace + nested-project
 *   labelling · triage against drift.yml · evidence · analyze · Meta-RAG index
 *   · localize · behavioural verification · codemod/fix-plan planning ·
 *   rationale · buildPlan · verdict
 *
 * The only substitution is transport. `installNpmFetchStub` serves the case's
 * frozen `upstream/old`/`upstream/new` trees as jsDelivr responses — the same
 * seam `test/scan-rows.test.ts` uses in production tests — so
 * `fetchTypeSurface`/`extractExports`/`diffSurfaces` genuinely parse and diff
 * real declaration files, and any other host throws rather than quietly
 * reaching the network.
 *
 * No ground truth reaches this module: its input is a `PublicCase` and a
 * materialized workspace, and `eval/src/case/isolation.test.ts` asserts that
 * nothing here can import the private loader.
 */

export const ADAPTER_VERSION = 'drift-end-to-end-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

export interface EndToEndResult {
  detection: DetectionArtifact;
  /**
   * The production plan verbatim, handed on to a repair track so tiering is
   * measured on what detection actually produced.
   *
   * Typed as production's own `RemediationPlan` rather than as a structural
   * subset: every repair track reads its commit units, and a benchmark-local
   * shape here would have to be re-widened with a cast at each of them, which
   * is exactly where a drifting field would stop being a compile error.
   */
  plan: RemediationPlan;
  summary: string;
}

export async function runEndToEndDetection(
  publicCase: PublicCase,
  workspace: MaterializedCase,
): Promise<EndToEndResult> {
  const config = DriftConfigSchema.parse({
    evidence: { typeSurface: true },
    verification: { behavioural: { enabled: true, network: false, timeoutSeconds: 20 } },
  });

  const repo: RepoContext = {
    owner: 'drift-bench',
    repo: publicCase.id,
    baseBranch: 'main',
    beforeSha: CASE_BEFORE_REF,
    afterSha: CASE_AFTER_REF,
    workspace: workspace.root,
  };

  const provider = new CaseRepoProvider({ workspaceRoot: workspace.root, beforeDir: workspace.beforeDir });

  // Every synthetic case names its package the same way at the same versions,
  // and `fetchTypeSurface`/`fetchText` cache by `name@version` at module scope
  // — correct in production, where a published version is immutable, and a
  // correctness bug here where two cases' local trees answer to one key.
  clearHttpCache();
  clearTypeSurfaceCache();

  // The upstream repository the case's frozen prose belongs to, read from the
  // frozen package's own manifest rather than named here — a case that froze a
  // changelog says which repository it came from, and one that did not gets no
  // prose, exactly as a package without a discoverable repository does.
  const githubRepo = await upstreamGitHubRepo(workspace.upstreamNewDir);

  const uninstallStub =
    publicCase.ecosystem === 'npm' && publicCase.networkPolicy !== 'allowed'
      ? installNpmFetchStub(
          [
            { name: publicCase.dependency.name, version: publicCase.dependency.fromVersion, dir: workspace.upstreamOldDir },
            { name: publicCase.dependency.name, version: publicCase.dependency.toVersion, dir: workspace.upstreamNewDir },
          ],
          { evidenceDir: workspace.evidenceDir, githubRepo },
        )
      : () => undefined;

  const triageSkipped: { dependency: string; reason: string }[] = [];

  try {
    const result = await analyzeRepository({
      repo,
      config,
      logger: {
        ...SILENT_LOGGER,
        // Triage decisions are only reported through the logger, and D0 needs
        // them: "Drift saw the bump and deliberately skipped it" and "Drift
        // never saw the bump" are opposite results that an empty change list
        // alone cannot distinguish.
        info: (message: string) => {
          const skipped = /^ {2}- (?<dep>[^:]+): skipped — (?<reason>.+)$/.exec(message);
          if (skipped?.groups) {
            triageSkipped.push({ dependency: skipped.groups['dep']!, reason: skipped.groups['reason']! });
          }
        },
      },
      provider,
      workspace: workspace.root,
      env: offlineEnv(),
    });

    if (!result.plan) {
      // A run that produced no plan is a real, reportable detection outcome —
      // "Drift found nothing to analyse here" — not an error. Recorded with an
      // empty artifact so it scores as a miss rather than vanishing.
      return {
        detection: emptyDetection(triageSkipped, result.summary),
        // Production's own empty plan, built by production's own builder, so a
        // no-findings run hands a repair track the same shape a findings run
        // does rather than a hand-assembled stand-in.
        plan: emptyPlan(repo, config),
        summary: result.summary,
      };
    }

    const plan = result.plan;
    const verdictByChangeId = new Map(
      plan.breakingChanges.map((change) => [change.id, String(verdictFor(change))] as const),
    );

    return {
      detection: toDetectionArtifact(plan, {
        includeDependencyChanges: true,
        triageSkipped,
        checkedSurfaces: plan.checkedSurfaces,
        verificationOutcomes: verificationOutcomesOf(result.plan),
        verdictByChangeId,
        // Production's own repository-level verdict, not a benchmark-local
        // reconstruction of one — see `resolvePlanVerdict` for why a measured
        // regression (`plan.confirmedRegressions`) can override what the
        // per-finding verdicts above would otherwise say on their own.
        verdict: resolvePlanVerdict(plan),
      }),
      plan,
      summary: result.summary,
    };
  } finally {
    uninstallStub();
  }
}

/** Production's plan for a repository where nothing was found. */
function emptyPlan(repo: RepoContext, config: DriftConfig): RemediationPlan {
  return buildPlan({ repo, config, changes: [], evidence: [], breakingChanges: [], impactSites: [] });
}

/** `owner/repo` from the frozen package manifest's `repository` field, or `null` when it declares none. */
async function upstreamGitHubRepo(upstreamDir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(upstreamDir, 'package.json'), 'utf8')) as {
      repository?: string | { url?: string };
    };
    const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url ?? '');
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function verificationOutcomesOf(plan: unknown): { kind: string; status: string }[] {
  const verification = (plan as { verification?: { status?: string; kind?: string } }).verification;
  return verification?.status ? [{ kind: verification.kind ?? 'behavioural', status: verification.status }] : [];
}

function emptyDetection(
  triageSkipped: readonly { dependency: string; reason: string }[],
  summary: string,
): DetectionArtifact {
  return {
    dependencyChanges: [],
    triageSkipped: triageSkipped.map((entry) => ({ ...entry })),
    upstreamFindings: [],
    checkedSurfaces: [],
    breakingChanges: [],
    impactSites: [],
    gaps: [summary],
    verificationOutcomes: [],
    verdict: 'insufficient-evidence',
  };
}

/**
 * An environment that cannot silently reach a registry.
 *
 * Application-level `fetch` interception stops Drift's own HTTP, but the
 * behavioural probe shells out to a package manager, and a subprocess does not
 * inherit a patched `globalThis.fetch`. These variables are the package
 * manager's own offline switches: honest, and honestly limited — this is
 * configuration, not a sandbox, and the README says so rather than claiming
 * isolation the harness does not implement.
 */
function offlineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}
