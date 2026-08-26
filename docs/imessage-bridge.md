# The iMessage bridge

A separate local process that owns every piece of Apple-private access the
assistant needs: the Messages database, Messages.app sending, and the Contacts
database. The calendar app talks to it over localhost and never touches any of
them directly.

This document is the design. It exists because two processes with independent
lifecycles need their seam written down before either side is built.

## 1. Why it is a separate process

Three reasons, in order of how much they cost to get wrong.

**Full Disk Access is granted to the responsible process, not the binary.**
macOS attributes a TCC grant to the top-level application that started the
chain. If the API server spawns `imsg`, the grant follows whatever launched the
server - Terminal, iTerm, VS Code, an agent harness - so starting the dev server
a different way silently breaks `chat.db` reads. Granting the terminal Full Disk
Access to work around that hands every script ever run from it the entire
message history. A bridge started by `launchd` has one stable identity, granted
once, and nothing else inherits it.

**Message streaming outlives a dev loop.** Watching for new messages is a
long-lived subscription. It has no business living in a process that restarts on
every file save.

**The calendar app stays portable.** `packages/core` and the scheduling engine
have no business knowing macOS exists. With the bridge absent the messaging port
reports unavailable and everything else works - the same shape as the rule that
scheduling never depends on an LLM. `docker compose up` keeps working; that
deployment simply has no messaging.

The practical consequence, which is the one that was asked for: the bridge is
configured once and left alone. `npm run dev` on the calendar app does not touch
it, restart it, or need its permissions.

## 2. What it owns, and what it does not

| The bridge owns                                | The calendar app owns                        |
| ---------------------------------------------- | -------------------------------------------- |
| Reading `chat.db` (via `imsg`)                 | Which events are linked to which people      |
| Sending through Messages.app                   | Whether a follow-up should exist at all      |
| Reading Contacts (via AppleScript)             | Drafting the text                            |
| Handle normalisation                           | The approval UI and the pending outbox       |
| Blast radius: rate caps, idempotency, audit    | Intent: what to say, to whom, and when       |

The split is deliberate: **the bridge is dumb about intent and strict about
consequences.** It cannot decide to message anyone. It can refuse to.

Approval lives in the calendar app because that is where the database and the UI
are, and duplicating an approval store in the bridge would mean two sources of
truth for one decision. What the bridge guarantees instead is that a bug on the
other side of the socket has a bounded worst case - see §6.

It does not reimplement `chat.db` parsing. `imsg` is the adapter to Apple; the
bridge is the adapter to the calendar app.

## 3. Shape

```text
apps/imessage-bridge          Node process, launchd-managed, 127.0.0.1:4320
  ├── spawns `imsg --json`    reading chats/history, sending
  └── spawns `osascript`      reading Contacts

packages/imessage-contract    zod schemas + CONTRACT_VERSION, imported by both
                              sides. Imports nothing from the workspace.

packages/integrations/        (later) MessagingProvider + ContactDirectory
  src/imessage/               adapters that speak HTTP to the bridge
```

The bridge depends on the contract package and nothing else in the workspace.
It never imports `core`, `app` or `config`. That keeps it extractable to its own
repository if it ever should be, and keeps its restart cycle genuinely
independent.

### Contract versioning

Two processes on separate lifecycles will drift. `CONTRACT_VERSION` is a single
integer in the contract package, reported by `GET /health`. The client compares
it and degrades to "messaging unavailable" on mismatch rather than sending a
request it cannot parse the answer to. Bumping it is a deliberate act; additive
optional fields do not.

## 4. The contract

All endpoints require `Authorization: Bearer <token>` and are bound to
`127.0.0.1`. Errors use the calendar app's existing envelope so the client can
reuse its handling:

```json
{ "error": { "code": "RATE_LIMITED", "message": "…" } }
```

Codes are a closed set in the contract package: `VALIDATION_ERROR` (400),
`AUTH_ERROR` (401), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429),
`UNSUPPORTED` (501), `PROVIDER_ERROR` (502), `INTERNAL_ERROR` (500).

### `GET /health`

Never fails on missing permissions - unavailability is data, not an error.

