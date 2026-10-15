import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { ChatAdapter } from '../adapters/types.js';
import type { Db } from '../db/client.js';
import { countActiveReminders, getGroup, listActiveReminders, type DbOrTx } from '../db/repositories.js';
import { digestRuns, groups, type DigestRun, type Group } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { canChangeSettings } from '../reminders/permissions.js';
import { fail, ok, type ActorContext, type ServiceResult } from '../reminders/types.js';
import type { Clock } from '../scheduler/clock.js';
import type { JobQueue } from '../scheduler/queue.js';
import { toIsoLocal } from '../scheduler/scheduler.js';
import { digestWindow, formatUpcoming, jitteredFireAt, nextDigestSlot, upcomingInWindow, weekKey } from './upcoming.js';

export interface DigestServiceOptions {
  botName: string;
  /** Source of jitter; injectable for tests. */
  random?: () => number;
  /** Runs later than this are skipped and the next week is scheduled (default 6h). */
  maxLatenessMs?: number;
  /** Failed sends are retried up to this many attempts, then the week is given up (default 4). */
  maxAttempts?: number;
}

export interface DigestChange {
  enabled: boolean | null;
  /** ISO weekday 1-7. */
  weekday: number | null;
  /** "HH:mm". */
  time: string | null;
  /** Post "nothing scheduled" in an empty week. */
  postEmpty?: boolean | null;
}

export type DigestOutcome = 'sent' | 'empty' | 'skipped' | 'noop' | 'early' | 'failed';

const HOUR = 3_600_000;
type ScheduledRun = Pick<DigestRun, 'id' | 'fireAt' | 'slotLocal'>;

/**
 * The weekly digest: on by default, but only for groups with at least one active reminder (a
 * group without any gets no run, and goes quiet again if all its reminders are cancelled).
 * The database is the source of truth: at most one pending run per group,
 * claimed (pending -> sent) in a transaction with the send inside it, so duplicate jobs,
 * retries and the sweeper can't post a week twice. pg-boss only makes it punctual.
 */
