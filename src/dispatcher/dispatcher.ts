import { and, eq, sql } from 'drizzle-orm';
import type { ChatAdapter } from '../adapters/types.js';
import type { Db } from '../db/client.js';
import { getGroup, getMember, getOccurrence, getReminder } from '../db/repositories.js';
import { occurrences } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../scheduler/clock.js';
import type { ScheduledOccurrence, Scheduler } from '../scheduler/scheduler.js';
import type { Greeter } from './greetings.js';
import { buildReminderMessage } from './messages.js';

export type DispatchOutcome = 'sent' | 'skipped' | 'noop' | 'early' | 'failed' | 'retry';

export interface DispatcherOptions {
  /** Occurrences later than this are skipped instead of sent (default 6h). */
  maxLatenessMs?: number;
  /** Occurrences later than this get a "(slightly late)" note (default 2 min). */
  lateNoteAfterMs?: number;
  /** After this many failed send attempts the occurrence is marked failed (default 4). */
  maxAttempts?: number;
}

const HOUR = 3_600_000;

/**
 * Sends due occurrences. Idempotent: the occurrence row is locked and moved pending → sent in
 * one transaction, so duplicate jobs, retries and the sweeper can never double-post.
 */
export class Dispatcher {
  private readonly maxLatenessMs: number;
  private readonly lateNoteAfterMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Db,
    private readonly adapter: ChatAdapter,
    private readonly scheduler: Scheduler,
    private readonly greeter: Greeter,
    private readonly clock: Clock,
    private readonly logger: Logger,
    opts: DispatcherOptions = {},
  ) {
    this.maxLatenessMs = opts.maxLatenessMs ?? 6 * HOUR;
    this.lateNoteAfterMs = opts.lateNoteAfterMs ?? 2 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
  }

  async dispatch(occurrenceId: number): Promise<DispatchOutcome> {
    const now = this.clock.now();
    let next: ScheduledOccurrence | undefined;
    let outcome: DispatchOutcome;
    try {
      outcome = await this.db.transaction(async (tx) => {
        const [occ] = await tx
          .select()
          .from(occurrences)
          .where(and(eq(occurrences.id, occurrenceId), eq(occurrences.status, 'pending')))
          .for('update', { skipLocked: true });
        if (!occ) return 'noop'; // already handled, or being handled by another worker

        const reminder = await getReminder(tx, occ.reminderId);
        const group = reminder ? await getGroup(tx, reminder.groupId) : undefined;
        if (!reminder || !group || !reminder.active || !group.active) {
          await tx.update(occurrences).set({ status: 'skipped' }).where(eq(occurrences.id, occ.id));
          return 'skipped';
        }

        const latenessMs = now.getTime() - occ.fireAt.getTime();
        if (latenessMs < -5_000) return 'early';
        if (latenessMs > this.maxLatenessMs) {
          await tx.update(occurrences).set({ status: 'skipped' }).where(eq(occurrences.id, occ.id));
          // Resume from now rather than replaying a backlog of missed occurrences.
          next = await this.scheduler.scheduleNext(tx, reminder, occ.offsetMinutes, now);
          this.logger.warn({ occurrenceId, latenessMs }, 'Occurrence too late; skipped');
          return 'skipped';
        }

        const subject = reminder.subjectMemberId ? await getMember(tx, reminder.subjectMemberId) : undefined;
        const message = await buildReminderMessage({
          reminder,
          offsetMinutes: occ.offsetMinutes,
          fireAt: occ.fireAt,
          subjectUserId: subject?.platformUserId ?? null,
          subjectDisplayName: subject?.lastKnownDisplayName ?? null,
          late: latenessMs > this.lateNoteAfterMs,
          formatMention: (id) => this.adapter.formatMention(id),
          greeter: this.greeter,
        });

        await tx
          .update(occurrences)
          .set({ status: 'sent', sentAt: now, attempts: sql`${occurrences.attempts} + 1` })
          .where(eq(occurrences.id, occ.id));
        next = await this.scheduler.scheduleNext(tx, reminder, occ.offsetMinutes, occ.fireAt);

        // Send while the row is still locked; if sending throws, everything above rolls back.
        await this.adapter.sendText(group.platformGroupId, message.text, message.mentionUserIds);
        return 'sent';
      });
    } catch (err) {
      return this.recordFailure(occurrenceId, err);
    }

    if (outcome === 'early') {
      const occ = await getOccurrence(this.db, occurrenceId);
      if (occ) await this.scheduler.enqueue([occ]);
    }
    await this.scheduler.enqueue([next]);
    if (outcome === 'sent') this.logger.info({ occurrenceId }, 'Reminder sent');
    return outcome;
  }

  private async recordFailure(occurrenceId: number, err: unknown): Promise<DispatchOutcome> {
    const message = err instanceof Error ? err.message : String(err);
    const [occ] = await this.db
      .update(occurrences)
      .set({ attempts: sql`${occurrences.attempts} + 1`, lastError: message.slice(0, 500) })
      .where(and(eq(occurrences.id, occurrenceId), eq(occurrences.status, 'pending')))
      .returning();
    if (!occ) throw err;
    if (occ.attempts < this.maxAttempts) {
      this.logger.warn({ err, occurrenceId, attempts: occ.attempts }, 'Send failed; will retry');
      throw err; // let the queue retry (the sweeper also retries due occurrences)
    }
    this.logger.error({ err, occurrenceId, attempts: occ.attempts }, 'Send failed permanently');
    const next = await this.db.transaction(async (tx) => {
      await tx.update(occurrences).set({ status: 'failed' }).where(eq(occurrences.id, occurrenceId));
      const reminder = await getReminder(tx, occ.reminderId);
      return reminder ? this.scheduler.scheduleNext(tx, reminder, occ.offsetMinutes, occ.fireAt) : undefined;
    });
    await this.scheduler.enqueue([next]);
    return 'failed';
  }
}
