import { z } from 'zod';
import type { Ecosystem, RiskLevel } from '../types.js';

/**
 * The ecosystem names, as a schema.
 *
 * Declared with an explicit `Ecosystem` annotation on each member so that
 * adding an ecosystem to the domain union without adding it here is a compile
 * error. A config schema that silently rejects a supported ecosystem would
 * make it unusable while every other layer claimed to support it.
 */
const ECOSYSTEM_NAMES = z.enum([
  'npm',
  'pypi',
  'go',
  'cargo',
  'maven',
  'rubygems',
  'nuget',
  'packagist',
  'hex',
  'pub',
  'swift',
  'cocoapods',
  'opam',
] as const satisfies readonly Ecosystem[]);

/**
 * `satisfies` above proves every name listed is a real ecosystem. This proves
 * the converse — that every real ecosystem is listed — by failing to compile
 * when the difference is anything but empty.
 */
type UnlistedEcosystem = Exclude<Ecosystem, (typeof ECOSYSTEM_NAMES.options)[number]>;
const _everyEcosystemIsConfigurable: UnlistedEcosystem extends never ? true : never = true;
void _everyEcosystemIsConfigurable;

/**
 * `.github/drift.yml` — the entire user-facing control surface.
 *
 * Defaults are deliberately conservative: a fresh install proposes plans and
 * asks before touching anything. Teams opt into autonomy, they don't opt out
 * of it.
 */
