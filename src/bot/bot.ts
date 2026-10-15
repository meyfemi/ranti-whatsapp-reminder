import type { ChatAdapter, IncomingMessage, QuotedMessage } from '../adapters/types.js';
import type { Db } from '../db/client.js';
import type { DigestService } from '../digest/service.js';
import { WEEKDAY_CODES } from '../digest/upcoming.js';
import {
  createInteraction,
  deleteInteraction,
  findActiveInteraction,
  getMember,
  listActiveReminders,
  listMembers,
  updateGroup,
  upsertGroup,
  upsertMember,
} from '../db/repositories.js';
import type { Group, MemberRow, PendingInteraction, Reminder } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { BulkParsed, CreateParsed, LinkParsed, ParsedCommand, ReminderTarget } from '../parser/schema.js';
import { ParserUnavailableError, type Parser, type ParserMentionedUser } from '../parser/types.js';
import {
  applyEdit,
  BULK_IMPORT_MINUTES,
  buildImport,
  cleanName,
  DEFAULT_WISH_TIME,
  nameMatchesMember,
  normaliseName,
  parsePreviewReply,
  previewTexts,
  type BulkContext,
  type BulkImportPayload,
  type PreviewReply,
} from '../reminders/bulk.js';
import { describeWhen, formatDay, sanitizeText, tzAbbrev } from '../reminders/format.js';
import { canCreate } from '../reminders/permissions.js';
import { eventsBetween, filterReminders, nextEvents, periodBounds } from '../reminders/query.js';
import { resolveTarget } from '../reminders/target.js';
import { birthdayName, type ReminderChanges, type ReminderService, type ReminderSnapshot } from '../reminders/service.js';
import type { ActorContext } from '../reminders/types.js';
import type { Clock } from '../scheduler/clock.js';
import { parseLocal } from '../scheduler/recurrence.js';
import { toIsoLocal } from '../scheduler/scheduler.js';
import { DateTime } from 'luxon';
import {
  cancelledConfirmation,
  createdConfirmation,
  digestConfirmation,
  editedConfirmation,
  helpText,
  introText,
  listText,
  nextEventsText,
  noMatchText,
  periodText,
  UNAVAILABLE_TEXT,
  UNDO_MINUTES,
} from './texts.js';

export interface BotOptions {
  platform: string;
  botName: string;
  defaultTimezone: string;
  /** Most birthdays accepted in one pasted list. */
  maxBulkEntries?: number;
}

export const DEFAULT_MAX_BULK_ENTRIES = 100;

const CLARIFY_MINUTES = 10;

export type UndoPayload =
  | { op: 'create'; reminderId: number }
  | { op: 'cancel'; reminderId: number }
  | { op: 'edit'; reminderId: number; before: ReminderSnapshot };
/** `quoted` is the post the bot was tagged under, kept so the answer is parsed with it. */
export type ClarifyPayload = { question: string; originalText: string; quoted?: QuotedMessage };
/** "Is this the same as the saved #4 John's birthday?" asked when someone adds their own birthday. */
export type ConfirmLinkPayload = { reminderId: number; command: CreateParsed };
export type ChoosePayload =
  | { op: 'cancel'; candidates: number[] }
  | { op: 'edit'; candidates: number[]; changes: ReminderChanges };

const isUndo = (text: string) => /^undo[.!]*$/i.test(text.trim());
const isYes = (text: string) => /^(?:yes|y|yeah|yep|ok|okay|sure)[.!]*$/i.test(text.trim());
const isNo = (text: string) => /^(?:no|n|nope|nah)[.!]*$/i.test(text.trim());

/**
 * Turns incoming group messages into actions. Only messages that @mention the bot, or replies to
 * the bot from someone with an open interaction (undo window / clarifying question), are handled;
 * everything else is ignored without calling the LLM.
 */
export class Bot {
  constructor(
    private readonly db: Db,
    private readonly adapter: ChatAdapter,
    private readonly parser: Parser,
    private readonly reminders: ReminderService,
    private readonly digests: DigestService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: BotOptions,
  ) {}

  attach(): void {
    this.adapter.onMessage((msg) => this.handleMessage(msg));
    this.adapter.onBotAddedToGroup((groupId) => this.handleAddedToGroup(groupId));
    this.adapter.onBotRemovedFromGroup?.((groupId) => this.handleRemovedFromGroup(groupId));
  }

