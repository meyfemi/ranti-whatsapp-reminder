import { describe, expect, it } from 'vitest';
import type { Reminder } from '../db/schema.js';
import { eventsBetween, filterReminders, nextEvents, periodBounds } from './query.js';

let seq = 0;
const reminder = (over: Partial<Reminder>): Reminder => ({
  id: ++seq,
  groupId: 1,
  shortId: seq,
  title: 'Thing',
  kind: 'event',
  startLocal: '2026-10-11 11:00:00',
  rrule: null,
  timezone: 'Africa/Lagos',
  offsetsMinutes: [0],
  subjectMemberId: null,
  messageStyle: null,
  createdByMemberId: 1,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  cancelledAt: null,
  ...over,
});

const NOW = new Date('2026-10-07T09:00:00Z'); // Wed 7 Oct, 10:00 WAT

describe('periodBounds', () => {
  it('covers whole local days', () => {
    const { start, end } = periodBounds('2026-10-07', '2026-10-11', 'Africa/Lagos');
    expect(start.toISOString()).toBe('2026-10-06T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-11T23:00:00.000Z');
  });
});

describe('filterReminders', () => {
  const a = reminder({ kind: 'birthday', subjectMemberId: 7 });
  const b = reminder({ kind: 'event' });
  it('filters by id, subject and kind', () => {
    expect(filterReminders([a, b], { shortIds: [], subjectMemberId: null, kind: null })).toEqual([a, b]);
    expect(filterReminders([a, b], { shortIds: [b.shortId], subjectMemberId: null, kind: null })).toEqual([b]);
    expect(filterReminders([a, b], { shortIds: [], subjectMemberId: 7, kind: null })).toEqual([a]);
    expect(filterReminders([a, b], { shortIds: [], subjectMemberId: null, kind: 'birthday' })).toEqual([a]);
    expect(filterReminders([a, b], { shortIds: [], subjectMemberId: 8, kind: null })).toEqual([]);
  });
});

describe('eventsBetween', () => {
  const { start, end } = periodBounds('2026-10-07', '2026-10-11', 'Africa/Lagos');

  it('lists events in the period soonest first, including each repeat', () => {
    const meeting = reminder({ title: 'Meeting', startLocal: '2026-10-11 11:00:00' });
    const later = reminder({ title: 'Later', startLocal: '2026-10-20 11:00:00' });
    const daily = reminder({ title: 'Attendance', startLocal: '2026-10-07 21:00:00', rrule: 'FREQ=DAILY' });
    const { events, truncated } = eventsBetween([meeting, later, daily], start, end, NOW);
    expect(truncated).toBe(false);
    expect(events.map((e) => `${e.reminder.title} ${e.at.toISOString()}`)).toEqual([
      'Attendance 2026-10-07T20:00:00.000Z',
      'Attendance 2026-10-08T20:00:00.000Z',
      'Attendance 2026-10-09T20:00:00.000Z',
      'Attendance 2026-10-10T20:00:00.000Z',
      'Meeting 2026-10-11T10:00:00.000Z',
      'Attendance 2026-10-11T20:00:00.000Z',
    ]);
  });

  it('leaves out events earlier today', () => {
    const morning = reminder({ startLocal: '2026-10-07 08:00:00' });
    expect(eventsBetween([morning], start, end, NOW).events).toEqual([]);
  });

  it('caps the list and reports truncation', () => {
    const daily = reminder({ startLocal: '2026-10-07 21:00:00', rrule: 'FREQ=DAILY' });
    const month = periodBounds('2026-10-07', '2026-10-31', 'Africa/Lagos');
    const { events, truncated } = eventsBetween([daily], month.start, month.end, NOW, 5);
    expect(events).toHaveLength(5);
    expect(truncated).toBe(true);
  });
});

describe('nextEvents', () => {
  it('returns the next event per reminder and drops finished ones', () => {
    const birthday = reminder({ kind: 'birthday', startLocal: '2026-03-03 09:00:00', rrule: 'FREQ=YEARLY' });
    const past = reminder({ startLocal: '2026-10-01 09:00:00' });
    expect(nextEvents([birthday, past], NOW).map((e) => e.at.toISOString())).toEqual(['2027-03-03T08:00:00.000Z']);
  });
});
