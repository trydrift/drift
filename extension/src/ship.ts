import { dirname } from 'node:path';
import { PACKAGE_MANAGERS, packageManagerById } from '../../src/detect/package-manager.js';
import { parseSlug } from '../../src/repo/local-git.js';
import { describeSeverity, severityOf } from './severity.js';
import type { UpgradeCandidate } from './upgrades.js';

/**
 * Turning an upgrade into a change someone can review.
 *
 * An upgrade that stops at "your lockfile is different now" leaves the
 * developer holding the boring half of the job: work out which files moved,
 * write the message, name the branch, remember what the evidence said. Drift
 * already knows all four, so it offers them — a branch named after the upgrade,
 * a commit scoped to the dependency files and nobody else's, a pull request
 * whose body is the evidence that justified the version.
 *
 * Everything here is offered, never assumed. The functions are pure where they
 * can be so the naming and the wording are testable without a repository, and
 * the two that reach the network do nothing until the developer has said yes.
 */

/** A commit message, split the way git wants it. */
export interface CommitMessage {
  subject: string;
  body: string;
}

/** Every basename any supported manager treats as a manifest or a lockfile. */
const DEPENDENCY_FILES: ReadonlySet<string> = new Set(
  PACKAGE_MANAGERS.flatMap((manager) => [...manager.manifests, ...manager.lockfiles]),
);

/**
 * The files an upgrade of these packages is allowed to have touched.
 *
 * Intersected with what is actually dirty, so the commit contains what the
 * install wrote and nothing else. That scoping is the whole point: a developer
 * who was midway through editing source when they pressed Upgrade gets a commit
 * holding their manifest and lockfile, not their unfinished work.
 *
 * A workspace member's install almost always rewrites the lockfile at the root
 * rather than beside the member's manifest, so root lockfiles count too — but
 * only lockfiles. A dirty root *manifest* during a member upgrade is somebody
 * else's edit, and sweeping it in would break the promise above.
 */
export function dependencyPaths(
  candidates: readonly UpgradeCandidate[],
  dirty: readonly string[],
): string[] {
  const allowed = new Set<string>();

  for (const candidate of candidates) {
    const manager = packageManagerById(candidate.packageManager);
    if (!manager) continue;

    const dir = dirname(candidate.manifestPath);
    const prefix = dir === '.' || dir === '' ? '' : `${dir}/`;

    allowed.add(candidate.manifestPath);
    for (const file of manager.manifests) allowed.add(`${prefix}${file}`);
    for (const file of manager.lockfiles) {
      allowed.add(`${prefix}${file}`);
      allowed.add(file);
    }
  }

  return dirty.filter((path) => allowed.has(path)).sort();
}

/** Dirty paths that are a manifest or lockfile of any ecosystem Drift knows. */
export function dependencyFilesIn(dirty: readonly string[]): string[] {
  return dirty.filter((path) => DEPENDENCY_FILES.has(path.split('/').pop() ?? '')).sort();
}

/**
 * A branch name that says what is on it.
 *
 * `drift/upgrade-react-18.3.1-to-19.2.0-2026-07-31` reads as itself in a
 * branch list six weeks from now, which `drift/fix-1722384000` does not. The
 * date also gives same-package repeat runs a human-readable collision point
 * that can grow to `-1`, `-2`, and so on when the branch already exists.
 */
export function upgradeBranchName(
  candidates: readonly UpgradeCandidate[],
  options: { prefix?: string; now?: Date } = {},
): string {
  const prefix = (options.prefix ?? 'drift').replace(/\/+$/, '');
  const first = candidates[0];
  if (!first) return `${prefix}/upgrade`;
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);

  if (candidates.length === 1) {
    return `${prefix}/upgrade-${slug(first.name)}-${slug(first.current)}-to-${slug(targetVersion(first))}-${day}`;
  }

  return `${prefix}/upgrade-${candidates.length}-packages-${day}`;
}

/**
 * The commit message.
 *
 * Conventional-commit shaped because release tooling reads these, and because
 * `chore(deps)` is what every other dependency bot in the ecosystem emits — a
 * repository that already filters on it should not have to learn a second
 * convention for Drift. The body is the evidence, stated plainly enough that
 * reviewing the commit alone tells you why the version was considered safe.
 */
