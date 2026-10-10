import { z } from 'zod';
import { isValidRrule, isValidTimezone, parseLocal } from '../scheduler/recurrence.js';

/**
 * Two layers:
 *  1. LlmOutputSchema: the JSON shape the model is constrained to (structured outputs).
 *     Every field is required (nullable where optional) so it maps cleanly to strict JSON Schema.
 *  2. validateCommand(): domain validation with context (mentioned IDs, valid dates, RRULEs, zones).
 *     Anything that fails becomes a `clarify` rather than being guessed at.
 */

export const REMINDER_KINDS = ['birthday', 'anniversary', 'event', 'generic'] as const;

const Target = z.object({
  short_id: z.number().int().nullable().describe('The #number of the reminder if the user gave one or it is unambiguous'),
  description: z.string().nullable().describe("The user's description of the reminder, e.g. 'the dues reminder'"),
});

const CreateCommand = z.object({
  action: z.literal('create'),
  title: z.string().describe("Short title, e.g. 'General meeting' or \"John's birthday\""),
  kind: z.enum(REMINDER_KINDS),
  start_local: z
    .string()
    .describe('First occurrence, local date-time in the group timezone, ISO 8601 without offset: YYYY-MM-DDTHH:mm:ss'),
  rrule: z.string().nullable().describe("RFC 5545 RRULE body without DTSTART, e.g. 'FREQ=YEARLY'. null for one-off"),
  offsets_minutes: z
    .array(z.number().int())
    .describe('Minutes before the event to send reminders. 0 = at the time. E.g. [5, 0]'),
  subject_user_id: z.string().nullable().describe('ID of the mentioned person the reminder is about (birthdays etc.)'),
  message_style: z.string().nullable().describe("The user's wording about how to word the message, if any"),
});

const EditCommand = z.object({
  action: z.literal('edit'),
  target: Target,
  changes: z.object({
    title: z.string().nullable(),
    start_local: z.string().nullable().describe('New local date-time (full ISO, no offset) if the date or time changes'),
    rrule: z.string().nullable().describe('New RRULE body if the repetition changes'),
    make_one_off: z.boolean().describe('true if the user wants it to stop repeating'),
    offsets_minutes: z.array(z.number().int()).nullable(),
    message_style: z.string().nullable(),
  }),
});

export const CommandSchema = z.discriminatedUnion('action', [
  CreateCommand,
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('cancel'), target: Target }),
  EditCommand,
  z.object({ action: z.literal('set_timezone'), timezone: z.string().describe('IANA zone, e.g. Europe/London') }),
  z.object({ action: z.literal('set_policy'), policy: z.enum(['anyone', 'admins']) }),
  z.object({ action: z.literal('help') }),
  z.object({ action: z.literal('clarify'), question: z.string() }),
  z.object({ action: z.literal('unsupported'), reason: z.string() }),
]);

/** Top level must be an object for structured outputs, so the union is wrapped. */
export const LlmOutputSchema = z.object({ command: CommandSchema });

export type ParsedCommand = z.infer<typeof CommandSchema>;
export type CreateParsed = Extract<ParsedCommand, { action: 'create' }>;
export type EditParsed = Extract<ParsedCommand, { action: 'edit' }>;
export type CancelParsed = Extract<ParsedCommand, { action: 'cancel' }>;
export type ReminderTarget = z.infer<typeof Target>;

export interface ValidationContext {
  /** All IDs (primary and alternates) of users mentioned in the message. */
  mentionedUserIds: string[];
}

const MAX_OFFSET = 60 * 24 * 30;
const offsetsSchema = z.array(z.number().int().min(0).max(MAX_OFFSET)).max(5);
const localDateTime = z.string().refine((s) => parseLocal(s) !== null, 'must be a local ISO date-time without offset');
const rruleSchema = z.string().refine(isValidRrule, 'must be a valid RRULE body (daily or slower)');

function domainSchema(ctx: ValidationContext) {
  const mentioned = new Set(ctx.mentionedUserIds);
  return z.discriminatedUnion('action', [
    CreateCommand.extend({
      title: z.string().trim().min(1).max(200),
      start_local: localDateTime,
      rrule: rruleSchema.nullable(),
      offsets_minutes: offsetsSchema,
      subject_user_id: z
        .string()
        .nullable()
        .refine((id) => id === null || mentioned.has(id), 'subject must be one of the mentioned users'),
    }),
    z.object({ action: z.literal('list') }),
    z.object({
      action: z.literal('cancel'),
      target: Target.refine((t) => t.short_id !== null || !!t.description?.trim(), 'target is empty'),
    }),
    EditCommand.extend({
      target: Target.refine((t) => t.short_id !== null || !!t.description?.trim(), 'target is empty'),
      changes: EditCommand.shape.changes.extend({
        start_local: localDateTime.nullable(),
        rrule: rruleSchema.nullable(),
        offsets_minutes: offsetsSchema.nullable(),
      }),
    }),
    z.object({
      action: z.literal('set_timezone'),
      timezone: z.string().refine(isValidTimezone, 'must be a valid IANA timezone'),
    }),
    z.object({ action: z.literal('set_policy'), policy: z.enum(['anyone', 'admins']) }),
    z.object({ action: z.literal('help') }),
    z.object({ action: z.literal('clarify'), question: z.string().trim().min(1).max(300) }),
    z.object({ action: z.literal('unsupported'), reason: z.string().trim().min(1).max(300) }),
  ]);
}

export type ValidationResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; issues: string[]; fallback: ParsedCommand };

/**
 * Validates an untrusted LLM response. Never throws; on failure returns a safe clarify/unsupported
 * fallback so the bot asks rather than guesses.
 */
export function validateCommand(raw: unknown, ctx: ValidationContext): ValidationResult {
  const wrapped = LlmOutputSchema.safeParse(raw);
  const candidate = wrapped.success ? wrapped.data.command : raw;
  const result = domainSchema(ctx).safeParse(candidate);
  if (result.success) return { ok: true, command: result.data as ParsedCommand };

  const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  const action = (candidate as { action?: unknown } | null)?.action;
  let question = "Sorry, I didn't quite get that. Could you rephrase it with the date and time?";
  if (issues.some((i) => i.startsWith('subject_user_id'))) {
    question = 'Who is this reminder for? Please @mention them.';
  } else if (issues.some((i) => i.startsWith('timezone'))) {
    question = "I don't recognise that timezone. Could you give it like Europe/London or Africa/Lagos?";
  } else if (action === 'cancel' || action === 'edit') {
    question = 'Which reminder do you mean? You can use its number, e.g. #4.';
  }
  return { ok: false, issues, fallback: { action: 'clarify', question } };
}
