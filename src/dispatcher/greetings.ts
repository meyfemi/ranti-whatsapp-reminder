/**
 * Birthday/anniversary greetings. The default is a template pool; an LLM-backed generator can be
 * plugged in behind the LLM_GREETINGS flag (see parser/greeting-llm.ts).
 */

export interface GreetingRequest {
  kind: 'birthday' | 'anniversary';
  /** Mention token for the subject (e.g. "@2348012345678"), or a plain name if there is no subject. */
  subject: string | null;
  /** Sanitized reminder title, e.g. "John's birthday". */
  title: string;
  /** Sanitized free-text style from the user, e.g. "always wish him happy birthday". */
  style: string | null;
}

export interface Greeter {
  greet(req: GreetingRequest): Promise<string>;
}

const BIRTHDAY_TEMPLATES = [
  '🎂 Happy birthday {who}! Wishing you a wonderful year ahead, full of joy and good health.',
  '🎉 It\'s {who}\'s birthday today! Happy birthday, may this new year bring you everything you hope for.',
  '🥳 Happy birthday {who}! Have a fantastic day and an even better year.',
  '🎈 Join us in wishing {who} a very happy birthday! Many happy returns of the day.',
  '🎁 Happy birthday {who}! Cheers to another year of blessings and laughter.',
  '🌟 Today we celebrate {who}! Happy birthday, enjoy every moment.',
  '🎂 Many happy returns, {who}! May your day be as bright as you make ours.',
  '🎉 Happy birthday {who}! Sending love, prayers and lots of cake your way.',
];

const ANNIVERSARY_TEMPLATES = [
  '💐 Happy anniversary {who}! Wishing you many more years of love and happiness.',
  '🥂 Cheers to {who} on this special anniversary! Here\'s to many more.',
  '❤️ Happy anniversary {who}! Celebrating you today.',
  '🎊 It\'s {who}\'s anniversary today. Congratulations and many happy returns!',
];

export class TemplateGreeter implements Greeter {
  constructor(private readonly random: () => number = Math.random) {}

  async greet(req: GreetingRequest): Promise<string> {
    const pool = req.kind === 'birthday' ? BIRTHDAY_TEMPLATES : ANNIVERSARY_TEMPLATES;
    const template = pool[Math.floor(this.random() * pool.length)] ?? pool[0]!;
    if (req.subject) return template.replaceAll('{who}', req.subject);
    // No subject member: greet the occasion itself.
    return req.kind === 'birthday' ? `🎂 Today: ${req.title}! Happy birthday! 🎉` : `💐 Today: ${req.title}! Happy anniversary! 🥂`;
  }
}

export const TEMPLATE_POOL_SIZES = { birthday: BIRTHDAY_TEMPLATES.length, anniversary: ANNIVERSARY_TEMPLATES.length };