export function upgradeCommitMessage(candidates: readonly UpgradeCandidate[]): CommitMessage {
  const first = candidates[0];
  if (!first) return { subject: 'chore(deps): upgrade dependencies', body: '' };

  const subject =
    candidates.length === 1
      ? `chore(deps): upgrade ${first.name} to ${targetVersion(first)}`
      : `chore(deps): upgrade ${candidates.length} packages`;

  const lines = candidates.map((candidate) => `- ${describeUpgrade(candidate)}`);

  const breaking = candidates.reduce((total, c) => total + c.breakingCount, 0);
  const impacted = candidates.reduce((total, c) => total + (c.actionableImpactCount ?? 0), 0);
  // A measured build failure with nothing statically localized is a stronger,
  // different fact than "no breaking changes" or "nothing uses the affected
  // APIs" — see `severityOf`'s own `verification-failed` tier, reused here
  // rather than reconstructing the same distinction badly.
  const verificationFailed = candidates.some((c) => severityOf(c) === 'verification-failed');
  const runtimeUnresolved = candidates.some(
    (c) => c.runtimeCompatibility === 'unknown' || c.runtimeCompatibility === 'partial',
  );

  const body = [
    ...lines,
    '',
    verificationFailed
      ? "Drift installed this upgrade and the project's own checks failed, even though static analysis found no specific location to point at. Review the failure before shipping this."
      : breaking === 0
        ? 'Drift found no breaking changes upstream for these versions.'
        : runtimeUnresolved && impacted === 0
          ? `Drift found ${count(breaking, 'breaking change')} upstream, but could not establish runtime compatibility for this repository.`
          : `Drift found ${count(breaking, 'breaking change')} upstream and ${
              impacted === 0
                ? 'no code in this repository that uses the affected APIs'
                : `${count(impacted, 'place')} in this repository that use the affected APIs`
            }${runtimeUnresolved ? '; runtime compatibility still requires review' : ''}.`,
  ].join('\n');

  return { subject, body };
}

/** One package, its versions, and what the evidence said about it. */
function describeUpgrade(candidate: UpgradeCandidate): string {
  const where = candidate.workspace ? ` in ${candidate.workspaceName ?? candidate.workspace}` : '';
  // "None used here" is a positive claim about this repository, so it may not
  // be made over an unresolved package-wide runtime condition -- which
  // produces `impactCount === 0` exactly as a genuinely unaffected package
  // does.
  const runtimeUnresolved =
    candidate.runtimeCompatibility === 'unknown' || candidate.runtimeCompatibility === 'partial';
  const verdict =
    candidate.breakingCount === 0 && !runtimeUnresolved
      ? 'no breaking changes found'
      : runtimeUnresolved
        ? `${count(candidate.breakingCount, 'breaking change')} upstream, and runtime compatibility could not be established here`
        : candidate.actionableImpactCount === 0 && candidate.impactCount === 0
          ? `${count(candidate.breakingCount, 'breaking change')} upstream, none used here`
          : `${count(candidate.breakingCount, 'breaking change')} upstream, ${count(candidate.impactCount, 'site')} affected here`;

  return `${candidate.name} ${candidate.current} → ${targetVersion(candidate)}${where} (${verdict})`;
}

/**
 * The pull request body.
 *
 * A reviewer's first question about a dependency bump is "why is this safe?",
 * and the honest answer is a table of what was checked, not a lockfile diff. The
 * sites that need attention are named first, because those are the ones a
 * reviewer would otherwise have to find by reading the whole diff.
 */
