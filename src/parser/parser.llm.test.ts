import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AnthropicParser } from './anthropic-parser.js';
import { compareCommands, FIXTURES, fixtureToInput } from './fixtures.js';

// Calls the real Anthropic API. Skipped unless RUN_LLM_TESTS=1 (and ANTHROPIC_API_KEY is set).
const enabled = process.env.RUN_LLM_TESTS === '1';

describe.skipIf(!enabled)('AnthropicParser against fixtures (real API)', () => {
  const parser = new AnthropicParser({
    model: process.env.PARSER_MODEL ?? 'claude-haiku-5-5',
    botName: 'Ranti',
    logger: pino({ level: 'warn' }),
  });

  it.concurrent.each(FIXTURES.map((f) => [f.name, f] as const))(
    '%s',
    async (_name, fixture) => {
      const actual = await parser.parseCommand(fixtureToInput(fixture));
      const problems = compareCommands(fixture, actual);
      expect(problems, JSON.stringify(actual, null, 2)).toEqual([]);
    },
    60_000,
  );
});
