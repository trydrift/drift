#!/usr/bin/env node
/**
 * Record a real Drift run, so the site can replay one.
 *
 * The demo on the landing page is not a mock-up and is not a script someone
 * wrote to look plausible. It is this: an actual analysis of an actual open
 * source repository, captured here — every dependency, every version, every
 * finding, and every progress event with the timestamp it really happened at.
 * The browser replays that recording at its original cadence.
 *
 * The timestamps are the point. A fabricated animation paces itself the way a
 * designer imagines work feels: evenly. Real work does not. One package resolves
 * instantly from a warm registry response and the next stalls four seconds
 * behind a changelog fetch, and that unevenness is the difference between
 * watching a tool work and watching a loading bar. So we keep it.
 *
 * Nothing here can run in a browser — Drift shells out to package managers,
 * clones repositories, and calls registries — which is exactly why it runs
 * once, here, and ships its own output.
 *
 * # Why this is not simply a loop
 *
 * A capture is overwhelmingly spent waiting, and on two entirely different
 * things. Cloning Kubernetes is minutes of pure download. Scanning it is
 * hundreds of registry round trips with real parsing behind them. Doing those
 * one target at a time left a laptop idle for most of an hour.
 *
 * So there are two pools, sized differently, and the important part is that
 * they overlap: clones run ahead of the scans, filling a small buffer of ready
 * checkouts, so a scan never waits for a download that could have happened
 * while the previous scan was running. Clones are also cached between runs — a
 * re-capture after a fix reuses the checkout and pays a `git fetch` instead of
 * a fresh clone of a repository with two million commits.
 *
 * # Fidelity, and where the line is
 *
 * The recordings are the product, so it matters exactly which parallelism is
 * safe:
 *
 * - **Cloning in parallel is free.** The recording's clock starts when the scan
 *   starts, not when the target does, so nothing about fetching a repository
 *   appears in it. (It used to: the clock started before the clone, which put
 *   several minutes of Kubernetes download into the offset of its first event.)
 * - **Scanning several targets at once is not free**, and the cost is spelled
 *   out honestly. The `at` timestamps stay meaningful — each target measures
 *   from its own start, and the stalls being recorded are network waits that
 *   overlap rather than queue — but a machine running four scans at once has
 *   less CPU for each, so the fastest events stretch slightly. Four is the
 *   default because that stretch is still inside the noise between two runs of
 *   the same target. `--jobs=1` reproduces a strictly serial cadence.
 * - **The scan's own concurrency is pinned**, deliberately, at
 *   {@link SCAN_CONCURRENCY} rather than sized from the machine the way a real
 *   run sizes it. A recording is a published artifact; it should not have a
 *   different cadence because it was captured on a bigger laptop.
 *
 * # Not re-recording what has not changed
 *
 * Each recording carries the commit it was taken at and a fingerprint of the
 * engine that took it. `--if-stale` re-captures only the targets where one of
 * those has moved, which turns a scheduled freshness check from an hour of work
 * into a handful of `git ls-remote` calls on the common day where nothing has.
 *
 * Usage:
 *   node site/scripts/capture.mjs               # every target
 *   node site/scripts/capture.mjs deno          # one, by id
 *   node site/scripts/capture.mjs --jobs=8      # more scans at once
 *   node site/scripts/capture.mjs --if-stale    # only what has moved
 *   node site/scripts/capture.mjs --check       # report staleness, record nothing
 *   node site/scripts/capture.mjs --no-cache    # ignore the clone cache
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFingerprint } from './engine-fingerprint.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'src', 'data');

const { scanUpgrades } = await import(join(repoRoot, 'dist/upgrade/scan.js'));
const { DriftConfigSchema } = await import(join(repoRoot, 'dist/config/schema.js'));
const { createLogger } = await import(join(repoRoot, 'dist/util/logger.js'));
const { configureHttpDiskCache } = await import(join(repoRoot, 'dist/util/http.js'));
const { deriveOverallConfidence } = await import(join(repoRoot, 'dist/confidence/calibrate.js'));
const { severityOf } = await import(join(repoRoot, 'dist/upgrade/severity.js'));
const RECORDING_SCHEMA_VERSION = 2;
import { isSchemaStale, validateRecording } from './recording-validation.mjs';

/**
 * A disk cache, and a GitHub token.
 *
 * Both exist for the same reason: a whole-repository sweep of GitLab asks the
 * GitHub API about several hundred gems, and an unauthenticated run is rate
 * limited at sixty requests an hour. It does not fail — it degrades, quietly,
 * into a recording full of "could not check" that would be a fair record of a
 * throttled laptop and a libel against the tool. The cache means a re-run after
 * a fix costs nothing, and the token means the first run is not throttled.
 *
 * Neither is committed: the cache lives in the OS temp directory, and the token
 * comes from the environment or `gh`.
 */
