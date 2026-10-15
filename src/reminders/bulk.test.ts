import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  buildImport,
  cleanName,
  findDate,
  matchMembersByName,
  mentionsOnLine,
  nameMatchesMember,
  parsePreviewReply,
  previewTexts,
  splitIntoParts,
  validateBirthDate,
  yearlyStartLocal,
  type BulkContext,
  type ParsedBulkEntry,
} from './bulk.js';

const NOW = new Date('2026-10-07T09:00:00Z'); // Wed 7 Oct 2026, 10:00 WAT
const date = (text: string, format: 'DMY' | 'MDY' = 'DMY') => {
  const d = findDate(text, format, NOW);
  return d && { day: d.day, month: d.month, year: d.year };
};

describe('findDate', () => {
  it.each([
    ['John - 12 Oct', { day: 12, month: 10, year: null }],
    ['Kemi October 12', { day: 12, month: 10, year: null }],
    ['Segun Jan 3rd', { day: 3, month: 1, year: null }],
    ['Mama Bisi – 5th of June', { day: 5, month: 6, year: null }],
    ['Chidi: 29 Feb', { day: 29, month: 2, year: null }],
    ['Peter: 5 May 1985', { day: 5, month: 5, year: 1985 }],
    ['Funmi - December 25, 1990', { day: 25, month: 12, year: 1990 }],
    ['Grace - 12-10-1990', { day: 12, month: 10, year: 1990 }],
    ['Obi 12.10.95', { day: 12, month: 10, year: 1995 }],
    ['Ife 01/02/05', { day: 1, month: 2, year: 2005 }],
    ['Aunty May 5 Jun', { day: 5, month: 6, year: null }],
  ])('%s', (text, expected) => {
    expect(date(text)).toEqual(expected);
  });

  it('returns null when there is no day', () => {
    expect(date('Uncle T sometime in May')).toBeNull();
    expect(date('Bisi')).toBeNull();
  });

  it('reads ambiguous numeric dates with the group setting', () => {
    expect(date('Ada 03/04', 'DMY')).toEqual({ day: 3, month: 4, year: null });
    expect(date('Ada 03/04', 'MDY')).toEqual({ day: 4, month: 3, year: null });
  });

  it('a number above 12 is the day, whatever the setting', () => {
    expect(date('Tunde 21/07', 'MDY')).toEqual({ day: 21, month: 7, year: null });
    expect(date('Obi 12/25', 'DMY')).toEqual({ day: 25, month: 12, year: null });
  });
});

describe('validateBirthDate', () => {
  const v = (month: number | null, day: number | null, year: number | null = null) => validateBirthDate({ month, day, year }, NOW);
  it('accepts real dates, including 29 Feb', () => {
    expect(v(2, 29)).toEqual({ month: 2, day: 29, year: null });
    expect(v(12, 31)).toEqual({ month: 12, day: 31, year: null });
    expect(v(2, 29, 1992)).toEqual({ month: 2, day: 29, year: 1992 });
  });
  it.each([
    [6, 31, null],
    [2, 30, null],
    [13, 1, null],
    [0, 5, null],
    [4, 0, null],
    [null, 4, null],
    [2, 29, 1991], // not a leap year
  ])('rejects %s/%s/%s', (month, day, year) => {
    expect(v(month, day, year)).toBeNull();
  });
  it('drops an implausible year but keeps the date', () => {
    expect(v(10, 12, 2090)).toEqual({ month: 10, day: 12, year: null });
    expect(v(10, 12, 1850)).toEqual({ month: 10, day: 12, year: null });
  });
});

describe('yearlyStartLocal', () => {
  it('uses this year if the date is still ahead, otherwise next year', () => {
    expect(yearlyStartLocal(10, 12, NOW, 'Africa/Lagos')).toBe('2026-10-12T06:00:00');
    expect(yearlyStartLocal(3, 3, NOW, 'Africa/Lagos')).toBe('2027-03-03T06:00:00');
    expect(yearlyStartLocal(10, 7, NOW, 'Africa/Lagos')).toBe('2027-10-07T06:00:00'); // 06:00 today has passed
  });
  it('anchors 29 Feb to the latest leap year', () => {
    expect(yearlyStartLocal(2, 29, NOW, 'Africa/Lagos')).toBe('2024-02-29T06:00:00');
  });
});

