import { DateTime } from 'luxon';
import type { Reminder } from '../db/schema.js';
import { describeOffsets, describeWhen, formatDay, formatTime, sanitizeText, tzAbbrev } from '../reminders/format.js';
import type { UpcomingEvent } from '../reminders/query.js';
import { toIsoLocal } from '../scheduler/scheduler.js';

export const UNDO_MINUTES = 5;

function tzLabel(timezone: string, now: Date): string {
  return `${timezone} (${tzAbbrev(DateTime.fromJSDate(now).setZone(timezone))})`;
}

/** Posted when the bot is added to a group. Kept under ~100 words. */
export function introText(botName: string, timezone: string, now: Date): string {
  const at = `@${botName}`;
  return [
    `👋 Hi everyone, I'm ${botName}! I post reminders in this group. Mention me to set one:`,
    `• ${at} meeting at 11am this Sunday, send a 5 min reminder`,
    `• ${at} 12 Oct is @John's birthday`,
    `• ${at} every first Saturday remind us to pay dues at 9am`,
    `• ${at} what reminders do we have?`,
    `Cancel with "${at} cancel #2". Times are in ${tzLabel(timezone, now)}; change it with "${at} set timezone to Europe/London".`,
  ].join('\n');
}

export function helpText(botName: string, timezone: string, now: Date): string {
  const at = `@${botName}`;
  return [
    `I post reminders in this group. Mention me with what you need:`,
    `• Create: "${at} remind us about choir practice Saturday 4pm, 30 min before too"`,
    `• Birthdays: "${at} 12 Oct is @John's birthday"`,
    `• Repeat: "${at} every Monday at 6am remind us to send reports"`,
    `• List: "${at} what reminders do we have?"`,
    `• Ask: "${at} anything on this week?" · "${at} when is my birthday?"`,
    `• Change: "${at} move #3 to 5pm" · Cancel: "${at} cancel #3"`,
    `• Reply "undo" to my confirmation within ${UNDO_MINUTES} minutes to undo it.`,
    `Admins: "${at} only admins can set reminders". Timezone: ${tzLabel(timezone, now)}; change with "${at} set timezone to Europe/London".`,
  ].join('\n');
}

type Schedulable = Pick<Reminder, 'startLocal' | 'rrule' | 'timezone' | 'offsetsMinutes' | 'title' | 'shortId' | 'kind'>;

function scheduleDetails(r: Schedulable, nextEvent: Date | null): string {
  const sched = { startLocal: toIsoLocal(r.startLocal), rrule: r.rrule, timezone: r.timezone, offsetsMinutes: r.offsetsMinutes };
  const parts = [`${sanitizeText(r.title)} (#${r.shortId}), ${describeWhen(sched)}.`];
  if (r.rrule && nextEvent) parts.push(`Next: ${formatDay(DateTime.fromJSDate(nextEvent).setZone(r.timezone))}.`);
  const onlyAtTime = r.offsetsMinutes.length === 1 && r.offsetsMinutes[0] === 0;
  if (!onlyAtTime || !r.rrule) {
    if (!(r.kind === 'birthday' || r.kind === 'anniversary') || !onlyAtTime) parts.push(describeOffsets(sched));
  }
  return parts.join(' ');
}

export function createdConfirmation(r: Schedulable, nextEvent: Date | null, subjectName: string | null): string {
  const greeting =
    r.kind === 'birthday'
      ? ` I'll wish ${subjectName ? sanitizeText(subjectName, 40) : 'them'} a happy birthday here.`
      : r.kind === 'anniversary'
        ? ` I'll post anniversary wishes here.`
        : '';
  return `Got it: ${scheduleDetails(r, nextEvent)}${greeting} Reply "undo" within ${UNDO_MINUTES} minutes to cancel.`;
}

export function editedConfirmation(r: Schedulable, nextEvent: Date | null): string {
  return `Updated: ${scheduleDetails(r, nextEvent)} Reply "undo" within ${UNDO_MINUTES} minutes to revert.`;
}