  /** Marks the group inactive so its reminders are skipped instead of failing to send. */
  async handleRemovedFromGroup(platformGroupId: string): Promise<void> {
    const { group } = await upsertGroup(this.db, {
      platform: this.opts.platform,
      platformGroupId,
      defaultTimezone: this.opts.defaultTimezone,
    });
    await updateGroup(this.db, group.id, { active: false });
    this.logger.info({ groupId: group.id }, 'Bot removed from group; group deactivated');
  }

  async handleAddedToGroup(platformGroupId: string): Promise<void> {
    const name = await this.adapter.getGroupName?.(platformGroupId).catch(() => undefined);
    const { group } = await upsertGroup(this.db, {
      platform: this.opts.platform,
      platformGroupId,
      name,
      defaultTimezone: this.opts.defaultTimezone,
    });
    if (!group.active) {
      await updateGroup(this.db, group.id, { active: true });
      await this.digests.reschedule(group.id); // picks a digest back up if it was on
    }
    await this.adapter.sendText(platformGroupId, introText(this.opts.botName, group.timezone, this.clock.now()));
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (!msg.mentionsBot && !msg.isReplyToBot) return;
    try {
      await this.process(msg);
    } catch (err) {
      this.logger.error({ err, groupId: msg.groupId }, 'Failed to handle message');
      await this.reply(msg, 'Sorry, something went wrong. Please try again.').catch(() => undefined);
    }
  }

  private async process(msg: IncomingMessage): Promise<void> {
    const now = this.clock.now();
    const { group } = await upsertGroup(this.db, {
      platform: this.opts.platform,
      platformGroupId: msg.groupId,
      defaultTimezone: this.opts.defaultTimezone,
    });
    const member = await upsertMember(this.db, group.id, {
      userId: msg.senderId,
      altUserIds: msg.senderAltIds,
      displayName: msg.senderDisplayName,
    });
    const actor: ActorContext = { group, member, isAdmin: msg.isFromAdmin };

    const [undo, clarify, choose, bulk, confirmLink] = await Promise.all([
      findActiveInteraction(this.db, group.id, member.id, 'undo', now),
      findActiveInteraction(this.db, group.id, member.id, 'clarify', now),
      findActiveInteraction(this.db, group.id, member.id, 'choose', now),
      findActiveInteraction(this.db, group.id, member.id, 'bulk_import', now),
      findActiveInteraction(this.db, group.id, member.id, 'confirm_link', now),
    ]);

    const text = msg.text.trim();
    if (isUndo(text)) {
      // Unmentioned "undo" replies are only answered when there is something to undo.
      if (!msg.mentionsBot && !undo) return;
      return this.handleUndo(msg, actor, undo);
    }
    if (confirmLink && (isYes(text) || isNo(text))) {
      return this.handleConfirmLink(msg, actor, confirmLink, isYes(text));
    }
    if (bulk) {
      // Preview replies are matched by code; only the person who pasted the list has one open.
      const reply = parsePreviewReply(text);
      if (reply) return this.handleBulkReply(msg, actor, bulk, reply);
      if (!msg.mentionsBot && !clarify) {
        return this.reply(msg, 'Reply "yes" to save the birthdays, "no" to cancel, "remove 3" or "fix 2: 4 March".');
      }
    }
    if (choose) {
      const picked = /^#?\s*(\d+)[.!]?$/.exec(text);
      if (picked) return this.handleChoice(msg, actor, choose, Number(picked[1]));
      if (/^(no|none|never ?mind|nevermind|stop)[.!]*$/i.test(text)) {
        await deleteInteraction(this.db, choose.id);
        return this.reply(msg, 'OK, nothing changed.');
      }
    }
    // Otherwise, a reply without a mention is only handled as the answer to an open question.
    if (!msg.mentionsBot && !clarify) return;
    // A bare mention shows help, unless it is under someone's post: then the post is the request.
    if (!text && !msg.quoted) return this.reply(msg, helpText(this.opts.botName, group.timezone, now));
    // An over-long birthday list is turned back before spending a parser call on it.
    const lines = text.split('\n').filter((l) => l.trim()).length;
    if (lines > this.maxBulk + 1 && /birth|bday/i.test(text)) return this.reply(msg, this.tooManyText());

    const pending = clarify ? (clarify.payload as ClarifyPayload) : undefined;
    const quoted = msg.quoted ?? pending?.quoted;
    const mentioned = await this.upsertMentioned(group, msg);
    const author = quoted ? await this.upsertQuotedAuthor(group, quoted) : undefined;
    const active = await listActiveReminders(this.db, group.id);
    let command: ParsedCommand;
    try {
      command = await this.parser.parseCommand({
        text,
        sender: { id: member.platformUserId, name: msg.senderDisplayName },
        timezone: group.timezone,
        dateFormat: group.dateFormat,
        now,
        mentionedUsers: mentioned.map(({ user }) => user),
        activeReminders: active.map((r) => ({
          shortId: r.shortId,
          title: r.title,
          kind: r.kind,
          when: describeWhen({ ...r, startLocal: toIsoLocal(r.startLocal) }),
        })),
        quoted: quoted && author ? { text: quoted.text, author: { id: quoted.senderId, name: author.name } } : undefined,
        pending: pending && { question: pending.question, originalText: pending.originalText },
      });
    } catch (err) {
      if (err instanceof ParserUnavailableError) return this.reply(msg, UNAVAILABLE_TEXT);
      throw err;
    }
    this.logger.debug({ action: command.action, groupId: group.id }, 'Parsed command');

    if (clarify && command.action !== 'clarify') await deleteInteraction(this.db, clarify.id);
    // "Me" in a quoted post is its author, so the author can be the reminder's subject too.
    const subjects = author ? [...mentioned, author] : mentioned;
    await this.execute(msg, actor, command, { text, quoted, clarify, mentioned: subjects });
  }

