import { redactText, startRunLog, withSpan } from '../../src/util/diagnostics.js';

export async function runRepoDiagnostic<T>(
  args: {
    command: string;
    type?: string;
    mode: 'quick' | 'deep';
    repoRoot: string;
    spanName: string;
    spanMeta?: Record<string, unknown>;
    isCancelled?: () => boolean;
  },
  work: () => Promise<T>,
): Promise<T> {
  const log = startRunLog({
    command: args.command,
    type: args.type ?? `scan-${args.mode}`,
    mode: args.mode,
    repoRoot: args.repoRoot,
  });

  try {
    const result = await log.run(() => withSpan(args.spanName, args.spanMeta, work));
    log.finish(args.isCancelled?.() ? 'cancelled' : 'ok');
    return result;
  } catch (err) {
    log.finish('threw', {
      message: redactText(err instanceof Error ? err.message : String(err)),
    });
    throw err;
  }
}