```json
{
  "status": "ok",
  "contractVersion": 1,
  "capabilities": {
    "imsg": { "available": true, "version": "0.5.1" },
    "messages": { "readable": true, "sendable": false, "detail": "Automation permission not granted" },
    "contacts": { "readable": true, "count": 412 },
    "send": { "enabled": false, "remainingToday": 0 }
  }
}
```

### `GET /contacts?q=&limit=`

```json
{
  "contacts": [
    {
      "id": "AB:1234-…",
      "displayName": "Sarah Chen",
      "handles": [
        { "kind": "phone", "value": "(415) 555-1212", "normalized": "+14155551212", "label": "mobile" },
        { "kind": "email", "value": "sarah@example.com", "normalized": "sarah@example.com" }
      ]
    }
  ],
  "truncated": false
}
```

Search is over name only. There is no "return everything" endpoint - the address
book does not need to leave this process wholesale.

### `GET /threads?handle=`

Thread **state**, never content:

```json
{
  "handle": "+14155551212",
  "chatId": 42,
  "service": "iMessage",
  "contactName": "Sarah Chen",
  "lastMessageAt": 1756200000000,
  "lastInboundAt": 1756200000000,
  "lastOutboundAt": 1756100000000
}
```

Timestamps are epoch milliseconds, matching `Instant` in the domain. `imsg`
emits ISO 8601, so the conversion happens here, once, at the boundary. A `404`
means no thread with that handle exists.

**This takes two `imsg` calls, and the reason is a real constraint.** `imsg
chats` has exactly one filter flag (`--unread-only`) - it cannot select by
handle - and `imsg history` selects only by `--chat-id`. So the bridge lists
chats, matches `identifier`/`participants` against the normalised handle itself,
then reads a bounded window of that chat's history to find the newest message in
each direction (`is_from_me`). The chat list alone is not enough: it carries
`last_message_at` but nothing that says who sent it, and `unread_count` rather
than a total. That handle→`chat_id` resolution is cached, because it is the
expensive half and it almost never changes.

There is deliberately no total message count. Nothing in the follow-up rules
needs one, and `imsg` does not expose it.

Reading bodies is a separate, explicit endpoint (`GET /threads/messages`) that
exists only for the LLM path - proposing a calendar event from "lunch next
week?" - and is the one call that should feel expensive to make.

### `POST /outbox`

```json
{ "idempotencyKey": "follow-up:evt_123:1", "to": "+14155551212", "text": "still on for Thursday?", "dryRun": false }
```

→ `{ "id": "snd_…", "status": "sent", "retrySafe": false, "at": 1756200000000 }`

`status` is one of:

| Status        | Meaning                                            | Retry |
| ------------- | -------------------------------------------------- | ----- |
| `sent`        | `imsg` confirmed a matching outgoing row           | n/a   |
| `unconfirmed` | dispatched, delivery not confirmed                 | never |
| `failed`      | `imsg` reported it never started                   | safe  |
| `blocked`     | a cap or guard refused it; nothing was dispatched  | safe  |
| `simulated`   | send disabled or `dryRun`; nothing was dispatched  | safe  |
| `duplicate`   | idempotency key already used; original returned    | n/a   |

`unconfirmed` exists because `imsg` reports three dispositions - `not_started`
(retry safe), `may_have_completed` and `still_in_flight` (both unsafe) - and
collapsing those into a boolean is how someone ends up texting a friend the same
question twice. Only `not_started` maps to `failed`. Everything ambiguous is
`unconfirmed`, and `retrySafe` is carried explicitly so the caller never has to
infer it.

`idempotencyKey` is required and enforced against the audit log, which covers
the other half: a client that retries a request whose response it never saw gets
the original result rather than a second text.

Service selection is `--service auto`, whose SMS fallback is documented as
narrow: text-only direct phone sends, before dispatch begins. The bridge does
not override it.

`GET /stream` (SSE, inbound messages) is reserved and not implemented in v1;
thread state is cheap enough to poll, and polling has no reconnection semantics
to get wrong.

## 5. Identity and normalisation

Calendar events name people in prose. Contacts store phone numbers as humans
typed them. iMessage handles are E.164 or an Apple ID email. Joining those is
the actual hard part of this feature, and it is the bridge's job to make the
join deterministic.

