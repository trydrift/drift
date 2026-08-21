/**
 * A ceiling on how long one case may take.
 *
 * Learned the hard way. A whole-corpus run of swe-bump-bench and a 40-case run
 * of BUMP both sat at 0% CPU for five hours, having accumulated five minutes
 * and forty-three seconds of CPU time respectively. They were not slow; they
 * were stopped, waiting on a network call that never returned and had no
 * abort. Nothing was written, so nothing was recoverable — five hours produced
 * no artifact at all.
 *
 * The failure is structural rather than incidental. These adapters drive the
 * real production pipeline against the live network, and production is
 * entitled to wait on a registry: a developer sitting at a terminal can see it
 * hang and press ctrl-C. A batch run over sixty repositories cannot, and one
 * unlucky case must not be able to cost the other fifty-nine their results.
 *
 * So every case runs under a deadline, and a case that exceeds it becomes a
 * recorded exclusion with `timed-out` in its reason rather than a hung
 * process. The run continues, the other cases still produce results, and the
 * artifact says exactly which case stalled and for how long — which is a
 * finding about Drift's behaviour on that repository, and is strictly more
 * information than an empty directory.
 *
 * The timeout does not stop the underlying work, because a promise cannot be
 * cancelled. The stalled operation keeps its socket until the process exits.
 * That is acceptable for a benchmark run and is stated rather than implied:
 * this bounds *reporting*, not resource use.
 *
 * One more thing it does not bound, learned from an artifact showing a single
 * case at 28,938 seconds under a 900-second deadline: **host sleep**. A laptop
 * that suspends stops firing timers while `Date.now()` keeps advancing, so a
 * case spanning a suspend records hours of wall clock without ever having been
 * given hours of deadline. Nothing here is wrong when that happens — the case
 * completed normally on wake — but a `durationMs` in these artifacts is wall
 * clock, not CPU time, and is not a performance measurement. No metric this
 * harness reports is derived from it.
 */

export const DEFAULT_CASE_TIMEOUT_MS = 900_000;

export class CaseTimeout extends Error {
  readonly elapsedMs: number;

  constructor(elapsedMs: number) {
    super(`the case exceeded its ${Math.round(elapsedMs / 1000)}s deadline and was abandoned so the run could continue`);
    this.name = 'CaseTimeout';
    this.elapsedMs = elapsedMs;
  }
}

export async function withDeadline<T>(work: () => Promise<T>, timeoutMs = DEFAULT_CASE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CaseTimeout(timeoutMs)), timeoutMs);
  });

  /*
   * The timer is deliberately *not* `unref`'d.
   *
   * Unref'ing looks like the tidy choice — it stops the timer holding the
   * process open — and it defeats the whole mechanism: a stalled case is
   * precisely the situation where nothing else is keeping the event loop
   * alive, so an unref'd timer never fires and Node exits with the run
   * unresolved. The first version did this and the test below caught it.
   *
   * Holding the loop open is safe because `clearTimeout` runs in the `finally`
   * as soon as the race settles either way, so the timer never outlives the
   * case it is bounding.
   */

  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
