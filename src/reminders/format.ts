import { DateTime } from 'luxon';
import { RRule } from '../scheduler/rrule-shim.js';
import { parseLocal } from '../scheduler/recurrence.js';
import { normaliseRrule } from '../scheduler/recurrence.js';

const ABBREV_LOCALES = ['en-US', 'en-GB', 'en-NG', 'en-KE', 'en-ZA', 'en-IN', 'en-AU', 'en-NZ', 'en-CA'];

/** Short timezone name such as "WAT", "BST" or "EDT"; falls back to "GMT+1" style. */
export function tzAbbrev(dt: DateTime): string {
  let fallback = '';
  for (const locale of ABBREV_LOCALES) {
    const name = dt.setLocale(locale).toFormat('ZZZZ');
    if (!fallback) fallback = name;
    if (!/^(GMT|UTC)[+-]/.test(name)) return name;
  }
  return fallback;
}

export const formatTime = (dt: DateTime) => dt.toFormat('HH:mm');
export const formatDay = (dt: DateTime) => dt.setLocale('en-GB').toFormat('ccc d LLL');
export const formatDayWithYear = (dt: DateTime) => dt.setLocale('en-GB').toFormat('ccc d LLL yyyy');

export function localDateTime(startLocal: string, timezone: string): DateTime {
  const floating = parseLocal(startLocal);
  if (!floating) throw new Error(`Invalid local date-time: ${startLocal}`);
  return DateTime.fromObject(
    {
      year: floating.year,
      month: floating.month,
      day: floating.day,
      hour: floating.hour,
      minute: floating.minute,
    },
    { zone: timezone },
  );
}

/** "5 minutes", "1 hour", "1 day 2 hours". */
export function formatDuration(minutes: number): string {
  if (minutes === 0) return '0 minutes';
  const parts: string[] = [];
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (mins) parts.push(`${mins} ${mins === 1 ? 'minute' : 'minutes'}`);
  return parts.join(' ');
}

const ORDINALS: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last' };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function weekdayList(byweekday: unknown): { n?: number; day: string }[] | null {
  if (!Array.isArray(byweekday)) return null;
  return byweekday.map((w: { weekday: number; n?: number } | number) =>
    typeof w === 'number' ? { day: WEEKDAYS[w]! } : { day: WEEKDAYS[w.weekday]!, n: w.n ?? undefined },
  );
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Human description of the recurrence pattern, e.g. "every first Saturday of the month". */
export function describeRecurrence(rrule: string, start: DateTime): string {
  const opts = RRule.parseString(normaliseRrule(rrule));
  const interval = opts.interval && opts.interval > 1 ? opts.interval : 1;
  const days = weekdayList(opts.byweekday);
  switch (opts.freq) {
    case RRule.YEARLY:
      return interval > 1 ? `every ${interval} years on ${start.toFormat('d LLL')}` : `every year on ${start.toFormat('d LLL')}`;
    case RRule.MONTHLY: {
      const every = interval > 1 ? `every ${interval} months` : 'every month';
      if (days?.length === 1 && days[0]!.n !== undefined && ORDINALS[days[0]!.n]) {
        const prefix = interval > 1 ? `every ${interval} months on the` : 'every';
        return `${prefix} ${ORDINALS[days[0]!.n]} ${days[0]!.day} of the month`.replace('every every', 'every');
      }
      const monthday = Array.isArray(opts.bymonthday) ? opts.bymonthday[0] : opts.bymonthday;
      if (monthday === -1) return `${every} on the last day`;
      return `${every} on the ${ordinalSuffix(monthday ?? start.day)}`;
    }
    case RRule.WEEKLY: {
      const names = days?.map((d) => d.day) ?? [start.setLocale('en-GB').toFormat('cccc')];
      return interval > 1 ? `every ${interval} weeks on ${joinList(names)}` : `every ${joinList(names)}`;
    }
    case RRule.DAILY:
      return interval > 1 ? `every ${interval} days` : 'every day';
    default:
      return new RRule({ ...opts, dtstart: null }).toText();
  }
}

export function ordinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export interface ScheduleLike {
  startLocal: string;
  rrule: string | null;
  timezone: string;
  offsetsMinutes: number[];
}

/** "Sun 11 Oct, 11:00 (WAT)" or "every year on 12 Oct at 09:00 (WAT)". */
export function describeWhen(r: ScheduleLike): string {
  const start = localDateTime(r.startLocal, r.timezone);
  const tz = tzAbbrev(start);
  if (!r.rrule) return `${formatDay(start)}, ${formatTime(start)} (${tz})`;
  return `${describeRecurrence(r.rrule, start)} at ${formatTime(start)} (${tz})`;
}

/** "Reminders at 10:55 and 11:00." / "Reminder 1 day before and at the time." */
export function describeOffsets(r: ScheduleLike): string {
  const offsets = [...r.offsetsMinutes].sort((a, b) => b - a);
  const start = localDateTime(r.startLocal, r.timezone);
  const label = offsets.length === 1 ? 'Reminder' : 'Reminders';
  const allSameDay = offsets.every((o) => start.minus({ minutes: o }).hasSame(start, 'day'));
  if (!r.rrule && allSameDay) {
    return `${label} at ${joinList(offsets.map((o) => formatTime(start.minus({ minutes: o }))))}.`;
  }
  const parts = offsets.map((o) => (o === 0 ? 'at the time' : `${formatDuration(o)} before`));
  return `${label} ${joinList(parts)}.`;
}

/**
 * Makes user-supplied text safe to echo: strips control/zero-width characters, collapses
 * whitespace, removes "@" so nothing echoed can look like or become a mention, and truncates.
 */
export function sanitizeText(input: string, maxLength = 120): string {
  const cleaned = input
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/[@＠﹫]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trimEnd()}…` : cleaned;
}
