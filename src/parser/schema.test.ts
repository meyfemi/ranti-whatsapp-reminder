import { describe, expect, it } from 'vitest';
import { allowedSubjectIds } from './context.js';
import { FIXTURES, fixtureToInput } from './fixtures.js';
import { validateCommand } from './schema.js';

const ctx = { mentionedUserIds: ['2348011111111@s.whatsapp.net', '99887766@lid'] };

const create = (over: Record<string, unknown> = {}) => ({
  command: {
    action: 'create',
    title: 'General meeting',
    kind: 'event',
    start_local: '2026-10-11T11:00:00',
    rrule: null,
    offsets_minutes: [5, 0],
    subject_user_id: null,
    message_style: null,
    ...over,
  },
});

describe('validateCommand', () => {
  it('accepts a valid create', () => {
    const r = validateCommand(create(), ctx);
    expect(r.ok).toBe(true);
  });

  it('accepts a subject that was mentioned (phone JID or LID)', () => {
    expect(validateCommand(create({ subject_user_id: '99887766@lid' }), ctx).ok).toBe(true);
  });

  it('rejects an invented subject ID with a who-is-it question', () => {
    const r = validateCommand(create({ subject_user_id: '111@s.whatsapp.net' }), ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fallback).toEqual({ action: 'clarify', question: 'Who is this reminder for? Please @mention them.' });
  });

  it.each([
    ['offset timestamp', { start_local: '2026-10-11T11:00:00Z' }],
    ['garbage date', { start_local: 'next sunday' }],
    ['hourly rrule', { rrule: 'FREQ=HOURLY' }],
    ['negative offset', { offsets_minutes: [-5] }],
    ['too many offsets', { offsets_minutes: [1, 2, 3, 4, 5, 6] }],
    ['empty title', { title: '   ' }],
    ['bad kind', { kind: 'party' }],
  ])('rejects %s', (_name, over) => {
    const r = validateCommand(create(over), ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fallback.action).toBe('clarify');
  });

  it('rejects unknown actions and non-objects', () => {
    expect(validateCommand({ command: { action: 'delete_group' } }, ctx).ok).toBe(false);
    expect(validateCommand('hello', ctx).ok).toBe(false);
    expect(validateCommand(null, ctx).ok).toBe(false);
  });

  it('validates timezones', () => {
    expect(validateCommand({ command: { action: 'set_timezone', timezone: 'Europe/London' } }, ctx).ok).toBe(true);
    const bad = validateCommand({ command: { action: 'set_timezone', timezone: 'London time' } }, ctx);
    expect(!bad.ok && bad.fallback.action).toBe('clarify');
  });

  it('requires a cancel target', () => {
    expect(validateCommand({ command: { action: 'cancel', target: { short_id: 4, description: null } } }, ctx).ok).toBe(true);
    expect(validateCommand({ command: { action: 'cancel', target: { short_id: null, description: ' ' } } }, ctx).ok).toBe(false);
  });

  it('validates edit changes', () => {
    const edit = (changes: Record<string, unknown>) => ({
      command: {
        action: 'edit',
        target: { short_id: 2, description: null },
        changes: {
          title: null,
          start_local: null,
          rrule: null,
          make_one_off: false,
          offsets_minutes: null,
          message_style: null,
          ...changes,
        },
      },
    });
    expect(validateCommand(edit({ start_local: '2026-10-12T10:00:00' }), ctx).ok).toBe(true);
    expect(validateCommand(edit({ start_local: 'tomorrow' }), ctx).ok).toBe(false);
  });

  it('every fixture expectation is itself a valid command', () => {
    for (const f of FIXTURES) {
      const r = validateCommand({ command: f.expected }, { mentionedUserIds: allowedSubjectIds(fixtureToInput(f)) });
      expect(r.ok, `${f.name}: ${!r.ok ? r.issues.join('; ') : ''}`).toBe(true);
    }
  });
});

describe('compareCommands', () => {
  it('every fixture matches itself', async () => {
    const { compareCommands } = await import('./fixtures.js');
    for (const f of FIXTURES) expect(compareCommands(f, f.expected), f.name).toEqual([]);
  });
});
