import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c.DEFAULT_TIMEZONE).toBe('Africa/Lagos');
    expect(c.MAX_ACTIVE_REMINDERS_PER_GROUP).toBe(50);
    expect(c.PARSER_MODEL).toBe('claude-haiku-5-5');
    expect(c.LLM_GREETINGS).toBe(false);
    expect(c.ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a malformed pairing phone', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', WA_PAIRING_PHONE: '+234 801' })).toThrow(/WA_PAIRING_PHONE/);
  });

  it('treats empty strings as unset', () => {
    const c = loadConfig({ DATABASE_URL: 'x', ALERT_WEBHOOK_URL: '', ANTHROPIC_API_KEY: '  ' });
    expect(c.ALERT_WEBHOOK_URL).toBeUndefined();
    expect(c.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
