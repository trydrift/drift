import semver from 'semver';
import type { Ecosystem } from '../types.js';
import { normalizeVersion } from '../detect/version.js';
import type { RegistryInfo, RepositoryStatus, VersionInfo } from '../evidence/registry.js';
import type { MaintenanceAssessment, MaintenanceFact } from './types.js';
import type { RuntimeDeclaration } from './runtime.js';

/**
 * Whether this package is still looked after — stated, not scored.
 *
 * The temptation here is a number: commits per month, days since release,
 * bus factor, a badge. Drift does not produce one, deliberately. A mature
 * library can go eighteen months without a commit because it is finished, and
 * a score that reads that as decay will talk a team out of a dependency that
 * was never a problem — while a package that ships weekly and was archived
 * yesterday scores beautifully right up until it stops.
 *
 * So this module emits sentences a developer can check, each with a link, and
 * marks exactly three of them as concerning: the maintainer said stop
 * (deprecated, yanked, retracted), the repository is archived, or the version
 * being proposed is itself withdrawn. Everything else is context.
 */

export interface MaintenanceInput {
  name: string;
  ecosystem: Ecosystem;
  from: string;
  to: string;
  registry: RegistryInfo | null;
  repository: RepositoryStatus | null;
  currentVersion: VersionInfo | null;
  targetVersion: VersionInfo | null;
  /** Evaluated against this instant, so the output is testable. */
  now?: Date;
  /**
   * Where this repository itself declares its Node.js version --
   * `package.json#engines`, `.nvmrc`, Dockerfiles, CI workflows -- so a
   * raised floor can be checked against this repository instead of merely
   * flagged for the developer to check by hand. Omitted when that has not
   * been gathered, in which case the fact falls back to the generic prompt.
   */
  repoRuntime?: readonly RuntimeDeclaration[];
  /**
   * Where this repository declares its own Python version --
   * `pyproject.toml#project.requires-python`, `setup.cfg`/`setup.py`,
   * `.python-version`, `runtime.txt`. Kept apart from `repoRuntime` rather
   * than merged into it: a Python floor like ">=3.9" also parses as a valid
   * semver range, so feeding it into the Node.js comparator would silently
   * compare the wrong language's numbers.
   */
  pythonRuntime?: readonly RuntimeDeclaration[];
  /**
   * Runtimes (`'node'`, `'python'`, `'go'`, `'ruby'`, `'java'`, `'rust'`) for
   * which a canonical `RuntimeRequirementAnalysis` already answered
   * compatibility for this dependency. Maintenance still states the upstream
   * fact for those, but does not run its own repository check against them —
   * that verdict has one owner, and two independent answers is precisely how
   * the report ends up contradicting itself (rationale says the repository
   * satisfies the floor while maintenance tells the reader to go check it).
   */
  analyzedRuntimeRequirements?: readonly { runtime: string; requirement: string }[];
  /** Legacy name-only input; retained conservatively for direct callers. */
  /** @deprecated Name-only coverage is unsafe and is ignored. */
  analyzedRuntimes?: readonly string[];
}

export function assessMaintenance(input: MaintenanceInput): MaintenanceAssessment {
  const { name, registry, repository, currentVersion, targetVersion } = input;
  const now = input.now ?? new Date();
  const facts: MaintenanceFact[] = [];

  const deprecated = targetVersion?.withdrawn ?? registry?.deprecated ?? undefined;
  if (deprecated) {
    facts.push({
      statement: `The maintainer has withdrawn ${name} ${input.to}: ${deprecated}`,
      url: registry?.homepage ?? undefined,
      concerning: true,
      polarity: 'blocks',
    });
  }

  if (repository?.archived) {
    facts.push({
      statement: 'The upstream repository is archived. It will not receive further fixes.',
      url: repository.url,
      concerning: true,
      polarity: 'blocks',
    });
  } else if (repository?.pushedAt) {
    // Stated as a date, not judged. A reader who knows the package decides
    // whether eighteen months is neglect or stability.
    facts.push({
      statement: `The repository was last pushed to ${describeAge(repository.pushedAt, now)}.`,
      url: repository.url,
    });
  }

  if (currentVersion?.withdrawn && !deprecated) {
    facts.push({
      statement: `The version currently installed, ${input.from}, has been withdrawn: ${currentVersion.withdrawn}`,
      concerning: true,
      // A real reason to move: the version in use today is the one that is
      // bad, not the target, so this argues for taking the upgrade.
      polarity: 'favors',
    });
  }

  const latestStable = highestStable(registry?.versions ?? []);
  if (latestStable) {
    const target = normalizeVersion(input.to);
    if (target && semver.eq(latestStable, target)) {
      facts.push({ statement: `${input.to} is the latest stable release.` });
    } else if (target && semver.gt(latestStable, target)) {
      facts.push({
        statement: `${input.to} is not the latest release; ${latestStable} is also available.`,
      });
    }
  }

  if (targetVersion?.releasedAt) {
    facts.push({ statement: `The target version was released ${describeAge(targetVersion.releasedAt, now)}.` });
  }

  const runtimeChange = describeRuntimeChange(currentVersion, targetVersion);
  if (runtimeChange) facts.push(runtimeChange);

  const releaseLine = describeReleaseLine(input, latestStable);
  if (releaseLine) facts.push(releaseLine);

  return {
    facts,
    ...(deprecated ? { deprecated } : {}),
    ...(repository?.archived ? { archived: true } : {}),
    ...(latestStable ? { latestStable } : {}),
    ...(targetVersion?.releasedAt ? { targetReleasedAt: targetVersion.releasedAt } : {}),
  };
}

