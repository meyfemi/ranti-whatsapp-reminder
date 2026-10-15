import { DateTime, IANAZone } from 'luxon';
import { RRule, type Options } from './rrule-shim.js';

/**
 * Recurrence maths. Pure functions, no I/O.
 *
 * Approach: rrule is run in "floating" time (local wall-clock values stored in UTC Date fields),
 * so recurrence expands in the group's local calendar. Each local wall-clock time is then
 * converted to a real UTC instant with luxon, which handles DST correctly.
 */

export interface RecurrenceSpec {
  /** Local date-time in the reminder's timezone, ISO without offset, e.g. "2026-10-12T09:00:00". */
  startLocal: string;
  /** RRULE body without DTSTART, e.g. "FREQ=YEARLY" or "FREQ=MONTHLY;BYDAY=1SA". Null = one-off. */
  rrule: string | null;
  timezone: string;
}

const MAX_ITERATIONS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

/** Parses an ISO local date-time (no offset). Returns null when invalid or when an offset is present. */
export function parseLocal(startLocal: string): DateTime | null {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(startLocal)) return null;
  const dt = DateTime.fromISO(startLocal, { zone: 'utc' });
  return dt.isValid ? dt : null;
}

/** Normalises an RRULE body: strips "RRULE:" prefix and any DTSTART/TZID lines. Throws on invalid input. */
export function normaliseRrule(body: string): string {
  const cleaned = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^DTSTART/i.test(l))
    .join(';')
    .replace(/^RRULE:/i, '')
    .toUpperCase();
  const options = RRule.parseString(cleaned);
  if (options.freq === undefined) throw new Error(`RRULE has no FREQ: ${body}`);
  if (options.freq === RRule.SECONDLY || options.freq === RRule.MINUTELY || options.freq === RRule.HOURLY) {
    throw new Error('Sub-daily recurrence is not supported');
  }
  if (options.byhour || options.byminute || options.bysecond) {
    throw new Error('BYHOUR/BYMINUTE/BYSECOND are not supported; the time comes from the start time');
  }
  return new RRule({ ...options, dtstart: null }).toString().replace(/^RRULE:/, '');
}

export function isValidRrule(body: string): boolean {
  try {
    normaliseRrule(body);
    return true;
  } catch {
    return false;
  }
}

function buildRule(spec: RecurrenceSpec, dtstart: DateTime): InstanceType<typeof RRule> {
  const options: Partial<Options> = RRule.parseString(normaliseRrule(spec.rrule!));
  const isFeb29 = dtstart.month === 2 && dtstart.day === 29;
  const hasByRules =
    options.bymonth != null ||
    options.bymonthday != null ||
    options.byweekday != null ||
    options.byyearday != null ||
    options.byweekno != null ||
    options.bysetpos != null;
  if (options.freq === RRule.YEARLY && isFeb29 && !hasByRules) {
    // Feb 29 birthdays fire on Feb 28 in non-leap years: "last day of February".
    options.bymonth = 2;
    options.bymonthday = -1;
  }
  return new RRule({ ...options, dtstart: dtstart.toJSDate(), tzid: null });
}

/** Converts a floating date (local wall-clock values in UTC fields) to a real UTC instant. */
export function floatingToUtc(floating: Date, timezone: string): DateTime {
  const f = DateTime.fromJSDate(floating, { zone: 'utc' });
  return DateTime.fromObject(
    { year: f.year, month: f.month, day: f.day, hour: f.hour, minute: f.minute, second: f.second },
    { zone: timezone },
  ).toUTC();
}

/** Converts a local ISO date-time to a UTC instant. */
export function localToUtc(startLocal: string, timezone: string): DateTime {
  const local = parseLocal(startLocal);
  if (!local) throw new Error(`Invalid local date-time: ${startLocal}`);
  return floatingToUtc(local.toJSDate(), timezone);
}

/**
 * Returns the UTC time of the first event strictly after `afterUtc`, or null if there is none
 * (one-off already passed, or recurrence ended).
 */
export function nextEventAfter(spec: RecurrenceSpec, afterUtc: Date): Date | null {
  const dtstart = parseLocal(spec.startLocal);
  if (!dtstart) throw new Error(`Invalid start_local: ${spec.startLocal}`);
  if (!isValidTimezone(spec.timezone)) throw new Error(`Invalid timezone: ${spec.timezone}`);
  const after = afterUtc.getTime();

  if (!spec.rrule) {
    const event = floatingToUtc(dtstart.toJSDate(), spec.timezone).toJSDate();
    return event.getTime() > after ? event : null;
  }

  const rule = buildRule(spec, dtstart);
  // Local offsets are within ±14h, so starting a day early in floating time never skips an event.
  let cursor = new Date(
    DateTime.fromJSDate(afterUtc).setZone(spec.timezone).setZone('utc', { keepLocalTime: true }).toMillis() - DAY_MS,
  );
  let inclusive = true;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = rule.after(cursor, inclusive);
    if (!next) return null;
    const utc = floatingToUtc(next, spec.timezone).toJSDate();
    if (utc.getTime() > after) return utc;
    cursor = next;
    inclusive = false;
  }
  throw new Error('Recurrence search did not converge');
}

/**
 * Next fire time for one offset: the first event E with (E - offset) strictly after notBeforeUtc.
 * Offsets are minutes before the event (0 = at the event time).
 */
export function nextFireAt(spec: RecurrenceSpec, offsetMinutes: number, notBeforeUtc: Date): Date | null {
  const threshold = new Date(notBeforeUtc.getTime() + offsetMinutes * 60_000);
  const event = nextEventAfter(spec, threshold);
  return event ? new Date(event.getTime() - offsetMinutes * 60_000) : null;
}

/** Lists up to `count` upcoming events strictly after `afterUtc` (for previews and tests). */
export function upcomingEvents(spec: RecurrenceSpec, afterUtc: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = afterUtc;
  for (let i = 0; i < count; i++) {
    const next = nextEventAfter(spec, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Every event in [fromUtc, toUtc), soonest first, expanded in the reminder's own timezone
 * (DST and 29 Feb handled exactly as for scheduling). At most `max` events.
 */
export function eventsInWindow(spec: RecurrenceSpec, fromUtc: Date, toUtc: Date, max = 100): Date[] {
  const out: Date[] = [];
  let cursor = new Date(fromUtc.getTime() - 1);
  while (out.length < max) {
    const next = nextEventAfter(spec, cursor);
    if (!next || next.getTime() >= toUtc.getTime()) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