export function cancelledConfirmation(r: Pick<Reminder, 'title' | 'shortId'>): string {
  return `Cancelled #${r.shortId} ${sanitizeText(r.title)}. Reply "undo" within ${UNDO_MINUTES} minutes to restore it.`;
}

export const UNAVAILABLE_TEXT = "Sorry, I can't process requests right now. Please try again in a few minutes.";

export function listText(items: { reminder: Reminder; nextEvent: Date | null }[], botName: string): string {
  if (items.length === 0) {
    return `No active reminders yet. Try "@${botName} remind us about the meeting on Sunday at 11am".`;
  }
  const lines = items.map(({ reminder: r, nextEvent }) => {
    const when = describeWhen({ ...r, startLocal: toIsoLocal(r.startLocal) });
    const next = r.rrule && nextEvent ? ` · next ${formatDay(DateTime.fromJSDate(nextEvent).setZone(r.timezone))}` : '';
    return `#${r.shortId} ${sanitizeText(r.title)}: ${when}${next}`;
  });
  return [`📋 Reminders (${items.length}):`, ...lines, `Cancel with "@${botName} cancel #<number>".`].join('\n');
}

const KIND_NOUNS: Record<Reminder['kind'], [string, string]> = {
  birthday: ['birthday', 'birthdays'],
  anniversary: ['anniversary', 'anniversaries'],
  event: ['event', 'events'],
  generic: ['reminder', 'reminders'],
};
const kindNoun = (kind: Reminder['kind'] | null, plural: boolean) => (kind ? KIND_NOUNS[kind] : KIND_NOUNS.generic)[plural ? 1 : 0];

/** Answer to "what's on this week?": events in a period, soonest first. */
export function periodText(
  events: UpcomingEvent[],
  truncated: boolean,
  period: { from: Date; to: Date; timezone: string },
  kind: Reminder['kind'] | null,
  botName: string,
): string {
  const from = formatDay(DateTime.fromJSDate(period.from).setZone(period.timezone));
  const to = formatDay(DateTime.fromJSDate(period.to).setZone(period.timezone));
  const range = from === to ? `on ${from}` : `between ${from} and ${to}`;
  if (events.length === 0) return `No ${kindNoun(kind, true)} coming up ${range}.`;
  const lines = events.map(({ reminder: r, at }) => {
    const local = DateTime.fromJSDate(at).setZone(r.timezone);
    return `• ${formatDay(local)}, ${formatTime(local)}: ${sanitizeText(r.title)} (#${r.shortId})`;
  });
  const more = truncated ? [`…and more. See them all with "@${botName} what reminders do we have?".`] : [];
  return [`📅 Coming up ${range}:`, ...lines, ...more].join('\n');
}

/** Answer to "when is X?": each matching reminder's schedule and next date. */
export function nextEventsText(events: UpcomingEvent[]): string {
  const lines = events.map(({ reminder: r, at }) => {
    const when = describeWhen({ ...r, startLocal: toIsoLocal(r.startLocal) });
    const head = `${sanitizeText(r.title)} (#${r.shortId}): ${when.charAt(0).toUpperCase()}${when.slice(1)}`;
    return r.rrule ? [head, `Next: ${formatDay(DateTime.fromJSDate(at).setZone(r.timezone))}`] : [head];
  });
  if (lines.length === 1) return `${lines[0]!.join('\n')}.`;
  return lines.map(([head, ...rest]) => [`• ${head}`, ...rest.map((l) => `   ${l}`)].join('\n')).join('\n');
}

/** Nothing matched a "when is X?" question. */
export function noMatchText(kind: Reminder['kind'] | null, subject: 'you' | 'them' | null): string {
  const what = kindNoun(kind, false);
  if (subject) return `I don't have ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} saved for ${subject}.`;
  return `I couldn't find a matching ${what}.`;
}