  private async execute(
    msg: IncomingMessage,
    actor: ActorContext,
    command: ParsedCommand,
    ctx: {
      text: string;
      quoted: QuotedMessage | undefined;
      clarify: PendingInteraction | undefined;
      mentioned: { member: MemberRow; ids: string[] }[];
    },
  ): Promise<void> {
    const now = this.clock.now();
    switch (command.action) {
      case 'create':
        return this.handleCreate(msg, actor, command, ctx.mentioned);
      case 'clarify': {
        const previous = ctx.clarify?.payload as ClarifyPayload | undefined;
        const originalText = previous ? `${previous.originalText}\n(then they said: ${ctx.text})` : ctx.text;
        await createInteraction(this.db, {
          groupId: actor.group.id,
          memberId: actor.member.id,
          kind: 'clarify',
          payload: { question: command.question, originalText, quoted: ctx.quoted } satisfies ClarifyPayload,
          expiresAt: new Date(now.getTime() + CLARIFY_MINUTES * 60_000),
        });
        return this.reply(msg, sanitizeText(command.question, 300));
      }
      case 'help':
        return this.reply(msg, helpText(this.opts.botName, actor.group.timezone, now));
      case 'unsupported':
        return this.reply(msg, sanitizeText(command.reason, 300));
      case 'list':
        return this.reply(msg, listText(await this.reminders.list(actor.group.id), this.opts.botName));
      case 'query':
        return this.handleQuery(msg, actor, command, ctx.mentioned);
      case 'cancel':
        return this.withTarget(msg, actor, command.target, { op: 'cancel' }, (r) => this.doCancel(msg, actor, r));
      case 'edit': {
        const changes: ReminderChanges = {
          title: command.changes.title,
          startLocal: command.changes.start_local,
          rrule: command.changes.rrule,
          makeOneOff: command.changes.make_one_off,
          offsetsMinutes: command.changes.offsets_minutes,
          messageStyle: command.changes.message_style,
        };
        return this.withTarget(msg, actor, command.target, { op: 'edit', changes }, (r) =>
          this.doEdit(msg, actor, r, changes),
        );
      }
      case 'set_timezone': {
        const res = await this.reminders.setTimezone(actor, command.timezone);
        if (!res.ok) return this.reply(msg, res.error);
        await this.digests.reschedule(actor.group.id);
        const abbrev = tzAbbrev(DateTime.fromJSDate(now).setZone(command.timezone));
        const kept = res.value.rescheduled ? ' Existing reminders keep their local times.' : '';
        return this.reply(msg, `Timezone set to ${command.timezone} (${abbrev}).${kept}`);
      }
      case 'bulk_add_birthdays':
        return this.handleBulk(msg, actor, command, ctx.mentioned);
      case 'link_birthday':
        return this.handleLink(msg, actor, command, ctx.mentioned);
      case 'set_date_format': {
        const res = await this.reminders.setDateFormat(actor, command.format);
        if (!res.ok) return this.reply(msg, res.error);
        return this.reply(
          msg,
          command.format === 'DMY'
            ? 'OK: I\'ll read numeric dates day first, so 03/04 is 3 Apr.'
            : 'OK: I\'ll read numeric dates month first, so 03/04 is 4 Mar.',
        );
      }
      case 'set_digest': {
        const res = await this.digests.configure(actor, {
          enabled: command.enabled === null ? null : command.enabled === 'on',
          weekday: command.weekday === null ? null : WEEKDAY_CODES.indexOf(command.weekday) + 1,
          time: command.time,
          postEmpty: command.empty_weeks === null ? null : command.empty_weeks === 'post',
        });
        if (!res.ok) return this.reply(msg, res.error);
        return this.reply(msg, digestConfirmation(res.value.group, res.value.next, this.opts.botName));
      }
      case 'show_upcoming':
        // Anyone can ask, whether or not the weekly digest is on.
        return this.reply(msg, await this.digests.upcomingText(actor.group));
      case 'set_policy': {
        const res = await this.reminders.setPolicy(actor, command.policy);
        if (!res.ok) return this.reply(msg, res.error);
        return this.reply(
          msg,
          command.policy === 'admins' ? 'OK: only group admins can set reminders now.' : 'OK: anyone in the group can set reminders now.',
        );
      }
    }
  }

