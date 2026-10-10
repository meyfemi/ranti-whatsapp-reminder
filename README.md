# Ranti: a WhatsApp group reminder bot

Ranti is a WhatsApp account you add to your existing groups (family, church, alumni, work). Members @mention it in plain language and it posts reminders into the group at the right time.

```
@Ranti remember 12 Oct is @John's birthday, always wish him happy birthday
@Ranti remind everyone about the general meeting at 11am this Sunday, and send a 5 min reminder
@Ranti every first Saturday of the month remind us to pay dues at 9am
@Ranti what reminders do we have?
@Ranti cancel #4
@Ranti set timezone to Europe/London
```

Every create, edit or cancel is echoed back, and the person who made the change can reply `undo` within 5 minutes. When a request is ambiguous, Ranti asks one short question instead of guessing.

> [!WARNING]
> **Ranti uses an unofficial WhatsApp client.** It connects through [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks the WhatsApp Web multi-device protocol as a linked device of a normal WhatsApp account. This is not the WhatsApp Business API and is not endorsed by WhatsApp or Meta. **The account can be restricted or banned at any time, without warning.** Use a dedicated phone number you can afford to lose, never your personal number. Ranti is built to look and behave like a polite human participant (see [Ban-risk measures](#ban-risk-measures)), but that reduces risk; it does not remove it.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Local setup](#local-setup)
- [Local development with the CLI simulator](#local-development-with-the-cli-simulator)
- [Pairing a WhatsApp number](#pairing-a-whatsapp-number)
- [Environment variables](#environment-variables)
- [Tests](#tests)
- [Deployment](#deployment)
- [Ban-risk measures](#ban-risk-measures)
- [Design notes](#design-notes)
- [Known limitations](#known-limitations)

## How it works

```
WhatsApp ──► adapters/whatsapp ──► bot ──► parser (LLM → JSON, zod-validated)
                (Baileys)           │
                                    └──► reminders (rules, permissions) ──► db (Postgres, source of truth)
                                                                              │
pg-boss job / sweeper ──► dispatcher (idempotent send) ◄── scheduler (rrule + luxon) ◄┘
```

- **The LLM is only a parser.** It turns one message into one structured command, using structured outputs so the reply is always JSON. A second zod layer then checks every field (dates, RRULEs, timezones, that a mentioned person really was mentioned). Dates, recurrence maths, scheduling and permission checks are all deterministic code.
- **The database is the source of truth.** Each reminder stores only its *next* occurrence per offset. pg-boss jobs make delivery punctual, and a sweeper delivers anything a job misses.
- **Dispatch is idempotent.** An occurrence row is locked and moved from `pending` to `sent` in one transaction, with the send inside it. Duplicate jobs, retries and the sweeper cannot double-post.

| Path | What lives there |
| --- | --- |
| `src/adapters/types.ts` | The platform-agnostic `ChatAdapter` interface |
| `src/adapters/whatsapp/` | Baileys adapter: Postgres auth store, mention/LID handling, pacing, reconnects. The only place Baileys is imported (enforced by ESLint). |
| `src/adapters/cli/` | Terminal group simulator with a fast-forwardable clock |
| `src/bot/` | Routes messages to actions; confirmations, undo, clarifying questions, intro/help text |
| `src/parser/` | LLM call, `system-prompt.md`, zod schemas, fixtures |
| `src/reminders/` | Validation, permissions, caps, create/list/cancel/edit/settings, formatting |
| `src/scheduler/` | Recurrence engine, occurrence scheduling, pg-boss queue, missed-job recovery |
| `src/dispatcher/` | Builds and sends due reminders; greeting templates and optional LLM greetings |
| `src/db/` | Drizzle schema, SQL migrations, repositories |
| `src/ops/` | Health endpoint, owner alerts |

## Requirements

- Node.js 22.9 or newer (Node 24 LTS recommended; the Docker image uses it)
- pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- Docker, for local Postgres
- An Anthropic API key, for the parser
- A spare WhatsApp number on a phone you control, for the real bot

## Local setup

```bash
pnpm install
docker compose up -d          # Postgres 17 on localhost:5433, plus a ranti_test database
cp .env.example .env          # then set ANTHROPIC_API_KEY
pnpm db:migrate               # optional: the app also migrates on startup
```

## Local development with the CLI simulator

Most behaviour can be tried without touching WhatsApp. The simulator is a fake group in your terminal, backed by the real database, parser, scheduler and dispatcher.

```bash
pnpm cli
```

Type messages as the current user and include `@ranti` to mention the bot. Mention other simulated users with `@name`.

| Command | What it does |
| --- | --- |
| `/as john` | Speak as another user, created on first use. `/as ade admin` makes them a group admin. |
| `/admin [name]` | Toggle admin for a user |
| `/group church` | Switch to, or create, another group |
| `/add` | Simulate the bot being added to the current group (posts the intro) |
| `/reply undo` | Reply to the bot's last message without mentioning it |
| `/users` | List simulated users |
| `/clock` | Show the simulated time |
| `/advance 2h` | Fast-forward (`90s`, `5m`, `2h`, `3d`, `1w`, or combined like `1d6h`). Every reminder due on the way fires at its own moment. |
| `/settime 2026-10-12T08:59` | Jump to a local date-time |

Example session:

```
alice@family> @ranti remind everyone about the general meeting at 11am this Sunday, and send a 5 min reminder
🤖 Ranti: Got it: General meeting (#1), Sun 11 Oct, 11:00 (WAT). Reminders at 10:55 and 11:00. Reply "undo" within 5 minutes to cancel.
alice@family> /settime 2026-10-11T11:00
🤖 Ranti: ⏰ Reminder: General meeting starts in 5 minutes (11:00).
🤖 Ranti: ⏰ Reminder: General meeting is starting now (11:00).
🕒 Sun 11 Oct 2026 11:00:00 (Africa/Lagos) [simulated]
2 reminder(s) fired.
```

The simulator clock keeps ticking in real time, so reminders also fire on their own while you wait. Simulated groups are stored with platform `cli`, separate from WhatsApp groups.

## Pairing a WhatsApp number

1. Install WhatsApp on a phone with the dedicated number and finish its normal setup.
2. Start the bot with `pnpm dev` locally, or the Docker image in production.
3. Link it as a device using one of these:
   - **QR code (default).** A QR code is printed in the terminal or container logs. On the phone, open WhatsApp, then Settings, Linked devices, Link a device, and scan it. QR codes rotate every few seconds; scan the latest one.
   - **Pairing code.** Set `WA_PAIRING_PHONE` to the bot's number, digits only with country code (e.g. `2348012345678`). An 8-character code is printed. On the phone, go to Linked devices, Link a device, then "Link with phone number instead", and enter it.
4. The log shows `WhatsApp connected`, and `/healthz` returns 200.

The session is stored in Postgres (`wa_auth_creds`, `wa_auth_keys`), so restarts and redeploys reconnect without re-pairing. `WA_SESSION_NAME` lets several numbers share one database.

**If the bot is logged out** (unlinked from the phone, or a WhatsApp-side logout), it stops reconnecting, logs an error, and calls the owner alert. To re-pair, delete the old session and start again:

```sql
delete from wa_auth_keys  where session = 'default';
delete from wa_auth_creds where session = 'default';
```

Then add the number to your groups. Ranti posts a short intro when it is added.

## Environment variables

All configuration is via environment variables (see `.env.example`). Nothing secret is committed. WhatsApp session data lives in the database, never in files in the repository.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string |
| `ANTHROPIC_API_KEY` | required for parsing | Anthropic API key |
| `PARSER_MODEL` | `claude-haiku-5-5` | Model used to parse commands |
| `LLM_GREETINGS` | `0` | `1` makes birthday and anniversary messages LLM-generated (validated, with template fallback) |
| `BOT_NAME` | `Ranti` | Name used in intro and help text |
| `DEFAULT_TIMEZONE` | `Africa/Lagos` | Timezone for new groups |
| `MAX_ACTIVE_REMINDERS_PER_GROUP` | `50` | Cap on active reminders per group |
| `WA_SESSION_NAME` | `default` | Name of the WhatsApp session stored in Postgres |
| `WA_PAIRING_PHONE` | unset | Use pairing-code login for this number instead of QR |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | `20` | Max outgoing messages per minute, all groups |
| `RATE_LIMIT_GROUP_PER_MINUTE` | `6` | Max outgoing messages per minute, per group |
| `INBOUND_PER_GROUP_PER_MINUTE` | `10` | Max bot-directed messages handled per group per minute; extras are dropped |
| `REPLY_DELAY_MIN_MS` / `REPLY_DELAY_MAX_MS` | `1000` / `4000` | Random "typing…" delay before each message |
| `ALERT_WEBHOOK_URL` | unset | Receives `POST {"text": "..."}` when the bot needs attention. Unset means log only. |
| `HEALTH_PORT` | `8080` | Port for `/livez` and `/healthz` |
| `LOG_LEVEL` | `info` | pino log level |
| `TEST_DATABASE_URL` | `postgres://ranti:ranti@localhost:5433/ranti_test` | Database the test suite resets and uses |

## Tests

```bash
docker compose up -d   # tests use a real Postgres (the ranti_test database)
pnpm test              # unit and integration tests
pnpm lint && pnpm typecheck
```

The test run drops and re-migrates the `ranti_test` schema, then runs DB-backed files serially. Coverage includes:

- **Recurrence:** DST gaps and overlaps, Feb 29 to Feb 28, "first Saturday", offsets.
- **Dispatcher:** idempotency under concurrent duplicates, retries, recovery.
- **Commands:** permissions, caps, undo.
- **WhatsApp adapter:** mention and LID handling, the auth store, rate limits and reconnect policy.

The parser fixtures in `src/parser/fixtures.ts` hold 31 example messages with expected commands. They run against the real API only when asked:

```bash
RUN_LLM_TESTS=1 ANTHROPIC_API_KEY=... pnpm vitest run src/parser
```

Results are compared by meaning. Wording may differ, and schedules are compared by their computed fire times.

## Deployment

```bash
docker build -t ranti .
docker run -d --name ranti --restart unless-stopped \
  -e DATABASE_URL=postgres://... -e ANTHROPIC_API_KEY=... \
  -p 8080:8080 ranti
docker logs -f ranti    # the pairing QR / code appears here on first run
```

- **Run exactly one instance per WhatsApp session.** A second instance makes WhatsApp drop the first one with "connection replaced", and Ranti stops and alerts rather than fighting over the session. Use a single replica with a stop-then-start (Recreate) rollout, not a rolling one.
- **Postgres** holds everything: reminders, the job queue (pg-boss, in schema `pgboss`), and the WhatsApp session. Back it up. Losing it means re-pairing and losing reminders.
- **Migrations** run automatically on startup.
- **Health checks.** `GET /livez` returns 200 while the process runs; use it for liveness, so a bot waiting to be paired is never restarted. `GET /healthz` returns 200 only when the database is reachable and WhatsApp is connected, otherwise 503 with details. Use it for readiness and uptime alerts.
- **Alerts.** Set `ALERT_WEBHOOK_URL` to something that pages you, such as a Slack or Discord webhook or a tiny relay to Telegram or email. It fires when WhatsApp logs the bot out, replaces the session, or refuses the connection.
- **Missed reminders.** Downtime is handled at startup. Reminders under 6 hours late are sent with "(slightly late)". Older ones are skipped and the series continues from the next occurrence.
- Logs are structured JSON (pino) on stdout.

## Ban-risk measures

- Ranti responds only when @mentioned, or when someone replies directly to one of its messages *and* has an undo window or open question. All other chatter is discarded before any network call and never reaches the LLM.
- It works in groups only. It never sends DMs, and it ignores DMs, broadcast lists, status updates and newsletters.
- It shows "typing…" and waits 1–4 seconds (random) before every message.
- Outgoing messages are rate limited globally and per group. They are queued, not dropped.
- Inbound bot-directed messages are capped per group, guarding against mention spam and LLM cost.
- Nothing echoed back can mention anyone. User text is sanitised (no `@`, control or zero-width characters), and the only person a reminder ever mentions is its subject.
- The socket does not mark itself online on connect, and the intro is posted at most once per group per 10 minutes.

## Design notes

- **Drizzle over Kysely.** Drizzle keeps the schema as TypeScript next to inferred row types, and `drizzle-kit generate` produces plain, reviewable SQL migrations that the app applies at startup. Kysely is an excellent query builder, but it would need a separate migration authoring step and hand-written table types. For a small schema, Drizzle is less code.
- **Recurrence.** rrule expands rules in the group's local "floating" time, and luxon converts each local time to UTC, so 09:00 stays 09:00 across DST changes. A local time that doesn't exist (spring-forward gap) moves forward an hour. Yearly 29 February rules fire on 28 February in non-leap years.
- **Changing a group's timezone** keeps every reminder's local wall-clock time. A 09:00 reminder stays at 09:00 in the new zone, and all pending occurrences are recomputed.
- **Members** are stored by the stable platform ID WhatsApp gives first, phone-number JID or LID, plus all known aliases. Lookups match any of them, and display names are never used to identify anyone.
- **Undo windows and clarifying questions** live in `pending_interactions`, tied to the member and group, and expire after 5 and 10 minutes.

### Where this differs from the original brief

- **Package and API.** The Baileys package is now `baileys` (pinned `7.0.0-rc14`, ESM-only). npm's `latest` tag points at this release candidate, and 6.x is tagged `legacy`.
- **QR rendering.** v7 deprecated `printQRInTerminal`, so the QR is drawn with `qrcode-terminal`, an extra dependency.
- **History sync.** Ranti keeps Baileys' default history sync, because v7 warns that disabling it breaks LID mappings. History messages are still ignored.
- **`ChatAdapter` additions:**
  - `formatMention(userId)`: each platform has its own mention token.
  - An optional `stop()` and `getGroupName()`.
  - An optional `onBotRemovedFromGroup()`, so a group the bot left is deactivated instead of failing sends.
- **`IncomingMessage` additions:**
  - `messageId`
  - `senderAltIds`, and `mentionedUsers` with LID and phone aliases
  - `mentionsBot` and `isReplyToBot`
- **Parser action.** The parser has a `set_policy` action for "only admins can set reminders". Undo is handled without the LLM.

## Known limitations

- **One command per message.** If a message asks for several reminders, only the first is created.
- **Event-relative wording.** Early-reminder offsets are minutes before the event. "The evening before" has to be expressed as an offset, e.g. 15 hours before.
- **Months without the day.** Monthly rules on the 29th–31st skip months that lack that day, as in RFC 5545. Use "last day of the month" for month-end.
- **Mention rendering.** Mentions render as names in WhatsApp clients, but in text they are numbers (`@2348...`). Reminders store the person, not the name.
- **Narrow double-send window.** If a send succeeds but the database commit right after it fails, a retry can post that reminder twice. Everything else about dispatch is idempotent.
