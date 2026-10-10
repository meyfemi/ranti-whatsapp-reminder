import { describe, expect, it } from 'vitest';
import { nextEventAfter } from '../scheduler/recurrence.js';
import type { CreateReminderInput } from './types.js';
import { validateCreate } from './validation.js';

const now = new Date('2026-10-07T09:00:00Z');
const base: CreateReminderInput = {
  title: 'Birthday',
  kind: 'birthday',
  startLocal: '2028-02-29T09:00:00',
  rrule: 'FREQ=YEARLY',
  offsetsMinutes: [0],
  subjectMemberId: null,
  messageStyle: null,
};

describe('validateCreate', () => {
  it('anchors a future Feb 29 yearly start to a past leap year so 2027 is not skipped', () => {
    const r = validateCreate(base, 'Africa/Lagos', now);
    expect(r.ok && r.value.startLocal).toBe('2024-02-29T09:00:00');
    const next = nextEventAfter({ startLocal: r.ok ? r.value.startLocal : '', rrule: 'FREQ=YEARLY', timezone: 'Africa/Lagos' }, now);
    expect(next?.toISOString()).toBe('2027-02-28T08:00:00.000Z');
  });

  it('dedupes and sorts offsets, defaulting to [0]', () => {
    const r = validateCreate({ ...base, startLocal: '2026-10-12T09:00:00', offsetsMinutes: [0, 5, 5] }, 'Africa/Lagos', now);
    expect(r.ok && r.value.offsetsMinutes).toEqual([5, 0]);
    const d = validateCreate({ ...base, startLocal: '2026-10-12T09:00:00', offsetsMinutes: [] }, 'Africa/Lagos', now);
    expect(d.ok && d.value.offsetsMinutes).toEqual([0]);
  });

  it('rejects bad input', () => {
    expect(validateCreate({ ...base, offsetsMinutes: [-1] }, 'Africa/Lagos', now).ok).toBe(false);
    expect(validateCreate({ ...base, offsetsMinutes: [1, 2, 3, 4, 5, 6] }, 'Africa/Lagos', now).ok).toBe(false);
    expect(validateCreate({ ...base, startLocal: 'soon' }, 'Africa/Lagos', now).ok).toBe(false);
    expect(validateCreate(base, 'Not/AZone', now).ok).toBe(false);
    expect(validateCreate({ ...base, rrule: 'FREQ=YEARLY;COUNT=1', startLocal: '2020-03-01T09:00:00' }, 'Africa/Lagos', now)).toEqual({
      ok: false,
      error: 'That schedule has no future dates.',
    });
  });
});