  private async handleCreate(
    msg: IncomingMessage,
    actor: ActorContext,
    command: Extract<ParsedCommand, { action: 'create' }>,
    mentioned: { member: MemberRow; ids: string[] }[],
  ): Promise<void> {
    let subject: MemberRow | undefined;
    if (command.subject_user_id) {
      subject = this.resolveSubject(command.subject_user_id, actor, mentioned);
      if (!subject) return this.reply(msg, 'Who is this reminder for? Please @mention them.');
    }
    // Someone adding their own birthday that's already saved by name from a list: offer to link.
    if (command.kind === 'birthday' && subject?.id === actor.member.id) {
      const same = await this.nameOnlyBirthdayFor(actor, command.start_local);
      if (same) {
        await createInteraction(this.db, {
          groupId: actor.group.id,
          memberId: actor.member.id,
          kind: 'confirm_link',
          payload: { reminderId: same.id, command } satisfies ConfirmLinkPayload,
          expiresAt: new Date(this.clock.now().getTime() + CLARIFY_MINUTES * 60_000),
        });
        return this.reply(
          msg,
          `I already have ${sanitizeText(same.title)} (#${same.shortId}) on that date. Is that you? Reply "yes" to link it to you, or "no" to save a new one.`,
        );
      }
    }
    return this.doCreate(msg, actor, command, subject);
  }

  private async doCreate(msg: IncomingMessage, actor: ActorContext, command: CreateParsed, subject: MemberRow | undefined) {
    const result = await this.reminders.create(actor, {
      title: command.title,
      kind: command.kind,
      startLocal: command.start_local,
      rrule: command.rrule,
      offsetsMinutes: command.offsets_minutes,
      subjectMemberId: subject?.id ?? null,
      messageStyle: command.message_style,
    });
    if (!result.ok) return this.reply(msg, result.error);

    const { reminder, occurrences } = result.value;
    await this.openUndoWindow(actor, { op: 'create', reminderId: reminder.id });
    const nextEvent = nextEventOf(occurrences);
    const subjectName = subject?.lastKnownDisplayName ?? (subject ? 'them' : null);
    await this.reply(msg, createdConfirmation(reminder, nextEvent, subjectName));
  }

  /** A name-only birthday on the same date whose name matches the sender's display name. */
  private async nameOnlyBirthdayFor(actor: ActorContext, startLocal: string): Promise<Reminder | undefined> {
    const date = parseLocal(startLocal);
    if (!date) return undefined;
    const active = await listActiveReminders(this.db, actor.group.id);
    return active.find((r) => {
      if (r.kind !== 'birthday' || r.subjectMemberId !== null) return false;
      const start = parseLocal(toIsoLocal(r.startLocal))!;
      const name = birthdayName(r, null);
      return start.month === date.month && start.day === date.day && !!name && nameMatchesMember(name, actor.member.lastKnownDisplayName);
    });
  }

