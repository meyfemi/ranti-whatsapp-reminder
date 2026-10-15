import { describe, expect, it } from 'vitest';
import { validateCommand } from './schema.js';
import { commandTools, fromToolCall } from './tools.js';

describe('commandTools', () => {
  const tools = commandTools();

  it('has one strict tool per action', () => {
    expect(tools.map((t) => t.name)).toContain('bulk_add_birthdays');
    expect(tools.every((t) => t.strict === true)).toBe(true);
  });

  it('has no nullable or union fields (the API allows at most 16 across all tools)', () => {
    const json = JSON.stringify(tools.map((t) => t.input_schema));
    expect(json).not.toMatch(/anyOf|oneOf|"type":\[|"null"/);
    expect(json).not.toMatch(/"(minimum|maximum|maxLength|minLength|pattern)"/);
  });

  it('every object is closed', () => {
    const objects: Record<string, unknown>[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (o.type === 'object') objects.push(o);
      Object.values(o).forEach(walk);
    };
    tools.forEach((t) => walk(t.input_schema));
    expect(objects.length).toBeGreaterThan(10);
    expect(objects.every((o) => o.additionalProperties === false)).toBe(true);
  });
});

describe('fromToolCall', () => {
  it('turns empty values back into nulls', () => {
    const cmd = fromToolCall('create', {
      title: 'Meeting', kind: 'event', start_local: '2026-10-11T11:00:00', rrule: '', offsets_minutes: [0],
      subject_user_id: 'null', message_style: '""',
    });
    expect(cmd).toEqual({
      action: 'create', title: 'Meeting', kind: 'event', start_local: '2026-10-11T11:00:00', rrule: null,
      offsets_minutes: [0], subject_user_id: null, message_style: null,
    });
    expect(validateCommand({ command: cmd }, { mentionedUserIds: [] }).ok).toBe(true);
  });

  it('handles nested objects, arrays, numbers, lists and choices', () => {
    expect(fromToolCall('query', { from_date: '', to_date: '', short_ids: [], subject_user_id: '', kind: 'none', no_match: false })).toEqual({
      action: 'query', from_date: null, to_date: null, short_ids: [], subject_user_id: null, kind: null, no_match: false,
    });
    const edit = fromToolCall('edit', {
      target: { short_id: 0, description: 'the meeting' },
      changes: { title: '', start_local: '2026-10-11T12:00:00', rrule: '', make_one_off: false, offsets_minutes: [], message_style: '' },
    }) as { target: unknown; changes: Record<string, unknown> };
    expect(edit.target).toEqual({ short_id: null, description: 'the meeting' });
    expect(edit.changes).toMatchObject({ title: null, rrule: null, offsets_minutes: null, start_local: '2026-10-11T12:00:00' });
    const bulk = fromToolCall('bulk_add_birthdays', {
      entries: [{ raw_line: '@123 3 Mar', name_text: '', mention_user_id: '123@lid', month: 3, day: 3, year: 0 }],
      unparsed: [],
    }) as { entries: unknown[] };
    expect(bulk.entries[0]).toEqual({ raw_line: '@123 3 Mar', name_text: null, mention_user_id: '123@lid', month: 3, day: 3, year: null });
  });

  it('leaves non-nullable fields alone', () => {
    expect(fromToolCall('unsupported', { reason: 'none' })).toEqual({ action: 'unsupported', reason: 'none' });
  });
});
