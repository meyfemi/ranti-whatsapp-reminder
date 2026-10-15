import type { Group, MemberRow, Reminder } from '../db/schema.js';

export type ReminderKind = Reminder['kind'];

/** Who is acting, in which group. Built by the bot layer from an incoming message. */
export interface ActorContext {
  group: Group;
  member: MemberRow;
  isAdmin: boolean;
}

export interface CreateReminderInput {
  title: string;
  kind: ReminderKind;
  /** ISO local date-time without offset, in the group's timezone. */
  startLocal: string;
  rrule: string | null;
  offsetsMinutes: number[];
  subjectMemberId: number | null;
  messageStyle: string | null;
  /** Name of a person who isn't linked to a member (wished by name, without a mention). */
  subjectName?: string | null;
  birthYear?: number | null;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: string): ServiceResult<T> => ({ ok: false, error });