describe('people', () => {
  const ada = { memberId: 1, tokens: ['@55443322110099', '@2348044444444'], name: 'Ada' }; // LID + phone JID
  const john = { memberId: 2, tokens: ['@2348011111111'], name: 'John' };

  it('maps mention tokens to members by the ID user part, for LID and phone-number forms', () => {
    expect(mentionsOnLine('@55443322110099 3 March', [john, ada])).toEqual([ada]);
    expect(mentionsOnLine('@2348044444444 - 3 March', [john, ada])).toEqual([ada]);
    expect(mentionsOnLine('@2348011111111 9 Feb', [ada, john])).toEqual([john]);
    expect(mentionsOnLine('Tunde 21/07', [ada, john])).toEqual([]);
  });

  it('does not match a token that only starts the same', () => {
    expect(mentionsOnLine('@23480111111119 9 Feb', [john])).toEqual([]);
  });

  it('matches display names exactly, ignoring case and spacing', () => {
    const members = [
      { id: 1, name: 'John' },
      { id: 2, name: 'Mary  Jane' },
      { id: 3, name: 'Tunde' },
      { id: 4, name: 'tunde' },
      { id: 5, name: null },
    ];
    expect(matchMembersByName(' john ', members).map((m) => m.id)).toEqual([1]);
    expect(matchMembersByName('mary jane', members).map((m) => m.id)).toEqual([2]);
    expect(matchMembersByName('Tunde', members).map((m) => m.id)).toEqual([3, 4]); // two: not linked
    expect(matchMembersByName('Jon', members)).toEqual([]); // no fuzzy matching
  });

  it('a name-only birthday matches a display name or its first word', () => {
    expect(nameMatchesMember('John', 'John Okafor')).toBe(true);
    expect(nameMatchesMember('john okafor', 'John  Okafor')).toBe(true);
    expect(nameMatchesMember('Okafor', 'John Okafor')).toBe(false);
    expect(nameMatchesMember('Jon', 'John')).toBe(false);
  });

  it('cleans names', () => {
    expect(cleanName('• Ada —')).toBe('Ada');
    expect(cleanName("Tola's birthday")).toBe('Tola');
    expect(cleanName('  Mary-Jane : ')).toBe('Mary-Jane');
    expect(cleanName('@2348011111111')).toBe('');
  });
});

const entry = (raw_line: string, name_text: string | null, month: number, day: number, extra: Partial<ParsedBulkEntry> = {}): ParsedBulkEntry => ({
  raw_line, name_text, mention_user_id: null, month, day, year: null, ...extra,
});
const ctx = (over: Partial<BulkContext> = {}): BulkContext => ({
  dateFormat: 'DMY',
  now: NOW,
  mentioned: [{ memberId: 10, tokens: ['@55443322110099'], name: 'Ada' }],
  members: [{ id: 10, name: 'Ada' }, { id: 11, name: 'John' }, { id: 12, name: 'Bisi' }, { id: 13, name: 'Bisi' }],
  existing: [],
  ...over,
});

