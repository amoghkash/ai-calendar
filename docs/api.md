# HTTP API

The server exposes the same application services the CLI uses. All timestamps
are epoch milliseconds; all request and response bodies are JSON.

Base URL: `http://localhost:4319/api`

## Bootstrap

| Method | Path      | Description                                                                         |
| ------ | --------- | ----------------------------------------------------------------------------------- |
| `GET`  | `/health` | liveness, version and timezone                                                      |
| `GET`  | `/state`  | everything the UI needs: user, tasks, events, blocks, risks, preferences, calendars |
| `GET`  | `/doctor` | diagnostics, same as `calendar-agent doctor`                                        |

## Tasks

| Method   | Path                  | Description                                      |
| -------- | --------------------- | ------------------------------------------------ |
| `GET`    | `/tasks?all=true`     | list tasks                                       |
| `POST`   | `/tasks`              | create (`title` and `estimatedMinutes` required) |
| `PATCH`  | `/tasks/:id`          | update                                           |
| `POST`   | `/tasks/:id/complete` | mark complete                                    |
| `DELETE` | `/tasks/:id`          | delete the task and its blocks                   |

`preferredWindows` (`[{ start, end }]`, each a `"12:00"` string or
`{ hour, minute }`) and `preferredDays` (`["monday", ...]`) tell the scheduler
where to put the task's blocks. They are a **hard filter that relaxes itself**:
if nothing fits inside them the pass runs again without them, so the task
floats rather than failing. Both are validated - a window that ends before it
starts and an unknown weekday are each a `400` - because they feed the
placement filter directly. Send `[]` to clear either one.

## Scheduling

| Method | Path                          | Description                                                                                                               |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/schedule/plan`              | simulate. Body: `{ taskIds?, days?, rebuild? }`. Returns the plan, the change set and `dryRun: true`. **Writes nothing.** |
| `POST` | `/schedule/apply`             | apply a stored proposal. Body: `{ changeSetId, mutationIds? }`                                                            |
| `POST` | `/schedule/reject`            | discard a proposal                                                                                                        |
| `GET`  | `/risks`                      | deadline risk for every open task                                                                                         |
| `GET`  | `/agenda?start&end`           | events and task blocks in a range                                                                                         |
| `GET`  | `/events?start&end`           | calendar events only                                                                                                      |
| `GET`  | `/free?minutes=120&start&end` | free windows of at least `minutes`                                                                                        |

## Direct editing

The scheduler proposes; these endpoints let the user act directly. They apply
immediately (no change set) because they represent an explicit human decision -
but they still refuse in `read_only` mode and on read-only calendars.

| Method   | Path                      | Description                                                                                                                           |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH`  | `/blocks/:id`             | move a task block. `{ start, end, pin? }`. Pins the block by default and patches the calendar event.                                  |
| `POST`   | `/blocks/:id/pin`         | `{ pinned }` - unpinning hands the block back to the scheduler                                                                        |
| `DELETE` | `/blocks/:id`             | unschedule: removes the block and its event. The task keeps its remaining work.                                                       |
| `POST`   | `/events`                 | create an event. `{ calendarId, title, start, end, description?, location?, attendees?, transparency?, isAllDay?, notifyAttendees? }` |
| `PATCH`  | `/events/:id`             | edit an event. Only the supplied fields change.                                                                                       |
| `DELETE` | `/events/:id?notify=true` | delete an event                                                                                                                       |

Recurring **series masters** are refused on both edit and delete: only single
occurrences may be changed. Attendees are not emailed unless
`notifyAttendees: true` is passed.

`transparency` is `busy` or `free` on the wire (`opaque`/`transparent` in the
domain). `attendees` is `[{ email, name?, optional?, response? }]` and is the
**complete guest list, not a delta**: providers replace the list wholesale, so
whoever is missing from it is uninvited, and `[]` clears the guests. Omit the
field entirely to leave the guests untouched. A guest's `response` is theirs to
set - it is only ever echoed back so an edit does not reset everyone's RSVP. An
address that is not an email is a `400` and writes nothing.

## Agent

| Method | Path             | Description                                                               |
| ------ | ---------------- | ------------------------------------------------------------------------- |
| `POST` | `/agent/message` | `{ text, conversationId? }` → reply, parsed commands, plan and change set |

## Calendars

