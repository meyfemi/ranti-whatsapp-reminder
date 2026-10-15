import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logger.js';
import { allowedSubjectIds, buildUserContent, loadSystemPrompt } from './context.js';
import { validateCommand, type ParsedCommand } from './schema.js';
import { commandTools, fromToolCall } from './tools.js';
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

const RETRY_QUESTION = "Sorry, I didn't quite get that. Could you rephrase it?";

/**
 * LLM-backed parser. The model only converts text to a command by calling one strict tool per
 * action (see tools.ts for why tools); the call is then validated again with zod before
 * anything uses it.
 */
export class AnthropicParser implements Parser {
  private readonly client: Anthropic;
  private readonly systemPrompt: string;
  private readonly tools = commandTools();

  constructor(private readonly opts: AnthropicParserOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 30_000, maxRetries: 2 });
    this.systemPrompt = loadSystemPrompt(opts.botName);
  }

  async parseCommand(input: ParserInput): Promise<ParsedCommand> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 16000,
        system: [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: this.tools,
        // "auto": forcing a tool is rejected by some current models; the prompt says to always call one.
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: buildUserContent(input) }],
        ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
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
        this.opts.logger.warn({ err }, 'Parser call failed');
      }
      throw new ParserUnavailableError('Parser unavailable', { cause: err });
    }

    if (response.stop_reason === 'refusal') {
      return { action: 'unsupported', reason: 'I can only help with reminders for this group.' };
    }
    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason === 'max_tokens' || !call) {
      this.opts.logger.warn({ stopReason: response.stop_reason }, 'Parser returned no usable output');
      return { action: 'clarify', question: RETRY_QUESTION };
    }

    const validated = validateCommand({ command: fromToolCall(call.name, call.input) }, { mentionedUserIds: allowedSubjectIds(input) });
    if (!validated.ok) {
      this.opts.logger.info({ issues: validated.issues }, 'Parser output failed validation');
      return validated.fallback;
    }
    return validated.command;
  }
}
