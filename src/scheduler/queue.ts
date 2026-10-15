import { PgBoss } from 'pg-boss';
import type { Logger } from '../logger.js';

/**
 * Delivers "this occurrence is due" signals. The database is the source of truth; the queue
 * only makes delivery punctual. Enqueueing the same occurrence twice is harmless.
 */
export interface JobQueue {
  enqueue(occurrenceId: number, fireAt: Date): Promise<void>;
  /** Same, for a weekly digest run. */
  enqueueDigest(runId: number, fireAt: Date): Promise<void>;
}

export type OccurrenceHandler = (occurrenceId: number) => Promise<void>;
export type DigestHandler = (runId: number) => Promise<void>;

export const FIRE_QUEUE = 'fire-occurrence';
export const DIGEST_QUEUE = 'fire-digest';
const RETRY = { retryLimit: 3, retryDelay: 20, retryBackoff: true } as const;

export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;

  constructor(
    connectionString: string,
    private readonly logger: Logger,
  ) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss' });
    this.boss.on('error', (err) => this.logger.error({ err }, 'pg-boss error'));
  }

  async start(handler: OccurrenceHandler, digestHandler?: DigestHandler): Promise<void> {
    await this.boss.start();
    // "exclusive" + singletonKey: at most one queued-or-active job per occurrence (or digest run).
    await this.boss.createQueue(FIRE_QUEUE, { policy: 'exclusive' });
    await this.boss.work<{ occurrenceId: number }>(FIRE_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data.occurrenceId);
      }
    });
    await this.boss.createQueue(DIGEST_QUEUE, { policy: 'exclusive' });
    if (digestHandler) {
      await this.boss.work<{ runId: number }>(DIGEST_QUEUE, { pollingIntervalSeconds: 5 }, async (jobs) => {
        for (const job of jobs) await digestHandler(job.data.runId);
      });
    }
  }

  async enqueueDigest(runId: number, fireAt: Date): Promise<void> {
    await this.boss.send(DIGEST_QUEUE, { runId }, { startAfter: fireAt, singletonKey: `digest-${runId}`, ...RETRY });
  }

  async enqueue(occurrenceId: number, fireAt: Date): Promise<void> {
    await this.boss.send(
      FIRE_QUEUE,
      { occurrenceId },
      {
        startAfter: fireAt,
        singletonKey: `occ-${occurrenceId}`,
        ...RETRY,
      },
    );
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

/**
 * A queue that only records what was enqueued. Used with a fake clock (CLI fast-forward, tests),
 * where due occurrences are found by the sweeper reading the database instead.
 */
export class ManualQueue implements JobQueue {
  readonly enqueued: { occurrenceId: number; fireAt: Date }[] = [];
  readonly enqueuedDigests: { runId: number; fireAt: Date }[] = [];
  async enqueue(occurrenceId: number, fireAt: Date): Promise<void> {
    this.enqueued.push({ occurrenceId, fireAt });
  }
  async enqueueDigest(runId: number, fireAt: Date): Promise<void> {
    this.enqueuedDigests.push({ runId, fireAt });
  }
}