  private async handleConfirmLink(msg: IncomingMessage, actor: ActorContext, pending: PendingInteraction, yes: boolean) {
    await deleteInteraction(this.db, pending.id);
    const payload = pending.payload as ConfirmLinkPayload;
    if (!yes) return this.doCreate(msg, actor, payload.command, actor.member);
    const res = await this.reminders.linkSubject(actor, payload.reminderId, actor.member.id, { bypassPermissions: true });
    if (!res.ok) return this.reply(msg, res.error);
    return this.reply(msg, `Linked: ${sanitizeText(res.value.title)} (#${res.value.shortId}) is yours now. I'll tag you on the day.`);
  }

  // ------------------------------------------------------------------ bulk birthdays

  private get maxBulk(): number {
    return this.opts.maxBulkEntries ?? DEFAULT_MAX_BULK_ENTRIES;
  }

  private tooManyText(): string {
    return `That's more than ${this.maxBulk} birthdays in one go. Please split the list into parts of up to ${this.maxBulk} and send them one at a time.`;
  }

  private async bulkContext(actor: ActorContext, mentioned: { member: MemberRow; ids: string[] }[]): Promise<BulkContext> {
    const members = await listMembers(this.db, actor.group.id);
    return {
      dateFormat: actor.group.dateFormat,
      now: this.clock.now(),
      mentioned: mentioned.map(({ member, ids }) => ({
        memberId: member.id,
        tokens: ids.map((id) => this.adapter.formatMention(id)),
        name: member.lastKnownDisplayName,
      })),
      members: members.map((m) => ({ id: m.id, name: m.lastKnownDisplayName })),
      existing: await this.reminders.existingBirthdays(this.db, actor.group.id),
    };
  }

  private async handleBulk(
    msg: IncomingMessage,
    actor: ActorContext,
    command: BulkParsed,
    mentioned: { member: MemberRow; ids: string[] }[],
  ): Promise<void> {
    if (!canCreate(actor)) return this.reply(msg, 'Only group admins can set reminders in this group.');
    const total = command.entries.length + command.unparsed.length;
    if (total === 0) {
      return this.reply(msg, `Put one birthday per line under your message, e.g.\n@${this.opts.botName} add these birthdays:\nJohn - 12 Oct\nAda - 3 March`);
    }
    if (total > this.maxBulk) return this.reply(msg, this.tooManyText());

    const payload = buildImport(command, await this.bulkContext(actor, mentioned));
    if (payload.entries.length === 0) {
      if (payload.skipped.length && payload.unreadable.length === 0) return this.reply(msg, 'All of those birthdays are already saved.');
      return this.reply(msg, 'I couldn\'t read any of those dates. Please write one birthday per line, like "John - 12 Oct".');
    }
    await this.openBulkImport(actor, payload);
    await this.sendPreview(msg, actor, payload);
  }

  private async openBulkImport(actor: ActorContext, payload: BulkImportPayload): Promise<void> {
    await createInteraction(this.db, {
      groupId: actor.group.id,
      memberId: actor.member.id,
      kind: 'bulk_import',
      payload,
      expiresAt: new Date(this.clock.now().getTime() + BULK_IMPORT_MINUTES * 60_000),
    });
  }

  private async sendPreview(msg: IncomingMessage, actor: ActorContext, payload: BulkImportPayload): Promise<void> {
    const remaining = await this.reminders.remainingSlots(actor.group.id);
    // Parts go out one by one through the adapter, so the usual pacing and rate limits apply.
    for (const part of previewTexts(payload, { remaining, limit: this.reminders.maxActivePerGroup })) {
      await this.reply(msg, part);
    }
  }

