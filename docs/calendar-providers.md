# Calendar providers

Every calendar integration implements one interface. Nothing above it knows
which service an event came from.

```ts
interface CalendarProvider {
  readonly id: CalendarProviderId;
  readonly capabilities: CalendarProviderCapabilities;

  authenticate(): Promise<ProviderAccount>;
  getCalendars(): Promise<readonly ProviderCalendar[]>;
  getEvents(options: FetchEventsOptions): Promise<FetchEventsResult>;
  createEvent(input: CalendarEventInput): Promise<NormalizedEvent>;
  updateEvent(ref: EventRef, changes: CalendarEventUpdate): Promise<NormalizedEvent>;
  deleteEvent(ref: EventRef): Promise<void>;
}
```

## Contract

**Normalisation.** `getEvents` returns `NormalizedEvent`, never a provider
payload. Timestamps are `Instant` (epoch ms); the authoring timezone is kept
separately for round-tripping and display.

**Partial updates.** `updateEvent` must only send the fields present in
`changes`. Moving an event must preserve its title, description, attendees,
location, recurrence and conferencing data. Google uses `PATCH`; Graph uses a
partial `PATCH` body.

**Concurrency.** Pass the last known etag through `EventRef.etag`; providers
reject stale writes (`412`), which the HTTP layer surfaces as a clear error
rather than a silent overwrite.

**Private metadata.** The agent tags its own events so it can recognise them on
the way back:

| Key                    | Meaning                               |
| ---------------------- | ------------------------------------- |
| `calendarAgentManaged` | `"true"` for events the agent created |
| `calendarAgentTaskId`  | the task the block belongs to         |
| `calendarAgentBlockId` | the schedule block                    |

Google stores these in `extendedProperties.private`; Graph uses named
`singleValueExtendedProperties` in a dedicated GUID namespace.

**Recurrence.** Providers report `recurrenceKind` as `single`, `series_master`
or `instance`, plus `seriesExternalId`. The system deliberately only modifies
individual instances; entire series are never rewritten automatically.

**Deletions.** Cancelled or removed events are returned in
`deletedExternalIds` rather than being silently omitted.

**Incremental sync.** Providers that support it return a `nextSyncToken`; the
sync layer stores it and passes it back. If the provider invalidates it (Google
returns `410`), the provider sets `resyncRequired` and the sync layer falls back
to a full window fetch transparently.

## Implementations

| Provider          | Package                              | Notes                                                                                                |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Google Calendar   | `packages/integrations/src/google/`  | Calendar API v3 over `fetch`; `singleEvents=true`; `sendUpdates=none`.                               |
| Microsoft Outlook | `packages/integrations/src/outlook/` | Graph v1.0 `calendarView/delta`; `Prefer: outlook.timezone="UTC"`.                                   |
| Mock              | `packages/integrations/src/mock/`    | Full in-memory implementation used by the tests and demo mode; also the reference for new providers. |

## Adding a provider

1. Create `packages/integrations/src/<name>/` with a `types.ts` (the wire
   format), a `mapper.ts` (pure conversion functions) and the provider class.
2. Keep the mapper pure and test it directly - that is where the bugs are.
3. Register the provider in `DefaultProviderRegistry.create()` and, if it uses
   OAuth2, add its endpoints via `OAuthClient` in `.oauth()`.
4. Add the credentials to `packages/config/src/schema.ts`.
5. Write tests with `FetchRecorder`, asserting both the request you send and the
   normalisation of the response.

Nothing in `packages/core` or `packages/app` needs to change.

## Event classification

Incoming events are classified before the scheduler sees them:

| Class       | Meaning                                  | Default policy             |
| ----------- | ---------------------------------------- | -------------------------- |
| `MOVABLE`   | a task block the agent created           | may be moved automatically |
| `PROTECTED` | a real-world commitment (doctor, travel) | never moved                |
| `FIXED`     | anything involving other people          | never moved                |
| `UNKNOWN`   | unrecognised                             | blocks time, never moved   |

User rules in `classification_rules` are applied first (title pattern, calendar,
attendees, all-day, created-by-agent). Otherwise the heuristics are deliberately
conservative: anything with other attendees is `FIXED`, and anything unmatched is
`UNKNOWN`.
