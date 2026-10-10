import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Logger } from '../logger.js';
import { allowedSubjectIds, buildUserContent, loadSystemPrompt } from './context.js';
import { LlmOutputSchema, validateCommand, type ParsedCommand } from './schema.js';
import { ParserUnavailableError, type Parser, type ParserInput } from './types.js';

export interface AnthropicParserOptions {
  apiKey?: string;
  model: string;
  botName: string;
  logger: Logger;
  /** Optional effort level; omitted = the model's default. */
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

/**
 * LLM-backed parser. The model only converts text to a command; its output is constrained by
 * structured outputs and then validated again with zod before anything uses it.
 */
export class AnthropicParser implements Parser {
  private readonly client: Anthropic;
  private readonly systemPrompt: string;

  constructor(private readonly opts: AnthropicParserOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 30_000, maxRetries: 2 });
    this.systemPrompt = loadSystemPrompt(opts.botName);
  }

  async parseCommand(input: ParserInput): Promise<ParsedCommand> {
    let response;
    try {
      response = await this.client.messages.parse({
        model: this.opts.model,
        max_tokens: 16000,
        system: [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildUserContent(input) }],
        output_config: {
          format: zodOutputFormat(LlmOutputSchema),
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        this.opts.logger.error({ err }, 'Parser API credentials rejected');
      } else if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
        this.opts.logger.error({ err, model: this.opts.model }, 'Parser request rejected (check PARSER_MODEL)');
      } else if (err instanceof Anthropic.RateLimitError) {
        this.opts.logger.warn({ err }, 'Parser rate limited');
      } else if (err instanceof Anthropic.APIError) {
        this.opts.logger.warn({ err }, 'Parser API error');
      } else {
        // zod/JSON errors from client-side parsing land here; treat as a garbled response.
        this.opts.logger.warn({ err }, 'Parser response could not be parsed');
        return { action: 'clarify', question: "Sorry, I didn't quite get that. Could you rephrase it?" };
      }
      throw new ParserUnavailableError('Parser unavailable', { cause: err });
    }

    if (response.stop_reason === 'refusal') {
      return { action: 'unsupported', reason: 'I can only help with reminders for this group.' };
    }
    if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
      this.opts.logger.warn({ stopReason: response.stop_reason }, 'Parser returned no usable output');
      return { action: 'clarify', question: "Sorry, I didn't quite get that. Could you rephrase it?" };
    }

    const validated = validateCommand(response.parsed_output, { mentionedUserIds: allowedSubjectIds(input) });
    if (!validated.ok) {
      this.opts.logger.info({ issues: validated.issues }, 'Parser output failed validation');
      return validated.fallback;
    }
    return validated.command;
  }
}
