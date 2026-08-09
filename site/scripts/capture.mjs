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

import { execFile } from 'node:child_process';
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
const { auditCurrentUsage } = await import(join(repoRoot, 'dist/audit/index.js'));
const { DriftConfigSchema } = await import(join(repoRoot, 'dist/config/schema.js'));
const { createLogger } = await import(join(repoRoot, 'dist/util/logger.js'));

/**
 * What to record.
 *
 * Each is a real, well-known project in its ecosystem, chosen so a visitor
 * recognises it and can go and check the claim. `dir` narrows a monorepo to the
 * package that actually declares dependencies — cloning Supabase and pointing
 * Drift at the root would analyse the website, not the client library.
 *
 * `maxPackages` is a recording budget, not a limitation of the tool: a full
 * sweep of Kubernetes' go.mod is hundreds of registry round trips, and nobody
 * watches a four-minute animation. It is stated on the page rather than hidden.
 */
const TARGETS = [
  {
    id: 'supabase',
    label: 'supabase-js',
    ecosystem: 'npm',
    language: 'TypeScript',
    repo: 'https://github.com/supabase/supabase-js',
    blurb: 'The official Supabase client for JavaScript and TypeScript.',
    dir: '',
    maxPackages: 14,
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
    maxPackages: 14,
  },
  {
    id: 'gitlab',
    label: 'gitlab',
    ecosystem: 'rubygems',
    language: 'Ruby',
    repo: 'https://github.com/gitlabhq/gitlabhq',
    blurb: "GitLab's Rails monolith — one of the largest Ruby codebases in the open.",
    dir: '',
    maxPackages: 14,
  },
  {
    id: 'kubernetes',
    label: 'kubernetes',
    ecosystem: 'go',
    language: 'Go',
    repo: 'https://github.com/kubernetes/kubernetes',
    blurb: 'The container orchestrator. One of the largest Go codebases in the open.',
    dir: '',
    // Wider than the others on purpose. Go projects pin exact versions in
    // go.mod and keep them current, so a 14-package slice of Kubernetes found
    // two outdated dependencies — a true result, and a thin recording. A wider
    // sweep shows the same discipline over a sample worth looking at.
    maxPackages: 34,
  },
  {
    id: 'deno',
    label: 'deno',
    ecosystem: 'cargo',
    language: 'Rust',
    repo: 'https://github.com/denoland/deno',
    blurb: 'A modern runtime for JavaScript and TypeScript, written in Rust.',
    dir: '',
    maxPackages: 14,
  },
  {
    id: 'elasticsearch',
    label: 'elasticsearch-java',
    ecosystem: 'maven',
    language: 'Java',
    repo: 'https://github.com/elastic/elasticsearch-java',
    blurb: "Elasticsearch's official Java API client.",
    dir: '',
    maxPackages: 14,
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
  const root = target.dir ? join(checkout, target.dir) : checkout;

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
      githubToken: process.env.GITHUB_TOKEN || undefined,
      breadth: { includeDev: false, maxSites: 12, maxPackages: target.maxPackages },
      concurrency: 4,
      onProgress: ({ phase, detail, done, total }) => mark(phase, detail, done, total),
      onCandidate: (candidate) => candidates.push(slimCandidate(candidate)),
    });
  } catch (err) {
    process.stderr.write(`[${target.id}] scan failed: ${err.message}\n`);
  }

  process.stderr.write(`[${target.id}] auditing installed versions\n`);
  let audit = null;
  try {
    audit = await auditCurrentUsage({
      root,
      repo,
      config,
      logger,
      githubToken: process.env.GITHUB_TOKEN || undefined,
      maxPackages: target.maxPackages,
      maxSites: 8,
      concurrency: 4,
      onProgress: (phase, detail, done, total) => mark(phase, detail, done, total),
    });
  } catch (err) {
    process.stderr.write(`[${target.id}] audit failed: ${err.message}\n`);
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
    packagesCapped: target.maxPackages,
    manifests: (scan?.targets ?? []).map((t) => t.manifestPath),
    events,
    candidates: candidates.sort(byAttention),
    audit: audit
      ? {
          checked: audit.checked,
          analysed: audit.analysed,
          findings: audit.findings.map(slimFinding),
        }
      : null,
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
  return {
    name: candidate.name,
    ecosystem: candidate.ecosystem,
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

function slimFinding(finding) {
  return {
    kind: finding.kind,
    dependency: finding.dependency,
    declaredRange: finding.declaredRange,
    rangeFloor: finding.rangeFloor,
    installedVersion: finding.installedVersion,
    summary: finding.breakingChange?.summary ?? finding.summary,
    remediation: finding.breakingChange?.remediation ?? null,
    sites: finding.sites.slice(0, 4).map(slimSite),
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
    const findings = result.audit?.findings.length ?? 0;
    process.stderr.write(
      `[${target.id}] done — ${result.candidates.length} candidates, ${findings} audit finding(s), ` +
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
    findings: data.audit?.findings.length ?? 0,
  });
}
await writeFile(join(outDir, 'index.json'), `${JSON.stringify(captured, null, 2)}\n`, 'utf8');
process.stderr.write(`\nwrote ${captured.length} recording(s) to site/src/data\n`);
