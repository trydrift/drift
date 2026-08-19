import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * Mining real npm breaking-update cases from migration history.
 *
 * The construction is causal, and follows BUMP's definition rather than
 * swe-bump-bench's. BUMP defines a breaking update as: the pre-update state
 * builds, a one-dependency update causes it to fail, and the failure
 * reproduces locally. swe-bump-bench instead sweeps `npm-check-updates` for
 * major bumps and keeps a task when `tsc` emits more errors than before —
 * which admits tasks whose baseline was already failing (its own collector
 * warns about this and keeps the task anyway) and defines success as "no more
 * errors than before", a bar a patch that deletes the calling code clears.
 *
 * So a candidate here is derived from a real migration a human already made:
 *
 *   1. find a merged PR that both bumps a dependency AND edits consumer source
 *      (a bump-only PR proves nothing broke; a source-only PR is unrelated);
 *   2. take the PR's base commit as the pre-update state;
 *   3. reconstruct a BUMP-ONLY state — base commit, plus only the
 *      manifest/lockfile change from the migration;
 *   4. the developer's source edits from that same PR become the gold patch,
 *      evidence of one valid repair rather than the definition of correctness.
 *
 * Steps 1–4 produce a *candidate*. Nothing here decides a candidate is a
 * benchmark case: `checkReproducibility` runs baseline/bump-only/gold three
 * times each and rules, and independent review adjudicates the ground truth.
 * This module deliberately cannot promote anything.
 *
 * Every rejected candidate is written out with its reason. A miner that only
 * emits its successes hides its own selection bias, and the rejection reasons
 * are the most informative thing it produces — BUMP's own discard rate (57 of
 * 628 at the sanity-check stage alone) is a headline finding, not a footnote.
 */

export const MINER_VERSION = 'npm-migration-pr-miner-v1';

export interface MineOptions {
  /** `owner/name`. Mining is scoped to repositories a caller names; this never crawls GitHub at large. */
  repositories: readonly string[];
  /** Hard cap on candidates emitted per repository, so a pilot run stays bounded. */
  maxPerRepository?: number;
  /** Only consider PRs merged at or after this ISO date. */
  since?: string;
  /** Where candidate and rejection records are written. */
  outputDir: string;
}

export interface Candidate {
  minerVersion: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  mergedAt: string;
  baseCommit: string;
  migrationCommit: string;
  dependency: { name: string; fromVersion: string; toVersion: string; section: string };
  manifestPaths: string[];
  lockfilePaths: string[];
  /** The developer's source-only edits — the gold patch. Never includes manifest or lockfile churn. */
  developerPatch: string;
  developerPatchFiles: string[];
  /** Files the PR touched that are neither manifest, lockfile, nor plausible migration. Non-empty is a causality risk. */
  unrelatedFiles: string[];
}

export interface Rejection {
  repository: string;
  prNumber: number | null;
  reason: string;
  detail: string;
}

export interface MineResult {
  candidates: Candidate[];
  rejections: Rejection[];
}

const MANIFEST = /(^|\/)package\.json$/;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/;