  private async handleBulkReply(msg: IncomingMessage, actor: ActorContext, pending: PendingInteraction, reply: PreviewReply) {
    const payload = pending.payload as BulkImportPayload;
    if (reply.kind === 'no') {
      await deleteInteraction(this.db, pending.id);
      return this.reply(msg, 'OK, I didn\'t save any of them.');
    }
    if (reply.kind === 'yes') {
      let entries = payload.entries;
      if (reply.count !== null) {
        if (reply.count < 1 || reply.count > entries.length) {
          return this.reply(msg, `There are ${entries.length} birthdays in the list. Reply "yes" to save them all, or "save N" for the first N.`);
        }
        entries = entries.slice(0, reply.count);
      }
      const remaining = await this.reminders.remainingSlots(actor.group.id);
      if (entries.length > remaining) {
        const limit = this.reminders.maxActivePerGroup;
        return this.reply(
          msg,
          remaining === 0
            ? `This group already has ${limit} active reminders, the limit. Cancel some first, then reply "yes" again.`
            : `Only ${remaining} more reminder${remaining === 1 ? '' : 's'} fit in this group (the limit is ${limit}). Reply "save ${remaining}" to save the first ${remaining}, or "remove N" to drop some.`,
        );
      }
      const res = await this.reminders.importBirthdays(actor, entries);
      if (!res.ok) return this.reply(msg, res.error);
      await deleteInteraction(this.db, pending.id);
      const n = res.value.created.length;
      const skipped = res.value.skipped.length
        ? ` (${res.value.skipped.map((e) => sanitizeText(e.name, 40)).join(', ')} ${res.value.skipped.length === 1 ? 'was' : 'were'} already saved.)`
        : '';
      return this.reply(
        msg,
        n === 1
          ? `Saved 1 birthday. I'll wish them at ${DEFAULT_WISH_TIME} on their day.${skipped}`
          : `Saved ${n} birthdays. I'll wish each person at ${DEFAULT_WISH_TIME} on their day.${skipped}`,
      );
    }

    const mentioned = await this.upsertMentioned(actor.group, msg);
    const edited = applyEdit(payload, reply, await this.bulkContext(actor, mentioned));
    if (!edited.ok) return this.reply(msg, edited.error);
    if (edited.payload.entries.length === 0) {
      await deleteInteraction(this.db, pending.id);
      return this.reply(msg, 'That removes everything, so there\'s nothing to save.');
    }
    await this.openBulkImport(actor, edited.payload);
    return this.sendPreview(msg, actor, edited.payload);
  }

  /** "link John to @John": attaches a member to a name-only birthday so future wishes tag them. */
  private async handleLink(
    msg: IncomingMessage,
    actor: ActorContext,
    command: LinkParsed,
    mentioned: { member: MemberRow; ids: string[] }[],
  ): Promise<void> {
    const member = this.resolveSubject(command.user_id, actor, mentioned);
    if (!member) return this.reply(msg, 'Who should I link that birthday to? Please @mention them.');
    const active = (await listActiveReminders(this.db, actor.group.id)).filter(
      (r) => r.kind === 'birthday' || r.kind === 'anniversary',
    );
    let target: Reminder | undefined;
    if (command.target.short_id !== null) target = active.find((r) => r.shortId === command.target.short_id);
    if (!target && command.target.description) {
      // Exact name first ("link John to @John"), then the usual title matching.
      const wanted = normaliseName(cleanName(command.target.description));
      const byName = active.filter((r) => normaliseName(birthdayName(r, null) ?? '') === wanted);
      const unlinked = byName.filter((r) => r.subjectMemberId === null);
      const pool = unlinked.length ? unlinked : byName;
      if (pool.length === 1) target = pool[0];
      else if (pool.length > 1) {
        const options = pool.slice(0, 5).map((r) => `#${r.shortId} ${sanitizeText(r.title)}`).join(', ');
        return this.reply(msg, `Which one do you mean: ${options}? Say e.g. "link #${pool[0]!.shortId} to @…".`);
      }
    }
    if (!target) {
      const resolution = resolveTarget(active, command.target);
      if (resolution.kind === 'none') return this.reply(msg, "I couldn't find a birthday matching that. Try listing the reminders first.");
      if (resolution.kind === 'ambiguous') {
        const options = resolution.candidates.map((r) => `#${r.shortId} ${sanitizeText(r.title)}`).join(', ');
        return this.reply(msg, `Which one do you mean: ${options}? Say e.g. "link #${resolution.candidates[0]!.shortId} to @…".`);
      }
      target = resolution.reminder;
    }
    const res = await this.reminders.linkSubject(actor, target.id, member.id);
    if (!res.ok) return this.reply(msg, res.error);
    const who = member.lastKnownDisplayName ? sanitizeText(member.lastKnownDisplayName, 40) : 'them';
    return this.reply(msg, `Linked: ${sanitizeText(res.value.title)} (#${res.value.shortId}) will tag ${who} on the day.`);
  }