configureHttpDiskCache(join(tmpdir(), 'drift-capture-cache'));

const githubToken =
  process.env.GITHUB_TOKEN ||
  (() => {
    try {
      return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();

if (!githubToken) {
  process.stderr.write(
    'warning: no GITHUB_TOKEN and no `gh` login. Release notes will be rate limited, ' +
      'and the recording will understate what Drift can see.\n',
  );
}

/**
 * What to record.
 *
 * Each is a real, well-known project in its ecosystem, chosen so a visitor
 * recognises it and can go and check the claim. `dir` is kept only as display
 * metadata for repositories whose best-known package lives below the checkout
 * root; the scan itself always starts at the repository root, matching the
 * extension's open-folder behaviour.
 *
 * Every recording is a **whole-repository** run at the CLI's own defaults —
 * every direct runtime dependency of every manifest, up to forty impact sites
 * per finding. There is no sampling and no budget. That is the point: someone
 * who clones the linked commit and runs `drift outdated` should get what they
 * see here, and a recording that quietly analysed fourteen of a project's two
 * hundred packages would make the page a demo of a different tool.
 *
 * The cost is that a large repository takes minutes to capture and the
 * recording is measured in megabytes. Both are paid once, here, rather than by
 * every visitor's trust.
 */

/** The CLI's own defaults, so a local run and a recording agree. */
const FULL_REPO = { maxPackages: 0, maxSites: 40 };
const TARGETS = [
  {
    id: 'supabase',
    label: 'supabase-js',
    ecosystem: 'npm',
    language: 'TypeScript',
    repo: 'https://github.com/supabase/supabase-js',
    blurb: 'The official Supabase client for JavaScript and TypeScript.',
    dir: '',
  },
  {
    // sentry-python was the first choice and is not usable: its runtime
    // dependencies still live in `setup.py`, while its `pyproject.toml`
    // declares only PEP 735 dev groups. Drift read the manifest correctly and
    // found zero *runtime* direct dependencies, which is the right answer and
    // a boring recording. Scrapy declares its real dependencies where the
    // ecosystem's tooling expects them, and they are the kind — Twisted,
    // cryptography, lxml — where breaking changes genuinely happen.
    id: 'scrapy',
    label: 'scrapy',
    ecosystem: 'pypi',
    language: 'Python',
    repo: 'https://github.com/scrapy/scrapy',
    blurb: 'The web crawling framework that most Python scrapers are built on.',
    dir: '',
  },
  {
    id: 'gitlab',
    label: 'gitlab',
    ecosystem: 'rubygems',
    language: 'Ruby',
    repo: 'https://github.com/gitlabhq/gitlabhq',
    blurb: "GitLab's Rails monolith — one of the largest Ruby codebases in the open.",
    dir: '',
  },
  {
    id: 'kubernetes',
    label: 'kubernetes',
    ecosystem: 'go',
    language: 'Go',
    repo: 'https://github.com/kubernetes/kubernetes',
    blurb: 'The container orchestrator. One of the largest Go codebases in the open.',
    dir: '',
  },
  {
    id: 'deno',
    label: 'deno',
    ecosystem: 'cargo',
    language: 'Rust',
    repo: 'https://github.com/denoland/deno',
    blurb: 'A modern runtime for JavaScript and TypeScript, written in Rust.',
    dir: '',
  },
  {
    id: 'elasticsearch',
    label: 'elasticsearch-java',
    ecosystem: 'maven',
    language: 'Java',
    repo: 'https://github.com/elastic/elasticsearch-java',
    blurb: "Elasticsearch's official Java API client.",
    dir: '',
  },
  {
    // The C++ entry, and the one that makes the clearest case for the header
    // surface diff: in C and C++ the published header *is* the API, so what
    // Drift compares is what the compiler would have compared.
    //
    // ESPHome rather than a single Arduino library, because `library.properties`
    // declares dependencies without versions — a real fact about that format,
    // and one that leaves nothing to be outdated. A PlatformIO project pins
    // exact versions, which is what an upgrade scan is about.
    id: 'esphome',
    label: 'esphome',
    ecosystem: 'arduino',
    language: 'C++',
    repo: 'https://github.com/esphome/esphome',
    blurb: 'The firmware behind most ESP32 and ESP8266 home-automation devices.',
    dir: '',
  },
  // Everything below completes the set. The page used to show seven
  // ecosystems out of sixteen, which reads as a list of the ones that work —
  // and the nine it left out include the three that changed most: PHP, Elixir,
  // and Swift could not be localized at all until the module map landed.
  //
  // Some of these recordings are thinner than the seven above, and that is the
  // honest part of showing them. A CocoaPods run has no advisory feed and no
  // verification command; an opam run has no registry metadata API. The page
  // says so with the same tier badge the capability matrix computes, rather
  // than quietly omitting the ecosystem and letting a visitor assume.
  {
    id: 'restsharp',
    label: 'RestSharp',
    ecosystem: 'nuget',
    language: 'C#',
    repo: 'https://github.com/restsharp/RestSharp',
    blurb: 'The HTTP client most .NET codebases reach for first.',
    dir: '',
  },
  {
    id: 'guzzle',
    label: 'guzzle',
    ecosystem: 'packagist',
    language: 'PHP',
    repo: 'https://github.com/guzzle/guzzle',
    blurb: "PHP's HTTP client, and a dependency of a large share of the ecosystem.",
    dir: '',
  },
  {
    id: 'phoenix',
    label: 'phoenix',
    ecosystem: 'hex',
    language: 'Elixir',
    repo: 'https://github.com/phoenixframework/phoenix',
    blurb: 'The web framework nearly every production Elixir application is built on.',
    dir: '',
  },
  {
    id: 'dio',
    label: 'dio',
    ecosystem: 'pub',
    language: 'Dart',
    repo: 'https://github.com/cfug/dio',
    blurb: "Dart's most-used HTTP client, in the package that declares its dependencies.",
    dir: 'dio',
  },
  {
    // Vapor was the first choice and produced an honest, boring recording:
    // twenty-two dependencies, every one already current. The Composable
    // Architecture pins more of its graph and moves more slowly, which is what
    // an upgrade scan is about.
    id: 'tca',
    label: 'swift-composable-architecture',
    ecosystem: 'swift',
    language: 'Swift',
    repo: 'https://github.com/pointfreeco/swift-composable-architecture',
    blurb: 'The state-management library much of the Swift app ecosystem builds on.',
    dir: '',
  },
  {
    id: 'flexlayout',
    label: 'FlexLayout',
    ecosystem: 'cocoapods',
    language: 'Swift',
    repo: 'https://github.com/layoutBox/FlexLayout',
    blurb: 'A Swift flexbox layout library, with the Podfile that pins its pods.',
    dir: '',
  },
  {
    id: 'cohttp',
    label: 'ocaml-cohttp',
    ecosystem: 'opam',
    language: 'OCaml',
    repo: 'https://github.com/mirage/ocaml-cohttp',
    blurb: "OCaml's HTTP library, from the MirageOS project.",
    dir: '',
  },
  {
    id: 'trantor',
    label: 'trantor',
    ecosystem: 'conan',
    language: 'C++',
    repo: 'https://github.com/an-tao/trantor',
    blurb: 'The C++ network library underneath Drogon, with a conanfile.txt.',
    dir: '',
  },
  {
    id: 'obs-backgroundremoval',
    label: 'obs-backgroundremoval',
    ecosystem: 'vcpkg',
    language: 'C++',
    repo: 'https://github.com/royshil/obs-backgroundremoval',
    blurb: 'An OBS plugin that pins its native dependencies through vcpkg.',
    dir: '',
  },
];

const config = DriftConfigSchema.parse({});
const logger = createLogger('error');

/**
 * How many packages one scan checks at once.
 *
 * Pinned rather than sized from the machine, which is the opposite of what a
 * real `drift outdated` run does and is right here for one reason: a recording
 * is a published artifact. Reading it off `availableParallelism()` would give
 * the page a different cadence depending on whose laptop last ran the capture,
 * and the cadence is the thing being recorded.
 */
const SCAN_CONCURRENCY = 8;

/**
 * Where checkouts are kept between runs.
 *
 * Cloning Kubernetes is minutes of download and it is the same download every
 * time. A cached checkout is updated with a shallow `fetch` instead — seconds
 * — and a cache that has gone wrong in any way at all is thrown away and
 * re-cloned rather than reasoned about.
 */
const cloneCacheDir = join(tmpdir(), 'drift-capture-clones');

/** The commit a repository's default branch is on right now, without cloning it. */
async function remoteHead(repo) {
  try {
    const { stdout } = await run('git', ['ls-remote', repo, 'HEAD'], { maxBuffer: 1024 * 1024 });
    return stdout.split(/\s/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A checkout of `target`, cloned or refreshed.
 *
 * Deliberately outside the recording: the clock the browser replays against
 * starts when the scan starts, so however long this takes and however many of
 * these run at once, nothing here reaches the page.
 */
async function checkoutOf(target, { useCache }) {
  const [owner, name] = new URL(target.repo).pathname.slice(1).split('/');
  const shallow = ['--depth', '1', '--filter=blob:none', '--single-branch',
    // Nothing here reads a tag, and Kubernetes has thousands of them.
    '--no-tags'];

  if (!useCache) {
    const workdir = await mkdtemp(join(tmpdir(), `drift-capture-${target.id}-`));
    const checkout = join(workdir, 'repo');
    process.stderr.write(`[${target.id}] cloning ${target.repo}\n`);
    await run('git', ['clone', ...shallow, target.repo, checkout], { maxBuffer: 64 * 1024 * 1024 });
    return { checkout, workdir, owner, name };
  }

  const checkout = join(cloneCacheDir, target.id);
  const refresh = async () => {
    process.stderr.write(`[${target.id}] refreshing cached checkout\n`);
    await run('git', ['fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD'], {
      cwd: checkout,
      maxBuffer: 64 * 1024 * 1024,
    });
    await run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: checkout });
    // A stale working tree from a previous scan — an installed `node_modules`,
    // a manifest an upgrade probe rewrote — would be read as part of the
    // project. The recording has to be of the repository, not of what the last
    // capture left in it.
    await run('git', ['clean', '-xdff'], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
  };

  try {
    if (existsSync(join(checkout, '.git'))) await refresh();
    else {
      await mkdir(cloneCacheDir, { recursive: true });
      process.stderr.write(`[${target.id}] cloning ${target.repo}\n`);
      await run('git', ['clone', ...shallow, target.repo, checkout], { maxBuffer: 64 * 1024 * 1024 });
    }
  } catch (err) {
    // Any cache that cannot be brought up to date is not worth understanding.
    process.stderr.write(`[${target.id}] cache unusable (${err.message.split('\n')[0]}); re-cloning\n`);
    await rm(checkout, { recursive: true, force: true });
    await mkdir(cloneCacheDir, { recursive: true });
    await run('git', ['clone', ...shallow, target.repo, checkout], { maxBuffer: 64 * 1024 * 1024 });
  }

  // `workdir` is null: a cached checkout outlives the capture on purpose.
  return { checkout, workdir: null, owner, name };
}

async function capture(target, prepared, fingerprint) {
  const { checkout, workdir, owner, name } = prepared;
  const root = checkout;
  // Started here, after the checkout exists, rather than at the top of the
  // target. The clone is not part of what is being recorded, and when the clock
  // started before it, Kubernetes' first event carried several minutes of
  // download in its offset and the page opened on a stall that never happened.
  const started = Date.now();

  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: checkout })).stdout.trim();

  const repo = {
    owner,
    repo: name,
    baseBranch: branch,
    beforeSha: head,
    afterSha: head,
    workspace: root,
  };

  // The recording. `at` is milliseconds since the run began — the browser
  // replays against these, so the cadence on the page is the cadence that
  // actually happened.
  const timeline = [];
  // Progress details name whatever path the run was given, which here is a
  // scratch directory on a laptop. Rewritten to the repository's own name so
  // the recording reads as what it is — an analysis of that project — rather
  // than leaking the machine that produced it.
  const scrub = (text) =>
    String(text ?? '')
      .split(checkout)
      .join(`${owner}/${name}`)
      .split(workdir)
      .join(`${owner}/${name}`);
  const timestamp = () => Date.now() - started;
  const markProgress = (phase, detail, done, total) => timeline.push({ type: 'progress', at: timestamp(), phase: scrub(phase), detail: scrub(detail), done, total });
  const markCandidate = (candidate) => timeline.push({ type: 'candidate-upsert', at: timestamp(), candidate: slimCandidate(candidate) });
  const markDropped = (id) => timeline.push({ type: 'candidate-drop', at: timestamp(), id });

  process.stderr.write(`[${target.id}] scanning for upgrades\n`);
  let scan;
  try {
    scan = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      githubToken: githubToken || undefined,
      breadth: { includeDev: false, maxSites: FULL_REPO.maxSites, maxPackages: FULL_REPO.maxPackages },
      concurrency: SCAN_CONCURRENCY,
      onProgress: ({ phase, detail, done, total }) => markProgress(phase, detail, done, total),
      onCandidate: (candidate) => markCandidate(candidate),
      onDropped: (id) => markDropped(id),
    });
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  }

  const finalCandidates = scan.candidates.map(slimCandidate).sort(byAttention);

  const recording = {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    id: target.id,
    label: target.label,
    ecosystem: target.ecosystem,
    language: target.language,
    repo: target.repo,
    blurb: target.blurb,
    capturedAt: new Date().toISOString(),
    commit: head,
    // What produced this recording. The commit says the *repository* has not
    // moved; this says Drift has not, which is the staleness nobody can see by
    // reading the page. See `engine-fingerprint.mjs`.
    engine: fingerprint,
    durationMs: Date.now() - started,
    packagesChecked: scan.checked,
    manifests: scan.targets.map((t) => t.manifestPath),
    nestedGitRepos: scan.nestedGitRepos.map((project) => project.dir),
    timeline,
    candidates: finalCandidates,
  };
  validateRecording(recording);
  return recording;
}

