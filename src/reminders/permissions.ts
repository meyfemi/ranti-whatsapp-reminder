import type { Reminder } from '../db/schema.js';
import type { ActorContext } from './types.js';

export function canCreate(actor: ActorContext): boolean {
  return actor.group.creationPolicy === 'anyone' || actor.isAdmin;
}

/** Only the creator or a group admin can cancel or edit a reminder. */
export function canModify(actor: ActorContext, reminder: Pick<Reminder, 'createdByMemberId'>): boolean {
  return actor.isAdmin || reminder.createdByMemberId === actor.member.id;
}

/** Group settings (timezone, creation policy). */
export function canChangeSettings(actor: ActorContext, setting: 'timezone' | 'policy'): boolean {
  if (setting === 'policy') return actor.isAdmin;
  return actor.group.creationPolicy === 'anyone' || actor.isAdmin;
}
