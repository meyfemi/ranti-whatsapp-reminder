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

const QueryCommand = z.object({
  action: z.literal('query'),
  from_date: z.string().nullable().describe('First day of the period asked about, YYYY-MM-DD, or null if no period'),
  to_date: z.string().nullable().describe('Last day of the period asked about (inclusive), YYYY-MM-DD, or null if no period'),
  short_ids: z.array(z.number().int()).describe('#numbers of the specific reminders asked about; empty = any reminder'),
  subject_user_id: z.string().nullable().describe('ID of the person the question is about, e.g. the sender for "my birthday"'),
  kind: z.enum(REMINDER_KINDS).nullable().describe('Only reminders of this kind, e.g. birthday; null = any kind'),
  no_match: z.boolean().describe('true if the question names a reminder or person that matches nothing in the context'),
});

const BulkEntry = z.object({
  raw_line: z.string().describe('The line exactly as written'),
  name_text: z.string().nullable().describe('The name as written, without the date or @token; null if the line only has an @mention'),
  mention_user_id: z.string().nullable().describe('ID of the mentioned user on this line, if any'),
  month: z.number().int().describe('1-12'),
  day: z.number().int().describe('1-31'),
  year: z.number().int().nullable().describe('Birth year if written, otherwise null'),
});

const BulkAddBirthdays = z.object({
  action: z.literal('bulk_add_birthdays'),
  entries: z.array(BulkEntry).describe('One entry per line with a person and a readable date'),
  unparsed: z.array(z.string()).describe('Lines that name someone but whose date cannot be read'),
});

const LinkBirthday = z.object({
  action: z.literal('link_birthday'),
  target: Target,
  user_id: z.string().describe('ID of the mentioned member to link the birthday to'),
});

const SetDigest = z.object({
  action: z.literal('set_digest'),
  enabled: z.enum(['on', 'off']).nullable().describe('on/off if the user turns the digest on or off; null if they only change the day or time'),
  weekday: z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']).nullable().describe('Day to send it on, if given'),
  time: z.string().nullable().describe('Local time to send it at, 24-hour HH:mm, if given'),
  empty_weeks: z.enum(['post', 'skip']).nullable().describe('Whether to post "nothing scheduled" in an empty week, if the user says'),
});

export const CommandSchema = z.discriminatedUnion('action', [
  CreateCommand,
  z.object({ action: z.literal('list') }),
  QueryCommand,
  z.object({ action: z.literal('cancel'), target: Target }),
  EditCommand,
  z.object({ action: z.literal('set_timezone'), timezone: z.string().describe('IANA zone, e.g. Europe/London') }),
  z.object({ action: z.literal('set_policy'), policy: z.enum(['anyone', 'admins']) }),
  BulkAddBirthdays,
  LinkBirthday,
  z.object({ action: z.literal('set_date_format'), format: z.enum(['DMY', 'MDY']) }),
  SetDigest,
  z.object({ action: z.literal('show_upcoming') }),
  z.object({ action: z.literal('help') }),
  z.object({ action: z.literal('clarify'), question: z.string() }),
  z.object({ action: z.literal('unsupported'), reason: z.string() }),
]);

/** Top level must be an object for structured outputs, so the union is wrapped. */
export const LlmOutputSchema = z.object({ command: CommandSchema });

export type ParsedCommand = z.infer<typeof CommandSchema>;
export type CreateParsed = Extract<ParsedCommand, { action: 'create' }>;
export type EditParsed = Extract<ParsedCommand, { action: 'edit' }>;
export type QueryParsed = Extract<ParsedCommand, { action: 'query' }>;
export type CancelParsed = Extract<ParsedCommand, { action: 'cancel' }>;
export type BulkParsed = Extract<ParsedCommand, { action: 'bulk_add_birthdays' }>;
export type LinkParsed = Extract<ParsedCommand, { action: 'link_birthday' }>;
export type SetDigestParsed = Extract<ParsedCommand, { action: 'set_digest' }>;
export type ReminderTarget = z.infer<typeof Target>;

export interface ValidationContext {
  /** All IDs (primary and alternates) of users mentioned in the message. */
  mentionedUserIds: string[];
}

const MAX_OFFSET = 60 * 24 * 30;
const offsetsSchema = z.array(z.number().int().min(0).max(MAX_OFFSET)).max(5);
const localDateTime = z.string().refine((s) => parseLocal(s) !== null, 'must be a local ISO date-time without offset');
const rruleSchema = z.string().refine(isValidRrule, 'must be a valid RRULE body (daily or slower)');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => parseLocal(s) !== null, 'must be a date YYYY-MM-DD');
const MAX_QUERY_DAYS = 366;
/** Hard bound on what the parser may return; the per-import limit (config) is lower. */
const MAX_BULK_LINES = 500;

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
    QueryCommand.extend({
      from_date: localDate.nullable(),
      to_date: localDate.nullable(),
      short_ids: z.array(z.number().int().min(1)).max(20),
      subject_user_id: z
        .string()
        .nullable()
        .refine((id) => id === null || mentioned.has(id), 'subject must be one of the mentioned users'),
    }).refine((q) => (q.from_date === null) === (q.to_date === null), 'from_date and to_date go together')
      .refine((q) => {
        // Runs even when a date failed its own check, so it must not assume valid dates.
        const from = q.from_date ? parseLocal(q.from_date) : null;
        const to = q.to_date ? parseLocal(q.to_date) : null;
        if (!from || !to) return true;
        const days = to.diff(from, 'days').days;
        return days >= 0 && days <= MAX_QUERY_DAYS;
      }, 'period must run forwards and be at most a year'),
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
    BulkAddBirthdays.extend({
      // Dates are checked line by line by code (bad lines are listed as unreadable), so only
      // the shape is enforced here. An ID that wasn't mentioned is dropped, never trusted.
      entries: z
        .array(
          BulkEntry.extend({
            raw_line: z.string().max(500),
            mention_user_id: z
              .string()
              .nullable()
              .transform((id) => (id !== null && mentioned.has(id) ? id : null)),
          }),
        )
        .max(MAX_BULK_LINES),
      unparsed: z.array(z.string().max(500)).max(MAX_BULK_LINES),
    }),
    LinkBirthday.extend({
      user_id: z.string().refine((id) => mentioned.has(id), 'user must be one of the mentioned users'),
    }),
    z.object({ action: z.literal('set_date_format'), format: z.enum(['DMY', 'MDY']) }),
    SetDigest.extend({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable() }).refine(
      (d) => d.enabled !== null || d.weekday !== null || d.time !== null || d.empty_weeks !== null,
      'nothing to change',
    ),
    z.object({ action: z.literal('show_upcoming') }),
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
  if (action === 'link_birthday') {
    question = 'Who should I link that birthday to? Please @mention them, e.g. "link John to @John".';
  } else if (issues.some((i) => i.startsWith('subject_user_id'))) {
    question = 'Who is this reminder for? Please @mention them.';
  } else if (issues.some((i) => i.startsWith('timezone'))) {
    question = "I don't recognise that timezone. Could you give it like Europe/London or Africa/Lagos?";
  } else if (action === 'set_digest') {
    question = 'Which day and time should the weekly digest go out? E.g. "Sundays at 7pm".';
  } else if (action === 'query') {
    question = 'Which reminder or which dates do you mean?';
  } else if (action === 'cancel' || action === 'edit') {
    question = 'Which reminder do you mean? You can use its number, e.g. #4.';
  }
  return { ok: false, issues, fallback: { action: 'clarify', question } };
}