export class DigestService {
  private readonly random: () => number;
  private readonly maxLatenessMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Db,
    private readonly adapter: ChatAdapter,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: DigestServiceOptions,
  ) {
    this.random = opts.random ?? Math.random;
    this.maxLatenessMs = opts.maxLatenessMs ?? 6 * HOUR;
    this.maxAttempts = opts.maxAttempts ?? 4;
  }

  // ------------------------------------------------------------------ settings

  /** Turns the digest on/off or moves it. Setting a day or time also turns it on. Admins only. */
  async configure(actor: ActorContext, change: DigestChange): Promise<ServiceResult<{ group: Group; next: DateTime | null }>> {
    if (!canChangeSettings(actor, 'digest')) return fail('Only group admins can change the weekly digest.');
    if (change.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(change.time)) return fail("I couldn't understand that time.");
    if (change.weekday !== null && !(change.weekday >= 1 && change.weekday <= 7)) return fail("I couldn't understand that day.");
    const enabled = change.enabled ?? (change.weekday !== null || change.time !== null ? true : actor.group.digestEnabled);

    const { group, run } = await this.db.transaction(async (tx) => {
      await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, actor.group.id)).for('update');
      await tx
        .update(groups)
        .set({
          digestEnabled: enabled,
          ...(change.weekday !== null ? { digestWeekday: change.weekday } : {}),
          ...(change.time !== null ? { digestTime: change.time } : {}),
          ...(change.postEmpty !== null && change.postEmpty !== undefined ? { digestPostEmpty: change.postEmpty } : {}),
        })
        .where(eq(groups.id, actor.group.id));
      const updated = (await getGroup(tx, actor.group.id))!;
      return { group: updated, run: await this.scheduleInTx(tx, updated) };
    });
    await this.enqueue(run);
    this.logger.info({ groupId: group.id, enabled, weekday: group.digestWeekday, time: group.digestTime }, 'Digest settings changed');
    return ok({ group, next: run ? this.slotOf(run, group.timezone) : null });
  }

  /** Gives the group a pending run if it should have one and doesn't (e.g. after its first reminder). */
  async ensureFor(groupId: number, opts: { enqueue?: boolean } = {}): Promise<void> {
    const [pending] = await this.db
      .select({ id: digestRuns.id })
      .from(digestRuns)
      .where(and(eq(digestRuns.groupId, groupId), eq(digestRuns.status, 'pending')));
    if (!pending) await this.reschedule(groupId, opts);
  }

  /** Recomputes a group's pending run (after a timezone change, or the bot rejoining). */
  async reschedule(groupId: number, opts: { enqueue?: boolean } = {}): Promise<void> {
    const run = await this.db.transaction(async (tx) => {
      const group = await getGroup(tx, groupId);
      return group ? this.scheduleInTx(tx, group) : undefined;
    });
    if (opts.enqueue ?? true) await this.enqueue(run);
  }

  /**
   * Replaces the group's pending run with the next slot after now (or none, if the digest is off).
   * A week that already had a digest (sent, failed or skipped) moves on to the following week.
   */
  private async scheduleInTx(tx: DbOrTx, group: Group, after: Date = this.clock.now()): Promise<ScheduledRun | undefined> {
    await tx.delete(digestRuns).where(and(eq(digestRuns.groupId, group.id), eq(digestRuns.status, 'pending')));
    if (!group.digestEnabled || !group.active) return undefined;
    if ((await countActiveReminders(tx, group.id)) === 0) return undefined; // nothing to summarise, ever
    let slot = nextDigestSlot(group, after);
    for (let i = 0; i < 3; i++) {
      const [done] = await tx
        .select({ id: digestRuns.id })
        .from(digestRuns)
        .where(and(eq(digestRuns.groupId, group.id), eq(digestRuns.weekKey, weekKey(slot))));
      if (!done) break;
      slot = nextDigestSlot(group, slot.toJSDate());
    }
    const [run] = await tx
      .insert(digestRuns)
      .values({
        groupId: group.id,
        weekKey: weekKey(slot),
        slotLocal: slot.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        fireAt: jitteredFireAt(slot, this.random),
      })
      .onConflictDoNothing()
      .returning({ id: digestRuns.id, fireAt: digestRuns.fireAt, slotLocal: digestRuns.slotLocal });
    return run;
  }

  // ------------------------------------------------------------------ sending

  async send(runId: number): Promise<DigestOutcome> {
    const now = this.clock.now();
    let next: ScheduledRun | undefined;
    let outcome: DigestOutcome;
    try {
      outcome = await this.db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(digestRuns)
          .where(and(eq(digestRuns.id, runId), eq(digestRuns.status, 'pending')))
          .for('update', { skipLocked: true });
        if (!run) return 'noop'; // already handled, or being handled by another worker
        const group = await getGroup(tx, run.groupId);
        if (!group || !group.active || !group.digestEnabled) {
          await this.mark(tx, run.id, 'skipped');
          return 'skipped';
        }
        if ((await countActiveReminders(tx, group.id)) === 0) {
          // Every reminder was cancelled: go quiet until the group has one again (ensureFor).
          await this.mark(tx, run.id, 'skipped');
          return 'skipped';
        }

        const latenessMs = now.getTime() - run.fireAt.getTime();
        if (latenessMs < -5_000) return 'early';
        if (latenessMs > this.maxLatenessMs) {
          await this.mark(tx, run.id, 'skipped');
          next = await this.scheduleInTx(tx, group, now);
          this.logger.warn({ runId, latenessMs }, 'Digest too late; skipped');
          return 'skipped';
        }

        const slot = this.slotOf(run, group.timezone).toJSDate();
        const text = await this.render(tx, group, digestWindow(slot, group.timezone, now), 'digest');
        await this.mark(tx, run.id, text ? 'sent' : 'skipped', text ? now : undefined);
        next = await this.scheduleInTx(tx, group, slot);
        if (!text) return 'empty';
        // Send while the row is still locked; if sending throws, everything above rolls back.
        await this.adapter.sendText(group.platformGroupId, text);
        return 'sent';
      });
    } catch (err) {
      return this.recordFailure(runId, err);
    }
    if (outcome === 'early') {
      const [run] = await this.db.select().from(digestRuns).where(eq(digestRuns.id, runId));
      if (run) await this.enqueue(run);
    }
    await this.enqueue(next);
    if (outcome === 'sent') this.logger.info({ runId }, 'Digest sent');
    return outcome;
  }

  private async recordFailure(runId: number, err: unknown): Promise<DigestOutcome> {
    const message = err instanceof Error ? err.message : String(err);
    const [run] = await this.db
      .update(digestRuns)
      .set({ attempts: sql`${digestRuns.attempts} + 1`, lastError: message.slice(0, 500) })
      .where(and(eq(digestRuns.id, runId), eq(digestRuns.status, 'pending')))
      .returning();
    if (!run) throw err;
    if (run.attempts < this.maxAttempts) {
      this.logger.warn({ err, runId, attempts: run.attempts }, 'Digest send failed; will retry');
      throw err;
    }
    this.logger.error({ err, runId }, 'Digest send failed permanently');
    const next = await this.db.transaction(async (tx) => {
      await this.mark(tx, runId, 'failed');
      const group = await getGroup(tx, run.groupId);
      return group ? this.scheduleInTx(tx, group, this.slotOf(run, group.timezone).toJSDate()) : undefined;
    });
    await this.enqueue(next);
    return 'failed';
  }

  private async mark(tx: DbOrTx, id: number, status: DigestRun['status'], sentAt?: Date): Promise<void> {
    await tx
      .update(digestRuns)
      .set({ status, ...(sentAt ? { sentAt, attempts: sql`${digestRuns.attempts} + 1` } : {}) })
      .where(eq(digestRuns.id, id));
  }

  /** The run's slot in the group zone. A timezone change reschedules, so the current zone applies. */
  private slotOf(run: Pick<DigestRun, 'slotLocal'>, timezone: string): DateTime {
    return DateTime.fromISO(toIsoLocal(run.slotLocal), { zone: timezone });
  }

  // ------------------------------------------------------------------ on demand

  /** "What's coming up?": the next 7 days from now, for anyone, whether or not the digest is on. */
  async upcomingText(group: Group): Promise<string> {
    const now = this.clock.now();
    const window = digestWindow(now, group.timezone, now);
    return (await this.render(this.db, group, window, 'on_demand'))!;
  }

  private async render(db: DbOrTx, group: Group, window: ReturnType<typeof digestWindow>, kind: 'digest' | 'on_demand') {
    const items = upcomingInWindow(await listActiveReminders(db, group.id), window, group.timezone);
    const groupName = group.name ?? (await this.adapter.getGroupName?.(group.platformGroupId).catch(() => undefined)) ?? null;
    return formatUpcoming(items, window, {
      kind,
      groupName,
      timezone: group.timezone,
      botName: this.opts.botName,
      postEmpty: group.digestPostEmpty,
    });
  }

  // ------------------------------------------------------------------ recovery

  /** Startup: gives every enabled group a pending run and re-enqueues future ones. */
  async ensureScheduled(): Promise<number> {
    const now = this.clock.now();
    const enabled = await this.db.select({ id: groups.id }).from(groups).where(and(eq(groups.digestEnabled, true), eq(groups.active, true)));
    // Created here without enqueueing: the loop below enqueues every future run once.
    for (const group of enabled) await this.ensureFor(group.id, { enqueue: false });
    const future = await this.db
      .select()
      .from(digestRuns)
      .where(and(eq(digestRuns.status, 'pending'), gt(digestRuns.fireAt, now)));
    for (const run of future) await this.enqueue(run);
    return future.length;
  }

  /** Sends (or skips, if too late) every pending run whose time has come. */
  async sweepDue(): Promise<number> {
    const due = await this.listDue(this.clock.now());
    for (const run of due) {
      try {
        await this.send(run.id);
      } catch (err) {
        this.logger.warn({ err, runId: run.id }, 'Digest sweep failed');
      }
    }
    return due.length;
  }

  async listDue(upTo: Date, limit = 500): Promise<DigestRun[]> {
    return this.db
      .select()
      .from(digestRuns)
      .where(and(eq(digestRuns.status, 'pending'), lte(digestRuns.fireAt, upTo)))
      .orderBy(asc(digestRuns.fireAt))
      .limit(limit);
  }

  private async enqueue(run: ScheduledRun | undefined): Promise<void> {
    if (!run) return;
    try {
      await this.queue.enqueueDigest(run.id, run.fireAt);
    } catch (err) {
      this.logger.warn({ err, runId: run.id }, 'Failed to enqueue digest; sweeper will pick it up');
    }
  }
}
