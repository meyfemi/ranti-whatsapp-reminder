import { DateTime } from 'luxon';
import { sanitizeText } from './format.js';

/**
 * Bulk birthday import ("@Ranti add these birthdays: ..."). Pure functions: the parser only splits
 * the list into lines with a name and a date; everything here (date checks, DMY/MDY, mentions,
 * member matching, duplicates, edits, the preview text) is deterministic.
 */

export type DateFormat = 'DMY' | 'MDY';

/** Local time birthdays are wished at, the same default as a single birthday without a time. */
export const DEFAULT_WISH_TIME = '06:00';
export const BULK_IMPORT_MINUTES = 30;
const MAX_NAME_LENGTH = 40;
const MAX_LINE_ECHO = 60;
export const MAX_PREVIEW_PART_LENGTH = 1500;

/** One line as the parser read it. */
export interface ParsedBulkEntry {
  raw_line: string;
  name_text: string | null;
  mention_user_id: string | null;
  month: number | null;
  day: number | null;
  year: number | null;
}

export interface ParsedBulkList {
  entries: ParsedBulkEntry[];
  unparsed: string[];
}

/** A birthday ready to save, as shown (numbered) in the preview. */
export interface ImportEntry {
  line: string;
  name: string;
  memberId: number | null;
  /** How memberId was found: an @mention on the line, or an exact display-name match. */
  linkedBy: 'mention' | 'name' | null;
  month: number;
  day: number;
  year: number | null;
}

export interface BulkImportPayload {
  entries: ImportEntry[];
  unreadable: string[];
  /** Names left out because they are already saved or listed twice. */
  skipped: { name: string; reason: 'saved' | 'twice' }[];
}

export interface MentionedMember {
  memberId: number;
  /** Mention tokens for every known ID of this person (phone-number JID and LID forms). */
  tokens: string[];
  name: string | null;
}

export interface KnownMember {
  id: number;
  name: string | null;
}

export interface ExistingBirthday {
  memberId: number | null;
  name: string | null;
  month: number;
  day: number;
}

export interface BulkContext {
  dateFormat: DateFormat;
  now: Date;
  mentioned: MentionedMember[];
  members: KnownMember[];
  existing: ExistingBirthday[];
}

