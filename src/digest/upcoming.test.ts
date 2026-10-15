import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { Reminder } from '../db/schema.js';
import {
  describeSchedule,
  DIGEST_JITTER_MS,
  digestWindow,
  formatRange,
  formatUpcoming,
  jitteredFireAt,
  nextDigestSlot,
  upcomingInWindow,
  weekKey,
} from './upcoming.js';

const TZ = 'Africa/Lagos';
let seq = 0;
const reminder = (over: Partial<Reminder>): Reminder => ({
  id: ++seq,
  groupId: 1,
  shortId: seq,
  title: 'Thing',
  kind: 'event',
  startLocal: '2026-10-11 11:00:00',
  rrule: null,
  timezone: TZ,
  offsetsMinutes: [0],
  subjectMemberId: null,
  subjectName: null,
  birthYear: null,
  messageStyle: null,
  createdByMemberId: 1,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  cancelledAt: null,
  ...over,
});

/** Items as "local day time title" for readable assertions. */
const run = (reminders: Reminder[], from: string, tz = TZ, notBefore?: string) => {
  const w = digestWindow(new Date(from), tz, notBefore ? new Date(notBefore) : undefined);
  return upcomingInWindow(reminders, w, tz).map(
    (i) => `${DateTime.fromJSDate(i.at).setZone(tz).toFormat('ccc dd LLL HH:mm')} ${i.reminder.title}`,
  );
};

