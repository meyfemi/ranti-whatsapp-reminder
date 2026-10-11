import { DateTime } from 'luxon';
import type { Reminder } from '../db/schema.js';
import { nextEventAfter } from '../scheduler/recurrence.js';
import { specOf } from '../scheduler/scheduler.js';

/**
 * Answers "what's on this week?" / "when is my birthday?" from stored reminders. Pure functions:
 * the parser only says what is being asked; the dates come from the same recurrence maths the
 * scheduler uses.
 */

export interface QueryFilter {
  shortIds: number[];
  subjectMemberId: number | null;
  kind: Reminder['kind'] | null;
}

export interface UpcomingEvent {
  reminder: Reminder;
  at: Date;
}

/** Max events listed for a period, so "this month" with a daily reminder stays readable. */
export const MAX_QUERY_EVENTS = 15;

export function filterReminders(reminders: Reminder[], f: QueryFilter): Reminder[] {
  return reminders.filter(
    (r) =>
      (f.shortIds.length === 0 || f.shortIds.includes(r.shortId)) &&
      (f.subjectMemberId === null || r.subjectMemberId === f.subjectMemberId) &&
      (f.kind === null || r.kind === f.kind),
  );
}

/** The group-local day range [from 00:00, to 24:00) as UTC instants. */
export function periodBounds(fromDate: string, toDate: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(fromDate, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(toDate, { zone: timezone }).plus({ days: 1 }).startOf('day');
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/**
 * Events (the event time itself, not early reminders) in [start, end), soonest first.
 * Events already in the past are left out. Returns at most `limit` events and whether more were cut.
 */
export function eventsBetween(
  reminders: Reminder[],
  start: Date,
  end: Date,
  now: Date,
  limit = MAX_QUERY_EVENTS,
): { events: UpcomingEvent[]; truncated: boolean } {
  const from = new Date(Math.max(start.getTime(), now.getTime()) - 1);
  const events: UpcomingEvent[] = [];
  for (const reminder of reminders) {
    const spec = specOf(reminder);
    let cursor = from;
    // limit + 1 per reminder is enough to know whether the overall list was cut.
    for (let i = 0; i <= limit; i++) {
      const at = nextEventAfter(spec, cursor);
      if (!at || at.getTime() >= end.getTime()) break;
      events.push({ reminder, at });
      cursor = at;
    }
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime() || a.reminder.shortId - b.reminder.shortId);
  return { events: events.slice(0, limit), truncated: events.length > limit };
}

/** Next event of each reminder after `now`, soonest first; reminders with nothing left are dropped. */
export function nextEvents(reminders: Reminder[], now: Date): UpcomingEvent[] {
  const out: UpcomingEvent[] = [];
  for (const reminder of reminders) {
    const spec = specOf(reminder);
    const at = nextEventAfter(spec, now);
    if (at) out.push({ reminder, at });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
