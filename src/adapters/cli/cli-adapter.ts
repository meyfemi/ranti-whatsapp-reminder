import { createInterface, type Interface } from 'node:readline';
import type { ChatAdapter, IncomingMessage, Member, MentionedUser, QuotedMessage } from '../types.js';

interface CliUser {
  name: string;
  userId: string;
  isAdmin: boolean;
}

export type CliCommandHandler = (args: string[]) => Promise<void> | void;

export interface CliAdapterOptions {
  botName: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Returns the current time; the CLI can run against a fake clock. */
  now?: () => Date;
}

const userIdFor = (name: string) => `cli:${name.toLowerCase()}`;
const groupIdFor = (name: string) => `cli-group:${name.toLowerCase()}`;

/**
 * A local REPL that simulates WhatsApp groups. Type plain text to speak as the current user;
 * include "@<botname>" to mention the bot. Lines starting with "/" are simulator commands.
 */
export class CliAdapter implements ChatAdapter {
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private addedHandler?: (groupId: string) => Promise<void>;
  private readonly users = new Map<string, CliUser>();
  private readonly groupMembers = new Map<string, Set<string>>();
  private readonly extraCommands = new Map<string, { help: string; run: CliCommandHandler }>();
  private currentUser: CliUser;
  private currentGroup = groupIdFor('family');
  private lastBotMessageId: string | undefined;
  /** Each user's last message per group, keyed "<group> <userId>", for /replyto. */
  private readonly lastPosts = new Map<string, { id: string; text: string }>();
  private seq = 0;
  /** Lines collected between /paste and /end, sent as one multi-line message. */
  private pasteBuffer: string[] | null = null;
  private rl?: Interface;
  private readonly out: NodeJS.WritableStream;
  private readonly now: () => Date;

  constructor(private readonly opts: CliAdapterOptions) {
    this.out = opts.output ?? process.stdout;
    this.now = opts.now ?? (() => new Date());
    this.currentUser = this.ensureUser('alice', true);
    this.ensureUser('john', false);
    this.joinGroup(this.currentGroup, this.currentUser.userId);
    this.joinGroup(this.currentGroup, userIdFor('john'));
  }

