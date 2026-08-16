/**
 * Repository access, abstracted away from GitHub.
 *
 * The analysis pipeline only ever needs a few things from a repository: which
 * files changed between two refs, the contents of a file at a ref, and — for
 * configuration that names files by pattern — which files exist at a ref.
 * Naming that as an interface is what lets Drift run with no network and no
 * credentials at all: a local git checkout answers all three perfectly well,
 * and far faster than the API does.
 *
 * This is the seam that makes the VS Code extension possible without asking
 * anyone for a token.
 */
export interface RepoProvider {
  /** Files changed between the two refs, repo-relative. */
  changedFiles(): Promise<string[]>;

  /** File contents at a ref, or `null` if it does not exist there. */
  readFile(path: string, ref: string): Promise<string | null>;

  /**
   * Every file tracked at a ref, repo-relative, or `null` if it cannot be
   * listed.
   *
   * `null` rather than `[]`, because the difference matters: an empty
   * repository and a listing that failed lead to opposite conclusions, and a
   * caller expanding a glob against `[]` would conclude the pattern matches
   * nothing and report a clean result for files it never looked at.
   *
   * Optional so a provider that genuinely cannot enumerate is not forced to
   * lie about it. Callers must handle its absence as "unknown", never as
   * "empty".
   */
  listFiles?(ref: string): Promise<string[] | null>;
}

/** Identifies the commit range under analysis. */
export interface RefRange {
  /** Commit before the change. */
  before: string;
  /** Commit after the change. */
  after: string;
}
