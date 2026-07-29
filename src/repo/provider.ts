/**
 * Repository access, abstracted away from GitHub.
 *
 * The analysis pipeline only ever needs two things from a repository: which
 * files changed between two refs, and the contents of a file at a ref. Naming
 * that as an interface is what lets Drift run with no network and no
 * credentials at all — a local git checkout answers both questions perfectly
 * well, and far faster than the API does.
 *
 * This is the seam that makes the VS Code extension possible without asking
 * anyone for a token.
 */
export interface RepoProvider {
  /** Files changed between the two refs, repo-relative. */
  changedFiles(): Promise<string[]>;

  /** File contents at a ref, or `null` if it does not exist there. */
  readFile(path: string, ref: string): Promise<string | null>;
}

/** Identifies the commit range under analysis. */
export interface RefRange {
  /** Commit before the change. */
  before: string;
  /** Commit after the change. */
  after: string;
}
