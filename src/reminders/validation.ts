import { isValidRrule, isValidTimezone, nextEventAfter, normaliseRrule, parseLocal } from '../scheduler/recurrence.js';
import { sanitizeText } from './format.js';
import { fail, ok, type CreateReminderInput, type ServiceResult } from './types.js';

export const MAX_OFFSETS = 5;
export const MAX_OFFSET_MINUTES = 60 * 24 * 30; // 30 days
export const MAX_TITLE_LENGTH = 100;
export const MAX_STYLE_LENGTH = 200;

/** Validates and normalises a create request. Pure apart from reading `now`. */
export function validateCreate(
  input: CreateReminderInput,
  timezone: string,
  now: Date,
): ServiceResult<CreateReminderInput> {
  if (!isValidTimezone(timezone)) return fail(`The group timezone "${timezone}" is not valid.`);

  const title = sanitizeText(input.title, MAX_TITLE_LENGTH);
  if (!title) return fail('The reminder needs a title.');

  const start = parseLocal(input.startLocal);
  if (!start) return fail("I couldn't understand the date and time.");
  const startLocal = start.toFormat("yyyy-MM-dd'T'HH:mm:ss");

  let rrule: string | null = null;
  if (input.rrule) {
    if (!isValidRrule(input.rrule)) return fail("I couldn't understand how often that should repeat.");
    rrule = normaliseRrule(input.rrule);
  }

  const offsets = [...new Set(input.offsetsMinutes.length ? input.offsetsMinutes : [0])].sort((a, b) => b - a);
  if (offsets.length > MAX_OFFSETS) return fail(`At most ${MAX_OFFSETS} reminder times per item, please.`);
  if (offsets.some((o) => !Number.isInteger(o) || o < 0 || o > MAX_OFFSET_MINUTES)) {
    return fail('Early reminders must be between 0 minutes and 30 days before.');
  }

  const spec = { startLocal, rrule, timezone };
  const nextEvent = nextEventAfter(spec, now);
  if (!nextEvent) {
    return fail(rrule ? 'That schedule has no future dates.' : 'That time has already passed.');
  }

  const messageStyle = input.messageStyle ? sanitizeText(input.messageStyle, MAX_STYLE_LENGTH) || null : null;
  return ok({ ...input, title, startLocal, rrule, offsetsMinutes: offsets, messageStyle });
}
