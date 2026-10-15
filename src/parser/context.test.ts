import { describe, expect, it } from 'vitest';
import { allowedSubjectIds, buildUserContent, loadSystemPrompt } from './context.js';

describe('parser context', () => {
  const input = {
    text: 'remind @john about it',
    sender: { id: 'cli:alice', name: 'alice' },
    timezone: 'Africa/Lagos',
    now: new Date('2026-10-07T09:00:00Z'),
    mentionedUsers: [{ id: 'cli:john', altIds: ['john@lid'], name: 'john', token: '@john' }],
    pending: { question: 'What time?', originalText: 'meeting sunday' },
  };

  it('includes local time with weekday, mentions and the pending question', () => {
    const content = buildUserContent(input);
    expect(content).toContain('"now_local": "Wednesday 2026-10-07T10:00"');
    expect(content).toContain('"token": "@john"');
    expect(content).toContain('"original_message": "meeting sunday"');
    expect(content).toContain('<message>\nremind @john about it\n</message>');
  });

  it('allows the sender and every known ID of mentioned users as subjects', () => {
    expect(allowedSubjectIds(input)).toEqual(['cli:alice', 'cli:john', 'john@lid']);
  });

  it('adds a quoted post and allows its author as a subject', () => {
    const quotedInput = { ...input, text: '', pending: undefined, quoted: { text: 'my birthday is 12 Oct', author: { id: 'cli:bola', name: 'bola' } } };
    expect(buildUserContent(quotedInput)).toContain(
      '<quoted_message author_id="cli:bola" author_name="bola">\nmy birthday is 12 Oct\n</quoted_message>\n\n<message>\n\n</message>',
    );
    expect(allowedSubjectIds(quotedInput)).toEqual(['cli:alice', 'cli:john', 'john@lid', 'cli:bola']);
  });

  it('loads the system prompt with the bot name filled in', () => {
    const prompt = loadSystemPrompt('Ranti');
    expect(prompt).toContain('command parser for Ranti');
    expect(prompt).not.toContain('{{BOT_NAME}}');
  });
});
