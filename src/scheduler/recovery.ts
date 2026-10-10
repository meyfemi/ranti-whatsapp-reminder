import type { Db } from '../db/client.js';
import { deleteExpiredInteractions, listPendingDue } from '../db/repositories.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { Scheduler } from './scheduler.js';

export interface OccurrenceDispatcher {
  dispatch(occurrenceId: number): Promise<unknown>;
}

/**
 * Missed-job recovery and the safety-net sweeper. The database is the source of truth:
 * anything pending and due is delivered (or skipped if too late) regardless of the job queue.
 */
export class Recovery {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly db: Db,
    private readonly scheduler: Scheduler,
    private readonly dispatcher: OccurrenceDispatcher,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** On startup: re-enqueue future occurrences and deliver/skip anything that was missed. */
  async runStartup(): Promise<{ requeued: number; due: number }> {
    const requeued = await this.scheduler.requeueFuture(this.db);
    const due = await this.sweepDue();
    this.logger.info({ requeued, due }, 'Startup recovery complete');
    return { requeued, due };
  }

  /**
   * Dispatches every pending occurrence whose time has come. The dispatcher decides whether
   * each is on time, slightly late (noted) or too late (skipped, next one scheduled).
   */
  async sweepDue(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const due = await listPendingDue(this.db, this.clock.now());
      for (const occ of due) {
        try {
          await this.dispatcher.dispatch(occ.id);
        } catch (err) {
          this.logger.warn({ err, occurrenceId: occ.id }, 'Sweeper dispatch failed');
        }
      }
      await deleteExpiredInteractions(this.db, this.clock.now());
      return due.length;
    } finally {
      this.sweeping = false;
    }
  }

  startSweeper(intervalMs = 60_000): void {
    this.stopSweeper();
    this.timer = setInterval(() => {
      this.sweepDue().catch((err) => this.logger.error({ err }, 'Sweeper crashed'));
    }, intervalMs);
    this.timer.unref();
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