export function pullRequestBody(candidates: readonly UpgradeCandidate[]): string {
  // `verification-failed` is included alongside `affected`: a measured build
  // failure with nothing statically localized needs a reviewer's attention at
  // least as much as a located site does, and `describeSeverity` already
  // shows it a different way in the table above — this section must not
  // silently drop it while claiming to name everything worth reviewing.
  const needsReview = candidates.filter((c) => {
    const severity = severityOf(c);
    return severity === 'affected' || severity === 'verification-failed' || severity === 'review-required' || severity === 'runtime-unresolved' || severity === 'evidence-missing';
  });

  const rows = candidates.map((candidate) => {
    const scope = candidate.workspace ? ` \`${candidate.workspace}\`` : '';
    return `| \`${candidate.name}\`${scope} | ${candidate.current} → ${targetVersion(candidate)} | ${describeSeverity(candidate)} | ${candidate.evidenceCount} | ${candidate.breakingCount} | ${candidate.impactCount} |`;
  });

  const lines = [
    candidates.length === 1
      ? `Upgrades **${candidates[0]!.name}** to ${targetVersion(candidates[0]!)}.`
      : `Upgrades ${candidates.length} packages.`,
    '',
    '| Package | Version | Verdict | Evidence | Breaking upstream | Sites here |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ];

  if (needsReview.length > 0) {
    lines.push(
      `### Needs review`,
      '',
      ...needsReview.map((candidate) =>
        severityOf(candidate) === 'verification-failed'
          ? `- **${candidate.name}** — installed and the project's own checks failed. Static analysis found no specific location to point at; see the verification output for what broke.`
          : `- **${candidate.name}** — ${candidate.actionableImpactCount ? `${count(candidate.actionableImpactCount, 'actionable place')} require edits.` : 'Local evidence is incomplete or requires review; no automatic edit is authorized.'}`,
      ),
      '',
    );
  }

  lines.push(
    'Evidence comes from the packages’ own changelogs, release notes, registry metadata and published type surfaces. ' +
      'Impact is the result of searching this repository for the APIs that actually changed — nothing here is inferred from version numbers alone.',
    '',
    '— opened by [Drift](https://github.com/trydrift/drift)',
  );

  return lines.join('\n');
}

/** `owner/repo` for a remote URL, or `null` when it is not a GitHub remote. */
export function remoteSlug(remoteUrl: string | null): string | null {
  return parseSlug(remoteUrl);
}

/**
 * GitHub's own "open a pull request" page for a branch.
 *
 * The fallback for everything the API path cannot do: a developer who declines
 * to sign in, a token without `repo`, an enterprise host Drift was not built
 * against. The branch is already pushed by the time this is offered, so the
 * page opens against real refs and the work is never stranded.
 */
export function compareUrl(remoteUrl: string | null, base: string, head: string): string | null {
  const slug = parseSlug(remoteUrl);
  if (!slug) return null;
  return `https://github.com/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

export interface PullRequest {
  url: string;
  number: number;
  /** True when a pull request for this branch already existed. */
  existing: boolean;
}

/**
 * Open a pull request, or find the one that is already open.
 *
 * Re-running an upgrade on a branch that already has a pull request is an
 * ordinary thing to do, and GitHub answers that with a 422 rather than a
 * pointer to the existing one. Turning that into "here is your pull request" is
 * the difference between a retry that works and an error the developer has to
 * interpret.
 */
export async function openPullRequest(args: {
  token: string;
  slug: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<PullRequest> {
  const [owner, repo] = args.slug.split('/');

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: githubHeaders(args.token),
    body: JSON.stringify({
      title: args.title,
      body: args.body,
      head: args.head,
      base: args.base,
      draft: args.draft ?? false,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (response.ok) {
    const created = (await response.json()) as { html_url: string; number: number };
    return { url: created.html_url, number: created.number, existing: false };
  }

  if (response.status === 422) {
    const existing = await findOpenPullRequest(args.token, args.slug, args.head);
    if (existing) return existing;
  }

  throw new Error(await describeGitHubError(response));
}

async function findOpenPullRequest(
  token: string,
  slug: string,
  head: string,
): Promise<PullRequest | null> {
  const [owner, repo] = slug.split('/');
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
    { headers: githubHeaders(token), signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) return null;

  const list = (await response.json()) as Array<{ html_url: string; number: number }>;
  const first = list[0];
  return first ? { url: first.html_url, number: first.number, existing: true } : null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'drift-vscode',
    'x-github-api-version': '2022-11-28',
  };
}

/**
 * GitHub's error, in the developer's terms.
 *
 * The API puts the useful part in `errors[].message` ("No commits between main
 * and drift/upgrade-react-18.3.1-to-19.2.0") and the useless part in the status
 * line, so surfacing the status alone would hide the one sentence that says
 * what to do.
 */
async function describeGitHubError(response: Response): Promise<string> {
  const detail = (await response.json().catch(() => null)) as {
    message?: string;
    errors?: Array<{ message?: string }>;
  } | null;

  const specific = detail?.errors?.map((error) => error.message).filter(Boolean).join('; ');
  if (specific) return specific;
  if (detail?.message) return detail.message;
  return `GitHub replied ${response.status}.`;
}

/** The version an upgrade actually installed. */
function targetVersion(candidate: UpgradeCandidate): string {
  return candidate.selected;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Lowercase, hyphenated, and safe as a git ref component. */
function slug(text: string): string {
  return text
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
