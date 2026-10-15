import { eq } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { Db } from '../db/client.js';
import {
  allocateShortId,
  countActiveReminders,
  getGroup,
  getReminder,
  insertReminder,
  listActiveReminders,
  listMembers,
  listPendingForReminder,
  updateGroup,
  updateReminder,
  type DbOrTx,
} from '../db/repositories.js';
import { groups, type Group, type Reminder } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../scheduler/clock.js';
import { isValidTimezone, parseLocal } from '../scheduler/recurrence.js';
import { toIsoLocal, type ScheduledOccurrence, type Scheduler } from '../scheduler/scheduler.js';
import { dropDuplicates, yearlyStartLocal, type ExistingBirthday, type ImportEntry } from './bulk.js';
import { canChangeSettings, canCreate, canModify } from './permissions.js';
import { fail, ok, type ActorContext, type CreateReminderInput, type ServiceResult } from './types.js';
import { validateCreate } from './validation.js';

export interface ReminderServiceOptions {
  maxActivePerGroup: number;
}

export interface CreatedReminder {
  reminder: Reminder;
  occurrences: ScheduledOccurrence[];
}

/** The editable fields of a reminder, captured before an edit so it can be undone. */
export interface ReminderSnapshot {
  title: string;
  startLocal: string;
  rrule: string | null;
  offsetsMinutes: number[];
  messageStyle: string | null;
}

export interface ReminderChanges {
  title?: string | null;
  startLocal?: string | null;
  rrule?: string | null;
  makeOneOff?: boolean;
  offsetsMinutes?: number[] | null;
  messageStyle?: string | null;
}

export interface EditedReminder extends CreatedReminder {
  before: ReminderSnapshot;
}

export interface ListedReminder {
  reminder: Reminder;
  /** UTC time of the next event (offset 0), if anything is scheduled. */
  nextEvent: Date | null;
}

const ROLLBACK_NOTHING_LEFT = 'All of those reminder times have already passed.';

/** Business rules for reminders: validation, permissions, caps, persistence and scheduling. */
export class ReminderService {
  constructor(
    private readonly db: Db,
    private readonly scheduler: Scheduler,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: ReminderServiceOptions,
  ) {}

  // ------------------------------------------------------------------ create

  async create(actor: ActorContext, input: CreateReminderInput): Promise<ServiceResult<CreatedReminder>> {
    if (!canCreate(actor)) return fail('Only group admins can set reminders in this group.');

    const validated = validateCreate(input, actor.group.timezone, this.clock.now());
    if (!validated.ok) return validated;
    const v = validated.value;

    const result = await this.inTransaction(async (tx) => {
      const capError = await this.checkCap(tx, actor.group.id);
      if (capError) return fail<CreatedReminder>(capError);
      return this.insertAndSchedule(tx, actor, v);
    });

    if (result.ok) {
      await this.scheduler.enqueue(result.value.occurrences);
      this.logger.info({ reminderId: result.value.reminder.id, groupId: actor.group.id }, 'Reminder created');
    }
    return result;
  }

  /** The shared tail of every create: stores a validated reminder and its first occurrences. */
  private async insertAndSchedule(
    tx: DbOrTx,
    actor: ActorContext,
    v: CreateReminderInput,
  ): Promise<ServiceResult<CreatedReminder>> {
    const shortId = await allocateShortId(tx, actor.group.id);
    const reminder = await insertReminder(tx, {
      groupId: actor.group.id,
      shortId,
      title: v.title,
      kind: v.kind,
      startLocal: v.startLocal,
      rrule: v.rrule,
      timezone: actor.group.timezone,
      offsetsMinutes: v.offsetsMinutes,
      subjectMemberId: v.subjectMemberId,
      subjectName: v.subjectName ?? null,
      birthYear: v.birthYear ?? null,
      messageStyle: v.messageStyle,
      createdByMemberId: actor.member.id,
    });
    const occurrences = await this.scheduler.scheduleInitial(tx, reminder);
    // e.g. "remind me 5 minutes before" when it's 3 minutes before: nothing left to send.
    if (occurrences.length === 0) return fail<CreatedReminder>(ROLLBACK_NOTHING_LEFT);
    return ok<CreatedReminder>({ reminder, occurrences });
  }

  // ------------------------------------------------------------------ bulk birthdays

  /** How many more active reminders the group can have. */
  async remainingSlots(groupId: number): Promise<number> {
    return Math.max(0, this.opts.maxActivePerGroup - (await countActiveReminders(this.db, groupId)));
  }

  get maxActivePerGroup(): number {
    return this.opts.maxActivePerGroup;
  }

