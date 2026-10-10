import type { DbOrTx } from '../db/repositories.js';
import { insertOccurrence, listPendingFuture, skipPendingForReminder } from '../db/repositories.js';
import type { Occurrence, Reminder } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { JobQueue } from './queue.js';
import { nextFireAt, type RecurrenceSpec } from './recurrence.js';

/** Postgres returns `timestamp` columns as "YYYY-MM-DD HH:mm:ss"; normalise to ISO. */
export function toIsoLocal(value: string): string {
  return value.replace(' ', 'T').replace(/\.\d+$/, '');
}

export function specOf(r: Pick<Reminder, 'startLocal' | 'rrule' | 'timezone'>): RecurrenceSpec {
  return { startLocal: toIsoLocal(r.startLocal), rrule: r.rrule, timezone: r.timezone };
}

export type ScheduledOccurrence = Pick<Occurrence, 'id' | 'fireAt' | 'offsetMinutes'>;

/**
 * Computes and stores occurrences. Only the next occurrence per offset is ever stored.
 * Methods that write take a DbOrTx so callers can include them in their transaction;
 * they return what was created so the caller can enqueue after commit via `enqueue()`.
 */
export class Scheduler {
  constructor(
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Stores the next occurrence for each offset of a reminder, starting from now. */
  async scheduleInitial(db: DbOrTx, reminder: Reminder): Promise<ScheduledOccurrence[]> {
    const now = this.clock.now();
    const created: ScheduledOccurrence[] = [];
    for (const offset of reminder.offsetsMinutes) {
      const fireAt = nextFireAt(specOf(reminder), offset, now);
      if (!fireAt) continue;
      const o = await insertOccurrence(db, { reminderId: reminder.id, offsetMinutes: offset, fireAt });
      if (o) created.push(o);
    }
    return created;
  }

  /**
   * After an occurrence fired/failed/was skipped, stores the next one for the same offset.
   * `notBefore` is normally the occurrence's own fire_at; after a long outage it is "now"
   * so we don't replay a backlog.
   */
  async scheduleNext(
    db: DbOrTx,
    reminder: Reminder,
    offsetMinutes: number,
    notBefore: Date,
  ): Promise<ScheduledOccurrence | undefined> {
    if (!reminder.active || !reminder.rrule) return undefined;
    const fireAt = nextFireAt(specOf(reminder), offsetMinutes, notBefore);
    if (!fireAt) return undefined;
    return insertOccurrence(db, { reminderId: reminder.id, offsetMinutes, fireAt });
  }

  /** Drops pending occurrences and recomputes them (after an edit or timezone change). */
  async reschedule(db: DbOrTx, reminder: Reminder): Promise<ScheduledOccurrence[]> {
    await skipPendingForReminder(db, reminder.id);
    if (!reminder.active) return [];
    return this.scheduleInitial(db, reminder);
  }

  async cancel(db: DbOrTx, reminderId: number): Promise<void> {
    await skipPendingForReminder(db, reminderId);
  }

  /** Enqueues delivery jobs. Call after the transaction that created the occurrences commits. */
  async enqueue(occurrences: (ScheduledOccurrence | undefined)[]): Promise<void> {
    for (const o of occurrences) {
      if (!o) continue;
      try {
        await this.queue.enqueue(o.id, o.fireAt);
      } catch (err) {
        // Not fatal: the sweeper delivers anything the queue misses.
        this.logger.warn({ err, occurrenceId: o.id }, 'Failed to enqueue occurrence; sweeper will pick it up');
      }
    }
  }

  /** Re-enqueues every future pending occurrence (startup safety net; duplicates are deduped). */
  async requeueFuture(db: DbOrTx): Promise<number> {
    const pending = await listPendingFuture(db, this.clock.now());
    await this.enqueue(pending);
    return pending.length;
  }
}