/**
 * Only what the page renders.
 *
 * A full `UpgradeCandidate` carries the entire plan, every evidence record and
 * every version ever published — megabytes per package, none of it on screen.
 * The site is a static download; shipping the rest would be someone's mobile
 * data spent on fields nothing reads.
 */
function slimCandidate(candidate) {
  const evidenceById = new Map((candidate.plan?.evidence ?? []).map((entry) => [entry.id, entry]));

  return {
    id: candidate.id,
    name: candidate.name,
    ecosystem: candidate.ecosystem,
    manifestPath: candidate.manifestPath,
    workspace: candidate.workspace ?? null,
    workspaceName: candidate.workspaceName ?? null,
    current: candidate.current,
    latest: candidate.latest,
    selected: candidate.selected,
    safeLatest: candidate.safeLatest ?? null,
    publishedVersions: candidate.versions,
    provenance: { kind: candidate.kind, source: 'manifest' },
    status: candidate.status,
    phase: candidate.phase ?? null,
    risk: candidate.risk,
    summary: candidate.summary,
    recommendation: candidate.recommendation ?? null,
    // Structured signal for the recording validator's "safe-to-upgrade
    // implies real evidence" invariant -- whether a computed surface diff or
    // actually-read compatibility prose backs this candidate's assessment, as
    // opposed to a clean security check or a version lookup alone. `null`
    // when no rationale was computed at all (e.g. an error candidate).
    hasCompatibilityEvidence: candidate.rationale?.hasCompatibilityEvidence ?? null,
    // What Drift established about this repository's runtime, as a state
    // rather than as a count of sites -- `unknown` and `partial` both
    // routinely come with zero sites, and the validator's job is to prove
    // neither can render as safe. `null` when the upgrade announced no
    // runtime requirement at all, which is deliberately NOT `compatible`.
    runtimeCompatibility: candidate.runtimeCompatibility ?? null,
    // The per-requirement breakdown behind the state above, so the validator
    // can check each runtime requirement's own answer rather than only the
    // worst one.
    runtimeAnalyses: candidate.runtimeAnalyses ?? [],
    // The application's actual verdict. The validator consumes this instead
    // of reconstructing a second severity algorithm from counts.
    severity: severityOf(candidate),
    independentActionableFindingCount: (candidate.plan?.dispositions ?? [])
      .filter((disposition) => disposition.state === 'actionable')
      .filter((disposition) =>
        (candidate.plan?.breakingChanges ?? []).some(
          (change) => change.id === disposition.changeId && change.kind !== 'runtime-requirement',
        ),
      ).length,
    actionableImpactCount: candidate.actionableImpactCount ?? 0,
    actionableImpactFiles: candidate.actionableImpactFiles ?? 0,
    runtimeDeclarationSiteCount: candidate.runtimeDeclarationSiteCount ?? 0,
    sourceCoverage: candidate.sourceCoverage ?? null,
    surfaceAssessment: candidate.surfaceAssessment ?? null,
    runtimeChanges: (candidate.plan?.breakingChanges ?? [])
      .filter((change) => change.kind === 'runtime-requirement' && change.runtime)
      .map((change) => ({ id: change.id, runtime: change.runtime.runtime })),
    dispositions: (candidate.plan?.dispositions ?? []).map((disposition) => ({
      changeId: disposition.changeId,
      state: disposition.state,
      reason: disposition.reason,
      siteCount: disposition.sites.length,
      actionableSiteCount: disposition.actionableSites.length,
      runtimeState: disposition.runtimeAnalysis?.state ?? null,
    })),
    breakingCount: candidate.breakingCount,
    impactCount: candidate.impactCount,
    impactFiles: candidate.impactFiles,
    evidenceCount: candidate.evidenceCount,
    gaps: candidate.gaps.slice(0, 3),
    // Findings that were actually localized come first, then the slice.
    //
    // Taking the first four in plan order looked fine and was not: a package
    // like Twisted reports hundreds of removed exports, only some of which
    // this repository touches, and the first four were reliably the ones it
    // does not. The panel then said "241 sites in 53 files" above four
    // findings with no file, no line and no code — the exact evidence that
    // makes the claim worth believing, missing from the one place it is
    // needed. Sorted by how much of this repository each finding actually
    // touches, so the four that ship are the four with something to show.
    breaking: (candidate.plan?.breakingChanges ?? [])
      .map((change) => ({
        change,
        sites: (candidate.plan?.impactSites ?? []).filter(
          (site) => site.breakingChangeId === change.id,
        ),
      }))
      .sort((a, b) => b.sites.length - a.sites.length)
      .slice(0, 4)
      .map(({ change, sites }) => ({
        kind: change.kind,
        summary: change.summary,
        remediation: change.remediation,
        confidence: change.confidence,
        runtime: change.runtime ?? null,
        // The single customer-facing number, computed from the same
        // assessment the extension and the Markdown report read. `null` for
        // the rare finding with no assessment at all, so the page can fall
        // back to the plain band without pretending it has a score.
        overall: change.assessment ? deriveOverallConfidence(change.assessment) : null,
        symbols: change.symbols.slice(0, 4),
        evidence: evidenceFor(change, evidenceById),
        // Strongest evidence first — the same ranking `dedupeSites` applies in
        // the core. Only four sites of a possible few hundred are kept, and
        // taking them in file order meant the page could show a `medium` match
        // on a generic identifier while a `high` one, where the file provably
        // binds the symbol from this dependency's import, went unshipped.
        sites: [...sites]
          .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
          .slice(0, 4)
          .map(slimSite),
      })),
  };
}

