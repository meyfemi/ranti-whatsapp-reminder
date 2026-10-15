import type { Reminder } from '../db/schema.js';
import type { ActorContext } from './types.js';

export function canCreate(actor: ActorContext): boolean {
  return actor.group.creationPolicy === 'anyone' || actor.isAdmin;
}

/** Only the creator or a group admin can cancel or edit a reminder. */
export function canModify(actor: ActorContext, reminder: Pick<Reminder, 'createdByMemberId'>): boolean {
  return actor.isAdmin || reminder.createdByMemberId === actor.member.id;
}

/** Group settings (timezone, creation policy, date format). */
export function canChangeSettings(actor: ActorContext, setting: 'timezone' | 'policy' | 'date_format'): boolean {
  if (setting === 'policy' || setting === 'date_format') return actor.isAdmin;
  return actor.group.creationPolicy === 'anyone' || actor.isAdmin;
}