  /** Answers questions about existing reminders. Read-only, so no permission check. */
  private async handleQuery(
    msg: IncomingMessage,
    actor: ActorContext,
    command: Extract<ParsedCommand, { action: 'query' }>,
    mentioned: { member: MemberRow; ids: string[] }[],
  ): Promise<void> {
    const now = this.clock.now();
    if (command.no_match) return this.reply(msg, noMatchText(command.kind, null));
    let subject: MemberRow | undefined;
    if (command.subject_user_id) {
      subject = this.resolveSubject(command.subject_user_id, actor, mentioned);
      if (!subject) return this.reply(msg, 'Who do you mean? Please @mention them.');
    }
    const matching = filterReminders(await listActiveReminders(this.db, actor.group.id), {
      shortIds: command.short_ids,
      subjectMemberId: subject?.id ?? null,
      kind: command.kind,
    });

    if (command.from_date && command.to_date) {
      const { start, end } = periodBounds(command.from_date, command.to_date, actor.group.timezone);
      const { events, truncated } = eventsBetween(matching, start, end, now);
      const period = { from: start, to: new Date(end.getTime() - 1), timezone: actor.group.timezone };
      return this.reply(msg, periodText(events, truncated, period, command.kind, this.opts.botName));
    }

    const upcoming = nextEvents(matching, now);
    if (upcoming.length === 0) {
      const who = subject ? (subject.id === actor.member.id ? 'you' : 'them') : null;
      return this.reply(msg, noMatchText(command.kind, who));
    }
    return this.reply(msg, nextEventsText(upcoming));
  }

  /** The member a parsed user ID refers to: someone mentioned in the message, or the sender. */
  private resolveSubject(
    id: string,
    actor: ActorContext,
    mentioned: { member: MemberRow; ids: string[] }[],
  ): MemberRow | undefined {
    return (
      mentioned.find((m) => m.ids.includes(id))?.member ??
      (id === actor.member.platformUserId || actor.member.altUserIds.includes(id) ? actor.member : undefined)
    );
  }

  private async handleUndo(msg: IncomingMessage, actor: ActorContext, undo: PendingInteraction | undefined): Promise<void> {
    if (!undo) return this.reply(msg, `There's nothing to undo (undo works for ${UNDO_MINUTES} minutes after a change).`);
    await deleteInteraction(this.db, undo.id);
    const payload = undo.payload as UndoPayload;
    switch (payload.op) {
      case 'create': {
        const r = await this.reminders.cancel(actor, payload.reminderId, { bypassPermissions: true });
        return this.reply(msg, r.ok ? `Undone: removed #${r.value.shortId} ${sanitizeText(r.value.title)}.` : r.error);
      }
      case 'cancel': {
        const r = await this.reminders.reactivate(actor, payload.reminderId);
        return this.reply(msg, r.ok ? `Undone: #${r.value.reminder.shortId} ${sanitizeText(r.value.reminder.title)} is back on.` : r.error);
      }
      case 'edit': {
        const r = await this.reminders.restore(actor, payload.reminderId, payload.before);
        if (!r.ok) return this.reply(msg, r.error);
        const next = nextEventOf(r.value.occurrences);
        const when = describeWhen({ ...r.value.reminder, startLocal: toIsoLocal(r.value.reminder.startLocal) });
        const nextText = r.value.reminder.rrule && next ? ` Next: ${formatDay(DateTime.fromJSDate(next).setZone(r.value.reminder.timezone))}.` : '';
        return this.reply(msg, `Undone: #${r.value.reminder.shortId} is back to ${when}.${nextText}`);
      }
    }
  }

  /** Resolves a cancel/edit target; asks "which one?" when it is ambiguous. */
  private async withTarget(
    msg: IncomingMessage,
    actor: ActorContext,
    target: ReminderTarget,
    pending: { op: 'cancel' } | { op: 'edit'; changes: ReminderChanges },
    run: (r: Reminder) => Promise<void>,
  ): Promise<void> {
    const active = (await this.reminders.list(actor.group.id)).map((l) => l.reminder);
    const resolution = resolveTarget(active, target);
    if (resolution.kind === 'none') return this.reply(msg, resolution.message);
    if (resolution.kind === 'found') return run(resolution.reminder);
    await createInteraction(this.db, {
      groupId: actor.group.id,
      memberId: actor.member.id,
      kind: 'choose',
      payload: { ...pending, candidates: resolution.candidates.map((c) => c.id) } satisfies ChoosePayload,
      expiresAt: new Date(this.clock.now().getTime() + CLARIFY_MINUTES * 60_000),
    });
    const options = resolution.candidates.map((c) => `#${c.shortId} ${sanitizeText(c.title)}`).join(', ');
    return this.reply(msg, `Which one do you mean: ${options}? Reply with the number.`);
  }