// ---------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const ORD = '(?:st|nd|rd|th)?';
const NUMERIC_RE = /(?<!\d)(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?(?!\d)/;
const DAY_MONTH_RE = new RegExp(`(?<!\\d)(\\d{1,2})${ORD}(?:\\s+of)?[\\s.,-]*(${MONTH_NAMES})\\b\\.?(?:[\\s,]+(\\d{4}))?(?!\\d)`, 'i');
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_NAMES})\\b\\.?\\s+(?:the\\s+)?(\\d{1,2})${ORD}(?!\\d)(?:[\\s,]+(\\d{4}))?(?!\\d)`, 'i');

export interface DayMonth {
  month: number;
  day: number;
  year: number | null;
}

/**
 * Reads a date such as "12 Oct", "October 12", "5th of June", "12/10", "12-10-1990" from text.
 * Numeric dates follow `format` unless one number is above 12. Tries numeric, then day-month,
 * then month-day. Returns the date (not yet checked for validity) and where it was, or null.
 */
export function findDate(text: string, format: DateFormat, now: Date): (DayMonth & { index: number; length: number }) | null {
  const found: (DayMonth & { index: number; length: number })[] = [];
  const numeric = NUMERIC_RE.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    let [day, month] = format === 'DMY' ? [a, b] : [b, a];
    if (a > 12 && b <= 12) [day, month] = [a, b];
    else if (b > 12 && a <= 12) [day, month] = [b, a];
    found.push({ day, month, year: fullYear(numeric[3], now), index: numeric.index, length: numeric[0].length });
  }
  const dm = DAY_MONTH_RE.exec(text);
  if (dm) {
    found.push({ day: Number(dm[1]), month: MONTHS[dm[2]!.toLowerCase()]!, year: fullYear(dm[3], now), index: dm.index, length: dm[0].length });
  }
  const md = MONTH_DAY_RE.exec(text);
  if (md) {
    found.push({ day: Number(md[2]), month: MONTHS[md[1]!.toLowerCase()]!, year: fullYear(md[3], now), index: md.index, length: md[0].length });
  }
  // By pattern, not position: in "Aunty May 5 Jun" the date is "5 Jun", not "May 5".
  return found[0] ?? null;
}

function fullYear(text: string | undefined, now: Date): number | null {
  if (!text) return null;
  const n = Number(text);
  if (text.length === 4) return n;
  const thisYear = now.getUTCFullYear();
  return 2000 + n <= thisYear ? 2000 + n : 1900 + n;
}

export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Checks a birthday: real month and day (29 Feb allowed), and a plausible year if one is given. */
export function validateBirthDate(d: { month: number | null; day: number | null; year: number | null }, now: Date): DayMonth | null {
  const { month, day } = d;
  if (month === null || day === null || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]!) return null;
  // An implausible year is dropped rather than failing the line; ages are never shown anyway.
  const year = d.year !== null && Number.isInteger(d.year) && d.year >= 1900 && d.year <= now.getUTCFullYear() ? d.year : null;
  if (month === 2 && day === 29 && year !== null && !isLeapYear(year)) return null; // 29 Feb 1991 never happened
  return { month, day, year };
}

/**
 * The first yearly start for a birthday, as stored by a single create: this year's date at the
 * default time if it is still ahead, otherwise next year's. 29 Feb is anchored to a past leap year.
 */
export function yearlyStartLocal(month: number, day: number, now: Date, timezone: string): string {
  const [hour, minute] = DEFAULT_WISH_TIME.split(':').map(Number) as [number, number];
  const local = DateTime.fromJSDate(now).setZone(timezone);
  let year = local.year;
  if (month === 2 && day === 29) {
    while (!isLeapYear(year)) year--;
  } else {
    const thisYear = DateTime.fromObject({ year, month, day, hour, minute }, { zone: timezone });
    if (thisYear.toMillis() <= now.getTime()) year++;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Mar", "12 Oct 1990": month names so DMY/MDY mistakes are obvious. */
export function formatDayMonth(d: DayMonth): string {
  return `${d.day} ${SHORT_MONTHS[d.month - 1]}${d.year ? ` ${d.year}` : ''}`;
}

// ---------------------------------------------------------------- people

/** Case- and whitespace-insensitive form of a name, for exact comparisons. */
export function normaliseName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const MENTION_RE = /@[\p{L}\p{N}_.-]+/gu;

/**
 * The mentioned members whose mention token appears on this line. Tokens are matched against the
 * user part of each of the person's IDs (phone-number JID and LID), never by position.
 */
export function mentionsOnLine(line: string, mentioned: MentionedMember[]): MentionedMember[] {
  const onLine = new Set([...line.matchAll(MENTION_RE)].map((m) => m[0].toLowerCase()));
  return mentioned.filter((m) => m.tokens.some((t) => onLine.has(t.toLowerCase())));
}

/** Members whose display name equals `name` exactly (ignoring case and spacing). */
export function matchMembersByName(name: string, members: KnownMember[]): KnownMember[] {
  const wanted = normaliseName(name);
  if (!wanted) return [];
  return members.filter((m) => m.name !== null && normaliseName(m.name) === wanted);
}

/**
 * Whether a name-only birthday's name refers to a member, judged by their display name: equal to
 * the full name or to its first word ("John" for "John Okafor"). Exact words only, never fuzzy.
 */
export function nameMatchesMember(name: string, displayName: string | null): boolean {
  if (!displayName) return false;
  const wanted = normaliseName(name);
  const full = normaliseName(displayName);
  return !!wanted && (wanted === full || wanted === full.split(' ')[0]);
}

/** Trims a name: drops @tokens, list bullets, "birthday" words and separators around it. */
export function cleanName(text: string): string {
  const s = text
    .replace(MENTION_RE, ' ')
    .replace(/^\s*(?:[-*•·]|\d{1,3}[.)])\s+/, '')
    .replace(/['’]s\s+(?:birthday|bday)\b/gi, ' ')
    .replace(/\b(?:birthday|bday|b-day)\b/gi, ' ')
    .replace(/^[\s\-–—:,;|.=>]+|[\s\-–—:,;|.=>]+$/g, '');
  return sanitizeText(s, MAX_NAME_LENGTH);
}

// ---------------------------------------------------------------- building the import

type LineResult = { ok: true; entry: ImportEntry } | { ok: false };

function readLine(p: ParsedBulkEntry, ctx: BulkContext): LineResult {
  const line = p.raw_line.trim();
  // Code reads the date itself where it can (so numeric dates follow the group's setting);
  // the parser's month/day is only used for wordings code doesn't recognise.
  const tokensRemoved = line.replace(MENTION_RE, ' ');
  const own = findDate(tokensRemoved, ctx.dateFormat, ctx.now);
  const date = validateBirthDate(own ?? { month: p.month, day: p.day, year: p.year }, ctx.now);
  if (!date) return { ok: false };

  const tagged = mentionsOnLine(line, ctx.mentioned);
  if (tagged.length > 1) return { ok: false }; // two people on one line: can't tell whose date it is
  let name = p.name_text ? cleanName(p.name_text) : '';
  if (!name && own) name = cleanName(tokensRemoved.slice(0, own.index) + ' ' + tokensRemoved.slice(own.index + own.length));

  if (tagged.length === 1) {
    const m = tagged[0]!;
    return { ok: true, entry: { line, name: (m.name && sanitizeText(m.name, MAX_NAME_LENGTH)) || name, memberId: m.memberId, linkedBy: 'mention', ...date } };
  }
  if (!name) return { ok: false };
  const matches = matchMembersByName(name, ctx.members);
  if (matches.length === 1) {
    return { ok: true, entry: { line, name, memberId: matches[0]!.id, linkedBy: 'name', ...date } };
  }
  return { ok: true, entry: { line, name, memberId: null, linkedBy: null, ...date } };
}

const sameDay = (a: { month: number; day: number }, b: { month: number; day: number }) => a.month === b.month && a.day === b.day;

/** Same member, or same name on the same date. */
export function isSameBirthday(
  a: { memberId: number | null; name: string | null; month: number; day: number },
  b: { memberId: number | null; name: string | null; month: number; day: number },
): boolean {
  if (a.memberId !== null && a.memberId === b.memberId) return true;
  return !!a.name && !!b.name && normaliseName(a.name) === normaliseName(b.name) && sameDay(a, b);
}

/** Turns the parser's reading of a pasted list into a preview: validated, linked and de-duplicated. */
export function buildImport(parsed: ParsedBulkList, ctx: BulkContext): BulkImportPayload {
  const out: BulkImportPayload = { entries: [], unreadable: parsed.unparsed.map((l) => l.trim()).filter(Boolean), skipped: [] };
  for (const p of parsed.entries) {
    const r = readLine(p, ctx);
    if (!r.ok) {
      if (p.raw_line.trim()) out.unreadable.push(p.raw_line.trim());
      continue;
    }
    const dupe = duplicateReason(r.entry, out.entries, ctx.existing);
    if (dupe) out.skipped.push({ name: r.entry.name, reason: dupe });
    else out.entries.push(r.entry);
  }
  return out;
}

function duplicateReason(entry: ImportEntry, others: ImportEntry[], existing: ExistingBirthday[]): 'saved' | 'twice' | null {
  if (existing.some((e) => isSameBirthday(entry, e))) return 'saved';
  if (others.some((o) => isSameBirthday(entry, o))) return 'twice';
  return null;
}

/** Splits saved and not-yet-saved entries again (used at save time, inside the transaction). */
export function dropDuplicates(entries: ImportEntry[], existing: ExistingBirthday[]): { keep: ImportEntry[]; dropped: ImportEntry[] } {
  const keep: ImportEntry[] = [];
  const dropped: ImportEntry[] = [];
  for (const e of entries) (duplicateReason(e, keep, existing) ? dropped : keep).push(e);
  return { keep, dropped };
}

// ---------------------------------------------------------------- replies to the preview

export type PreviewReply =
  | { kind: 'yes'; count: number | null }
  | { kind: 'no' }
  | { kind: 'remove'; numbers: number[] }
  | { kind: 'fix'; number: number; value: string };

/** Recognises the replies a preview accepts. Anything else returns null. */
export function parsePreviewReply(text: string): PreviewReply | null {
  const t = text.trim().replace(/[.!]+$/, '');
  let m: RegExpExecArray | null;
  if ((m = /^(?:yes|y|ok|okay|save(?: them| all)?|confirm)(?:\s+(?:the\s+)?(?:first\s+)?(\d+))?$/i.exec(t))) {
    return { kind: 'yes', count: m[1] ? Number(m[1]) : null };
  }
  if ((m = /^save\s+(?:the\s+)?first\s+(\d+)$/i.exec(t))) return { kind: 'yes', count: Number(m[1]) };
  if (/^(?:no|n|cancel|stop|never ?mind)$/i.test(t)) return { kind: 'no' };
  if ((m = /^(?:remove|delete|drop)\s+#?(\d+(?:\s*(?:,|and|&)\s*#?\d+)*)$/i.exec(t))) {
    const numbers = [...new Set(m[1]!.split(/\s*(?:,|and|&)\s*/i).map((n) => Number(n.replace('#', ''))))];
    return { kind: 'remove', numbers };
  }
  if ((m = /^(?:fix|change|edit)\s+#?(\d+)\s*(?::|to|=|-)?\s*(.+)$/is.exec(text.trim()))) {
    return { kind: 'fix', number: Number(m[1]), value: m[2]!.trim() };
  }
  return null;
}

export type EditResult = { ok: true; payload: BulkImportPayload } | { ok: false; error: string };

/**
 * Applies "remove N" or "fix N: <date or name>". A fix that reads as a date changes the date;
 * a single @mention links the person; anything else is a new name (matched to members again).
 */
export function applyEdit(
  payload: BulkImportPayload,
  reply: Extract<PreviewReply, { kind: 'remove' | 'fix' }>,
  ctx: BulkContext,
): EditResult {
  const count = payload.entries.length;
  const outOfRange = (n: number) => n < 1 || n > count;
  if (reply.kind === 'remove') {
    const bad = reply.numbers.filter(outOfRange);
    if (bad.length) return { ok: false, error: `There's no number ${bad[0]} in the list. Pick between 1 and ${count}.` };
    const drop = new Set(reply.numbers.map((n) => n - 1));
    return { ok: true, payload: { ...payload, entries: payload.entries.filter((_, i) => !drop.has(i)) } };
  }

  if (outOfRange(reply.number)) return { ok: false, error: `There's no number ${reply.number} in the list. Pick between 1 and ${count}.` };
  const index = reply.number - 1;
  const current = payload.entries[index]!;
  let updated: ImportEntry;
  const tagged = mentionsOnLine(reply.value, ctx.mentioned);
  const date = findDate(reply.value.replace(MENTION_RE, ' '), ctx.dateFormat, ctx.now);
  if (date) {
    const valid = validateBirthDate(date, ctx.now);
    if (!valid) return { ok: false, error: `"${sanitizeText(reply.value, MAX_LINE_ECHO)}" isn't a real date. Try e.g. "fix ${reply.number}: 4 March".` };
    updated = { ...current, ...valid };
  } else if (tagged.length === 1 && !cleanName(reply.value)) {
    const m = tagged[0]!;
    updated = { ...current, memberId: m.memberId, linkedBy: 'mention', name: (m.name && sanitizeText(m.name, MAX_NAME_LENGTH)) || current.name };
  } else {
    const name = cleanName(reply.value);
    if (!name) return { ok: false, error: `Give a date or a name, e.g. "fix ${reply.number}: 4 March".` };
    const matches = matchMembersByName(name, ctx.members);
    updated = matches.length === 1
      ? { ...current, name, memberId: matches[0]!.id, linkedBy: 'name' }
      : { ...current, name, memberId: null, linkedBy: null };
  }
  const others = payload.entries.filter((_, i) => i !== index);
  const dupe = duplicateReason(updated, others, ctx.existing);
  if (dupe) {
    return { ok: false, error: `That would make ${sanitizeText(updated.name, MAX_NAME_LENGTH)} ${dupe === 'saved' ? 'a birthday that is already saved' : 'appear twice'}.` };
  }
  const entries = [...payload.entries];
  entries[index] = updated;
  return { ok: true, payload: { ...payload, entries } };
}