| Method   | Path             | Description                                            |
| -------- | ---------------- | ------------------------------------------------------ |
| `GET`    | `/calendars`     | accounts, calendars and available providers            |
| `PATCH`  | `/calendars/:id` | `{ selected?, isTaskTarget?, includeInAvailability? }` |
| `DELETE` | `/accounts/:id`  | disconnect an account                                  |
| `POST`   | `/sync`          | `{ full? }` → sync report with external changes        |

## Categories

| Method   | Path              | Description                                                |
| -------- | ----------------- | ---------------------------------------------------------- |
| `GET`    | `/categories`     | categories with how many tasks and events each covers      |
| `POST`   | `/categories`     | `{ name, color?, matchPattern?, calendarId?, isDefault? }` |
| `PATCH`  | `/categories/:id` | rename, recolour, change the match rule                    |
| `DELETE` | `/categories/:id` | delete and unassign everything using it                    |

## Data management

Everything destructive **simulates by default**: `dryRun` must be explicitly
`false`, and `reset` additionally requires `confirm: true`.

| Method   | Path                 | Description                                                                  |
| -------- | -------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/maintenance/stats` | row counts plus stale-data indicators                                        |
| `POST`   | `/maintenance/prune` | `{ before?, dryRun?, includeConversations? }` - drop old history and orphans |
| `POST`   | `/maintenance/reset` | `{ scopes, confirm, dryRun }` - delete whole categories of data              |
| `DELETE` | `/calendars/:id`     | remove a calendar, its events and its sync cursors                           |
| `DELETE` | `/accounts/:id`      | disconnect an account and clean up everything it brought                     |

Scopes: `events`, `blocks`, `tasks`, `categories`, `calendars`, `accounts`,
`conversations`, `changeSets`, `preferences`, `settings`.

## Preferences and settings

| Method | Path           | Description                                                       |
| ------ | -------------- | ----------------------------------------------------------------- |
| `GET`  | `/preferences` | the resolved scheduling policy                                    |
| `PUT`  | `/preferences` | validated partial update; unknown fields are dropped              |
| `GET`  | `/settings`    | runtime settings, the provider catalogue, and what is running now |
| `PUT`  | `/settings`    | validated partial update of `llm` and `logLevel`                  |

`PUT /preferences` accepts any subset of `timezone`, `workingHours`,
`sleepHours`, `recurringBlocks`, `deepWork`, `minimumBlockMinutes`,
`maximumBlockMinutes`, `allowTaskSplitting`, `bufferBetweenBlocksMinutes`,
`maxDailyTaskMinutes`, `protectExistingEvents`, `allDayEventsBlockTime`,
`granularityMinutes`, `planningHorizonDays`, `placementStrategy`, `automation`
and `classificationRules`. Time windows may be given as `"09:00"` or as
`{ "hour": 9, "minute": 0 }`. An invalid value is a `400` and writes nothing.

`PUT /settings` changes the model without a restart. It **rejects any request
containing an API key**: credentials are read from the server environment only,
and `GET /settings` reports whether one is present, never its value.

```jsonc
// PUT /settings
{ "llm": { "provider": "anthropic", "model": "claude-sonnet-5" }, "logLevel": "info" }
```

## OAuth

| Method | Path                        | Description                                                        |
| ------ | --------------------------- | ------------------------------------------------------------------ |
| `GET`  | `/oauth/:provider/start`    | redirect to the provider (add `?json=true` to get the URL instead) |
| `GET`  | `/oauth/:provider/callback` | exchange the code, store tokens, import calendars                  |

## Errors

Errors are structured and carry a stable code:

```json
{
  "error": {
    "name": "ValidationError",
    "code": "VALIDATION_ERROR",
    "message": "A task needs a positive estimated duration.",
    "details": {},
    "retryable": false
  }
}
```

| Code                                        | Status |
| ------------------------------------------- | ------ |
| `VALIDATION_ERROR`                          | 400    |
| `AUTH_ERROR`                                | 401    |
| `PERMISSION_DENIED`                         | 403    |
| `NOT_FOUND`                                 | 404    |
| `CONFLICT`                                  | 409    |
| `SCHEDULING_ERROR`                          | 422    |
| `RATE_LIMITED`                              | 429    |
| `UNSUPPORTED`                               | 501    |
| `PROVIDER_ERROR`, `SYNC_ERROR`, `LLM_ERROR` | 502    |