describe('buildImport', () => {
  it('links mentions and exact names, keeps others name-only, and lists unreadable lines', () => {
    const r = buildImport(
      {
        entries: [
          entry('John - 12 Oct', 'John', 10, 12),
          entry('@55443322110099 3 March', null, 3, 3, { mention_user_id: '55443322110099@lid' }),
          entry('Tunde 21/07', 'Tunde', 7, 21),
          entry('Bisi 5 Jun', 'Bisi', 6, 5),
          entry('Kunle 31 June', 'Kunle', 6, 31),
        ],
        unparsed: ['Uncle T sometime in May'],
      },
      ctx(),
    );
    expect(r.entries.map((e) => [e.name, e.memberId, e.linkedBy, `${e.day}/${e.month}`])).toEqual([
      ['John', 11, 'name', '12/10'],
      ['Ada', 10, 'mention', '3/3'],
      ['Tunde', null, null, '21/7'],
      ['Bisi', null, null, '5/6'], // two members called Bisi: not linked
    ]);
    expect(r.unreadable).toEqual(['Uncle T sometime in May', 'Kunle 31 June']);
  });

  it('re-reads numeric dates with the group setting instead of trusting the parser', () => {
    const parsed = { entries: [entry('Ada 03/04', 'Ada', 3, 4)], unparsed: [] };
    expect(buildImport(parsed, ctx({ dateFormat: 'DMY' })).entries[0]).toMatchObject({ day: 3, month: 4 });
    expect(buildImport(parsed, ctx({ dateFormat: 'MDY' })).entries[0]).toMatchObject({ day: 4, month: 3 });
  });

  it('falls back to the parser for wordings code does not read', () => {
    const r = buildImport({ entries: [entry('Sade first day of June', 'Sade', 6, 1)], unparsed: [] }, ctx());
    expect(r.entries[0]).toMatchObject({ name: 'Sade', day: 1, month: 6 });
  });

  it('skips birthdays already saved (same member, or same name and date) and duplicates within the list', () => {
    const r = buildImport(
      {
        entries: [
          entry('@55443322110099 4 April', null, 4, 4), // Ada is saved already, on another date
          entry('Tunde 21/07', 'Tunde', 7, 21), // same name + date as a saved one
          entry('Tunde 22/07', 'Tunde', 7, 22), // same name, other date: a different Tunde
          entry('Sola 1 Sep', 'Sola', 9, 1),
          entry('sola - 1st September', 'sola', 9, 1),
        ],
        unparsed: [],
      },
      ctx({ existing: [{ memberId: 10, name: 'Ada', month: 3, day: 3 }, { memberId: null, name: 'Tunde', month: 7, day: 21 }] }),
    );
    expect(r.entries.map((e) => `${e.name} ${e.day}/${e.month}`)).toEqual(['Tunde 22/7', 'Sola 1/9']);
    expect(r.skipped).toEqual([
      { name: 'Ada', reason: 'saved' },
      { name: 'Tunde', reason: 'saved' },
      { name: 'sola', reason: 'twice' },
    ]);
  });

  it('a line with two people tagged cannot be read', () => {
    const c = ctx({ mentioned: [{ memberId: 1, tokens: ['@111'], name: 'A' }, { memberId: 2, tokens: ['@222'], name: 'B' }] });
    expect(buildImport({ entries: [entry('@111 @222 3 Jan', null, 1, 3)], unparsed: [] }, c).unreadable).toHaveLength(1);
  });
});

