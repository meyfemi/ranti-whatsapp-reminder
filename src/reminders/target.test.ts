import { describe, expect, it } from 'vitest';
import type { Reminder } from '../db/schema.js';
import { resolveTarget } from './target.js';

const r = (shortId: number, title: string, kind: Reminder['kind'] = 'generic') => ({ shortId, title, kind }) as Reminder;
const active = [r(1, "John's birthday", 'birthday'), r(2, 'General meeting', 'event'), r(4, 'Pay dues'), r(5, "Mary's birthday", 'birthday')];

describe('resolveTarget', () => {
  it('finds by short ID', () => {
    expect(resolveTarget(active, { short_id: 4, description: null })).toMatchObject({ kind: 'found', reminder: { shortId: 4 } });
  });
  it('reports a missing short ID', () => {
    expect(resolveTarget(active, { short_id: 9, description: null })).toEqual({
      kind: 'none',
      message: "I couldn't find an active reminder #9.",
    });
  });
  it('falls back to the description when the short ID is wrong', () => {
    expect(resolveTarget(active, { short_id: 9, description: 'the dues reminder' })).toMatchObject({ reminder: { shortId: 4 } });
  });
  it('matches descriptions by words', () => {
    expect(resolveTarget(active, { short_id: null, description: 'the dues reminder' })).toMatchObject({ reminder: { shortId: 4 } });
    expect(resolveTarget(active, { short_id: null, description: "John's birthday" })).toMatchObject({ reminder: { shortId: 1 } });
    expect(resolveTarget(active, { short_id: null, description: 'meeting' })).toMatchObject({ reminder: { shortId: 2 } });
  });
  it('reports ambiguity', () => {
    const res = resolveTarget(active, { short_id: null, description: 'the birthday reminder' });
    expect(res.kind).toBe('ambiguous');
    expect(res.kind === 'ambiguous' && res.candidates.map((c) => c.shortId)).toEqual([1, 5]);
  });
  it('reports no match', () => {
    expect(resolveTarget(active, { short_id: null, description: 'the picnic' }).kind).toBe('none');
  });
});
