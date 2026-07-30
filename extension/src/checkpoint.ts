import { Git } from './git.js';

/**
 * Rewind.
 *
 * Every turn the developer takes starts by recording what the repository looked
 * like, so that "put it back the way it was" is always available and always
 * exact. The alternative — reading a diff and reversing it — is guesswork the
 * moment an agent creates a file, deletes one, or edits something Drift never
 * planned to touch.
 *
 * A checkpoint is a git tree object and nothing else. It costs one `write-tree`
 * against a scratch index, it is deduplicated by git's own object store, and it
 * is unreachable from any ref, so it costs nothing permanent either: an ordinary
 * `git gc` collects the ones that are no longer referenced once the session ends.
 * Nothing is committed, no branch moves, and the developer's staging area is
 * untouched.
 */

export interface Checkpoint {
  id: string;
  /** The tree object holding the whole working tree at that moment. */
  tree: string;
  /** Where HEAD was, so a rewind can say whether commits have happened since. */
  head: string | null;
  label: string;
  at: number;
}

export class Checkpoints {
  private readonly entries = new Map<string, Checkpoint>();
  private counter = 0;

  constructor(private readonly root: string) {}

  get size(): number {
    return this.entries.size;
  }

  get(id: string): Checkpoint | undefined {
    return this.entries.get(id);
  }

  /**
   * Record the current working tree.
   *
   * Returns `null` rather than throwing when the snapshot cannot be taken — a
   * folder that is not a git repository, a git binary that is not installed. A
   * missing rewind button is a fair outcome there; a failed turn is not.
   */
  async capture(label: string): Promise<Checkpoint | null> {
    const git = new Git(this.root);
    try {
      const tree = await git.snapshotTree();
      const head = await git.headSha().catch(() => null);
      this.counter += 1;
      const checkpoint: Checkpoint = { id: `c${this.counter}`, tree, head, label, at: Date.now() };
      this.entries.set(checkpoint.id, checkpoint);
      return checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Restore a checkpoint, reporting what it touched.
   *
   * The file list is gathered before the restore, because afterwards there is
   * nothing left to compare against — and the developer's first question after
   * a rewind is always "what did that just change?".
   */
  async restore(id: string): Promise<{ files: string[]; commitsSince: boolean }> {
    const checkpoint = this.entries.get(id);
    if (!checkpoint) throw new Error('That checkpoint is no longer available.');

    const git = new Git(this.root);
    const files = await git.changedAgainstTree(checkpoint.tree);
    const head = await git.headSha().catch(() => null);

    await git.restoreTree(checkpoint.tree);

    // Everything taken after this point describes a repository that no longer
    // exists, so rewinding twice to the same place cannot half-work.
    this.forgetAfter(checkpoint);

    return { files, commitsSince: Boolean(head && checkpoint.head && head !== checkpoint.head) };
  }

  private forgetAfter(checkpoint: Checkpoint): void {
    for (const [id, entry] of this.entries) {
      if (entry.at > checkpoint.at) this.entries.delete(id);
    }
  }
}
