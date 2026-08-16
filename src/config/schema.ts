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
  'conan',
  'vcpkg',
  'arduino',
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
      /** Dev and optional dependencies still run in CI and in the hands of some
       * consumers, so they are analysed by default alongside runtime ones. */
      dev: z.boolean().default(true),
    })
    .prefault({}),

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
      /**
       * Contract documents this repository consumes, diffed between commits.
       *
       * Each format is a provider (`evidence/spec/`) that declares its own
       * weight, taxonomy and remediation text; these are the two keys it reads.
       * The enable flags default to `true` and the path lists to empty, so a
       * format costs nothing until a document is named — and naming one is the
       * whole opt-in.
       */
      /** Diff OpenAPI/Swagger specs listed in `openapiSpecs`. */
      openapi: z.boolean().default(true),
      /** Repo-relative paths of the OpenAPI specs this repo consumes. */
      openapiSpecs: z.array(z.string()).default([]),
      /** Diff protobuf definitions listed in `protobufSpecs`, via `buf breaking`. */
      protobuf: z.boolean().default(true),
      /** Repo-relative paths of the `.proto` files this repo consumes. */
      protobufSpecs: z.array(z.string()).default([]),
      /** Diff GraphQL SDL listed in `graphqlSchemas`, via graphql-inspector. */
      graphql: z.boolean().default(true),
      /** Repo-relative paths of the GraphQL schema documents this repo consumes. */
      graphqlSchemas: z.array(z.string()).default([]),
      /** Cap on release notes fetched per dependency. */
      maxReleases: z.number().int().min(1).max(100).default(25),
    })
    .prefault({}),

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
    .prefault({}),

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
    .prefault({}),

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
      /**
       * Lowest per-change confidence eligible for automatic dispatch.
       *
       * This is a **blocker**, not a warning. A finding below the threshold
       * that Drift planned a commit for falls back to approval, and the plan is
       * still filed in full so a human can read it and proceed with one comment.
       *
       * It used to be warning-only, which made the setting a lie: a repository
       * configured for `high` would still dispatch an agent against a
       * low-confidence guess, having noted its own doubt in a paragraph nobody
       * had to read. A finding with no planned commit is unaffected — nothing
       * is about to be edited on its account.
       */
      minConfidence: z.enum(['low', 'medium', 'high']).default('medium'),

      /**
       * Dispatch automatically even when findings are below `minConfidence`.
       *
       * Named for what it is. This exists for teams deliberately exploring what
       * an agent does with weak evidence on a throwaway branch, and it is the
       * only way to get the pre-fix behaviour back. Leaving it off is correct
       * for every repository whose branches matter.
       */
      experimentalDispatchBelowMinConfidence: z.boolean().default(false),
      /** Instruct the agent to leave tests semantically unchanged. */
      forbidTestWeakening: z.boolean().default(true),
    })
    .prefault({}),

  /** How the fix is produced. */
  remediation: z
    .object({
      /** One commit per breaking change vs. one per dependency. */
      commitGranularity: z
        .enum(['per-breaking-change', 'per-dependency', 'single'])
        .default('per-breaking-change'),
      branchPrefix: z.string().default('drift/'),
      /**
       * @deprecated Use `pullRequest.draft`. Kept only so an existing config
       * keeps working; see `opensPullRequestAsDraft`.
       *
       * Optional, with no default, on purpose. It used to default to `true`
       * while `pullRequest.draft` defaulted to `false`, and both were read —
       * so setting the documented, current field to `false` changed nothing,
       * because the legacy field it was OR'd with was still `true`. A setting
       * that cannot be turned off from the page documenting it is worse than
       * one that does not exist.
       */
      draftPr: z.boolean().optional(),
      /** Model hint passed to the Copilot Agent Tasks API. */
      model: z.string().optional(),
      /** Extra repo-specific guidance appended to every agent task. */
      customInstructions: z.string().default(''),
      /**
       * Wait, within the same run, for the dispatched Copilot task to reach a
       * terminal state before finishing.
       *
       * Only meaningful for the Action: a one-shot process has no other
       * chance to learn whether the task it just submitted actually
       * succeeded, so without this the check run posted at dispatch time
       * ("Copilot is fixing…") is also the last thing anyone ever sees, even
       * if the agent later fails or times out. The self-hosted webhook
       * runner does not consult this — it reconciles pending tasks on its
       * own background schedule instead, without blocking the delivery that
       * dispatched them.
       *
       * Off by default because it changes what has always been a
       * fire-and-forget dispatch into a job that runs for as long as the
       * agent takes, which costs Action minutes and is a behaviour change a
       * team should opt into, not one that arrives silently.
       */
      awaitCompletion: z
        .object({
          enabled: z.boolean().default(false),
          timeoutMinutes: z.number().int().min(1).max(360).default(20),
          pollIntervalSeconds: z.number().int().min(5).max(300).default(30),
        })
        .prefault({}),
      /**
       * Allow Drift to query Codemod.com's registry and Maven Central (for
       * OpenRewrite — see `src/remediation/live-search.ts`) live, for a
       * matching recipe, when its own built-in codemod engine cannot
       * resolve the commit — and to use one ahead of an AI agent.
       *
       * Off by default, and this is what gates the network query itself, on
       * every surface, not only whether a found recipe may run: with this
       * `false`, Drift never contacts either registry. A community recipe
       * is third-party code executed as part of an automated commit
       * pipeline; unlike Drift's own codemods, it was not proven correct by
       * construction, so discovering and running one — even pinned to an
       * exact version — is an explicit opt-in, not a default. On the CLI
       * and in the extension this only changes what is *offered*: a recipe
       * is never applied without an explicit choice in that run, regardless
       * of this setting. On the Action, which cannot prompt, this is what
       * actually gates whether a found recipe is used.
       */
      communityRecipes: z.boolean().default(false),
    })
    .prefault({}),

  /** Experimental verification that compares old and new dependency behaviour. */
  verification: z
    .object({
      behavioural: z
        .object({
          enabled: z.boolean().default(false),
          sandbox: z.literal('required').default('required'),
          maxSymbols: z.number().int().min(1).max(100).default(10),
          maxCasesPerSymbol: z.number().int().min(1).max(100).default(20),
          timeoutSeconds: z.number().int().min(1).max(1800).default(120),
          network: z.boolean().default(false),
          memoryMb: z.number().int().min(128).max(16384).default(1024),
          cpuLimit: z.number().min(0.1).max(32).default(1),
          retainArtifacts: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * Privacy-preserving product telemetry.
   *
   * Disabled unless a collector endpoint is explicitly configured. There is no
   * hosted Drift telemetry backend in this repository. Event construction is
   * allow-listed and rejects source code, raw paths, repository names, prompts,
   * model responses, command output, and likely secrets before anything can be
   * sent.
   */
  telemetry: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.string().url().optional(),
      installationId: z.string().optional(),
      rotationSalt: z.string().optional(),
      retentionDays: z.number().int().min(1).max(730).default(180),
    })
    .prefault({}),

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

      /**
       * Open as a draft for a human to promote.
       *
       * The single source of truth. `remediation.draftPr` is the deprecated
       * spelling and is consulted only when this is not set — see
       * `opensPullRequestAsDraft`.
       *
       * Optional rather than defaulted so "the user chose false" is
       * distinguishable from "the user said nothing", which is the whole
       * difference between honouring a legacy setting and ignoring an explicit
       * one. The effective default is `true`, which is what Drift has always
       * actually done.
       */
      draft: z.boolean().optional(),

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
    .prefault({}),

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
    .prefault({}),

  /**
   * GitHub code scanning alerts, one per affected package.
   *
   * Every run that produces a plan — whether or not anything is breaking —
   * can also render its findings as SARIF and upload them to the repository's
   * code scanning dashboard, so the same evidence, location, and fix Drift
   * puts in a pull request also shows up as an alert, the way CodeQL's and
   * Scorecard's own findings do. Requires the workflow to grant
   * `security-events: write`; Drift logs and continues, rather than failing
   * the run, when that permission is missing.
   */
  codeScanning: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Alert even on findings with no local impact and no security signal —
       * a plain "update available" with nothing broken and nothing insecure.
       * Off (the default) keeps the Security tab to things a developer can
       * actually act on: a breaking change that reaches code here, or a
       * vulnerability. On adds one low-severity alert per otherwise-quiet
       * outdated dependency, which is real signal for a team that wants full
       * dependency visibility in Code Scanning rather than just the job
       * summary — but is noise for most.
       */
      includeInformational: z.boolean().default(false),

      /**
       * How findings are grouped into alerts.
       *
       * `'package'` (the default) folds every breaking change and security
       * signal for one dependency into a single alert, matching the "one
       * alert per package" design this module was built around — it keeps
       * the Security tab from growing one row per breaking change. Because
       * one alert can bundle many call sites, no single one of them is
       * representative, so the alert carries no code snippet — just the
       * text and a link list of every location.
       *
       * `'breakingChange'` opens one alert per breaking change instead,
       * covering every call site it reaches. The alert is scoped to a
       * single issue now, so its primary location's snippet is shown as a
       * representative example of that one breaking change, even though it
       * may have reached more than one site.
       *
       * `'affectedSite'` goes one step further: one alert per individual
       * call site. There is exactly one location per alert in this mode,
       * so its snippet is never a stand-in for anything else — it's a
       * direct view of the one line the alert is about. This is the
       * noisiest mode by far — a single breaking change reaching fifty call
       * sites in a large repository becomes fifty alerts — hence not the
       * default.
       */
      granularity: z.enum(['package', 'breakingChange', 'affectedSite']).default('package'),

      /**
       * Also open a GitHub issue for every alert, in addition to the code
       * scanning upload.
       *
       * Off by default: code scanning already puts every alert on the
       * Security tab, and most teams don't want the same information
       * duplicated as issues. Teams that don't watch that tab, or that want
       * alerts triaged and assigned the way any other issue is, can turn
       * this on. Each issue embeds the alert's `ruleId` as a hidden marker
       * and re-running looks that marker up before filing, so a rescan
       * finds the existing issue rather than piling up duplicates — the
       * same statelessness the approval-issue flow already relies on.
       */
      createIssuesPerAlert: z.boolean().default(false),
    })
    .prefault({}),

  /**
   * The one-click "file this" action offered wherever Drift shows a
   * breaking change — the CLI's interactive `analyze`/`outdated` prompts
   * and the VS Code extension's report view. Both surfaces call the same
   * shared helper (`src/actions/issue-branch.ts`) and read this block for
   * their default, so the behaviour stays identical whichever one you use.
   *
   * Every action here fails soft: no git repo, no `gh`/GitHub token, or a
   * request that errors out is logged and surfaced as a dismissable
   * warning, never a thrown error or a crashed session.
   */
  issueCreation: z
    .object({
      /**
       * What the primary action does. `'issue'` (the default) files a
       * GitHub issue with the finding's evidence and a rescan-safe hidden
       * marker, mirroring `codeScanning.createIssuesPerAlert`'s dedup
       * behaviour so re-triggering it updates rather than duplicates.
       * `'branch'` creates (or checks out, if it already exists) a local
       * branch named for the finding, with no issue filed. `'both'` does
       * both and links them: the branch name is included in the issue body.
       */
      default: z.enum(['issue', 'branch', 'both']).default('issue'),

      /**
       * `'package'` (the default) bundles every breaking change for one
       * dependency into a single issue/branch — the same "one row per
       * package" shape `codeScanning.granularity`'s `'package'` mode uses,
       * and the option offered at each package's group header.
       *
       * `'change'` scopes the action to one breaking change at a time,
       * offered on each individual finding — useful when different call
       * sites of the same upgrade need to be triaged or landed separately.
       */
      granularity: z.enum(['package', 'change']).default('package'),

      /**
       * GitHub usernames to assign the issue to, when the action's `default`
       * above (or `codeScanning.createIssuesPerAlert`) files one. Empty by
       * default — no one is assigned unless a team opts in.
       */
      assignees: z.array(z.string()).default([]),
    })
    .prefault({}),

  /**
   * Proactive scanning of every direct dependency's *installed* version
   * against its registry — not "what changed in this push", which is the
   * rest of this config, but "what's available and un-taken right now".
   *
   * Off by default: unlike the push-triggered pipeline, this has no natural
   * trigger of its own and needs a `schedule` added to the workflow — see
   * `examples/workflows/drift-outdated.yml`. Once on, each outdated
   * dependency is scanned the same way `drift outdated` scans it, and every
   * dependency scanned — upgraded or not, breaking or not — gets a code
   * scanning alert (and, if `codeScanning.createIssuesPerAlert` is on, an
   * issue) carrying the exact command to apply it. This mode never commits,
   * dispatches a branch, or opens a PR itself, even for an upgrade it can
   * prove safe: Drift only ever edits code in response to a version change
   * that has actually landed somewhere, and nothing has landed yet for a
   * dependency this scan merely noticed is available. Once the reported
   * command is run and the resulting commit is pushed, the ordinary
   * push-triggered pipeline takes over exactly as it would for any other
   * dependency bump — see `runOutdatedScan` in `runners/action.ts`.
   */
  outdated: z
    .object({
      enabled: z.boolean().default(false),
    })
    .prefault({}),

  /**
   * Drift-owned helper analyzers (`cargo-public-api`, `japicmp`) that a
   * computed surface diff needs but does not ship.
   *
   * On by default: these are Drift's own known-safe commands (a `cargo
   * install`/`brew install` of a named helper, never arbitrary code), and
   * without them a whole ecosystem's evidence silently degrades to prose. A
   * missing helper is installed inline the first time a scan needs it,
   * instead of surfacing a gap that only a second, manual pass can close.
   * Set to `false` for an environment where installing global toolchain
   * binaries as a side effect of a scan is unwanted.
   */
  tools: z
    .object({
      autoInstall: z.boolean().default(true),
    })
    .prefault({}),

  /**
   * Test each upgrade before reporting it.
   *
   * Drift predicts breakage by diffing published type surfaces, which is cheap
   * and imperfect: it sees a parameter move and reports every call site, when
   * the new signature still accepts most of them. With this on, every candidate
   * is installed in a throwaway git worktree — never the developer's checkout —
   * and the project's own checks are run against it, before the candidate is
   * reported at all. Predictions the compiler contradicts are dropped rather
   * than shown and later withdrawn, and breakage no prediction saw is caught.
   *
   * It costs an install and a check run per candidate, which is the trade being
   * made deliberately: a scan takes longer, and what it says is true.
   */
  verify: z
    .object({
      enabled: z.boolean().default(true),

      /**
       * Which of the project's checks to run.
       *
       * All three by default, and the tests are the reason this is worth the
       * time. A compiler settles signatures and nothing else: a default that
       * moved, a method that now throws where it used to return null, a parser
       * that got stricter about the same input — every one of those typechecks
       * clean and breaks in production. The test suite is the only thing in a
       * repository that has an opinion about them.
       *
       * A suite that is already failing before the upgrade is applied is
       * excluded from the verdict rather than blamed on it (see the baseline
       * pass in `verification/upgrade-probe.ts`), so a red or flaky project
       * degrades to typecheck-and-build instead of reporting nonsense. Drop
       * `'test'` here for a suite too slow to sit through.
       */
      checks: z.array(z.enum(['typecheck', 'build', 'test'])).default(['typecheck', 'build', 'test']),

      /** Per-command ceiling, covering both the install and each check. */
      timeoutMs: z.number().int().positive().default(15 * 60_000),

      /**
       * Gitignored paths (glob patterns, repo-relative) to carry into a
       * verification worktree even though they are not tracked by git —
       * hand-generated source a build reads as an input but that was never
       * committed. `**` matches across directories, `*` and `?` do not.
       *
       * Empty by default. Drift used to copy every gitignored file outside a
       * denylist of regenerable directories (`node_modules`, `dist`, …) —
       * which also copied `.env`, private keys, and credentials files
       * straight into a directory about to run an upgrade candidate's own
       * install/build/test scripts. Sensitive filenames are now excluded
       * unconditionally regardless of this setting (see
       * `SENSITIVE_PATTERNS` in `src/repo/worktree.ts`), but the safer
       * default is to copy nothing unless a project says what it actually
       * needs — explicit and auditable, rather than "everything that isn't
       * obviously a secret".
       */
      generatedSourceGlobs: z.array(z.string()).default([]),
    })
    .prefault({}),
});

export type DriftConfig = z.infer<typeof DriftConfigSchema>;
export type LicensePolicy = DriftConfig['licenses'];

export const DEFAULT_CONFIG: DriftConfig = DriftConfigSchema.parse({});

/**
 * Whether a pull request opens as a draft.
 *
 * One function, called everywhere, because there are two spellings of this
 * setting and they used to be combined with `||` at each call site — which
 * made the newer one unusable. `pullRequest.draft: false` next to the legacy
 * `remediation.draftPr: true` (its old default, and the value in the shipped
 * example) produced a draft, so the field a user had just read the docs for
 * appeared to do nothing.
 *
 * Precedence is explicit instead: the current field wins outright when set,
 * the deprecated one is honoured only in its absence, and `true` is the
 * fallback because that is what Drift has always actually done.
 */
export function opensPullRequestAsDraft(config: DriftConfig): boolean {
  return config.pullRequest.draft ?? config.remediation.draftPr ?? true;
}

/** True when a config still uses the deprecated spelling, so callers can warn once. */
export function usesDeprecatedDraftSetting(config: DriftConfig): boolean {
  return config.remediation.draftPr !== undefined;
}

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
