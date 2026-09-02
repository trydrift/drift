import { rm } from 'node:fs/promises';

type Remove = typeof rm;

/**
 * Best-effort removal for benchmark worktrees.
 *
 * A case result has already been computed when this runs, so cleanup must not
 * replace that result with `reproduction-failed`. Node retries transient
 * ENOTEMPTY/EBUSY races for recursive removals; a final failure is recorded on
 * stderr and deliberately swallowed.
 */
export async function cleanupTemporaryDirectory(
  path: string,
  options: { remove?: Remove; log?: (message: string) => void } = {},
): Promise<void> {
  const remove = options.remove ?? rm;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    await remove(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    log(`[eval:cleanup] could not remove temporary directory ${path}: ${(error as Error).message}`);
  }
}