  private async handleChoice(msg: IncomingMessage, actor: ActorContext, choose: PendingInteraction, shortId: number) {
    const payload = choose.payload as ChoosePayload;
    const active = (await this.reminders.list(actor.group.id)).map((l) => l.reminder);
    const picked = active.find((r) => r.shortId === shortId && payload.candidates.includes(r.id));
    if (!picked) return this.reply(msg, `#${shortId} isn't one of the options. Reply with one of the numbers I listed.`);
    await deleteInteraction(this.db, choose.id);
    return payload.op === 'cancel' ? this.doCancel(msg, actor, picked) : this.doEdit(msg, actor, picked, payload.changes);
  }

  private async doCancel(msg: IncomingMessage, actor: ActorContext, reminder: Reminder): Promise<void> {
    const res = await this.reminders.cancel(actor, reminder.id);
    if (!res.ok) return this.reply(msg, res.error);
    await this.openUndoWindow(actor, { op: 'cancel', reminderId: reminder.id });
    return this.reply(msg, cancelledConfirmation(res.value));
  }

  private async doEdit(msg: IncomingMessage, actor: ActorContext, reminder: Reminder, changes: ReminderChanges) {
    const res = await this.reminders.edit(actor, reminder.id, changes);
    if (!res.ok) return this.reply(msg, res.error);
    await this.openUndoWindow(actor, { op: 'edit', reminderId: reminder.id, before: res.value.before });
    return this.reply(msg, editedConfirmation(res.value.reminder, nextEventOf(res.value.occurrences)));
  }

  private async openUndoWindow(actor: ActorContext, payload: UndoPayload): Promise<void> {
    await createInteraction(this.db, {
      groupId: actor.group.id,
      memberId: actor.member.id,
      kind: 'undo',
      payload,
      expiresAt: new Date(this.clock.now().getTime() + UNDO_MINUTES * 60_000),
    });
  }

  /** Records mentioned users as members and builds the parser's view of them. */
  private async upsertMentioned(
    group: Group,
    msg: IncomingMessage,
  ): Promise<{ member: MemberRow; ids: string[]; user: ParserMentionedUser }[]> {
    const out = [];
    for (const m of msg.mentionedUsers) {
      const member = await upsertMember(this.db, group.id, {
        userId: m.userId,
        altUserIds: m.altUserIds,
        displayName: m.displayName,
      });
      const ids = [member.platformUserId, ...member.altUserIds, m.userId, ...m.altUserIds];
      out.push({
        member,
        ids: [...new Set(ids)],
        user: {
          id: m.userId,
          altIds: [...new Set(ids)].filter((id) => id !== m.userId),
          name: member.lastKnownDisplayName ?? m.displayName,
          token: this.adapter.formatMention(m.userId),
        },
      });
    }
    return out;
  }

  /** Records the quoted post's author as a member, so "my birthday" in their post can link to them. */
  private async upsertQuotedAuthor(
    group: Group,
    quoted: QuotedMessage,
  ): Promise<{ member: MemberRow; ids: string[]; name: string }> {
    const member = await upsertMember(this.db, group.id, {
      userId: quoted.senderId,
      altUserIds: quoted.senderAltIds,
      displayName: quoted.senderDisplayName,
    });
    const ids = [...new Set([member.platformUserId, ...member.altUserIds, quoted.senderId, ...quoted.senderAltIds])];
    const name = member.lastKnownDisplayName ?? quoted.senderDisplayName ?? this.adapter.formatMention(quoted.senderId);
    return { member, ids, name };
  }

  private async reply(msg: IncomingMessage, text: string): Promise<void> {
    await this.adapter.sendText(msg.groupId, text);
  }

  /** Exposed for tests. */
  async memberById(id: number): Promise<MemberRow | undefined> {
    return getMember(this.db, id);
  }
}

function nextEventOf(occurrences: { fireAt: Date; offsetMinutes: number }[]): Date | null {
  if (occurrences.length === 0) return null;
  return new Date(Math.min(...occurrences.map((o) => o.fireAt.getTime() + o.offsetMinutes * 60_000)));
}
