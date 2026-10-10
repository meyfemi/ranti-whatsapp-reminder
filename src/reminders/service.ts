import { eq } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { Db } from '../db/client.js';
import { allocateShortId, countActiveReminders, insertReminder } from '../db/repositories.js';
import { groups, type Reminder } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../scheduler/clock.js';
import type { ScheduledOccurrence, Scheduler } from '../scheduler/scheduler.js';
import { canCreate } from './permissions.js';
import { fail, ok, type ActorContext, type CreateReminderInput, type ServiceResult } from './types.js';
import { validateCreate } from './validation.js';

export interface ReminderServiceOptions {
  maxActivePerGroup: number;
}

export interface CreatedReminder {
  reminder: Reminder;
  occurrences: ScheduledOccurrence[];
}

/** Business rules for reminders: validation, permissions, caps, persistence and scheduling. */
export class ReminderService {
  constructor(
    private readonly db: Db,
    private readonly scheduler: Scheduler,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: ReminderServiceOptions,
  ) {}

  async create(actor: ActorContext, input: CreateReminderInput): Promise<ServiceResult<CreatedReminder>> {
    if (!canCreate(actor)) return fail('Only group admins can set reminders in this group.');

    const validated = validateCreate(input, actor.group.timezone, this.clock.now());
    if (!validated.ok) return validated;
    const v = validated.value;

    const result = await this.db.transaction(async (tx) => {
      // Lock the group row so concurrent creates can't both slip under the cap.
      await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, actor.group.id)).for('update');
      const active = await countActiveReminders(tx, actor.group.id);
      if (active >= this.opts.maxActivePerGroup) {
        return fail<CreatedReminder>(
          `This group already has ${active} active reminders (the limit is ${this.opts.maxActivePerGroup}). Cancel one first.`,
        );
      }
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
        messageStyle: v.messageStyle,
        createdByMemberId: actor.member.id,
      });
      const occurrences = await this.scheduler.scheduleInitial(tx, reminder);
      if (occurrences.length === 0) {
        // e.g. "remind me 5 minutes before" when it's 3 minutes before: nothing left to send.
        tx.rollback();
      }
      return ok<CreatedReminder>({ reminder, occurrences });
    }).catch((err: unknown) => {
      if (err instanceof TransactionRollbackError) {
        return fail<CreatedReminder>('All of those reminder times have already passed.');
      }
      throw err;
    });

    if (result.ok) {
      await this.scheduler.enqueue(result.value.occurrences);
      this.logger.info({ reminderId: result.value.reminder.id, groupId: actor.group.id }, 'Reminder created');
    }
    return result;
  }
}
