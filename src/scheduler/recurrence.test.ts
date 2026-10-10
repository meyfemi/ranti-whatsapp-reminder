import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  isValidRrule,
  localToUtc,
  nextEventAfter,
  nextFireAt,
  normaliseRrule,
  parseLocal,
  upcomingEvents,
  type RecurrenceSpec,
} from './recurrence.js';

const utc = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).toJSDate();
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const local = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm ccc");

describe('parseLocal / localToUtc', () => {
  it('rejects offsets and garbage', () => {
    expect(parseLocal('2026-10-11T11:00:00Z')).toBeNull();
    expect(parseLocal('2026-10-11T11:00:00+01:00')).toBeNull();
    expect(parseLocal('not a date')).toBeNull();
    expect(parseLocal('2026-10-11T11:00:00')).not.toBeNull();
  });

  it('converts Lagos wall time to UTC (WAT = UTC+1, no DST)', () => {
    expect(localToUtc('2026-10-11T11:00:00', 'Africa/Lagos').toISO()).toBe('2026-10-11T10:00:00.000Z');
  });
});

describe('one-off events', () => {
  const spec: RecurrenceSpec = { startLocal: '2026-10-11T11:00:00', rrule: null, timezone: 'Africa/Lagos' };

  it('returns the event when in the future', () => {
    expect(iso(nextEventAfter(spec, utc('2026-10-10T00:00:00')))).toBe('2026-10-11T10:00:00.000Z');
  });

  it('returns null once passed', () => {
    expect(nextEventAfter(spec, utc('2026-10-11T10:00:00'))).toBeNull();
  });

  it('computes offsets: 5 minutes before and at the time', () => {
    const now = utc('2026-10-10T12:00:00');
    expect(iso(nextFireAt(spec, 5, now))).toBe('2026-10-11T09:55:00.000Z');
    expect(iso(nextFireAt(spec, 0, now))).toBe('2026-10-11T10:00:00.000Z');
  });

  it('drops an offset whose fire time has already passed but keeps the event itself', () => {
    const now = utc('2026-10-11T09:57:00'); // 10:57 local: 5-min reminder already missed
    expect(nextFireAt(spec, 5, now)).toBeNull();
    expect(iso(nextFireAt(spec, 0, now))).toBe('2026-10-11T10:00:00.000Z');
  });

  it('after firing, there is no next occurrence', () => {
    expect(nextFireAt(spec, 5, utc('2026-10-11T09:55:00'))).toBeNull();
  });
});

describe('yearly birthdays', () => {
  const spec: RecurrenceSpec = { startLocal: '2026-10-12T09:00:00', rrule: 'FREQ=YEARLY', timezone: 'Africa/Lagos' };

  it('fires on the date each year', () => {
    const events = upcomingEvents(spec, utc('2026-10-01T00:00:00'), 3).map(iso);
    expect(events).toEqual(['2026-10-12T08:00:00.000Z', '2027-10-12T08:00:00.000Z', '2028-10-12T08:00:00.000Z']);
  });

  it('after firing, schedules next year', () => {
    expect(iso(nextFireAt(spec, 0, utc('2026-10-12T08:00:00')))).toBe('2027-10-12T08:00:00.000Z');
  });

  it('Feb 29 birthdays fire on Feb 28 in non-leap years', () => {
    const feb29: RecurrenceSpec = { startLocal: '2028-02-29T09:00:00', rrule: 'FREQ=YEARLY', timezone: 'Africa/Lagos' };
    const events = upcomingEvents(feb29, utc('2028-01-01T00:00:00'), 5).map((d) => local(d, 'Africa/Lagos'));
    expect(events).toEqual([
      '2028-02-29T09:00 Tue',
      '2029-02-28T09:00 Wed',
      '2030-02-28T09:00 Thu',
      '2031-02-28T09:00 Fri',
      '2032-02-29T09:00 Sun',
    ]);
  });

  it('a Feb 29 start in the past still yields Feb 28 next (non-leap) year', () => {
    const feb29: RecurrenceSpec = { startLocal: '2024-02-29T09:00:00', rrule: 'FREQ=YEARLY', timezone: 'Africa/Lagos' };
    expect(local(nextEventAfter(feb29, utc('2026-10-10T00:00:00'))!, 'Africa/Lagos')).toBe('2027-02-28T09:00 Sun');
  });
});

describe('monthly "first Saturday"', () => {
  const spec: RecurrenceSpec = {
    startLocal: '2026-10-10T09:00:00',
    rrule: 'FREQ=MONTHLY;BYDAY=1SA',
    timezone: 'Africa/Lagos',
  };

  it('fires on the first Saturday of each month', () => {
    // 10 Oct 2026 is the *second* Saturday, so October's first Saturday (3 Oct) has passed.
    const events = upcomingEvents(spec, utc('2026-10-10T00:00:00'), 4).map((d) => local(d, 'Africa/Lagos'));
    expect(events).toEqual([
      '2026-11-07T09:00 Sat',
      '2026-12-05T09:00 Sat',
      '2027-01-02T09:00 Sat',
      '2027-02-06T09:00 Sat',
    ]);
  });

  it('a 30-minute offset fires at 08:30 on the same days', () => {
    expect(local(nextFireAt(spec, 30, utc('2026-10-10T00:00:00'))!, 'Africa/Lagos')).toBe('2026-11-07T08:30 Sat');
    // Just after the 08:30 reminder fires (07:30Z), the next one is the following month.
    expect(local(nextFireAt(spec, 30, utc('2026-11-07T07:30:00'))!, 'Africa/Lagos')).toBe('2026-12-05T08:30 Sat');
    // The at-time reminder (offset 0) on 7 Nov is still pending at that moment.
    expect(local(nextFireAt(spec, 0, utc('2026-11-07T07:30:00'))!, 'Africa/Lagos')).toBe('2026-11-07T09:00 Sat');
  });
});