function confidenceRank(confidence) {
  return confidence === 'high' ? 2 : confidence === 'medium' ? 1 : 0;
}

function evidenceFor(change, evidenceById) {
  return change.citations
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .slice(0, 3)
    .map(slimEvidence);
}

function slimEvidence(evidence) {
  return {
    source: evidence.source,
    title: evidence.title,
    url: evidence.url ?? null,
    locator: evidence.locator ?? null,
  };
}

function slimSite(site) {
  return {
    file: site.file,
    line: site.line,
    excerpt: site.excerpt.slice(0, 160),
    matchedSymbol: site.matchedSymbol,
    confidence: site.confidence,
    ...(site.runtimeVerdict ? { runtimeVerdict: site.runtimeVerdict } : {}),
  };
}

/** Packages with findings first — the same order the extension's panel uses. */
function byAttention(a, b) {
  return (
    b.impactCount - a.impactCount ||
    b.breakingCount - a.breakingCount ||
    a.name.localeCompare(b.name)
  );
}

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name) => args.includes(`--${name}`);

const requested = args.filter((arg) => !arg.startsWith('-'));
const selected = requested.length > 0 ? TARGETS.filter((t) => requested.includes(t.id)) : TARGETS;

if (selected.length === 0) {
  console.error(`No matching target. Known: ${TARGETS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

/**
 * How many *scans* run at once. See the fidelity note at the top of this file:
 * this is the one number that shows up in the output, so it stays at four
 * unless somebody asks for otherwise.
 */
const jobs = Math.max(1, Number(flag('jobs') ?? process.env.CAPTURE_JOBS ?? 4) || 1);

/**
 * How many *clones* run at once, which is a different question with a different
 * answer.
 *
 * Nothing about a clone reaches the recording, so this is bounded by bandwidth
 * and by how many concurrent fetches GitHub will serve cheerfully, not by
 * fidelity. It runs ahead of the scans so that a scan never waits for a
 * download that could have happened while the previous scan was running.
 */
const cloneJobs = Math.max(
  jobs,
  Number(flag('clone-jobs') ?? process.env.CAPTURE_CLONE_JOBS ?? Math.min(8, availableParallelism())) || jobs,
);

/**
 * How long one target may take before it is abandoned.
 *
 * Generous on purpose: GitLab's recording legitimately takes over half an hour,
 * and Kubernetes' took sixty-nine minutes on a runner. This is a guard against
 * a wedged scan, not a performance budget, so it is set well past the slowest
 * honest run rather than near it.
 */
const targetTimeoutMs =
  Math.max(1, Number(flag('target-timeout') ?? process.env.CAPTURE_TARGET_TIMEOUT_MINUTES ?? 90) || 90) * 60_000;

const useCache = !has('no-cache');
const onlyStale = has('if-stale') || has('check');
const checkOnly = has('check');

await mkdir(outDir, { recursive: true });

/** What produced the recordings that are already committed, and what would produce new ones. */
const fingerprint = await engineFingerprint(repoRoot);

/**
 * Why a target is being re-recorded, or `null` when it does not need to be.
 *
 * Two reasons, and they go stale independently. The repository moves — a new
 * dependency, a new release — which the commit catches. And *Drift* moves — a
 * better surface diff, a new evidence source — which nothing about the
 * recording's content would reveal, and which the engine fingerprint catches.
 *
 * Anything unreadable counts as stale. A recording that cannot be parsed, or a
 * remote that will not answer, is not evidence that nothing has changed.
 */
async function stalenessOf(target) {
  const path = join(outDir, `${target.id}.json`);
  if (!existsSync(path)) return 'never recorded';

  let existing;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return 'the existing recording could not be read';
  }

  if (isSchemaStale(existing, RECORDING_SCHEMA_VERSION)) {
    return `recording schema changed (${existing.schemaVersion ?? 1} -> ${RECORDING_SCHEMA_VERSION})`;
  }

  if (existing.engine !== fingerprint) {
    return existing.engine
      ? `recorded by a different engine (${existing.engine} -> ${fingerprint})`
      : `recorded before the engine was fingerprinted (now ${fingerprint})`;
  }

  const head = await remoteHead(target.repo);
  if (!head) return 'could not reach the repository to check';
  if (head !== existing.commit) return `${target.repo.split('/').slice(-1)[0]} moved to ${head.slice(0, 10)}`;

  return null;
}

let queue = [...selected];
if (onlyStale) {
  // Every remote asked at once: `git ls-remote` is a single round trip and
  // seventeen of them one after another is the whole cost of a check that
  // usually finds nothing to do.
  const reasons = await Promise.all(selected.map(stalenessOf));
  const stale = selected.filter((_, at) => reasons[at] !== null);

  for (const [at, target] of selected.entries()) {
    process.stderr.write(
      reasons[at] ? `[${target.id}] stale — ${reasons[at]}\n` : `[${target.id}] current\n`,
    );
  }

  if (checkOnly) {
    // For CI: the exit code is the answer, and the list is on stdout so a
    // workflow can pass it straight back to this script.
    process.stdout.write(stale.map((target) => target.id).join(' '));
    process.stderr.write(
      `\n${stale.length} of ${selected.length} recording(s) are out of date` +
        `${stale.length > 0 ? `: ${stale.map((t) => t.id).join(', ')}` : ''}\n`,
    );
    process.exit(stale.length > 0 ? 1 : 0);
  }

  queue = stale;
  if (queue.length === 0) process.stderr.write('every recording is current; nothing to capture\n');
}

process.stderr.write(
  `capturing ${queue.length} target(s), ${Math.min(jobs, queue.length)} scan(s) and ` +
    `${Math.min(cloneJobs, queue.length)} clone(s) at a time (engine ${fingerprint})\n`,
);

const startedAt = Date.now();

/**
 * Clones running ahead of scans, over one shared queue.
 *
 * A queue rather than an even split of the list: the targets are wildly
 * uneven — Kubernetes takes minutes and FlexLayout takes seconds — so a worker
 * that finishes early has to be able to take the next thing rather than sit out
 * the rest of the run.
 *
 * Each entry becomes a promise for a ready checkout the moment a clone slot is
 * free, and a scan worker awaits whichever it picks up. Bounded on both sides:
 * `cloneJobs` clones may be in flight, and `jobs` scans, so the pipeline never
 * turns into seventeen simultaneous downloads of large repositories.
 */
const pending = new Map();
let cloning = 0;
const cloneWaiters = [];

async function cloneSlot(work) {
  if (cloning >= cloneJobs) await new Promise((resolve) => cloneWaiters.push(resolve));
  cloning += 1;
  try {
    return await work();
  } finally {
    cloning -= 1;
    cloneWaiters.shift()?.();
  }
}

for (const target of queue) {
  const prepared = cloneSlot(() => checkoutOf(target, { useCache }));
  // Nothing reads a rejection until a scan worker awaits it, and an unhandled
  // rejection in the meantime would take the process down.
  prepared.catch(() => undefined);
  pending.set(target.id, prepared);
}

const scanQueue = [...queue];

/** Targets that did not produce a recording, and why. */
const failures = [];

/**
 * Give up on a target that has stopped making progress.
 *
 * A scan can wedge — a package manager that ignores the signal sent to it, a
 * socket that never closes, a deadlock between the probe's own workers — and
 * when it does, nothing downstream is defensive about it. The whole capture
 * hung on `gitlab`, and because the last worker never settled, Node drained the
 * event loop and exited on an unsettled top-level await, taking with it fifteen
 * recordings that had already finished, including a Kubernetes scan that had
 * cost an hour of runner time.
 *
 * Two things about this are deliberate. The deadline is generous — GitLab's own
 * recording takes over half an hour legitimately, and a timeout that fires on
 * slow work would be worse than the hang it replaces. And a target that trips it
 * is *reported*, never quietly skipped: its previous recording stays on disk,
 * still marked stale by its engine fingerprint, so the next run tries it again
 * rather than pretending it succeeded.
 */
function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // What is still holding this process open. A hang with no handles at all
      // is a deadlock in our own code; one sitting on a socket or a child
      // process is something the environment did. That distinction is most of
      // the diagnosis and is impossible to recover afterwards, so it is
      // written down at the moment it is knowable.
      try {
        process.report?.writeReport(join(outDir, '..', '..', `capture-hang-${label}.json`));
        process.stderr.write(`[${label}] wrote a diagnostic report for the hang\n`);
      } catch {
        // Best effort. A missing report must not replace the timeout error.
      }
      reject(new Error(`gave up after ${(ms / 1000 / 60).toFixed(0)} minutes without finishing`));
    }, ms);
    // Deliberately *not* `unref`'d, which is the reflex here and is exactly
    // backwards. An unref'd timer does not keep the event loop alive, and the
    // case this guard exists for is the one where nothing else is keeping it
    // alive either — a wedged scan holding no socket and no child process. The
    // loop would drain and Node would exit on the unsettled await before the
    // deadline ever fired, which is the original bug with extra code.
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function worker() {
  for (;;) {
    const target = scanQueue.shift();
    if (!target) return;

    try {
      const prepared = await withDeadline(pending.get(target.id), targetTimeoutMs, target.id);
      const result = await withDeadline(capture(target, prepared, fingerprint), targetTimeoutMs, target.id);
      validateRecording(result);
      await writeFile(join(outDir, `${target.id}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      process.stderr.write(
        `[${target.id}] done — ${result.candidates.length} candidates, ` +
          `${result.timeline.length} events, ${(result.durationMs / 1000).toFixed(1)}s\n`,
      );
    } catch (err) {
      failures.push({ id: target.id, reason: err.message });
      process.stderr.write(`[${target.id}] FAILED: ${err.stack ?? err.message}\n`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
process.stderr.write(`\nall captures finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);

// An index of what was actually captured, so the site never lists a demo whose
// recording failed — a broken tab is worse than an absent one.
const captured = [];
for (const target of TARGETS) {
  const path = join(outDir, `${target.id}.json`);
  if (!existsSync(path)) continue;
  const data = JSON.parse(await readFile(path, 'utf8'));
  captured.push({
    id: data.id,
    label: data.label,
    ecosystem: data.ecosystem,
    language: data.language,
    repo: data.repo,
    blurb: data.blurb,
    commit: data.commit,
    capturedAt: data.capturedAt,
    packagesChecked: data.packagesChecked,
    candidates: data.candidates.length,
  });
}
await writeFile(join(outDir, 'index.json'), `${JSON.stringify(captured, null, 2)}\n`, 'utf8');
process.stderr.write(`\nwrote ${captured.length} recording(s) to site/src/data\n`);

// Said last and loudly, and the exit code carries it — but only after every
// recording that *did* work has been written and indexed. One wedged target
// used to discard fourteen good ones on its way out; a target that fails now
// costs exactly itself, and its previous recording stays on disk still marked
// stale, so the next run picks it up again.
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} target(s) did not record:\n`);
  for (const failure of failures) process.stderr.write(`  ${failure.id}: ${failure.reason}\n`);
  process.exitCode = 1;
}