/**
 * A raised runtime minimum.
 *
 * One of the two breaking changes that renames nothing — no symbol moved, so no
 * API diff and no symbol rule can see it, and it breaks the build outright on
 * an older runtime. Reported as a plain statement of fact.
 */
function describeRuntimeChange(
  current: VersionInfo | null,
  target: VersionInfo | null,
): MaintenanceFact | null {
  const before = current?.runtime;
  const after = target?.runtime;
  if (!after) return null;
  if (before && before.requirement === after.requirement) return null;

  const introduced = !before;
  const statement = introduced
    ? `The target version requires ${after.name} ${after.requirement}.`
    : `The required ${after.name} version changed from ${before!.requirement} to ${after.requirement}.`;

  // Maintenance states the upstream fact and nothing more. Whether this
  // repository satisfies, violates, partially overlaps, or leaves unknown this
  // floor — and whether that blocks the upgrade — is decided once, by the
  // canonical `RuntimeRequirementAnalysis` that every runtime metadata bump now
  // flows through (see `evidence/index.ts` -> `analyze/index.ts`). A second
  // verdict here would only ever agree redundantly or contradict it.
  return { statement, concerning: false, polarity: 'context' };
}

/**
 * Did the floor actually go up?
 *
 * Only the leading version in each requirement is compared, which is what a
 * minimum is in every syntax that matters here — `>=18`, `>=1.21`, `>=3.9`.
 * Anything this cannot parse is reported as a change without a judgement,
 * which is the honest outcome.
 */
export function raisesMinimum(before: string, after: string): boolean {
  const floor = (requirement: string) =>
    normalizeVersion(/(\d+(?:\.\d+)*)/.exec(requirement)?.[1] ?? '');
  const [low, high] = [floor(before), floor(after)];
  return Boolean(low && high && semver.gt(high, low));
}

/**
 * Whether the version currently installed is still in the line the maintainer
 * supports.
 *
 * Stated only where it can be derived: being more than one major version behind
 * the latest release is a fact about the version numbers, not an inference
 * about the maintainer's policy, and it is phrased that way.
 */
function describeReleaseLine(
  input: MaintenanceInput,
  latestStable: string | null,
): MaintenanceFact | null {
  const current = normalizeVersion(input.from);
  if (!current || !latestStable) return null;

  const behind = semver.major(latestStable) - semver.major(current);
  if (behind < 1) return null;

  return {
    statement: `The installed version ${input.from} is ${behind} major version${behind === 1 ? '' : 's'} behind the latest release, ${latestStable}. Maintainers rarely backport fixes that far.`,
  };
}

function highestStable(versions: readonly string[]): string | null {
  const stable = versions
    .map((raw) => normalizeVersion(raw))
    .filter((v): v is string => v !== null && !semver.prerelease(v))
    .sort(semver.rcompare);
  return stable[0] ?? null;
}

/**
 * "18 days ago", "about 2 years ago".
 *
 * Rendered relative because the question a reader is asking is how stale this
 * is, and an absolute date makes them do the subtraction.
 */
export function describeAge(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return `on ${iso}`;

  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days < 0) return `on ${then.toISOString().slice(0, 10)}`;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;

  const months = Math.round(days / 30.44);
  if (months < 24) return `about ${months} months ago`;
  return `about ${Math.round(days / 365.25)} years ago`;
}

