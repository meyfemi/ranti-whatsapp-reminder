import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  describeOffsets,
  describeRecurrence,
  describeWhen,
  formatDuration,
  sanitizeText,
  tzAbbrev,
} from './format.js';

describe('tzAbbrev', () => {
  it('prefers named abbreviations', () => {
    expect(tzAbbrev(DateTime.fromISO('2026-10-11T11:00', { zone: 'Africa/Lagos' }))).toBe('WAT');
    expect(tzAbbrev(DateTime.fromISO('2026-07-11T11:00', { zone: 'Europe/London' }))).toBe('BST');
    expect(tzAbbrev(DateTime.fromISO('2026-12-11T11:00', { zone: 'Europe/London' }))).toBe('GMT');
    expect(tzAbbrev(DateTime.fromISO('2026-10-11T11:00', { zone: 'America/New_York' }))).toBe('EDT');
  });
});

describe('describeWhen', () => {
  it('one-off', () => {
    expect(describeWhen({ startLocal: '2026-10-11T11:00:00', rrule: null, timezone: 'Africa/Lagos', offsetsMinutes: [0] })).toBe(
      'Sun 11 Oct, 11:00 (WAT)',
    );
  });
  it('yearly', () => {
    expect(
      describeWhen({ startLocal: '2026-10-12T09:00:00', rrule: 'FREQ=YEARLY', timezone: 'Africa/Lagos', offsetsMinutes: [0] }),
    ).toBe('every year on 12 Oct at 09:00 (WAT)');
  });
  it('monthly first Saturday', () => {
    expect(
      describeWhen({
        startLocal: '2026-11-07T09:00:00',
        rrule: 'FREQ=MONTHLY;BYDAY=1SA',
        timezone: 'Africa/Lagos',
        offsetsMinutes: [0],
      }),
    ).toBe('every first Saturday of the month at 09:00 (WAT)');
  });
});

describe('describeRecurrence', () => {
  const start = DateTime.fromISO('2026-10-11T09:00', { zone: 'Africa/Lagos' });
  it.each([
    ['FREQ=DAILY', 'every day'],
    ['FREQ=WEEKLY', 'every Sunday'],
    ['FREQ=WEEKLY;BYDAY=MO,WE', 'every Monday and Wednesday'],
    ['FREQ=WEEKLY;INTERVAL=2', 'every 2 weeks on Sunday'],
    ['FREQ=MONTHLY', 'every month on the 11th'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'every month on the last day'],
    ['FREQ=MONTHLY;BYDAY=-1FR', 'every last Friday of the month'],
  ])('%s → %s', (rule, text) => {
    expect(describeRecurrence(rule, start)).toBe(text);
  });
});

describe('describeOffsets', () => {
  it('lists clock times for a one-off', () => {
    expect(
      describeOffsets({ startLocal: '2026-10-11T11:00:00', rrule: null, timezone: 'Africa/Lagos', offsetsMinutes: [0, 5] }),
    ).toBe('Reminders at 10:55 and 11:00.');
  });
  it('uses relative wording for recurring reminders', () => {
    expect(
      describeOffsets({ startLocal: '2026-10-11T11:00:00', rrule: 'FREQ=WEEKLY', timezone: 'Africa/Lagos', offsetsMinutes: [1440, 0] }),
    ).toBe('Reminders 1 day before and at the time.');
  });
});

describe('formatDuration', () => {
  it.each([
    [5, '5 minutes'],
    [60, '1 hour'],
    [90, '1 hour 30 minutes'],
    [1440, '1 day'],
    [2880 + 120, '2 days 2 hours'],
  ])('%i → %s', (m, s) => expect(formatDuration(m)).toBe(s));
});

describe('sanitizeText', () => {
  it('removes mention characters and control/zero-width characters', () => {
    expect(sanitizeText('Meeting @everyone @2348012345678')).toBe('Meeting everyone 2348012345678');
    expect(sanitizeText('a\u200b\nb\tc')).toBe('a b c');
    expect(sanitizeText('full-width ＠all')).toBe('full-width all');
  });
  it('truncates long text', () => {
    expect(sanitizeText('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