// ---------------------------------------------------------------- preview text

function entryLine(e: ImportEntry, n: number): string {
  const name = sanitizeText(e.name, MAX_NAME_LENGTH) || 'Tagged member';
  const who =
    e.linkedBy === 'mention' ? `${name} (tagged)` : e.linkedBy === 'name' ? `${name} (matched to member ${name})` : name;
  const feb29 = e.month === 2 && e.day === 29 ? ' (wished on 28 Feb in non-leap years)' : '';
  return `${n}. ${who} – ${formatDayMonth(e)}${feb29}`;
}

/**
 * The preview message(s). Never contains mentions: names are plain text. Long previews are split
 * into numbered parts so each stays a reasonable message length.
 */
export function previewTexts(payload: BulkImportPayload, cap: { remaining: number; limit: number }): string[] {
  const { entries } = payload;
  const lines: string[] = [];
  lines.push(entries.length === 1 ? 'I found 1 birthday:' : `I found ${entries.length} birthdays:`);
  entries.forEach((e, i) => lines.push(entryLine(e, i + 1)));
  const notes: string[] = [];
  if (payload.unreadable.length) {
    notes.push(`⚠️ Couldn't read: ${payload.unreadable.map((l) => `"${sanitizeText(l, MAX_LINE_ECHO)}"`).join(', ')}`);
  }
  const saved = payload.skipped.filter((s) => s.reason === 'saved').map((s) => sanitizeText(s.name, MAX_NAME_LENGTH));
  const twice = payload.skipped.filter((s) => s.reason === 'twice').map((s) => sanitizeText(s.name, MAX_NAME_LENGTH));
  if (saved.length) notes.push(`ℹ️ Already saved: ${saved.join(', ')} (skipped)`);
  if (twice.length) notes.push(`ℹ️ Listed twice: ${twice.join(', ')} (kept once)`);
  if (entries.length > cap.remaining) {
    notes.push(`⚠️ This group can only have ${cap.remaining} more reminder${cap.remaining === 1 ? '' : 's'} (the limit is ${cap.limit}).`);
  }
  if (notes.length) lines.push('', ...notes);
  lines.push('', instructions(entries.length, cap.remaining));
  return splitIntoParts(lines, MAX_PREVIEW_PART_LENGTH);
}

function instructions(count: number, remaining: number): string {
  const example = count >= 2 ? `"remove ${Math.min(3, count)}" or "fix ${Math.min(2, count)}: 4 March"` : '"fix 1: 4 March"';
  const save =
    count > remaining
      ? `Reply "save ${remaining}" to save the first ${remaining}, or "no" to cancel.`
      : `Reply "yes" to save ${count}, or "no" to cancel.`;
  return `${save} You can also reply ${example}. (Reply to this message.)`;
}

/** Joins lines into messages of at most `max` characters, numbering them "(1/2)" when split. */
export function splitIntoParts(lines: string[], max: number): string[] {
  const parts: string[][] = [[]];
  let length = 0;
  for (const line of lines) {
    const current = parts[parts.length - 1]!;
    if (current.length && length + line.length + 1 > max) {
      parts.push([line]);
      length = line.length;
    } else {
      current.push(line);
      length += line.length + 1;
    }
  }
  const texts = parts.map((p) => p.join('\n').trim()).filter(Boolean);
  return texts.length === 1 ? texts : texts.map((t, i) => `(${i + 1}/${texts.length})\n${t}`);
}
