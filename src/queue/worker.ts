import type { Logger } from '../util/logger.js';
import { MAX_ATTEMPTS, backoffMs, type Job, type JobQueue } from './types.js';

/**
 * Drains the queue, one job at a time.
 *
 * Serial rather than concurrent, and that is a decision rather than a
 * simplification: a Drift job runs a whole analysis pipeline, and two of them
 * racing on the same repository would duplicate branches and API spend for no
 * gain. Throughput is not the constraint here — a webhook runner watching one
 * organisation sees a handful of pushes a minute at most.
 */

export interface QueueWorkerOptions {
  queue: JobQueue;
  handler: (job: Job) => Promise<void>;
  logger: Logger;
  /** How long to wait after finding the queue empty. */
  pollIntervalMs?: number;
}

export class QueueWorker {
  private readonly queue: JobQueue;
  private readonly handler: (job: Job) => Promise<void>;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;

  private running = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;

  constructor(options: QueueWorkerOptions) {
    this.queue = options.queue;
    this.handler = options.handler;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this.run();
  }

  /**
   * Stop accepting work and wait for the job in flight.
   *
   * The wait is the point. Killing a running job would leave it `running` in
   * the database until the next startup recovers it, so a clean shutdown that
   * lets it finish is the difference between a deploy costing nothing and a
   * deploy costing a duplicate analysis.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.wakeUp?.();
    await this.loop;
    this.running = false;
    this.loop = null;
  }

  /** Cut a poll short — used when something has just been enqueued. */
  notify(): void {
    this.wakeUp?.();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let job: Job | null = null;

      try {
        job = await this.queue.claim();
      } catch (err) {
        // The queue itself being unavailable is not a reason to exit the loop;
        // it is usually a transient file lock.
        this.logger.error(`Could not claim a job: ${(err as Error).message}`);
      }

      // `stop()` can be called while the claim above is in flight, before
      // there is a sleep for it to interrupt. Re-checking here is what stops
      // shutdown from waiting out a full poll interval it did not need to.
      if (this.stopping) {
        if (job) await this.queue.fail(job.id, 'worker shut down before processing', Date.now());
        return;
      }

      if (!job) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      await this.process(job);
    }
  }

  private async process(job: Job): Promise<void> {
    const started = Date.now();
    try {
      await this.handler(job);
      await this.queue.complete(job.id);
      this.logger.info(
        `Delivery ${job.deliveryId} (${job.event}) completed in ${Date.now() - started}ms`,
      );
    } catch (err) {
      const message = (err as Error).message ?? String(err);

      if (job.attempts >= MAX_ATTEMPTS) {
        // Terminal. Surfaced in `/health` so a failed delivery is discoverable
        // without reading logs.
        await this.queue.fail(job.id, message);
        this.logger.error(
          `Delivery ${job.deliveryId} (${job.event}) failed permanently after ${job.attempts} attempts: ${message}`,
        );
        return;
      }

      const delay = backoffMs(job.attempts);
      await this.queue.fail(job.id, message, Date.now() + delay);
      this.logger.warn(
        `Delivery ${job.deliveryId} (${job.event}) failed on attempt ${job.attempts}; retrying in ${Math.round(delay / 1000)}s: ${message}`,
      );
    }
  }

  /** Interruptible sleep, so shutdown does not wait out a full poll interval. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        // Cleared so a later `notify()` cannot resolve an already-settled sleep.
        this.wakeUp = null;
        resolve();
      };

      // Deliberately not `unref`'d. An unref'd poll timer lets the event loop
      // drain while this promise is still pending, so `stop()` would await a
      // sleep that never resolves. A worker that is running is a reason for
      // the process to stay alive; shutdown is explicit, via `stop()`.
      const timer = setTimeout(finish, ms);
      this.wakeUp = finish;
    });
  }
}