export async function mineRepositories(options: MineOptions): Promise<MineResult> {
  const candidates: Candidate[] = [];
  const rejections: Rejection[] = [];
  await mkdir(join(options.outputDir, 'candidates'), { recursive: true });
  await mkdir(join(options.outputDir, 'rejected'), { recursive: true });

  for (const repository of options.repositories) {
    const found = await mineRepository(repository, options).catch((err: Error) => {
      rejections.push({ repository, prNumber: null, reason: 'repository-unavailable', detail: err.message });
      return { candidates: [] as Candidate[], rejections: [] as Rejection[] };
    });
    candidates.push(...found.candidates);
    rejections.push(...found.rejections);
  }

  for (const candidate of candidates) {
    const name = `${candidate.repository.replace('/', '__')}-pr-${candidate.prNumber}.json`;
    await writeFile(join(options.outputDir, 'candidates', name), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  }
  await writeFile(
    join(options.outputDir, 'rejected', 'rejections.json'),
    `${JSON.stringify(rejections, null, 2)}\n`,
    'utf8',
  );

  return { candidates, rejections };
}

async function mineRepository(repository: string, options: MineOptions): Promise<MineResult> {
  const candidates: Candidate[] = [];
  const rejections: Rejection[] = [];
  const limit = options.maxPerRepository ?? 5;

  const pulls = await listMergedPulls(repository, options.since);

  const checkout = await mkdtemp(join(tmpdir(), 'drift-mine-'));
  try {
    // Blobless partial clone: the miner needs full history for `git show` at
    // two refs, but not every blob of every revision. On a large repository
    // that is the difference between a minute and half an hour, and git
    // fetches the blobs it actually asks for on demand.
    await execFile(
      'git',
      ['clone', '--quiet', '--filter=blob:none', `https://github.com/${repository}.git`, checkout],
      { maxBuffer: 1 << 26 },
    );

    for (const pull of pulls) {
      if (candidates.length >= limit) break;

      const files = await listPullFiles(repository, pull.number);
      const manifests = files.filter((file) => MANIFEST.test(file));
      const lockfiles = files.filter((file) => LOCKFILE.test(file));
      const sources = files.filter((file) => SOURCE.test(file) && !MANIFEST.test(file));

      if (manifests.length === 0) {
        rejections.push({ repository, prNumber: pull.number, reason: 'no-manifest-change', detail: 'The PR changes no package.json.' });
        continue;
      }
      if (sources.length === 0) {
        // A bump with no source adaptation is evidence that nothing broke for
        // this consumer. Valuable as a *negative* case, and explicitly not a
        // repair case, so it is rejected here rather than silently mislabelled.
        rejections.push({ repository, prNumber: pull.number, reason: 'bump-only-no-adaptation', detail: 'No consumer source changed; a candidate negative case, not a repair case.' });
        continue;
      }

      const base = pull.baseSha;
      const head = pull.mergeCommitSha ?? pull.headSha;

      const bumps = await dependencyBumps(checkout, base, head, manifests);
      if (bumps.length === 0) {
        rejections.push({ repository, prNumber: pull.number, reason: 'no-version-moved', detail: 'package.json changed but no dependency version moved.' });
        continue;
      }
      if (bumps.length > 1) {
        // BUMP restricts to one-liner single-dependency updates for exactly
        // this reason: with two dependencies moving, a failure cannot be
        // attributed to either, and the benchmark's causal claim collapses.
        rejections.push({
          repository,
          prNumber: pull.number,
          reason: 'multiple-dependencies-moved',
          detail: `${bumps.length} dependencies moved (${bumps.map((bump) => bump.name).join(', ')}); causality cannot be attributed.`,
        });
        continue;
      }

      const developerPatch = await diffPaths(checkout, base, head, sources);
      const unrelatedFiles = files.filter(
        (file) => !MANIFEST.test(file) && !LOCKFILE.test(file) && !SOURCE.test(file),
      );

      candidates.push({
        minerVersion: MINER_VERSION,
        repository,
        prNumber: pull.number,
        prUrl: pull.url,
        mergedAt: pull.mergedAt,
        baseCommit: base,
        migrationCommit: head,
        dependency: bumps[0]!,
        manifestPaths: manifests,
        lockfilePaths: lockfiles,
        developerPatch,
        developerPatchFiles: sources,
        unrelatedFiles,
      });
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }

  return { candidates, rejections };
}

interface PullSummary {
  number: number;
  url: string;
  mergedAt: string;
  baseSha: string;
  headSha: string;
  mergeCommitSha: string | null;
}

/**
 * Merged PRs, newest first, via the `gh` CLI.
 *
 * `gh` rather than a raw token read from the environment: it uses whatever
 * authentication the operator already has, and never asks this process to
 * handle a credential.
 */
async function listMergedPulls(repository: string, since?: string): Promise<PullSummary[]> {
  const { stdout } = await execFile(
    'gh',
    ['pr', 'list', '--repo', repository, '--state', 'merged', '--limit', '100', '--json', 'number,url,mergedAt,baseRefOid,headRefOid,mergeCommit'],
    { maxBuffer: 1 << 24 },
  );

  const raw = JSON.parse(stdout) as {
    number: number;
    url: string;
    mergedAt: string;
    baseRefOid: string;
    headRefOid: string;
    mergeCommit: { oid: string } | null;
  }[];

  return raw
    .filter((pull) => (since ? pull.mergedAt >= since : true))
    .map((pull) => ({
      number: pull.number,
      url: pull.url,
      mergedAt: pull.mergedAt,
      baseSha: pull.baseRefOid,
      headSha: pull.headRefOid,
      mergeCommitSha: pull.mergeCommit?.oid ?? null,
    }));
}

async function listPullFiles(repository: string, number: number): Promise<string[]> {
  const { stdout } = await execFile(
    'gh',
    ['api', '--paginate', `repos/${repository}/pulls/${number}/files`, '--jq', '.[].filename'],
    { maxBuffer: 1 << 24 },
  );
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Dependency versions that actually moved between two commits.
 *
 * Read from the manifests themselves rather than from the diff text: a diff
 * line can move a dependency between sections, reformat, or reorder without
 * changing a version, and each of those would be a phantom bump.
 */
async function dependencyBumps(
  checkout: string,
  base: string,
  head: string,
  manifests: readonly string[],
): Promise<{ name: string; fromVersion: string; toVersion: string; section: string }[]> {
  const bumps: { name: string; fromVersion: string; toVersion: string; section: string }[] = [];

  for (const manifest of manifests) {
    const before = await showFile(checkout, base, manifest);
    const after = await showFile(checkout, head, manifest);
    if (!before || !after) continue;

    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const left = (parseManifest(before)?.[section] ?? {}) as Record<string, string>;
      const right = (parseManifest(after)?.[section] ?? {}) as Record<string, string>;
      for (const [name, toVersion] of Object.entries(right)) {
        const fromVersion = left[name];
        if (fromVersion && fromVersion !== toVersion) bumps.push({ name, fromVersion, toVersion, section });
      }
    }
  }

  return bumps;
}

function parseManifest(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function showFile(checkout: string, ref: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['show', `${ref}:${path}`], { cwd: checkout, maxBuffer: 1 << 24 });
    return stdout;
  } catch {
    return null;
  }
}

async function diffPaths(checkout: string, base: string, head: string, paths: readonly string[]): Promise<string> {
  if (paths.length === 0) return '';
  try {
    const { stdout } = await execFile('git', ['diff', base, head, '--', ...paths], { cwd: checkout, maxBuffer: 1 << 26 });
    return stdout;
  } catch {
    return '';
  }
}