Every handle is normalised on the way out:

- email → lowercased, trimmed
- phone → digits only, `+` preserved, a configured default region
  (`IMESSAGE_BRIDGE_REGION`, default `US`) applied to numbers without a country
  code

This is a pragmatic normaliser, not libphonenumber. It is correct for the common
cases and will mis-handle unusual international formats. That limitation is
acceptable because **the bridge never picks a contact** - it returns candidates
with their normalised handles, and the calendar app proposes the link for the
user to confirm once. Nothing silently guesses which human a text goes to.

## 6. Send safety

Sending is irreversible in a way a calendar write is not: an event can be
deleted, a text cannot be unsent. So the bridge's job is to bound the damage
from any caller, including a buggy one.

1. **Off by default.** `IMESSAGE_BRIDGE_SEND=false` ships as the default. Until
   it is flipped, every send returns `simulated` with the text it would have
   sent. The whole feature is developable in this mode.
2. **Idempotency keys are mandatory**, deduplicated against the audit log.
3. **Caps**: per-recipient per day and global per day, both configurable. A cap
   breach is `429 RATE_LIMITED`, logged, and never retried automatically.
4. **Append-only audit log** (JSONL on disk): timestamp, normalised recipient,
   idempotency key, byte length, outcome. It records that a message was sent and
   to whom, which is what an audit needs; whether it also records the text is a
   config flag, default off.
5. **No broadcast.** `to` is a single handle. Sending to N people is N calls
   through N caps.
6. **Bearer token, localhost only.** A token is required even on loopback,
   because any process on the machine can reach loopback.

There is no autonomous mode and none is planned. The bridge is the last mile of
a decision a human already made in the calendar app's UI.

## 7. Failure model

Missing permissions are the **normal** state on a fresh machine, not an error
condition. `imsg` absent, Full Disk Access not granted, Messages automation
denied, Contacts denied - each is a capability that reports false with a
human-readable `detail`, and each disables exactly the endpoints that need it
(`503 UNSUPPORTED` with the remedy in the message) while the rest keep working.

Contacts can be readable while Messages is not. Reading can work while sending
does not - that is the single most likely real configuration, and it is the one
where the first slice of this feature is fully useful.

Two of these fail in ways worth naming, because both look like a crash and
neither is one:

- **A pending Automation prompt does not return an error, it blocks.** The
  process hangs until the timeout kills it, and stderr is empty. So a killed
  `osascript` is reported as the dialog it almost always is, not as a generic
  failure.
- **`/health` must never pay for a full address-book dump.** The capability
  probe asks Contacts only for a count; the dump stays lazy behind an actual
  search. Otherwise a health check costs tens of seconds on a large address
  book, which reads as a hang.

Every remedy travels in `detail`, and everything that reports a capability has
to carry it through - a capability that says only "it failed" leaves the
operator with nothing to do.

### The Contacts dump has one non-obvious constraint

AppleScript charges an Apple Event per property access. Reading contacts the
obvious way - loop over people, ask each for its phones - measured at **113
seconds for 20 contacts**, which is over an hour for a real address book, and it
manifests as a hang rather than an error.

The plural form (`value of phones of every person`) fetches the same data for
every contact in one event. Six bulk reads plus an in-memory loop measured at
**1.9 seconds for 783 contacts**, end to end through the HTTP endpoint in 2.5s
cold and 32ms warm off the cache.

This is the difference between the feature working and the feature being
unusable, and the slow version is the one that looks more natural. The dump
script carries a comment saying so.

There is a second trap in the same place: **`tell application "Contacts"` does
not auto-launch it from a background process.** It fails with `-600 Application
isn't running`, and AppleScript's own `launch` does not rescue it either. The
bridge shells out to `open -ga Contacts` and retries once - `-g` so a background
service never steals focus - which makes the first call after a reboot succeed
instead of telling the user to go open an app by hand.

## 8. Testing without a Mac

The suite must stay green on a machine with no `chat.db`, no `imsg`, and no
Contacts - the same discipline that lets the calendar app run its whole HTTP API
against a fixed clock and a scripted calendar.

