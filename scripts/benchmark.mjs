#!/usr/bin/env node
/**
 * Run Drift against pinned real checkouts and record what it cost.
 *
 * Deliberately the same entry point the capture harness uses — `scanUpgrades`
 * against a real repository at a pinned commit — rather than a synthetic
 * fixture, because the things that dominate a scan (registry latency, how far a
 * declaration tree reaches, whether a project has a typecheck to run) do not
 * exist in a fixture at all.
 *
 * Two runs of the same target are not comparable unless their caches are in the
 * same state, so cold and warm are separate modes and never mixed:
 *
 *   --cold   a private, empty HTTP disk cache for this run
 *   --warm   a shared disk cache, pre-populated by a preceding run
 *
 * The commit is pinned per target from `benchmarks.lock.json` when present, so
 * a before/after comparison is against the same input rather than against
 * whatever the default branch moved to in between.
 *
 * Usage:
 *   node scripts/benchmark.mjs --targets=supabase,scrapy --cold --out=baseline
 *   node scripts/benchmark.mjs --targets=supabase --warm --out=after
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * The representative set.
 *
 * Chosen to span both axes that actually change what Drift does: ecosystem
 * (which decides whether there is a type surface to diff, a registry to ask, a
 * verification command to run) and size (which decides whether the repository
 * walk or the network dominates). Sub-selecting with `--targets` is how the
 * inner loop stays fast; the full capture suite is what proves a change
 * generalised.
 */
export const TARGETS = {
  trantor: { repo: 'https://github.com/an-tao/trantor', ecosystem: 'conan', size: 'small' },
  flexlayout: { repo: 'https://github.com/layoutBox/FlexLayout', ecosystem: 'cocoapods', size: 'small' },
  supabase: { repo: 'https://github.com/supabase/supabase-js', ecosystem: 'npm', size: 'medium' },
  scrapy: { repo: 'https://github.com/scrapy/scrapy', ecosystem: 'pypi', size: 'medium' },
  deno: { repo: 'https://github.com/denoland/deno', ecosystem: 'cargo', size: 'large' },
  kubernetes: { repo: 'https://github.com/kubernetes/kubernetes', ecosystem: 'go', size: 'large' },

  // The rest of the capture suite's ecosystems. Not in the inner loop — the
  // four above cover the paths that dominate — but the set a change has to
  // generalise across before it is believed, since each of these exercises a
  // different registry, a different surface provider, and a different set of
  // gaps.
  restsharp: { repo: 'https://github.com/restsharp/RestSharp', ecosystem: 'nuget', size: 'small' },
  guzzle: { repo: 'https://github.com/guzzle/guzzle', ecosystem: 'packagist', size: 'small' },
  phoenix: { repo: 'https://github.com/phoenixframework/phoenix', ecosystem: 'hex', size: 'medium' },
  dio: { repo: 'https://github.com/cfug/dio', ecosystem: 'pub', size: 'small' },
  tca: { repo: 'https://github.com/pointfreeco/swift-composable-architecture', ecosystem: 'swift', size: 'medium' },
  cohttp: { repo: 'https://github.com/mirage/ocaml-cohttp', ecosystem: 'opam', size: 'small' },
  elasticsearch: { repo: 'https://github.com/elastic/elasticsearch-java', ecosystem: 'maven', size: 'medium' },
  esphome: { repo: 'https://github.com/esphome/esphome', ecosystem: 'arduino', size: 'large' },
  obs: { repo: 'https://github.com/royshil/obs-backgroundremoval', ecosystem: 'vcpkg', size: 'small' },
  gitlab: { repo: 'https://github.com/gitlabhq/gitlabhq', ecosystem: 'rubygems', size: 'large' },
};

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const cold = has('cold');
const warm = has('warm');
if (cold === warm) {
  console.error('benchmark: pass exactly one of --cold or --warm');
  process.exit(1);
}

const selected = (flag('targets') ?? Object.keys(TARGETS).join(',')).split(',').filter(Boolean);
/** An alternate build to measure, so two engine commits can be compared in one sitting. */
const dist = flag('dist');
/** Repeat count. Cold runs vary with the network; the median of three is worth the wait. */
const repeats = Number(flag('repeat', '1')) || 1;
const outName = flag('out', cold ? 'cold' : 'warm');
/**
 * Which of `benchmark-scan.mjs`'s named `PROFILES` to run — e.g.
 * `production-extension-quick` or `runtime-only-quick`. Unset measures
 * whatever that script measured before profiles existed (`legacy`), so an
 * existing invocation's meaning does not change under it.
 */
const scanProfile = flag('profile');
/** Print each run's stage-by-stage `profile-report.mjs` breakdown after the summary table. */
const showStages = has('stages');
const outDir = join(repoRoot, 'bench-results');
const cloneCache = join(tmpdir(), 'drift-capture-clones');
/**
 * Where the HTTP disk cache lives for this run.
 *
 * A cold run gets a directory of its own and deletes it first, because "cold"
 * has to mean cold — reusing the warm cache and calling the result a first-run
 * number is the single easiest way to publish a fictitious improvement.
 */
const httpCache = cold ? join(tmpdir(), `drift-bench-cold-${process.pid}`) : join(tmpdir(), 'drift-bench-warm');

const lockPath = join(repoRoot, 'benchmarks.lock.json');
const pinned = existsSync(lockPath) ? JSON.parse(await readFile(lockPath, 'utf8')) : {};