export const DriftConfigSchema = z.object({
  /**
   * `approve` — Drift analyses and posts a plan, then waits for a human.
   * `auto`    — Drift dispatches Copilot as soon as a change is detected,
   *             subject to `maxAutoRisk` and every guardrail below.
   */
  mode: z.enum(['auto', 'approve']).default('approve'),

  /**
   * Highest risk level eligible for automatic dispatch in `auto` mode.
   * Anything above this falls back to `approve` behaviour rather than being
   * dropped, so nothing is ever silently ignored.
   */
  maxAutoRisk: z.enum(['none', 'low', 'medium', 'high']).default('medium'),

  /** Branches whose dependency changes Drift watches. Glob patterns. */
  watchBranches: z.array(z.string()).default(['main', 'master', 'develop']),

  /**
   * Package ecosystems to analyse.
   *
   * Every ecosystem Drift can detect is on by default. Leaving one off would
   * mean a project gets silently partial results with nothing saying so, which
   * is the failure this tool is built to avoid — what each ecosystem can and
   * cannot do is stated per stage in `detect/capabilities.ts` instead.
   */
  ecosystems: z
    .array(ECOSYSTEM_NAMES)
    .default([...ECOSYSTEM_NAMES.options]),

  /** Dependency name globs to ignore entirely. */
  ignore: z.array(z.string()).default([]),

  /** Dependency name globs that always require human approval. */
  alwaysApprove: z.array(z.string()).default([]),

  /** Which version bumps are worth analysing at all. */
  triggerOn: z
    .object({
      major: z.boolean().default(true),
      minor: z.boolean().default(true),
      patch: z.boolean().default(false),
      /** Transitive (lockfile-only) moves are noisy; off by default. */
      transitive: z.boolean().default(false),
      /** Dev dependencies rarely break production code paths. */
      dev: z.boolean().default(false),
    })
    .default({}),

  /** Evidence-gathering knobs. */
  evidence: z
    .object({
      /** Fetch GitHub release notes between the two versions. */
      githubReleases: z.boolean().default(true),
      /** Read the dependency's CHANGELOG from its repository. */
      changelog: z.boolean().default(true),
      /**
       * Diff the actual TypeScript declaration surface of old vs new.
       * The strongest signal Drift has for npm packages.
       */
      typeSurface: z.boolean().default(true),
      /** Diff OpenAPI specs when the dependency ships or is one. */
      openapi: z.boolean().default(true),
      /** Repo-relative globs pointing at OpenAPI specs this repo consumes. */
      openapiSpecs: z.array(z.string()).default([]),
      /** Cap on release notes fetched per dependency. */
      maxReleases: z.number().int().min(1).max(100).default(25),
    })
    .default({}),

  /**
   * The other half of the question: why an upgrade might be worth taking.
   *
   * On by default, because a tool that only ever argues against upgrading is a
   * tool that teaches people to ignore it. Each source can be switched off
   * individually for a repository that cannot reach it.
   */
  rationale: z
    .object({
      /** Check known vulnerabilities for both versions against OSV. */
      security: z.boolean().default(true),
      /** Deprecation, archival, retraction, release recency, runtime minimums. */
      maintenance: z.boolean().default(true),
      /** Plain-English summary of the upstream changes between the versions. */
      summary: z.boolean().default(true),
    })
    .default({}),

  /**
   * License policy. Off by default.
   *
   * Opt-in because a license check with no configured policy has nothing to
   * compare against, and a tool that reports "the license is MIT" on every
   * upgrade is noise. Enabling it without an `allow` or `deny` list still
   * reports a *change* of license, which is the part that matters on an
   * upgrade regardless of policy.
   */
  licenses: z
    .object({
      enabled: z.boolean().default(false),
      /** SPDX identifiers permitted. Empty means every license not denied. */
      allow: z.array(z.string()).default([]),
      /** SPDX identifiers refused. Always wins over `allow`. */
      deny: z.array(z.string()).default([]),
      /**
       * Treat a missing or unreadable license as a violation.
       *
       * Off by default: many registries simply do not publish the field, and
       * failing an upgrade over an empty registry column is the kind of false
       * alarm that gets a policy check switched off entirely.
       */
      requireDeclared: z.boolean().default(false),
    })
    .default({}),

  /** Guardrails. These are the reason a team can leave `auto` mode on. */
  guardrails: z
    .object({
      /** Paths Copilot must never modify. Enforced in the task prompt. */
      protectedPaths: z
        .array(z.string())
        .default([
          '.github/workflows/**',
          '**/*.lock',
          'infra/**',
          'terraform/**',
          '**/secrets/**',
        ]),
      /** Abort if a plan would touch more than this many files. */
      maxFilesChanged: z.number().int().min(1).default(50),
      /** Abort if more than this many dependencies moved at once. */
      maxDependenciesPerRun: z.number().int().min(1).default(10),
      /** Refuse to dispatch when no evidence beyond a semver guess exists. */
      requireEvidence: z.boolean().default(true),
      /** Lowest per-change confidence eligible for automatic dispatch. */
      minConfidence: z.enum(['low', 'medium', 'high']).default('medium'),
      /** Instruct the agent to leave tests semantically unchanged. */
      forbidTestWeakening: z.boolean().default(true),
    })
    .default({}),

  /** How the fix is produced. */
  remediation: z
    .object({
      /** One commit per breaking change vs. one per dependency. */
      commitGranularity: z
        .enum(['per-breaking-change', 'per-dependency', 'single'])
        .default('per-breaking-change'),
      branchPrefix: z.string().default('drift/'),
      /** Open the PR as a draft for a human to promote. */
      draftPr: z.boolean().default(true),
      /** Model hint passed to the Copilot Agent Tasks API. */
      model: z.string().optional(),
      /** Extra repo-specific guidance appended to every agent task. */
      customInstructions: z.string().default(''),
    })
    .default({}),

  /**
   * How the pull request gets opened.
   *
   * The default finishes the job: once there is a branch with a reviewed
   * commit on it, leaving the developer to open the pull request by hand is
   * asking them to do the one step the tool was supposed to automate. What
   * stays manual is the *merge* — Drift's output is always something a human
   * opens, never something that has already landed.
   */
  pullRequest: z
    .object({
      /** Open a pull request once the branch is pushed. */
      enabled: z.boolean().default(true),

      /**
       * Whether to confirm the branch name and title first.
       *
       * `ask` in interactive surfaces (the CLI and the panel), because a
       * proposed name a developer can edit is better than a good one they
       * cannot. The GitHub Action ignores this and always proceeds: there is
       * nobody there to ask, and a workflow that stops to prompt is a workflow
       * that hangs.
       */
      confirm: z.enum(['ask', 'never']).default('ask'),

      /**
       * Which branch to merge into.
       *
       * `branched-from` targets whatever the work was started from, which is
       * the right answer on any team that does not develop directly on its
       * default branch. See `resolveBaseBranch` for why the difference matters.
       */
      base: z.enum(['branched-from', 'default-branch']).default('branched-from'),

      /** Open as a draft for a human to promote. */
      draft: z.boolean().default(false),

      /** Labels applied to the pull request, when the token can set them. */
      labels: z.array(z.string()).default([]),

      /** GitHub usernames or team slugs to request review from. */
      reviewers: z.array(z.string()).default([]),

      /**
       * Branch and title templates.
       *
       * Placeholders: `{prefix}`, `{summary}`, `{name}`, `{from}`, `{to}`,
       * `{count}`, `{date}`. An unrecognised placeholder is left verbatim, so a
       * typo produces an obviously wrong name rather than a plausible one that
       * silently collides with the next run.
       */
      branchTemplate: z.string().default('{prefix}upgrade-{summary}-{date}'),
      titleTemplate: z.string().default('chore(deps): upgrade {summary}'),

      /**
       * Credit Drift as a co-author on the commits it makes.
       *
       * The human stays the author — they chose the upgrade and reviewed the
       * diff. Off is offered because some repositories lint commit trailers.
       */
      coAuthor: z.boolean().default(true),
    })
    .default({}),

  /** Optional LLM-assisted evidence interpretation. */
  llm: z
    .object({
      /**
       * Off by default: the rule-based analyser is deterministic and needs no
       * API key. Enabling this improves recall on prose changelogs.
       */
      enabled: z.boolean().default(false),
      provider: z.enum(['anthropic']).default('anthropic'),
      model: z.string().default('claude-opus-5'),
      /** Thinking depth / token spend for the extraction call. */
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
      /** Env var holding the API key. Never the key itself. */
      apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
    })
    .default({}),
});

export type DriftConfig = z.infer<typeof DriftConfigSchema>;
export type LicensePolicy = DriftConfig['licenses'];

export const DEFAULT_CONFIG: DriftConfig = DriftConfigSchema.parse({});

const RISK_ORDER: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** True when `risk` is at or below the configured automatic ceiling. */
export function riskWithinLimit(risk: RiskLevel, limit: RiskLevel): boolean {
  return RISK_ORDER[risk] <= RISK_ORDER[limit];
}

export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}