describe('upcomingInWindow', () => {
  it('expands yearly, monthly ("first Saturday"), weekly and one-off reminders over the 7 days', () => {
    const items = run(
      [
        reminder({ title: "Ada's birthday", kind: 'birthday', startLocal: '2026-10-14 06:00:00', rrule: 'FREQ=YEARLY' }),
        reminder({ title: 'Pay dues', kind: 'generic', startLocal: '2026-11-07 09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=1SA' }),
        reminder({ title: 'Choir practice', startLocal: '2026-10-01 18:00:00', rrule: 'FREQ=WEEKLY;BYDAY=TH' }),
        reminder({ title: 'Wedding', startLocal: '2026-10-17 14:00:00' }),
        reminder({ title: 'Too late', startLocal: '2026-10-20 14:00:00' }), // after the window
      ],
      '2026-10-12T07:00:00Z', // Mon 12 Oct 08:00 WAT
    );
    expect(items).toEqual(['Wed 14 Oct 06:00 Ada\'s birthday', 'Thu 15 Oct 18:00 Choir practice', 'Sat 17 Oct 14:00 Wedding']);
    // First Saturday of November falls in a window starting Mon 2 Nov.
    expect(run([reminder({ title: 'Pay dues', kind: 'generic', startLocal: '2026-11-07 09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=1SA' })], '2026-11-02T07:00:00Z'))
      .toEqual(['Sat 07 Nov 09:00 Pay dues']);
  });

  it('includes every occurrence of a daily reminder', () => {
    expect(run([reminder({ title: 'Attendance', startLocal: '2026-10-01 21:00:00', rrule: 'FREQ=DAILY' })], '2026-10-12T07:00:00Z')).toHaveLength(7);
  });

  it('spans a month end and a year end', () => {
    const monthly = reminder({ title: 'Month-end report', kind: 'generic', startLocal: '2026-10-31 17:00:00', rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1' });
    const newYear = reminder({ title: 'New year service', startLocal: '2027-01-01 00:30:00' });
    expect(run([monthly], '2026-10-28T07:00:00Z')).toEqual(['Sat 31 Oct 17:00 Month-end report']);
    expect(run([monthly, newYear], '2026-12-28T07:00:00Z')).toEqual(['Thu 31 Dec 17:00 Month-end report', 'Fri 01 Jan 00:30 New year service']);
  });

  it('keeps local times across a DST change inside the window', () => {
    // UK clocks go back on Sun 25 Oct 2026; a weekly 09:00 stays 09:00 local either side.
    const tz = 'Europe/London';
    const weekly = reminder({ title: 'Standup', timezone: tz, startLocal: '2026-10-01 09:00:00', rrule: 'FREQ=WEEKLY;BYDAY=SA,MO' });
    const w = digestWindow(new Date('2026-10-23T08:00:00Z'), tz);
    const items = upcomingInWindow([weekly], w, tz);
    expect(items.map((i) => DateTime.fromJSDate(i.at).setZone(tz).toFormat('ccc dd HH:mm'))).toEqual(['Sat 24 09:00', 'Mon 26 09:00']);
    expect(items.map((i) => i.at.toISOString())).toEqual(['2026-10-24T08:00:00.000Z', '2026-10-26T09:00:00.000Z']);
  });

  it('29 Feb birthdays: on the day in leap years, 28 Feb otherwise', () => {
    const feb29 = reminder({ title: "Chidi's birthday", kind: 'birthday', startLocal: '2024-02-29 06:00:00', rrule: 'FREQ=YEARLY' });
    expect(run([feb29], '2027-02-25T07:00:00Z')).toEqual(["Sun 28 Feb 06:00 Chidi's birthday"]);
    expect(run([feb29], '2028-02-25T07:00:00Z')).toEqual(["Tue 29 Feb 06:00 Chidi's birthday"]);
  });

  it('leaves out cancelled reminders', () => {
    expect(run([reminder({ title: 'Gone', startLocal: '2026-10-13 10:00:00', active: false })], '2026-10-12T07:00:00Z')).toEqual([]);
  });

  it('drops timed items already over, but keeps today’s birthdays; all-day items come first in a day', () => {
    const items = run(
      [
        reminder({ title: 'Early call', startLocal: '2026-10-12 07:00:00' }),
        reminder({ title: 'Lunch', startLocal: '2026-10-12 13:00:00' }),
        reminder({ title: 'Morning prayer', startLocal: '2026-10-12 08:05:00' }),
        reminder({ title: "Ada's birthday", kind: 'birthday', startLocal: '2026-10-12 06:00:00', rrule: 'FREQ=YEARLY' }),
        reminder({ title: "Tunde & Bisi's anniversary", kind: 'anniversary', startLocal: '2026-10-12 06:00:00', rrule: 'FREQ=YEARLY' }),
      ],
      '2026-10-12T07:00:00Z', // slot 08:00 WAT
      TZ,
      '2026-10-12T07:07:00Z', // sent at 08:07 after jitter
    );
    expect(items).toEqual([
      "Mon 12 Oct 06:00 Ada's birthday",
      "Mon 12 Oct 06:00 Tunde & Bisi's anniversary",
      'Mon 12 Oct 13:00 Lunch',
    ]);
  });
});

describe('formatUpcoming', () => {
  const window = digestWindow(new Date('2026-10-13T07:00:00Z'), TZ); // Tue 13 – Mon 19 Oct
  const opts = { kind: 'digest' as const, groupName: 'Family Group', timezone: TZ, botName: 'Ranti' };
  const items = upcomingInWindow(
    [
      reminder({ title: "Ada's birthday", kind: 'birthday', startLocal: '2026-10-15 06:00:00', rrule: 'FREQ=YEARLY', subjectMemberId: 7 }),
      reminder({ title: 'Choir practice', startLocal: '2026-10-16 18:00:00' }),
      reminder({ title: 'Pay monthly dues', kind: 'generic', startLocal: '2026-10-18 09:00:00' }),
      reminder({ title: "Tunde & Bisi's anniversary", kind: 'anniversary', startLocal: '2026-10-18 06:00:00', rrule: 'FREQ=YEARLY' }),
    ],
    window,
    TZ,
  );

  it('groups by day with all-day items first, in the group timezone, with no mentions', () => {
    expect(formatUpcoming(items, window, opts)).toBe(
      [
        '📅 This week in Family Group (13–19 Oct)',
        '',
        "Thu 15 – 🎂 Ada's birthday",
        'Fri 16 – Choir practice, 18:00',
        "Sun 18 – 💍 Tunde & Bisi's anniversary",
        'Sun 18 – Pay monthly dues, 09:00',
        '',
        'Have a great week!',
      ].join('\n'),
    );
  });

  it('never contains an @, even if a title has one', () => {
    const w = upcomingInWindow([reminder({ title: '@2348011111111 birthday', kind: 'birthday', startLocal: '2026-10-15 06:00:00', rrule: 'FREQ=YEARLY' })], window, TZ);
    expect(formatUpcoming(w, window, opts)).not.toContain('@');
  });

  it('shows at most 20 items, then how many more', () => {
    const daily = Array.from({ length: 4 }, (_, i) => reminder({ title: `Daily ${i}`, startLocal: `2026-10-01 0${i + 1}:00:00`, rrule: 'FREQ=DAILY' }));
    const many = upcomingInWindow(daily, window, TZ);
    expect(many).toHaveLength(24); // the first morning's ones are before the 08:00 send
    const text = formatUpcoming(many, window, opts)!;
    expect(text.split('\n').filter((l) => / – Daily/.test(l))).toHaveLength(20);
    expect(text).toContain('+4 more. Ask me about a day, e.g. "@Ranti what\'s on Saturday?"');
  });

  it('an empty week posts nothing unless the group asked, and on-demand always answers', () => {
    expect(formatUpcoming([], window, opts)).toBeNull();
    expect(formatUpcoming([], window, { ...opts, postEmpty: true })).toBe('📅 Nothing scheduled this week in Family Group (13–19 Oct).');
    expect(formatUpcoming([], window, { ...opts, kind: 'on_demand' })).toBe('📅 Nothing coming up in the next 7 days (13–19 Oct).');
    expect(formatUpcoming(items, window, { ...opts, kind: 'on_demand', groupName: null })!.split('\n')[0]).toBe('📅 Coming up (13–19 Oct)');
  });

  it('formats ranges across months', () => {
    expect(formatRange(digestWindow(new Date('2026-09-28T07:00:00Z'), TZ), TZ)).toBe('28 Sep – 4 Oct');
    expect(formatRange(digestWindow(new Date('2026-12-29T07:00:00Z'), TZ), TZ)).toBe('29 Dec – 4 Jan');
  });
});

describe('digest schedule', () => {
  const settings = { digestWeekday: 7, digestTime: '19:00', timezone: TZ }; // Sundays 19:00
  const slot = (after: string, s = settings) => nextDigestSlot(s, new Date(after)).toFormat("ccc yyyy-MM-dd'T'HH:mm ZZ");

  it('finds the next configured day and time', () => {
    expect(slot('2026-10-15T09:00:00Z')).toBe('Sun 2026-10-18T19:00 +01:00');
    expect(slot('2026-10-18T17:59:00Z')).toBe('Sun 2026-10-18T19:00 +01:00'); // 18:59 local, same day
    expect(slot('2026-10-18T18:00:00Z')).toBe('Sun 2026-10-25T19:00 +01:00'); // exactly at the slot: next week
  });

  it('handles DST: the local time is kept, and a time that does not exist moves forward', () => {
    const london = { digestWeekday: 7, digestTime: '01:30', timezone: 'Europe/London' };
    expect(slot('2027-03-25T12:00:00Z', london)).toBe('Sun 2027-03-28T02:30 +01:00'); // 01:30 skipped by spring-forward
    expect(slot('2026-10-20T12:00:00Z', { ...london, digestTime: '09:00' })).toBe('Sun 2026-10-25T09:00 +00:00');
  });

  it('keys runs by ISO week', () => {
    expect(weekKey(nextDigestSlot(settings, new Date('2026-10-15T09:00:00Z')))).toBe('2026-W42');
    expect(weekKey(DateTime.fromISO('2027-01-03T19:00', { zone: TZ }))).toBe('2026-W53');
  });

  it('jitter stays within 0-15 minutes', () => {
    const s = nextDigestSlot(settings, new Date('2026-10-15T09:00:00Z'));
    for (const r of [0, 0.25, 0.5, 0.999999, 1, -1]) {
      const delta = jitteredFireAt(s, () => r).getTime() - s.toMillis();
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThan(DIGEST_JITTER_MS);
    }
    expect(jitteredFireAt(s, () => 0.5).getTime() - s.toMillis()).toBe(7.5 * 60_000);
  });

  it('describes the schedule', () => {
    expect(describeSchedule(settings)).toBe('Sundays at 19:00 (Africa/Lagos)');
  });
});
