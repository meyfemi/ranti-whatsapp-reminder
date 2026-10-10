import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logger.js';
import { TemplateGreeter, type Greeter, type GreetingRequest } from './greetings.js';

const SYSTEM = `You write one short, warm group-chat message (1-2 sentences, at most 280 characters, at most 2 emoji) celebrating a birthday or anniversary in a WhatsApp group. Write the placeholder {who} exactly once where the person's name goes. Do not use "@" anywhere else and do not mention anyone else. Follow the group's requested style when given, as long as it is kind and appropriate; otherwise ignore it. Reply with the message only.`;

/**
 * Optional LLM-generated greetings (LLM_GREETINGS=1). Output is checked strictly and falls back to
 * the template pool on any problem, so a bad generation can never mass-mention or go silent.
 */
export class LlmGreeter implements Greeter {
  private readonly client: Anthropic;
  private readonly fallback: Greeter;

  constructor(
    private readonly model: string,
    private readonly logger: Logger,
    opts: { apiKey?: string; fallback?: Greeter } = {},
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: 20_000, maxRetries: 1 });
    this.fallback = opts.fallback ?? new TemplateGreeter();
  }

  async greet(req: GreetingRequest): Promise<string> {
    if (!req.subject) return this.fallback.greet(req);
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({ occasion: req.kind, title: req.title, requested_style: req.style }),
          },
        ],
      });
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      const valid =
        response.stop_reason === 'end_turn' &&
        text.split('{who}').length === 2 &&
        !text.includes('@') &&
        text.length <= 320;
      if (!valid) {
        this.logger.warn({ stopReason: response.stop_reason }, 'LLM greeting rejected; using template');
        return this.fallback.greet(req);
      }
      return text.replace('{who}', req.subject);
    } catch (err) {
      this.logger.warn({ err }, 'LLM greeting failed; using template');
      return this.fallback.greet(req);
    }
  }
}