describe('DST (Europe/London)', () => {
  const weekly: RecurrenceSpec = {
    startLocal: '2026-03-22T09:00:00',
    rrule: 'FREQ=WEEKLY',
    timezone: 'Europe/London',
  };

  it('keeps 09:00 local across the spring-forward change', () => {
    const events = upcomingEvents(weekly, utc('2026-03-20T00:00:00'), 2).map(iso);
    // 22 Mar is GMT (09:00Z); 29 Mar is BST (08:00Z). Clocks change on 29 Mar 2026 at 01:00.
    expect(events).toEqual(['2026-03-22T09:00:00.000Z', '2026-03-29T08:00:00.000Z']);
  });

  it('keeps 09:00 local across the fall-back change', () => {
    const autumn: RecurrenceSpec = { ...weekly, startLocal: '2026-10-18T09:00:00' };
    const events = upcomingEvents(autumn, utc('2026-10-17T00:00:00'), 2).map(iso);
    // 18 Oct BST (08:00Z); 25 Oct GMT (09:00Z). Clocks change on 25 Oct 2026 at 02:00.
    expect(events).toEqual(['2026-10-18T08:00:00.000Z', '2026-10-25T09:00:00.000Z']);
  });

  it('a non-existent local time (01:30 on spring-forward day) shifts forward an hour', () => {
    const gap: RecurrenceSpec = { startLocal: '2026-03-29T01:30:00', rrule: null, timezone: 'Europe/London' };
    const e = nextEventAfter(gap, utc('2026-03-01T00:00:00'))!;
    expect(local(e, 'Europe/London')).toBe('2026-03-29T02:30 Sun');
    expect(iso(e)).toBe('2026-03-29T01:30:00.000Z');
  });

  it('an ambiguous local time (01:30 on fall-back day) resolves to a single instant', () => {
    const amb: RecurrenceSpec = { startLocal: '2026-10-25T01:30:00', rrule: null, timezone: 'Europe/London' };
    const e = nextEventAfter(amb, utc('2026-10-01T00:00:00'))!;
    expect(local(e, 'Europe/London')).toBe('2026-10-25T01:30 Sun');
  });

  it('a daily reminder never double-fires or skips around the change', () => {
    const daily: RecurrenceSpec = { startLocal: '2026-10-23T07:00:00', rrule: 'FREQ=DAILY', timezone: 'Europe/London' };
    const events = upcomingEvents(daily, utc('2026-10-22T00:00:00'), 5).map((d) => local(d, 'Europe/London'));
    expect(events).toEqual([
      '2026-10-23T07:00 Fri',
      '2026-10-24T07:00 Sat',
      '2026-10-25T07:00 Sun',
      '2026-10-26T07:00 Mon',
      '2026-10-27T07:00 Tue',
    ]);
  });
});

describe('timezones far from UTC', () => {
  it('handles a reminder just after local midnight in Pacific/Auckland', () => {
    const spec: RecurrenceSpec = { startLocal: '2026-10-11T00:30:00', rrule: 'FREQ=DAILY', timezone: 'Pacific/Auckland' };
    // 00:30 NZDT (UTC+13) = 11:30Z previous day.
    const e = nextEventAfter(spec, utc('2026-10-10T00:00:00'))!;
    expect(iso(e)).toBe('2026-10-10T11:30:00.000Z');
  });
});

describe('recurrence end and validation', () => {
  it('honours COUNT', () => {
    const spec: RecurrenceSpec = { startLocal: '2026-10-11T09:00:00', rrule: 'FREQ=DAILY;COUNT=2', timezone: 'Africa/Lagos' };
    expect(upcomingEvents(spec, utc('2026-10-01T00:00:00'), 5)).toHaveLength(2);
  });

  it('normalises and validates rrule bodies', () => {
    expect(normaliseRrule('RRULE:freq=monthly;byday=1sa')).toBe('FREQ=MONTHLY;BYDAY=+1SA');
    expect(isValidRrule('FREQ=YEARLY')).toBe(true);
    expect(isValidRrule('FREQ=HOURLY')).toBe(false);
    expect(isValidRrule('FREQ=DAILY;BYHOUR=9')).toBe(false);
    expect(isValidRrule('nonsense')).toBe(false);
  });

  it('rejects invalid timezones', () => {
    expect(() =>
      nextEventAfter({ startLocal: '2026-10-11T09:00:00', rrule: null, timezone: 'Mars/Base' }, new Date()),
    ).toThrow(/timezone/);
  });
});