const githubToken =
  process.env.GITHUB_TOKEN ||
  (() => {
    try {
      return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();

async function checkoutOf(id) {
  const target = TARGETS[id];
  if (!target) throw new Error(`unknown target ${id}`);
  const dir = join(cloneCache, id);
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(cloneCache, { recursive: true });
    process.stderr.write(`[${id}] cloning\n`);
    await run('git', ['clone', '--depth', '1', '--filter=blob:none', '--single-branch', '--no-tags', target.repo, dir], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  // Pinned where we have a pin, so before/after is the same input. Without a
  // pin we record whatever HEAD is and write it back, which pins it for every
  // later run in the comparison.
  const want = pinned[id];
  if (want) {
    const at = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    if (at !== want) {
      await run('git', ['fetch', '--depth', '1', 'origin', want], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).catch(
        () => undefined,
      );
      await run('git', ['checkout', '--detach', want], { cwd: dir }).catch(() => undefined);
    }
  }
  // A previous scan's leftovers — an installed `node_modules`, a manifest a
  // probe rewrote — would be measured as part of the repository.
  await run('git', ['clean', '-xdff'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  await run('git', ['checkout', '--', '.'], { cwd: dir }).catch(() => undefined);
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  return { dir, head };
}

/**
 * One scan, in a child process.
 *
 * A child rather than in-process, for two reasons that both matter: the
 * profiler and every module-level cache in the engine start empty (a second
 * target in the same process would inherit the first's warmed surfaces and read
 * as faster than it is), and `getrusage` on the child gives real CPU time and
 * peak RSS that a shared process cannot attribute.
 */
async function scanOnce(id, checkout, profilePath) {
  const script = join(here, 'benchmark-scan.mjs');
  const started = Date.now();
  const child = await run(process.execPath, [script], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      DRIFT_PROFILE: profilePath,
      DRIFT_BENCH_ROOT: checkout.dir,
      DRIFT_BENCH_CACHE: httpCache,
      ...(dist ? { DRIFT_BENCH_DIST: dist } : {}),
      ...(scanProfile ? { DRIFT_BENCH_PROFILE: scanProfile } : {}),
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    },
  }).catch((err) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? String(err), failed: true }));
  const wallMs = Date.now() - started;
  let result = null;
  try {
    result = JSON.parse(child.stdout.slice(child.stdout.lastIndexOf('\n{')));
  } catch {
    result = { error: child.stderr.split('\n').slice(-5).join('\n') };
  }
  return { wallMs, ...result };
}

await mkdir(outDir, { recursive: true });
if (cold) await rm(httpCache, { recursive: true, force: true });

const results = [];
for (const id of selected) {
  const checkout = await checkoutOf(id);
  pinned[id] ??= checkout.head;
  const runs = [];
  for (let attempt = 0; attempt < repeats; attempt++) {
    // A cold run means cold every time, not just the first of three.
    if (cold && attempt > 0) await rm(httpCache, { recursive: true, force: true });
    const profilePath = join(outDir, `${outName}-${id}${attempt > 0 ? `.${attempt}` : ''}.profile.json`);
    process.stderr.write(`[${id}] scanning (${cold ? 'cold' : 'warm'}${repeats > 1 ? ` ${attempt + 1}/${repeats}` : ''})\n`);
    const result = await scanOnce(id, checkout, profilePath);
    runs.push({ ...result, profile: profilePath });
    process.stderr.write(
      `[${id}] ${(result.wallMs / 1000).toFixed(1)}s · ${result.checked ?? '?'} checked · ` +
        `${result.outdated ?? '?'} outdated · ${result.candidates ?? '?'} analysed\n`,
    );
  }

  // The median, not the mean: one run that caught a registry mid-hiccup should
  // not move the number the comparison is made against.
  const median = [...runs].sort((a, b) => a.wallMs - b.wallMs)[Math.floor(runs.length / 2)];
  results.push({
    id,
    ...TARGETS[id],
    commit: checkout.head,
    mode: cold ? 'cold' : 'warm',
    ...median,
    ...(runs.length > 1 ? { allWallMs: runs.map((r) => r.wallMs) } : {}),
  });
}

await writeFile(lockPath, `${JSON.stringify(pinned, null, 2)}\n`, 'utf8');
const summaryPath = join(outDir, `${outName}.json`);
await writeFile(summaryPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

console.log(`\n${'='.repeat(72)}`);
console.log(`benchmark: ${outName} (${cold ? 'cold' : 'warm'})${scanProfile ? ` · profile ${scanProfile}` : ''}`);
console.log('='.repeat(72));
for (const r of results) {
  console.log(
    `${r.id.padEnd(14)}${String(r.ecosystem).padEnd(12)}${`${(r.wallMs / 1000).toFixed(1)}s`.padStart(9)}` +
      `${String(r.checked ?? '-').padStart(7)} deps${String(r.outdated ?? '-').padStart(6)} outdated` +
      `${String(r.candidates ?? '-').padStart(6)} analysed`,
  );
}
console.log(`\nwrote ${summaryPath}`);

// Every run above already wrote a full `DRIFT_PROFILE` dump (span-level
// wall/CPU/HTTP-wait/cache-hit detail — see `src/util/profile.ts`); `--stages`
// renders each one with `profile-report.mjs` rather than leaving it to a
// second, separate command per target.
if (showStages) {
  for (const r of results) {
    if (!existsSync(r.profile)) continue;
    await run(process.execPath, [join(here, 'profile-report.mjs'), r.profile], { maxBuffer: 64 * 1024 * 1024 })
      .then(({ stdout }) => process.stdout.write(stdout))
      .catch((err) => process.stderr.write(`[${r.id}] could not render profile: ${err.message}\n`));
  }
}