describe('preview replies', () => {
  it.each([
    ['yes', { kind: 'yes', count: null }],
    ['Yes!', { kind: 'yes', count: null }],
    ['save 3', { kind: 'yes', count: 3 }],
    ['save the first 2', { kind: 'yes', count: 2 }],
    ['no', { kind: 'no' }],
    ['cancel', { kind: 'no' }],
    ['remove 3', { kind: 'remove', numbers: [3] }],
    ['remove 2, 4 and 5', { kind: 'remove', numbers: [2, 4, 5] }],
    ['fix 2: 4 March', { kind: 'fix', number: 2, value: '4 March' }],
    ['fix 1 to Mama Bisi', { kind: 'fix', number: 1, value: 'Mama Bisi' }],
  ])('%s', (text, expected) => {
    expect(parsePreviewReply(text)).toEqual(expected);
  });
  it('ignores anything else', () => {
    expect(parsePreviewReply('thanks')).toBeNull();
    expect(parsePreviewReply('yes please add more later')).toBeNull();
  });

  const payload = buildImport(
    { entries: [entry('John - 12 Oct', 'Jon', 10, 12), entry('Tunde 21/07', 'Tunde', 7, 21), entry('Sola 1 Sep', 'Sola', 9, 1)], unparsed: [] },
    ctx(),
  );

  it('remove N drops entries', () => {
    const r = applyEdit(payload, { kind: 'remove', numbers: [1, 3] }, ctx());
    expect(r.ok && r.payload.entries.map((e) => e.name)).toEqual(['Tunde']);
    expect(applyEdit(payload, { kind: 'remove', numbers: [4] }, ctx())).toMatchObject({ ok: false });
  });

  it('fix N: <date> changes the date; an impossible date is refused', () => {
    const r = applyEdit(payload, { kind: 'fix', number: 2, value: '4 March' }, ctx());
    expect(r.ok && r.payload.entries[1]).toMatchObject({ name: 'Tunde', day: 4, month: 3 });
    expect(applyEdit(payload, { kind: 'fix', number: 2, value: '31 April' }, ctx())).toMatchObject({ ok: false });
  });

  it('fix N: <name> renames and matches members again', () => {
    const r = applyEdit(payload, { kind: 'fix', number: 1, value: 'John' }, ctx());
    expect(r.ok && r.payload.entries[0]).toMatchObject({ name: 'John', memberId: 11, linkedBy: 'name' });
  });

  it('fix N: @mention links the tagged member', () => {
    const r = applyEdit(payload, { kind: 'fix', number: 3, value: '@55443322110099' }, ctx());
    expect(r.ok && r.payload.entries[2]).toMatchObject({ memberId: 10, linkedBy: 'mention' });
  });

  it('a fix that creates a duplicate is refused', () => {
    expect(applyEdit(payload, { kind: 'fix', number: 3, value: 'Tunde' }, ctx())).toMatchObject({ ok: true }); // other date
    const r = applyEdit(payload, { kind: 'fix', number: 3, value: '21 July' }, ctx());
    expect(r.ok).toBe(true);
    const twice = applyEdit(r.ok ? r.payload : payload, { kind: 'fix', number: 3, value: 'Tunde' }, ctx());
    expect(twice).toMatchObject({ ok: false });
  });
});

describe('previewTexts', () => {
  const payload = {
    entries: [
      { line: '', name: 'John', memberId: 11, linkedBy: 'name' as const, month: 10, day: 12, year: null },
      { line: '', name: 'Ada', memberId: 10, linkedBy: 'mention' as const, month: 3, day: 3, year: null },
      { line: '', name: 'Chidi', memberId: null, linkedBy: null, month: 2, day: 29, year: 1992 },
    ],
    unreadable: ['Uncle T sometime in May'],
    skipped: [{ name: 'Bola', reason: 'saved' as const }],
  };

  it('shows month names, links, the 29 Feb note, problems and instructions, with no mentions', () => {
    const [text, ...rest] = previewTexts(payload, { remaining: 10, limit: 50 });
    expect(rest).toEqual([]);
    expect(text).toBe(
      [
        'I found 3 birthdays:',
        '1. John (matched to member John) – 12 Oct',
        '2. Ada (tagged) – 3 Mar',
        '3. Chidi – 29 Feb 1992 (wished on 28 Feb in non-leap years)',
        '',
        '⚠️ Couldn\'t read: "Uncle T sometime in May"',
        'ℹ️ Already saved: Bola (skipped)',
        '',
        'Reply "yes" to save 3, or "no" to cancel. You can also reply "remove 3" or "fix 2: 4 March". (Reply to this message.)',
      ].join('\n'),
    );
    expect(text).not.toContain('@');
  });

  it('warns when the group cap would be exceeded and offers to save the first N', () => {
    const [text] = previewTexts(payload, { remaining: 2, limit: 50 });
    expect(text).toContain('⚠️ This group can only have 2 more reminders (the limit is 50).');
    expect(text).toContain('Reply "save 2" to save the first 2');
  });

  it('splits long previews into numbered parts', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...payload.entries[0]!, name: `Person number ${i + 1}`, linkedBy: null }));
    const parts = previewTexts({ entries: many, unreadable: [], skipped: [] }, { remaining: 100, limit: 200 });
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(p.startsWith(`(${i + 1}/${parts.length})\n`)).toBe(true);
      expect(p.length).toBeLessThanOrEqual(1500 + 10);
    });
    expect(parts.join('\n')).toContain('100. Person number 100 – 12 Oct');
  });

  it('splitIntoParts keeps short text whole', () => {
    expect(splitIntoParts(['a', 'b'], 100)).toEqual(['a\nb']);
  });
});
