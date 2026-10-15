import { z } from 'zod';

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ADAPTER: z.enum(['whatsapp', 'cli']).default('whatsapp'),
  DATABASE_URL: z.string().min(1),
  BOT_NAME: z.string().min(1).default('Ranti'),
  DEFAULT_TIMEZONE: z.string().default('Africa/Lagos'),
  MAX_ACTIVE_REMINDERS_PER_GROUP: z.coerce.number().int().positive().default(50),
  /** Most birthdays accepted in one pasted list. */
  BULK_IMPORT_MAX_ENTRIES: z.coerce.number().int().positive().default(100),
  ANTHROPIC_API_KEY: optionalString,
  PARSER_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_GREETINGS: boolFromEnv,
  WA_SESSION_NAME: z.string().default('default'),
  WA_PAIRING_PHONE: optionalString.refine((v) => v === undefined || /^\d{7,15}$/.test(v), {
    message: 'WA_PAIRING_PHONE must be digits only, including country code',
  }),
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_GROUP_PER_MINUTE: z.coerce.number().int().positive().default(6),
  /** Max bot-directed messages handled per group per minute; extra ones are dropped (cost/abuse guard). */
  INBOUND_PER_GROUP_PER_MINUTE: z.coerce.number().int().positive().default(10),
  REPLY_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(1000),
  REPLY_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(4000),
  ALERT_WEBHOOK_URL: optionalString.pipe(z.url().optional()),
  HEALTH_PORT: z.coerce.number().int().positive().default(8080),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  if (result.data.REPLY_DELAY_MAX_MS < result.data.REPLY_DELAY_MIN_MS) {
    throw new Error('Invalid configuration: REPLY_DELAY_MAX_MS must be >= REPLY_DELAY_MIN_MS');
  }
  return result.data;
}
