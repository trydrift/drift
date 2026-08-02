import type { DependencyChange } from '../types.js';

/**
 * Branch names, pull request titles, and where a pull request should land.
 *
 * Shared by the CLI, the GitHub Action, and the extension so that the same
 * upgrade produces the same branch name and the same title wherever it was
 * started from. A team that has learned to recognise `drift/upgrade-…` in the
 * branch list should not have to learn a second shape because someone ran the
 * CLI instead of clicking the button.
 *
 * Templates are deliberately a small, closed set of placeholders rather than a
 * templating language. A branch name is used to create refs and open pull
 * requests; letting arbitrary expressions into it buys nothing and adds an
 * injection surface for a value that comes from a package name.
 */

/** What a name can be built from. */
export interface NamingFacts {
  /** The dependency moves this branch is about. */
  changes: readonly Pick<DependencyChange, 'name' | 'from' | 'to'>[];
  /** Used for `{date}`. Injected so tests are not time-dependent. */
  now?: Date;
}

export interface NamingTemplates {
  /** Branch name, e.g. `{prefix}upgrade-{summary}-{date}`. */
  branch: string;
  /** Pull request and commit subject, e.g. `chore(deps): upgrade {summary}`. */
  title: string;
  /** Prepended to the branch, kept separate so it can be set on its own. */
  prefix: string;
}

export const DEFAULT_TEMPLATES: NamingTemplates = {
  branch: '{prefix}upgrade-{summary}-{date}',
  title: 'chore(deps): upgrade {summary}',
  prefix: 'drift/',
};

/**
 * The placeholders a template may use.
 *
 * `{summary}` is the one that carries the meaning: one package reads as
 * `zod-3.24.1-to-4.0.0`, several read as `4-packages`. Anything else would make
 * a branch name for a twelve-package run unusable.
 */
export function placeholders(facts: NamingFacts, prefix: string): Record<string, string> {
  const { changes } = facts;
  const now = facts.now ?? new Date();
  const first = changes[0];

  const summary = !first
    ? 'dependencies'
    : changes.length === 1
      ? `${first.name}-${first.from ?? 'unknown'}-to-${first.to ?? 'unknown'}`
      : `${changes.length}-packages`;

  const titleSummary = !first
    ? 'dependencies'
    : changes.length === 1
      ? `${first.name} to ${first.to ?? 'a new version'}`
      : `${changes.length} packages`;

  return {
    prefix,
    summary,
    'summary-text': titleSummary,
    name: first?.name ?? 'dependencies',
    from: first?.from ?? '',
    to: first?.to ?? '',
    count: String(changes.length),
    date: now.toISOString().slice(0, 10),
  };
}

function fill(template: string, values: Record<string, string>): string {
  // An unknown placeholder is left verbatim rather than blanked. A branch named
  // `drift/upgrade-{whoops}` is obviously wrong and gets fixed; a branch named
  // `drift/upgrade-` looks plausible and collides with the next one.
  return template.replace(/\{([a-z-]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/**
 * A git-legal branch name.
 *
 * Package names carry `@`, `/`, `:`, and `.` — all of which are either illegal
 * in a ref or change its meaning. `@octokit/rest` must not become a branch
 * inside a directory called `@octokit`, and a name ending in `.lock` is
 * rejected by git outright.
 */
export function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9/_.-]+/g, '-')
    // A leading `@` and an inner `/` in a package name would nest the ref.
    .replace(/(?<=[^/])\/(?=[^/])/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
    .replace(/\.lock$/, '-lock');

  // Git caps refs well above this; the limit here is what stays readable in a
  // branch list and in a `git checkout` a human types.
  return (cleaned || 'drift-upgrade').slice(0, 200).replace(/[-./]+$/, '');
}

export function branchNameFor(facts: NamingFacts, templates: Partial<NamingTemplates> = {}): string {
  const merged = { ...DEFAULT_TEMPLATES, ...templates };
  // A prefix is a directory segment; `drift` and `drift/` must mean the same.
  const prefix = merged.prefix ? `${merged.prefix.replace(/\/+$/, '')}/` : '';

  const filled = fill(merged.branch, placeholders(facts, prefix));

  // Sanitise the part after the prefix only, so the prefix keeps its slash.
  if (filled.startsWith(prefix) && prefix) {
    return `${prefix}${sanitizeBranchName(filled.slice(prefix.length))}`;
  }
  return sanitizeBranchName(filled);
}

export function titleFor(facts: NamingFacts, templates: Partial<NamingTemplates> = {}): string {
  const merged = { ...DEFAULT_TEMPLATES, ...templates };
  const values = placeholders(facts, merged.prefix);
  // `{summary}` in a title should read as prose, not as a branch slug.
  return fill(merged.title, { ...values, summary: values['summary-text']! }).trim();
}

/**
 * Where the pull request should merge into.
 *
 * `branched-from` is the default and the interesting one: the base is whatever
 * branch the work was started from, not the repository's default branch. On a
 * team that develops on `develop` and releases from `main`, or one that stacks
 * work on a feature branch, targeting the default branch quietly proposes
 * merging into the wrong place — and a pull request pointed at the wrong base
 * shows a diff full of other people's commits, which is the kind of mistake
 * that gets a tool switched off after one try.
 */
export type BaseBranchPolicy = 'branched-from' | 'default-branch';

export interface BaseResolution {
  branch: string;
  /** How it was decided, shown to the user so the choice is never a mystery. */
  reason: string;
}

/**
 * Decide the base branch from the policy and what git could tell us.
 *
 * `branchedFrom` being `null` is ordinary rather than exceptional — a branch
 * created before Drift ran, or one whose reflog has been pruned, simply has no
 * recorded start point. Falling back to the default branch and *saying so* is
 * better than either guessing silently or refusing to proceed.
 */
export function resolveBaseBranch(args: {
  policy: BaseBranchPolicy;
  branchedFrom: string | null;
  defaultBranch: string | null;
  currentBranch: string;
}): BaseResolution | null {
  const { policy, branchedFrom, defaultBranch, currentBranch } = args;

  if (policy === 'branched-from' && branchedFrom && branchedFrom !== currentBranch) {
    return { branch: branchedFrom, reason: `\`${currentBranch}\` was branched from \`${branchedFrom}\`` };
  }

  if (defaultBranch && defaultBranch !== currentBranch) {
    const reason =
      policy === 'branched-from'
        ? `Drift could not tell what \`${currentBranch}\` was branched from, so it is using the default branch`
        : 'configured to target the default branch';
    return { branch: defaultBranch, reason };
  }

  // Nothing to merge into: the current branch *is* the base.
  return null;
}