  /** Registers an extra slash command (used for the fake clock). */
  registerCommand(name: string, help: string, run: CliCommandHandler): void {
    this.extraCommands.set(name, { help, run });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onBotAddedToGroup(handler: (groupId: string) => Promise<void>): void {
    this.addedHandler = handler;
  }

  formatMention(userId: string): string {
    return `@${userId.replace(/^cli:/, '')}`;
  }

  async getGroupName(groupId: string): Promise<string | undefined> {
    return groupId.replace(/^cli-group:/, '');
  }

  async getGroupMembers(groupId: string): Promise<Member[]> {
    const ids = this.groupMembers.get(groupId) ?? new Set<string>();
    return [...ids].map((id) => {
      const user = [...this.users.values()].find((u) => u.userId === id);
      return { userId: id, altUserIds: [], displayName: user?.name, isAdmin: user?.isAdmin ?? false };
    });
  }

  async sendText(groupId: string, text: string, mentionUserIds: string[] = []): Promise<void> {
    this.lastBotMessageId = `bot-${++this.seq}`;
    const where = groupId === this.currentGroup ? '' : ` [${groupId.replace(/^cli-group:/, '')}]`;
    const mentions = mentionUserIds.length ? `  (mentions: ${mentionUserIds.join(', ')})` : '';
    this.print(`\n🤖 ${this.opts.botName}${where}: ${text}${mentions}\n`);
  }

  async start(): Promise<void> {
    this.print(this.helpText());
    this.rl = createInterface({ input: this.opts.input ?? process.stdin, output: this.out, terminal: false });
    this.prompt();
    // Process lines strictly in order.
    let chain = Promise.resolve();
    this.rl.on('line', (line) => {
      chain = chain.then(() => this.handleLine(line)).then(() => this.prompt());
    });
    await new Promise<void>((resolve) => this.rl!.on('close', () => chain.then(() => resolve())));
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  /** Processes one REPL line. Public so tests can drive the simulator directly. */
  async handleLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (this.pasteBuffer) {
      if (line.toLowerCase() !== '/end') {
        if (line) this.pasteBuffer.push(line);
        return;
      }
      const text = this.pasteBuffer.join('\n');
      this.pasteBuffer = null;
      if (text) await this.deliver(text, false);
      return;
    }
    if (!line) return;
    if (line.startsWith('/')) {
      await this.handleCommand(line);
      return;
    }
    await this.deliver(line, false);
  }

  private async handleCommand(line: string): Promise<void> {
    const [cmd = '', ...args] = line.slice(1).split(/\s+/);
    switch (cmd.toLowerCase()) {
      case 'as': {
        const [name, flag] = args;
        if (!name) return this.print('Usage: /as <name> [admin]\n');
        const user = this.ensureUser(name, flag === 'admin' ? true : undefined);
        this.joinGroup(this.currentGroup, user.userId);
        this.currentUser = user;
        return this.print(`You are now ${user.name}${user.isAdmin ? ' (admin)' : ''}.\n`);
      }
      case 'admin': {
        const name = args[0] ?? this.currentUser.name;
        const user = this.ensureUser(name);
        user.isAdmin = !user.isAdmin;
        return this.print(`${user.name} is ${user.isAdmin ? 'now' : 'no longer'} an admin.\n`);
      }
      case 'group': {
        const name = args[0];
        if (!name) return this.print(`Current group: ${this.currentGroup}\n`);
        this.currentGroup = groupIdFor(name);
        this.joinGroup(this.currentGroup, this.currentUser.userId);
        return this.print(`Switched to group "${name}".\n`);
      }
      case 'add': {
        // Simulates someone adding the bot to the current group.
        await this.addedHandler?.(this.currentGroup);
        return;
      }
      case 'paste': {
        this.pasteBuffer = [];
        return this.print('Pasting: type or paste lines, then /end to send them as one message.\n');
      }
      case 'reply': {
        if (!this.lastBotMessageId) return this.print('The bot has not said anything yet.\n');
        await this.deliver(args.join(' '), true);
        return;
      }
      case 'replyto': {
        // Simulates replying to someone's post (usually with "@<bot>" to have the bot read it).
        const [name, ...rest] = args;
        const author = name ? this.users.get(name.toLowerCase()) : undefined;
        if (!author) return this.print('Usage: /replyto <name> <text>\n');
        const post = this.lastPosts.get(`${this.currentGroup} ${author.userId}`);
        if (!post) return this.print(`${author.name} hasn't posted in this group yet.\n`);
        const quoted: QuotedMessage = {
          text: this.stripBot(post.text),
          senderId: author.userId,
          senderAltIds: [],
          senderDisplayName: author.name,
        };
        await this.deliver(rest.join(' '), false, { id: post.id, quoted, mentionsFrom: post.text });
        return;
      }
      case 'users': {
        const lines = [...this.users.values()].map((u) => `  ${u.name}${u.isAdmin ? ' (admin)' : ''} = ${u.userId}`);
        return this.print(`${lines.join('\n')}\n`);
      }
      case 'help':
        return this.print(this.helpText());
      case 'quit':
      case 'exit':
        this.rl?.close();
        return;
      default: {
        const extra = this.extraCommands.get(cmd.toLowerCase());
        if (extra) {
          await extra.run(args);
          return;
        }
        this.print(`Unknown command /${cmd}. Type /help.\n`);
      }
    }
  }

  private async deliver(
    text: string,
    isReply: boolean,
    replyTo?: { id: string; quoted: QuotedMessage; mentionsFrom: string },
  ): Promise<void> {
    const mentionsBot = this.botToken().test(text);
    const mentionedUsers: MentionedUser[] = [];
    for (const match of `${text} ${replyTo?.mentionsFrom ?? ''}`.matchAll(/@([A-Za-z][\w-]*)/g)) {
      const name = match[1]!;
      if (name.toLowerCase() === this.opts.botName.toLowerCase()) continue;
      const user = this.users.get(name.toLowerCase());
      if (user && !mentionedUsers.some((m) => m.userId === user.userId)) {
        mentionedUsers.push({ userId: user.userId, altUserIds: [], displayName: user.name });
      }
    }
    const messageId = `cli-${++this.seq}`;
    this.lastPosts.set(`${this.currentGroup} ${this.currentUser.userId}`, { id: messageId, text });
    const msg: IncomingMessage = {
      messageId,
      groupId: this.currentGroup,
      senderId: this.currentUser.userId,
      senderAltIds: [],
      senderDisplayName: this.currentUser.name,
      text: this.stripBot(text),
      mentionedUserIds: mentionedUsers.map((m) => m.userId),
      mentionedUsers,
      quotedMessageId: isReply ? this.lastBotMessageId : replyTo?.id,
      isReplyToBot: isReply,
      quoted: replyTo?.quoted,
      mentionsBot,
      isFromAdmin: this.currentUser.isAdmin,
      timestamp: this.now(),
    };
    await this.messageHandler?.(msg);
  }

  private botToken(): RegExp {
    return new RegExp(`@${escapeRegExp(this.opts.botName)}\\b`, 'gi');
  }

  private stripBot(text: string): string {
    return text
      .replace(this.botToken(), '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  private ensureUser(name: string, isAdmin?: boolean): CliUser {
    const key = name.toLowerCase();
    let user = this.users.get(key);
    if (!user) {
      user = { name: key, userId: userIdFor(key), isAdmin: isAdmin ?? false };
      this.users.set(key, user);
    } else if (isAdmin !== undefined) {
      user.isAdmin = isAdmin;
    }
    return user;
  }

  private joinGroup(groupId: string, userId: string): void {
    let set = this.groupMembers.get(groupId);
    if (!set) this.groupMembers.set(groupId, (set = new Set()));
    set.add(userId);
  }

  private prompt(): void {
    this.out.write(`${this.currentUser.name}@${this.currentGroup.replace(/^cli-group:/, '')}> `);
  }

  private print(text: string): void {
    this.out.write(text);
  }

  private helpText(): string {
    const extra = [...this.extraCommands.entries()].map(([n, c]) => `  /${n.padEnd(22)} ${c.help}`);
    return [
      `\n${this.opts.botName} CLI simulator. Mention the bot with @${this.opts.botName.toLowerCase()}.`,
      '  /as <name> [admin]       speak as another user (created on first use)',
      '  /admin [name]            toggle admin for a user',
      '  /group <name>            switch to another group',
      '  /add                     simulate the bot being added to this group',
      '  /reply <text>            reply to the bot\'s last message (no mention needed)',
      '  /paste ... /end          send several lines as one message (e.g. a birthday list)',
      `  /replyto <name> <text>   reply to <name>'s last post, e.g. /replyto john @${this.opts.botName.toLowerCase()}`,
      '  /users                   list simulated users',
      ...extra,
      '  /quit                    exit',
      '',
    ].join('\n');
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
