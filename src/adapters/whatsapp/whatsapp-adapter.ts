import {
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type GroupMetadata,
  type proto,
  type WASocket,
} from 'baileys';
import type pg from 'pg';
import qrcode from 'qrcode-terminal';
import type { Logger } from '../../logger.js';
import type { AlertOwner } from '../../ops/alert.js';
import type { ChatAdapter, IncomingMessage, Member } from '../types.js';
import { usePostgresAuthState } from './auth-store.js';
import { backoffDelay, disconnectAction } from './connection-policy.js';
import { parseRaw, participantEventIds, toIncoming, type ParticipantInfo } from './extract.js';
import { mentionToken, normalizeJid, uniqueIds } from './jid.js';
import { OutboundLimiter, randomDelay, SlidingWindow } from './rate-limit.js';

export interface WhatsAppAdapterOptions {
  pool: pg.Pool;
  sessionName: string;
  logger: Logger;
  alertOwner: AlertOwner;
  /** Digits only, with country code. When set and not yet paired, log in with a pairing code. */
  pairingPhone?: string;
  globalPerMinute: number;
  groupPerMinute: number;
  inboundPerGroupPerMinute: number;
  replyDelayMinMs: number;
  replyDelayMaxMs: number;
}

export type ConnectionStatus = 'starting' | 'waiting_for_pairing' | 'open' | 'reconnecting' | 'stopped';

const METADATA_TTL_MS = 5 * 60_000;
const INTRO_DEDUPE_MS = 10 * 60_000;
const SENT_CACHE_SIZE = 500;

/**
 * ChatAdapter over Baileys (WhatsApp Web multi-device). This is the only module that imports
 * Baileys. It runs as a linked device of a normal WhatsApp account — an unofficial client — so it
 * is deliberately conservative: group chats only, mention/reply-triggered, paced and rate limited.
 */
export class WhatsAppAdapter implements ChatAdapter {
  private sock?: WASocket;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private addedHandler?: (groupId: string) => Promise<void>;
  private removedHandler?: (groupId: string) => Promise<void>;
  private botIds: string[] = [];
  private status: ConnectionStatus = 'starting';
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private pairingRequested = false;
  private readonly metadata = new Map<string, { data: GroupMetadata; at: number }>();
  private readonly sent = new Map<string, proto.IMessage>();
  private readonly introSentAt = new Map<string, number>();
  private readonly inbound = new Map<string, SlidingWindow>();
  private readonly outbound: OutboundLimiter;
  private auth?: Awaited<ReturnType<typeof usePostgresAuthState>>;
  private firstOpen?: { resolve: () => void; reject: (err: Error) => void };

  constructor(private readonly opts: WhatsAppAdapterOptions) {
    this.outbound = new OutboundLimiter({ globalPerMinute: opts.globalPerMinute, groupPerMinute: opts.groupPerMinute });
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onBotAddedToGroup(handler: (groupId: string) => Promise<void>): void {
    this.addedHandler = handler;
  }

  onBotRemovedFromGroup(handler: (groupId: string) => Promise<void>): void {
    this.removedHandler = handler;
  }

  formatMention(userId: string): string {
    return mentionToken(userId);
  }

  /** Connects and resolves once the connection is open (after pairing, on first run). */
  async start(): Promise<void> {
    this.auth = await usePostgresAuthState(this.opts.pool, this.opts.sessionName);
    const opened = new Promise<void>((resolve, reject) => (this.firstOpen = { resolve, reject }));
    await this.connect();
    await opened;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.status = 'stopped';
    clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.auth) return;
    const logger = this.opts.logger.child({ module: 'baileys' }, { level: 'warn' });
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: this.auth.state.creds, keys: makeCacheableSignalKeyStore(this.auth.state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      // History sync stays at Baileys' defaults: v7 needs it for initial LID mappings. History arrives
      // as non-"notify" upserts, which are ignored below, so the bot never acts on old messages.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid) => this.cachedMetadata(jid),
      getMessage: async (key) => (key.id ? this.sent.get(key.id) : undefined),
    });
    this.sock = sock;
    this.pairingRequested = false;

    sock.ev.on('creds.update', () => {
      this.auth!.saveCreds().catch((err) => this.opts.logger.error({ err }, 'Failed to save WhatsApp creds'));
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) void this.handleQr(sock, qr);
      if (connection === 'open') {
        this.botIds = uniqueIds([sock.user?.id, sock.user?.lid]);
        this.attempt = 0;
        this.status = 'open';
        this.opts.logger.info({ botIds: this.botIds }, 'WhatsApp connected');
        this.firstOpen?.resolve();
      }
      if (connection === 'close') {
        if (sock !== this.sock) return; // an old socket closing after we replaced it
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        this.handleClose(statusCode, lastDisconnect?.error);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return; // ignore history/appends
      for (const m of messages) {
        void this.handleIncoming(m).catch((err) => this.opts.logger.error({ err }, 'Error handling incoming message'));
      }
    });

    sock.ev.on('groups.update', (updates) => {
      for (const u of updates) if (u.id) this.metadata.delete(u.id);
    });

