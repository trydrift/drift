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
  verdictFor,
  type Logger,
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
  /** The production plan, handed on to a repair track so tiering is measured on what detection actually produced. */
  plan: PlanLike & { commits: readonly unknown[] };
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

  const uninstallStub =
    publicCase.ecosystem === 'npm' && publicCase.networkPolicy !== 'allowed'
      ? installNpmFetchStub([
          { name: publicCase.dependency.name, version: publicCase.dependency.fromVersion, dir: workspace.upstreamOldDir },
          { name: publicCase.dependency.name, version: publicCase.dependency.toVersion, dir: workspace.upstreamNewDir },
        ])
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
        plan: { changes: [], evidence: [], breakingChanges: [], impactSites: [], gaps: [], commits: [] },
        summary: result.summary,
      };
    }

    const plan = result.plan as unknown as PlanLike & { commits: readonly unknown[] };
    const verdictByChangeId = new Map(
      plan.breakingChanges.map((change) => [change.id, String(verdictFor(change as never))] as const),
    );

    return {
      detection: toDetectionArtifact(plan, {
        includeDependencyChanges: true,
        triageSkipped,
        checkedSurfaces: checkedSurfacesOf(result.plan),
        verificationOutcomes: verificationOutcomesOf(result.plan),
        verdictByChangeId,
        verdict: reduceVerdict([...verdictByChangeId.values()], plan.breakingChanges.length === 0),
      }),
      plan,
      summary: result.summary,
    };
  } finally {
    uninstallStub();
  }
}

/**
 * Production's own precedence, restated once here rather than per adapter.
 *
 * The ordering is deliberate and is the safety-relevant part: an inconclusive
 * result never outranks a positive one, and no absence of evidence is ever
 * promoted to a safe-equivalent verdict. A run with no breaking change and no
 * successfully computed surface is `insufficient-evidence`, not `clean` —
 * "nothing was flagged" is not the same claim as "the surface was checked and
 * found compatible", and only the second one may be reported as safe.
 */
function reduceVerdict(verdicts: readonly string[], noBreakingChanges: boolean): string {
  if (noBreakingChanges) return verdicts.length === 0 ? 'insufficient-evidence' : verdicts[0]!;
  const precedence = [
    'locally-affected',
    'insufficient-evidence',
    'verification-incomplete',
    'detected-not-locally-reachable',
    'no-incompatible-change-in-checked-surfaces',
  ];
  return precedence.find((verdict) => verdicts.includes(verdict)) ?? verdicts[0] ?? 'unchecked';
}

function checkedSurfacesOf(plan: unknown): { name: string; status: string }[] {
  const surfaces = (plan as { checkedSurfaces?: { name?: string; kind?: string; status: string }[] }).checkedSurfaces ?? [];
  return surfaces.map((surface) => ({ name: surface.name ?? surface.kind ?? 'unknown', status: surface.status }));
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