Two injectable seams, mirroring the repo's existing port style:

- `ImsgRunner` - `{ run(args): Promise<Result>, stream(args): AsyncIterable }`.
  Real implementation spawns `imsg`; the test implementation replays scripted
  JSON.
- `ContactSource` - real implementation shells to `osascript`; the test
  implementation is an array.

`createBridge(config, overrides)` takes both, exactly as `createApp` takes a
database and a clock. Every route test runs against fakes in milliseconds.

## 9. Running it

While developing, one command builds and starts it:

```bash
npm run bridge
```

On a terminal that prints the token it is using. There is nothing to set up
first: with no token in the environment the bridge generates a 32-byte one and
saves it to `~/.calendar-agent/imessage-bridge/token` with mode `0600`, then
reuses it on every later start. `npm run -s bridge:token` prints it again
without starting a listener.

The token is echoed **only when stdout is a terminal**. Under `launchd` stdout is
a log file that outlives the process, so the banner names the file instead of the
secret.

For the real thing, `launchd` - so it survives logout and starts on boot, and so
its TCC identity stays fixed:

```bash
cp docs/examples/com.calendar-agent.imessage-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.calendar-agent.imessage-bridge.plist
```

The plist carries no secret: it lets the bridge read the same token file. A
`LaunchAgents` plist is world-readable, so a token embedded there would be worse
protected than the `0600` file it replaced.

Grant Full Disk Access to the `node` binary named in the plist - not to your
terminal - and approve the Messages and Contacts automation prompts the first
time each is used.

Configuration is environment-only. There is no config file and no settings
endpoint, because every value here changes the blast radius of sending and so
should change where the operator can see it, not from across a socket.

| Variable                                | Default                | Purpose                                     |
| --------------------------------------- | ---------------------- | ------------------------------------------- |
| `IMESSAGE_BRIDGE_TOKEN`                 | *(generated)*          | Bearer token; overrides the token file      |
| `IMESSAGE_BRIDGE_TOKEN_FILE`            | `~/.calendar-agent/imessage-bridge/token` | Where the token is read from and generated into |
| `IMESSAGE_BRIDGE_HOST` / `_PORT`        | `127.0.0.1` / `4320`   | Bind address                                |
| `IMESSAGE_BRIDGE_SEND`                  | `false`                | Master switch for real sending              |
| `IMESSAGE_BRIDGE_REGION`                | `US`                   | Default region for bare phone numbers       |
| `IMESSAGE_BRIDGE_PER_RECIPIENT_DAILY`   | `3`                    | Per-person daily cap                        |
| `IMESSAGE_BRIDGE_GLOBAL_DAILY`          | `20`                   | Total daily cap                             |
| `IMESSAGE_BRIDGE_AUDIT_LOG`             | `~/.calendar-agent/imessage-bridge/audit.jsonl` | Append-only send log |
| `IMESSAGE_BRIDGE_AUDIT_TEXT`            | `false`                | Whether the audit log records message text  |
| `IMESSAGE_BRIDGE_CONTACTS_TTL_SECONDS`  | `900`                  | Contacts cache lifetime                     |
| `IMESSAGE_BRIDGE_CONTACTS_TIMEOUT_MS`   | `90000`                | Full address-book dump; AppleScript is slow |
| `IMESSAGE_BRIDGE_CONTACTS_PROBE_TIMEOUT_MS` | `10000`            | Liveness probe used by `/health`            |
| `IMESSAGE_BRIDGE_IMSG_PATH`             | `imsg`                 | Path to the binary                          |

The audit log is load-bearing rather than decorative: it is replayed at start-up,
so idempotency keys and both daily caps survive a restart. A send that cannot be
written to it fails rather than becoming an unaudited send.

## 10. Deliberately not here

- **Group chats.** One handle per thread in v1. Group follow-ups need a
  different identity model and a much more careful send path.
- **Attachments, reactions, typing indicators.** No follow-up needs them.
- **Message search.** The LLM path reads a bounded recent window of one thread.
- **Any storage of message bodies.** The bridge holds a contacts cache and an
  audit log. Nothing else touches disk.
- **Multi-user.** Single Mac, single Apple ID, by construction.
