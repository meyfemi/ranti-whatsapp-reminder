import { DateTime } from 'luxon';
import type { Group, Reminder } from '../db/schema.js';
import { formatTime, sanitizeText } from '../reminders/format.js';
import { eventsInWindow } from '../scheduler/recurrence.js';
import { specOf } from '../scheduler/scheduler.js';

/**
 * "What's coming up": the weekly digest and its on-demand version. Pure functions. Dates come
 * from the recurrence engine (each rule expanded in its own timezone), never from the
 * occurrences table, which only holds the next occurrence.
 */

export const WINDOW_DAYS = 7;
export const MAX_DIGEST_ITEMS = 20;
const ALL_DAY_KINDS: ReadonlySet<Reminder['kind']> = new Set(['birthday', 'anniversary']);
const KIND_EMOJI: Partial<Record<Reminder['kind'], string>> = { birthday: '🎂', anniversary: '💍' };

export interface DigestWindow {
  /** Start of the first local day. */
  dayStart: Date;
  /** End of the last local day (exclusive). */
  end: Date;
  /** Timed items before this are over and left out; all-day items count from `dayStart`. */
  notBefore: Date;
}

export interface UpcomingItem {
  reminder: Reminder;
  /** UTC time of the main occurrence (offset 0). */
  at: Date;
  allDay: boolean;
}

/** The 7 local days starting on the day of `from`. */
export function digestWindow(from: Date, timezone: string, notBefore: Date = from): DigestWindow {
  const day = DateTime.fromJSDate(from).setZone(timezone).startOf('day');
  return { dayStart: day.toJSDate(), end: day.plus({ days: WINDOW_DAYS }).toJSDate(), notBefore };
}

/**
 * Every active reminder's main occurrence in the window, grouped by local day: birthdays and
 * anniversaries (all-day) first within a day, then by time.
 */
export function upcomingInWindow(reminders: Reminder[], window: DigestWindow, timezone: string): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const reminder of reminders) {
    if (!reminder.active) continue;
    const allDay = ALL_DAY_KINDS.has(reminder.kind);
    const from = allDay ? window.dayStart : new Date(Math.max(window.dayStart.getTime(), window.notBefore.getTime()));
    for (const at of eventsInWindow(specOf(reminder), from, window.end, WINDOW_DAYS * 2)) {
      items.push({ reminder, at, allDay });
    }
  }
  const dayOf = (d: Date) => DateTime.fromJSDate(d).setZone(timezone).toISODate()!;
  return items.sort(
    (a, b) =>
      dayOf(a.at).localeCompare(dayOf(b.at)) ||
      Number(b.allDay) - Number(a.allDay) ||
      a.at.getTime() - b.at.getTime() ||
      a.reminder.shortId - b.reminder.shortId,
  );
}

/** "13–19 Oct", "28 Sep – 4 Oct". */
export function formatRange(window: DigestWindow, timezone: string): string {
  // en-US month abbreviations ("Sep", not en-GB's "Sept"), day-first order as elsewhere.
  const first = DateTime.fromJSDate(window.dayStart).setZone(timezone).setLocale('en-US');
  const last = DateTime.fromJSDate(window.end).setZone(timezone).minus({ days: 1 }).setLocale('en-US');
  if (first.hasSame(last, 'month')) return `${first.toFormat('d')}–${last.toFormat('d LLL')}`;
  return `${first.toFormat('d LLL')} – ${last.toFormat('d LLL')}`;
}

export interface FormatOptions {
  kind: 'digest' | 'on_demand';
  groupName: string | null;
  timezone: string;
  botName: string;
  maxItems?: number;
}

/**
 * The digest text, or null for an empty weekly digest (it isn't posted unless the group asked).
 * Names are plain text: nothing here mentions anyone.
 */
export function formatUpcoming(
  items: UpcomingItem[],
  window: DigestWindow,
  opts: FormatOptions & { postEmpty?: boolean },
): string | null {
  const range = formatRange(window, opts.timezone);
  const where = opts.groupName ? ` in ${sanitizeText(opts.groupName, 60)}` : '';
  if (items.length === 0) {
    if (opts.kind === 'digest') return opts.postEmpty ? `📅 Nothing scheduled this week${where} (${range}).` : null;
    return `📅 Nothing coming up in the next 7 days (${range}).`;
  }
  const max = opts.maxItems ?? MAX_DIGEST_ITEMS;
  const lines = items.slice(0, max).map(({ reminder: r, at, allDay }) => {
    const local = DateTime.fromJSDate(at).setZone(opts.timezone).setLocale('en-GB');
    const emoji = KIND_EMOJI[r.kind];
    const title = `${emoji ? `${emoji} ` : ''}${sanitizeText(r.title)}`;
    return `${local.toFormat('ccc d')} – ${title}${allDay ? '' : `, ${formatTime(local)}`}`;
  });
  const more = items.length > max ? [`+${items.length - max} more. Ask me about a day, e.g. "@${opts.botName} what's on Saturday?"`] : [];
  const heading = opts.kind === 'digest' ? `📅 This week${where} (${range})` : `📅 Coming up${where} (${range})`;
  const footer = opts.kind === 'digest' ? ['', 'Have a great week!'] : [];
  return [heading, '', ...lines, ...more, ...footer].join('\n');
}

// ---------------------------------------------------------------- schedule

export const DIGEST_JITTER_MS = 15 * 60_000;
export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const WEEKDAY_PLURALS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

export type DigestSettings = Pick<Group, 'digestWeekday' | 'digestTime' | 'timezone'>;

/** The first configured send time (local, in the group zone) strictly after `after`. */
export function nextDigestSlot(settings: DigestSettings, after: Date): DateTime {
  const [hour, minute] = settings.digestTime.split(':').map(Number) as [number, number];
  const start = DateTime.fromJSDate(after).setZone(settings.timezone).startOf('day');
  for (let i = 0; i <= 7; i++) {
    const day = start.plus({ days: i });
    if (day.weekday !== settings.digestWeekday) continue;
    // fromObject resolves a DST gap (e.g. 02:30 that doesn't exist) by moving forward.
    const slot = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour, minute }, { zone: settings.timezone });
    if (slot.toMillis() > after.getTime()) return slot;
  }
  return nextDigestSlot(settings, start.plus({ days: 8 }).toJSDate());
}

/** ISO week of a local slot: one digest per group per week. */
export function weekKey(slot: DateTime): string {
  return slot.toFormat("kkkk-'W'WW");
}

/** Spreads sends over 0-15 minutes after the slot so many groups don't post in the same second. */
export function jitteredFireAt(slot: DateTime, random: () => number): Date {
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 0.999999) * DIGEST_JITTER_MS);
  return new Date(slot.toMillis() + jitter);
}

export function describeSchedule(settings: DigestSettings): string {
  const [hour, minute] = settings.digestTime.split(':');
  return `${WEEKDAY_PLURALS[settings.digestWeekday - 1]} at ${hour}:${minute} (${settings.timezone})`;
}