    sock.ev.on('group-participants.update', (event) => {
      this.metadata.delete(event.id);
      const ids = participantEventIds(event.participants as unknown[]);
      const involvesBot = ids.some((id) => this.botIds.includes(id));
      if (!involvesBot) return;
      if (event.action === 'add') void this.handleAdded(event.id);
      if (event.action === 'remove') {
        void this.removedHandler?.(event.id).catch((err) => this.opts.logger.error({ err }, 'Removed handler failed'));
      }
    });
  }

  private async handleQr(sock: WASocket, qr: string): Promise<void> {
    this.status = 'waiting_for_pairing';
    if (this.opts.pairingPhone) {
      if (this.pairingRequested || sock.authState.creds.registered) return;
      this.pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(this.opts.pairingPhone);
        process.stdout.write(
          `\nPairing code for +${this.opts.pairingPhone}: ${code}\n` +
            'On the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead.\n\n',
        );
      } catch (err) {
        this.opts.logger.error({ err }, 'Failed to request a pairing code; falling back to QR');
        this.printQr(qr);
      }
      return;
    }
    this.printQr(qr);
  }

  private printQr(qr: string): void {
    process.stdout.write('\nScan this QR code with WhatsApp (Settings > Linked devices > Link a device):\n');
    qrcode.generate(qr, { small: true });
  }

  private handleClose(statusCode: number | undefined, error: unknown): void {
    const action = disconnectAction(statusCode);
    if (this.stopped) return;
    if (action.kind === 'stop') {
      this.status = 'stopped';
      this.opts.logger.error({ statusCode, reason: action.reason, err: error }, action.message);
      void this.opts.alertOwner(`Ranti (WhatsApp) stopped: ${action.message}`);
      this.firstOpen?.reject(new Error(action.message));
      return;
    }
    this.status = 'reconnecting';
    const delay = action.immediate ? 0 : backoffDelay(this.attempt++);
    this.opts.logger.warn({ statusCode, delay, attempt: this.attempt }, 'WhatsApp connection closed; reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.opts.logger.error({ err }, 'Reconnect failed');
        this.handleClose(undefined, err);
      });
    }, delay);
  }

  private async handleAdded(groupId: string): Promise<void> {
    const last = this.introSentAt.get(groupId) ?? 0;
    if (Date.now() - last < INTRO_DEDUPE_MS) return;
    this.introSentAt.set(groupId, Date.now());
    await this.addedHandler?.(groupId).catch((err) => this.opts.logger.error({ err }, 'Added handler failed'));
  }

  private async handleIncoming(m: Parameters<typeof parseRaw>[0]): Promise<void> {
    // Stage 1 drops everything that doesn't mention or reply to the bot, before any network call.
    const raw = parseRaw(m, this.botIds);
    if (!raw) return;

    let window = this.inbound.get(raw.groupId);
    if (!window) this.inbound.set(raw.groupId, (window = new SlidingWindow(this.opts.inboundPerGroupPerMinute, 60_000)));
    if (!window.tryRecord(Date.now())) {
      this.opts.logger.warn({ groupId: raw.groupId }, 'Inbound rate limit hit; message dropped');
      return;
    }

    const meta = await this.groupMetadata(raw.groupId).catch(() => undefined);
    const incoming = toIncoming(raw, (meta?.participants ?? []) as ParticipantInfo[]);
    await this.messageHandler?.(incoming);
  }

  async sendText(groupId: string, text: string, mentionUserIds: string[] = []): Promise<void> {
    await this.outbound.schedule(groupId, async () => {
      const sock = this.requireSocket();
      await sock.sendPresenceUpdate('composing', groupId).catch(() => undefined);
      await new Promise((r) => setTimeout(r, randomDelay(this.opts.replyDelayMinMs, this.opts.replyDelayMaxMs)));
      const sentMsg = await this.requireSocket().sendMessage(groupId, {
        text,
        mentions: mentionUserIds.map((id) => normalizeJid(id) ?? id),
      });
      await sock.sendPresenceUpdate('paused', groupId).catch(() => undefined);
      if (sentMsg?.key.id && sentMsg.message) this.rememberSent(sentMsg.key.id, sentMsg.message);
    });
  }

  async getGroupMembers(groupId: string): Promise<Member[]> {
    const meta = await this.groupMetadata(groupId);
    return meta.participants.map((p) => {
      const ids = uniqueIds([p.id, p.lid, p.phoneNumber]);
      return {
        userId: ids[0]!,
        altUserIds: ids.slice(1),
        displayName: p.notify ?? p.name ?? undefined,
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      };
    });
  }

  async getGroupName(groupId: string): Promise<string | undefined> {
    return (await this.groupMetadata(groupId)).subject;
  }

  private requireSocket(): WASocket {
    if (!this.sock || this.status !== 'open') throw new Error('WhatsApp is not connected');
    return this.sock;
  }

  private async cachedMetadata(jid: string): Promise<GroupMetadata | undefined> {
    const hit = this.metadata.get(jid);
    return hit && Date.now() - hit.at < METADATA_TTL_MS ? hit.data : undefined;
  }

  private async groupMetadata(groupId: string): Promise<GroupMetadata> {
    const cached = await this.cachedMetadata(groupId);
    if (cached) return cached;
    const data = await this.requireSocket().groupMetadata(groupId);
    this.metadata.set(groupId, { data, at: Date.now() });
    return data;
  }

  private rememberSent(id: string, message: proto.IMessage): void {
    this.sent.set(id, message);
    if (this.sent.size > SENT_CACHE_SIZE) this.sent.delete(this.sent.keys().next().value!);
  }
}