  /** The group's active birthdays in the shape duplicate checks need. */
  async existingBirthdays(db: DbOrTx, groupId: number): Promise<ExistingBirthday[]> {
    const active = (await listActiveReminders(db, groupId)).filter((r) => r.kind === 'birthday');
    const names = new Map((await listMembers(db, groupId)).map((m) => [m.id, m.lastKnownDisplayName]));
    return active.map((r) => {
      const start = parseLocal(toIsoLocal(r.startLocal))!;
      return {
        memberId: r.subjectMemberId,
        name: birthdayName(r, r.subjectMemberId ? (names.get(r.subjectMemberId) ?? null) : null),
        month: start.month,
        day: start.day,
      };
    });
  }

  /**
   * Saves a confirmed import: every birthday goes through the same validation and insert as a
   * single create, all in one transaction (all saved or none). Entries that became duplicates
   * since the preview are left out and returned as `skipped`.
   */
  async importBirthdays(
    actor: ActorContext,
    entries: ImportEntry[],
  ): Promise<ServiceResult<{ created: CreatedReminder[]; skipped: ImportEntry[] }>> {
    if (!canCreate(actor)) return fail('Only group admins can set reminders in this group.');
    const now = this.clock.now();
    const result = await this.inTransaction(async (tx) => {
      await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, actor.group.id)).for('update');
      const { keep, dropped } = dropDuplicates(entries, await this.existingBirthdays(tx, actor.group.id));
      if (keep.length === 0) return fail<{ created: CreatedReminder[]; skipped: ImportEntry[] }>('All of those birthdays are already saved.');
      const active = await countActiveReminders(tx, actor.group.id);
      if (active + keep.length > this.opts.maxActivePerGroup) {
        const left = Math.max(0, this.opts.maxActivePerGroup - active);
        return fail<{ created: CreatedReminder[]; skipped: ImportEntry[] }>(
          `Only ${left} more reminder${left === 1 ? '' : 's'} fit in this group (the limit is ${this.opts.maxActivePerGroup}).`,
        );
      }
      const created: CreatedReminder[] = [];
      for (const e of keep) {
        const validated = validateCreate(
          {
            title: `${e.name}'s birthday`,
            kind: 'birthday',
            startLocal: yearlyStartLocal(e.month, e.day, now, actor.group.timezone),
            rrule: 'FREQ=YEARLY',
            offsetsMinutes: [0],
            subjectMemberId: e.memberId,
            subjectName: e.name,
            birthYear: e.year,
            messageStyle: null,
          },
          actor.group.timezone,
          now,
        );
        if (!validated.ok) return validated;
        const one = await this.insertAndSchedule(tx, actor, validated.value);
        if (!one.ok) return one;
        created.push(one.value);
      }
      return ok({ created, skipped: dropped });
    });
    if (result.ok) {
      await this.scheduler.enqueue(result.value.created.flatMap((c) => c.occurrences));
      this.logger.info({ groupId: actor.group.id, count: result.value.created.length }, 'Birthdays imported');
    }
    return result;
  }

  /**
   * Links a birthday (or any reminder) to a member so future wishes @mention them.
   * `bypassPermissions` is for the person themself confirming "yes, that's me".
   */
  async linkSubject(
    actor: ActorContext,
    reminderId: number,
    memberId: number,
    opts: { bypassPermissions?: boolean } = {},
  ): Promise<ServiceResult<Reminder>> {
    const reminder = await this.lockReminder(this.db, actor, reminderId);
    if (!reminder || !reminder.active) return fail("I couldn't find that reminder.");
    if (!opts.bypassPermissions && !canModify(actor, reminder)) {
      return fail('Only the person who set this reminder or a group admin can change it.');
    }
    if (reminder.subjectMemberId === memberId) return fail(`#${reminder.shortId} is already linked to them.`);
    const updated = await updateReminder(this.db, reminder.id, { subjectMemberId: memberId });
    this.logger.info({ reminderId, groupId: actor.group.id }, 'Reminder linked to member');
    return ok(updated);
  }

  // ------------------------------------------------------------------ list

  async list(groupId: number): Promise<ListedReminder[]> {
    const active = await listActiveReminders(this.db, groupId);
    const out: ListedReminder[] = [];
    for (const reminder of active) {
      const pending = await listPendingForReminder(this.db, reminder.id);
      const events = pending.map((o) => o.fireAt.getTime() + o.offsetMinutes * 60_000);
      out.push({ reminder, nextEvent: events.length ? new Date(Math.min(...events)) : null });
    }
    return out;
  }

  // ------------------------------------------------------------------ cancel

  /**
   * Cancels a reminder. `bypassPermissions` is only for undoing one's own create
   * (the undo window is tied to the member who created it).
   */
  async cancel(
    actor: ActorContext,
    reminderId: number,
    opts: { bypassPermissions?: boolean } = {},
  ): Promise<ServiceResult<Reminder>> {
    return this.db.transaction(async (tx) => {
      const reminder = await this.lockReminder(tx, actor, reminderId);
      if (!reminder) return fail<Reminder>("I couldn't find that reminder.");
      if (!reminder.active) return fail<Reminder>(`#${reminder.shortId} is already cancelled.`);
      if (!opts.bypassPermissions && !canModify(actor, reminder)) {
        return fail<Reminder>('Only the person who set this reminder or a group admin can change it.');
      }
      const updated = await updateReminder(tx, reminder.id, { active: false, cancelledAt: this.clock.now() });
      await this.scheduler.cancel(tx, reminder.id);
      this.logger.info({ reminderId, groupId: actor.group.id }, 'Reminder cancelled');
      return ok(updated);
    });
  }

  /** Undo of a cancel: reactivates the reminder and schedules it again. */
  async reactivate(actor: ActorContext, reminderId: number): Promise<ServiceResult<CreatedReminder>> {
    const result = await this.inTransaction(async (tx) => {
      const reminder = await this.lockReminder(tx, actor, reminderId);
      if (!reminder) return fail<CreatedReminder>("I couldn't find that reminder.");
      if (reminder.active) return fail<CreatedReminder>(`#${reminder.shortId} is already active.`);
      const capError = await this.checkCap(tx, actor.group.id);
      if (capError) return fail<CreatedReminder>(capError);
      const updated = await updateReminder(tx, reminder.id, { active: true, cancelledAt: null });
      const occurrences = await this.scheduler.scheduleInitial(tx, updated);
      if (occurrences.length === 0) return fail<CreatedReminder>('That reminder has no future dates left to restore.');
      return ok<CreatedReminder>({ reminder: updated, occurrences });
    });
    if (result.ok) await this.scheduler.enqueue(result.value.occurrences);
    return result;
  }

  // ------------------------------------------------------------------ edit

  async edit(actor: ActorContext, reminderId: number, changes: ReminderChanges): Promise<ServiceResult<EditedReminder>> {
    const result = await this.inTransaction(async (tx) => {
      const reminder = await this.lockReminder(tx, actor, reminderId);
      if (!reminder || !reminder.active) return fail<EditedReminder>("I couldn't find that reminder.");
      if (!canModify(actor, reminder)) {
        return fail<EditedReminder>('Only the person who set this reminder or a group admin can change it.');
      }
      const before = snapshot(reminder);
      const next: ReminderSnapshot = {
        title: changes.title ?? before.title,
        startLocal: changes.startLocal ?? before.startLocal,
        rrule: changes.makeOneOff ? null : (changes.rrule ?? before.rrule),
        offsetsMinutes: changes.offsetsMinutes ?? before.offsetsMinutes,
        messageStyle: changes.messageStyle ?? before.messageStyle,
      };
      if (JSON.stringify(next) === JSON.stringify(before)) return fail<EditedReminder>("That doesn't change anything.");
      const applied = await this.applySnapshot(tx, reminder, next);
      if (!applied.ok) return applied;
      return ok<EditedReminder>({ ...applied.value, before });
    });
    if (result.ok) {
      await this.scheduler.enqueue(result.value.occurrences);
      this.logger.info({ reminderId, groupId: actor.group.id }, 'Reminder edited');
    }
    return result;
  }

  /** Undo of an edit: puts back the snapshot taken before it. */
  async restore(actor: ActorContext, reminderId: number, before: ReminderSnapshot): Promise<ServiceResult<CreatedReminder>> {
    const result = await this.inTransaction(async (tx) => {
      const reminder = await this.lockReminder(tx, actor, reminderId);
      if (!reminder || !reminder.active) return fail<CreatedReminder>("I couldn't find that reminder.");
      return this.applySnapshot(tx, reminder, before);
    });
    if (result.ok) await this.scheduler.enqueue(result.value.occurrences);
    return result;
  }

  private async applySnapshot(
    tx: DbOrTx,
    reminder: Reminder,
    next: ReminderSnapshot,
  ): Promise<ServiceResult<CreatedReminder>> {
    const validated = validateCreate(
      { ...next, kind: reminder.kind, subjectMemberId: reminder.subjectMemberId },
      reminder.timezone,
      this.clock.now(),
    );
    if (!validated.ok) return validated;
    const v = validated.value;
    const updated = await updateReminder(tx, reminder.id, {
      title: v.title,
      startLocal: v.startLocal,
      rrule: v.rrule,
      offsetsMinutes: v.offsetsMinutes,
      messageStyle: v.messageStyle,
    });
    const occurrences = await this.scheduler.reschedule(tx, updated);
    if (occurrences.length === 0) return fail(ROLLBACK_NOTHING_LEFT);
    return ok({ reminder: updated, occurrences });
  }

  // ------------------------------------------------------------------ settings

  /**
   * Changes the group timezone. Active reminders keep their local wall-clock times
   * (a 09:00 reminder stays at 09:00 in the new zone) and are rescheduled.
   */
  async setTimezone(actor: ActorContext, timezone: string): Promise<ServiceResult<{ group: Group; rescheduled: number }>> {
    if (!canChangeSettings(actor, 'timezone')) return fail('Only group admins can change the timezone in this group.');
    if (!isValidTimezone(timezone)) return fail(`"${timezone}" isn't a timezone I recognise.`);
    const result = await this.inTransaction(async (tx) => {
      await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, actor.group.id)).for('update');
      await updateGroup(tx, actor.group.id, { timezone });
      const all: ScheduledOccurrence[] = [];
      const active = await listActiveReminders(tx, actor.group.id);
      for (const r of active) {
        const updated = await updateReminder(tx, r.id, { timezone });
        all.push(...(await this.scheduler.reschedule(tx, updated)));
      }
      const group = (await getGroup(tx, actor.group.id))!;
      return ok({ group, rescheduled: active.length, occurrences: all });
    });
    if (!result.ok) return result;
    await this.scheduler.enqueue(result.value.occurrences);
    this.logger.info({ groupId: actor.group.id, timezone }, 'Group timezone changed');
    return ok({ group: result.value.group, rescheduled: result.value.rescheduled });
  }

  async setDateFormat(actor: ActorContext, format: Group['dateFormat']): Promise<ServiceResult<Group>> {
    if (!canChangeSettings(actor, 'date_format')) return fail('Only group admins can change the date format.');
    await updateGroup(this.db, actor.group.id, { dateFormat: format });
    return ok((await getGroup(this.db, actor.group.id))!);
  }

  async setPolicy(actor: ActorContext, policy: Group['creationPolicy']): Promise<ServiceResult<Group>> {
    if (!canChangeSettings(actor, 'policy')) return fail('Only group admins can change who can set reminders.');
    await updateGroup(this.db, actor.group.id, { creationPolicy: policy });
    return ok((await getGroup(this.db, actor.group.id))!);
  }

  // ------------------------------------------------------------------ helpers

  private async checkCap(tx: DbOrTx, groupId: number): Promise<string | null> {
    // Lock the group row so concurrent creates can't both slip under the cap.
    await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for('update');
    const active = await countActiveReminders(tx, groupId);
    if (active < this.opts.maxActivePerGroup) return null;
    return `This group already has ${active} active reminders (the limit is ${this.opts.maxActivePerGroup}). Cancel one first.`;
  }

  private async lockReminder(tx: DbOrTx, actor: ActorContext, reminderId: number): Promise<Reminder | undefined> {
    const reminder = await getReminder(tx, reminderId);
    if (!reminder || reminder.groupId !== actor.group.id) return undefined;
    return reminder;
  }

  /** Runs fn in a transaction; a `ServiceResult` failure or `tx.rollback()` rolls everything back. */
  private async inTransaction<T>(fn: (tx: DbOrTx) => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    let failure: ServiceResult<T> | undefined;
    try {
      return await this.db.transaction(async (tx) => {
        const res = await fn(tx);
        if (!res.ok) {
          failure = res;
          tx.rollback();
        }
        return res;
      });
    } catch (err) {
      if (err instanceof TransactionRollbackError) return failure ?? fail(ROLLBACK_NOTHING_LEFT);
      throw err;
    }
  }
}

/** The person a birthday is for, by name: the stored name, the member's name, or the title. */
export function birthdayName(r: Pick<Reminder, 'subjectName' | 'title'>, memberName: string | null): string | null {
  return r.subjectName ?? memberName ?? (r.title.replace(/['’]s\s+birthday$/i, '').trim() || null);
}

export function snapshot(r: Reminder): ReminderSnapshot {
  return {
    title: r.title,
    startLocal: toIsoLocal(r.startLocal),
    rrule: r.rrule,
    offsetsMinutes: [...r.offsetsMinutes],
    messageStyle: r.messageStyle,
  };
}
