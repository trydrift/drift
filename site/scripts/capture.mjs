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
 * Usage:
 *   node site/scripts/capture.mjs            # every target
 *   node site/scripts/capture.mjs deno       # one, by id
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'src', 'data');

const { scanUpgrades } = await import(join(repoRoot, 'dist/upgrade/scan.js'));
const { DriftConfigSchema } = await import(join(repoRoot, 'dist/config/schema.js'));
const { createLogger } = await import(join(repoRoot, 'dist/util/logger.js'));
const { configureHttpDiskCache } = await import(join(repoRoot, 'dist/util/http.js'));

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

async function capture(target) {
  const started = Date.now();
  const workdir = await mkdtemp(join(tmpdir(), `drift-capture-${target.id}-`));
  const checkout = join(workdir, 'repo');

  process.stderr.write(`\n[${target.id}] cloning ${target.repo}\n`);
  await run('git', [
    'clone',
    '--depth',
    '1',
    '--filter=blob:none',
    '--single-branch',
    target.repo,
    checkout,
  ], { maxBuffer: 64 * 1024 * 1024 });

  const [owner, name] = new URL(target.repo).pathname.slice(1).split('/');
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: checkout })).stdout.trim();
  const root = checkout;

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
  const events = [];
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
  const mark = (phase, detail, done, total) =>
    events.push({ at: Date.now() - started, phase: scrub(phase), detail: scrub(detail), done, total });

  process.stderr.write(`[${target.id}] scanning for upgrades\n`);
  const candidates = [];
  let scan = null;
  try {
    scan = await scanUpgrades({
      root,
      repo,
      config,
      logger,
      githubToken: githubToken || undefined,
      breadth: { includeDev: false, maxSites: FULL_REPO.maxSites, maxPackages: FULL_REPO.maxPackages },
      concurrency: 8,
      onProgress: ({ phase, detail, done, total }) => mark(phase, detail, done, total),
      onCandidate: (candidate) => candidates.push(slimCandidate(candidate)),
    });
  } catch (err) {
    process.stderr.write(`[${target.id}] scan failed: ${err.message}\n`);
  }

  await rm(workdir, { recursive: true, force: true });

  return {
    id: target.id,
    label: target.label,
    ecosystem: target.ecosystem,
    language: target.language,
    repo: target.repo,
    blurb: target.blurb,
    capturedAt: new Date().toISOString(),
    commit: head,
    durationMs: Date.now() - started,
    packagesChecked: scan?.checked ?? 0,
    manifests: (scan?.targets ?? []).map((t) => t.manifestPath),
    nestedGitRepos: (scan?.nestedGitRepos ?? []).map((project) => project.dir),
    events,
    candidates: candidates.sort(byAttention),
  };
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
    name: candidate.name,
    ecosystem: candidate.ecosystem,
    manifestPath: candidate.manifestPath,
    workspace: candidate.workspace ?? null,
    workspaceName: candidate.workspaceName ?? null,
    current: candidate.current,
    latest: candidate.latest,
    selected: candidate.selected,
    safeLatest: candidate.safeLatest ?? null,
    status: candidate.status,
    risk: candidate.risk,
    summary: candidate.summary,
    recommendation: candidate.recommendation ?? null,
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

const requested = process.argv.slice(2);
const selected = requested.length > 0 ? TARGETS.filter((t) => requested.includes(t.id)) : TARGETS;

if (selected.length === 0) {
  console.error(`No matching target. Known: ${TARGETS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

for (const target of selected) {
  try {
    const result = await capture(target);
    await writeFile(join(outDir, `${target.id}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stderr.write(
      `[${target.id}] done — ${result.candidates.length} candidates, ` +
        `${result.events.length} events, ${(result.durationMs / 1000).toFixed(1)}s\n`,
    );
  } catch (err) {
    process.stderr.write(`[${target.id}] FAILED: ${err.stack ?? err.message}\n`);
  }
}

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
