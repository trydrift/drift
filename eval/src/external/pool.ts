/**
 * A bounded worker pool for whole benchmark cases.
 *
 * These corpora run one case at a time, and a case is a git fetch, a network
 * round of registry and artifact reads, and — for the Java and Python tracks —
 * the project's own build. BUMP's 546 measured cases came to **22.7 hours**
 * that way, a median of 63 seconds each with a tail reaching 75 minutes, and
 * almost all of it waiting rather than computing.
 *
 * The cases are independent by construction: each clones into its own
 * temporary directory, and the runners already treat results as a set rather
 * than a sequence. So the only shared thing is the checkpoint file, and that
 * is serialized at the writer (see `checkpoint` in `cli.ts`) rather than by
 * running everything single-file.
 *
 * Deliberately not `Promise.all` over everything: a benchmark that starts 546
 * Maven builds at once finishes none of them. The bound is the point, and it
 * is the caller's to choose because the right number depends on whether the
 * dataset's cases are network-bound or compile-bound.
 */

/** Runs `work` over `items`, at most `limit` in flight, preserving nothing but completion. */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const bound = Math.max(1, Math.floor(limit));
  if (bound === 1) {
    // The serial path stays genuinely serial rather than a pool of one, so a
    // run pinned to `--concurrency 1` behaves exactly as it did before pools
    // existed — which is what makes it a usable control when a concurrent run
    // produces a surprising number.
    for (const [index, item] of items.entries()) await work(item, index);
    return;
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(bound, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
}
