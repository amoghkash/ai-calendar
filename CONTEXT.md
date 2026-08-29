# Context

Orientation for someone (or something) picking this repo up cold. It covers how
to run it, how to verify a change, the invariants that must not break, and the
traps that are not visible from the code. It does **not** re-explain the
architecture — that is [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. What this is

An open-source, local-first AI scheduling assistant. It reads your calendars,
understands tasks and deadlines, finds time for work, flags deadlines at risk,
and reschedules when the calendar changes.

The whole design hangs off one rule:

> **The scheduling engine is deterministic. The LLM is optional.**

Every scheduling decision is made by a pure, testable module in
`packages/core/src/scheduling/` with no model in the loop. An LLM, if configured,
only turns natural language into typed commands and structured explanations into
prose. Turning the model off must never break scheduling.

### Doc map

| Read this                                      | For                                             |
| ---------------------------------------------- | ----------------------------------------------- |
| [README.md](README.md)                         | product tour, setup, provider/LLM configuration |
| [ARCHITECTURE.md](ARCHITECTURE.md)             | layers, ports/adapters, safety model, decisions |
| [CONTRIBUTING.md](CONTRIBUTING.md)             | the rules that matter, where things live        |
| [docs/scheduling.md](docs/scheduling.md)       | how the engine actually places blocks           |
| [docs/configuration.md](docs/configuration.md) | config precedence, runtime settings             |
| [docs/api.md](docs/api.md)                     | the HTTP surface                                |
| [docs/imessage-bridge.md](docs/imessage-bridge.md) | the iMessage/Contacts bridge design         |
| [DESIGN.md](DESIGN.md)                         | the design system the web UI implements         |
| [ROADMAP.md](ROADMAP.md)                       | what is deliberately not built yet              |

## 2. Run it

Requires Node >= 20.11.

```bash
npm install
npm run build && npm start
```

API + built UI on <http://localhost:4319>. `npm start` runs
`apps/server/dist/bin.js`, and the server serves `apps/web/dist` statically with
an SPA fallback — so **a stale `npm run build` means a stale UI**.

For UI work, run both with hot reload:

```bash
npm run dev
```

That builds, then runs the API on 4319 and Vite on 5173 (which proxies `/api`).

**If `npm start` dies with `EADDRINUSE: 127.0.0.1:4319`,** an older server is
still holding the port. Find and stop it:

```bash
lsof -nP -iTCP:4319 -sTCP:LISTEN
```

## 3. Verify a change

This is the gate. Run all four before claiming anything works:

```bash
npm run typecheck && npx eslint . && npm test && npm run build
```

- `npm test` — the suite must stay green. Vitest resolves workspace packages
  straight to `src/`, so tests never depend on a build.
- `npm run typecheck` covers packages, the test project, and the web app
  separately. The web app is the only one `tsc -b` does not reach.
- **There are no web UI tests.** The vitest include pattern would pick up
  `apps/web/src/**/*.test.ts` if any existed. For UI changes, verification means
  typecheck + build + actually looking at it in a browser.
- `npm run test:postgres` runs the database suite against a real PostgreSQL.
  See [CONTRIBUTING.md](CONTRIBUTING.md#testing-against-postgresql).

`.claude/launch.json` defines a `web` dev-server entry so an agent with browser
tooling can start Vite and drive the UI directly.

## 4. This checkout's local state

Things true of this machine that are not true of a fresh clone:

- **`.env` sets `DATABASE_URL`**, so this checkout runs on **PostgreSQL**, not
  the JSON-file default. `.data/calendar-agent.json` exists but is not what the
  server reads. Migrations run automatically on start.
- **Real Google calendars are connected** with live OAuth tokens. Anything that
  writes an event — `POST /api/events`, approving a change set — writes to the
  owner's actual calendar. Treat writes as consequential.
  - `POST /api/schedule/plan` is safe: it simulates and persists a _pending_
    change set only. Nothing reaches a calendar until `/schedule/apply`.
  - Automation mode is `suggest`, so nothing auto-applies.
- Seeding demo tasks for a screenshot is fine; delete them afterwards. Do not
  create calendar events as test data.

## 5. Invariants

Break these and the product stops being what it claims to be.

1. **Scheduling never depends on an LLM.** If a model is unreachable,
   misconfigured, or off, scheduling and risk still work and the assistant
   degrades to the deterministic parser.
2. **`packages/core` imports nothing from the workspace.** No React, Express,
   `pg`, provider SDKs, or other `@calendar-agent/*` packages. This is enforced
   by a `no-restricted-imports` rule in `eslint.config.js` — if lint complains
   about a core import, the fix is to move the code, not to relax the rule.
3. **`plan()` is side-effect free.** Simulation-first falls out of the design;
   it is not a flag.
4. **Calendar mutations go through a change set** (`packages/core/src/planning/`)
   and obey the automation policy. Unrecognised events are `UNKNOWN` and never
   moved.
5. **Credentials never cross the HTTP API.** `PUT /api/settings` rejects any
   request carrying an `apiKey`. Keys are read from the server environment only;
   the UI reports whether one is present, never its value.
6. **Every repository is keyed by `userId`.** Single-user today, but the seam is
   the point.

## 6. Configuration and settings

Three sources seed the **first** run, in increasing precedence: built-in
defaults → `calendar-agent.yaml` → environment (`.env`). After that, **the
database is the source of truth** for anything the settings panel can edit, so a
change made in the UI is not reverted by the file on restart.

Two stores, both per user, both effective immediately:

| Store                    | Endpoint                     | Covers                                                                                                                        |
| ------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scheduling_preferences` | `GET`/`PUT /api/preferences` | timezone, working hours, sleep, recurring blocks, deep work, block sizing, placement, automation policy, classification rules |
| `app_settings`           | `GET`/`PUT /api/settings`    | LLM provider/model/temperature/max tokens/base URL, log level                                                                 |

Still YAML-only (bootstrap-time or rarely tuned): `database`, `server`, OAuth
client config, `weights`, `risk`, `stability`, `blocked_periods`.

Both write paths validate and drop unknown keys —
`packages/app/src/services/preferences-input.ts` and `parseSettingsPatch` in
`settings-service.ts`. An invalid value is a `400` that writes nothing. Add
validation there when you add a field, or the settings form becomes a way to
persist a corrupt scheduler config.

### Changing the model at runtime

`AppContext.llm` is built once at start-up, so services capture the reference.
To let a stored setting take effect without a restart:

- `ReconfigurableLLMProvider` (`packages/agent/src/llm/reconfigurable.ts`) keeps
  a stable object whose `name`/`model` are **getters** over a swappable
  delegate. `name === 'none'` stays an honest test of "is an LLM enabled".
- `AdaptiveCommandParser` (`packages/agent/src/parser/adaptive-parser.ts`) picks
  heuristic-vs-LLM **per request**, and absorbs LLM failures by falling back to
  the heuristic (logged as `agent.llm_unavailable`). That is what keeps
  invariant #1 true when someone selects a provider before adding its key.
- An injected LLM (tests) is left unwrapped; `SettingsService` skips re-wiring.

## 7. The web UI

`apps/web` is React 18 + Vite, no UI framework, no CSS library.

- **[DESIGN.md](DESIGN.md) is the spec.** White canvas, near-black primary CTAs,
  Inter standing in for Cal Sans on display type (600 weight, negative
  tracking), 8px buttons/inputs, 12px cards, 16px modals, pill nav groups.
- **All design tokens are CSS custom properties at the top of
  `apps/web/src/styles.css`.** Use `var(--…)`; never inline a hex.
- The spec is a _marketing-site_ system. Hero bands, pricing tiers and
  testimonials have no product equivalent and are not implemented — the token
  system, type ramp, shape scale and shared components are.
- The dark surface (`--surface-dark`) appears exactly once: the footer status
  strip. Keep it scarce.
- **On the grid, shading means _unavailable_.** The day column floor is
  `--surface-soft` and working hours are carved back out of it in canvas white,
  so free time reads as open space. This inverts the dark theme's logic, where
  the available band was the one that got painted - do not port that back.
- Hover styling is deliberately minimal (background shift to `--surface-soft`).
  The spec says not to document hover; an interactive grid still needs feedback.

Component map:

| File                           | Role                                             |
| ------------------------------ | ------------------------------------------------ |
| `App.tsx`                      | shell: top nav, rails, footer, dialog hosting    |
| `components/CalendarView.tsx`  | day/week grid, drag-to-move, click-to-create     |
| `components/TaskPanel.tsx`     | open/done lists + create-and-edit form           |
| `components/ProposalPanel.tsx` | change-set diff, quality meters, approve/discard |
| `components/ChatPanel.tsx`     | assistant bubbles                                |

| `components/CalendarSettings.tsx` | show / busy / tasks per calendar |
| `components/EntryEditor.tsx` | one modal for new event, event, task block |
| `components/SettingsDialog.tsx` | the settings panel (six sections) |
| `components/Icon.tsx` | the line-icon set |
| `event.ts` | reading guests, RSVPs and the join link off an event |
| `time.ts` | formatting; all timestamps are epoch ms |

## 8. Landmines

Things that cost time if you learn them the hard way.

- **A wrong parameter count in `postgres-database.ts` is invisible locally.**
  The memory and JSON drivers ignore the SQL entirely, so an insert whose column
  list, `$n` placeholders and values array disagree passes the default test run
  and fails only against a real database (`bind message supplies N parameters,
but prepared statement requires M`). `postgres/statements.test.ts` audits all
  three counts statically and runs in the normal suite; when you add a column,
  add it in all three places.
- **PostgreSQL migrations are tracked by id.** `MIGRATIONS` in
  `packages/database/src/postgres/schema.sql.ts` is an array of `{id, sql}` and
  applied ids are recorded. Editing `0001_initial` does nothing to an existing
  database — add a **new** entry.
- **Adding one repository touches six places:** the port in
  `packages/core/src/ports/repositories.ts` (interface + the `Database` bundle),
  `memory/collections.ts` (snapshot field _and_ `emptySnapshot()`),
  `memory/memory-database.ts`, `postgres/postgres-database.ts`, a new migration,
  and the hand-built `Database` wrapper in
  `packages/app/src/referential-integrity.test.ts`. The JSON driver inherits
  from the memory one and merges old files against `emptySnapshot()`, so
  back-compat is free — but only if you add the field in both spots.
- **TS config is strict in ways that bite:** `verbatimModuleSyntax` (use
  `import type`), `noUncheckedIndexedAccess` (indexing yields `T | undefined`),
  `noUnusedLocals`/`noUnusedParameters`, and `composite` project references
  (`tsc -b`, not plain `tsc`). The codebase style uses conditional spreads
  (`...(x === undefined ? {} : { x })`) for optional properties — match it.
- **CSS that references a dead token fails silently.** The old dark theme's
  variables (`--panel-2`, `--line`, `--text`, `--danger`, `--bg`) no longer
  exist. `background: var(--panel-2)` is not an error - it just renders
  unstyled, so a panel written against the old names looks broken rather than
  broken-looking. Grep for `var(--` against the `:root` block at the top of
  `styles.css` before trusting new styles, and never hard-code a hex.
- **Panel headers are `.panel-head`, not `<h2>`.** `.panel h2` is a plain
  16px title now; the flex header row with a spacer, count badge and action
  button is `.panel-head`. Putting a button inside the `h2` renders it in the
  display font at title size.
- **`.warn` and `.note` are flex rows expecting an icon plus one `<span>`.**
  A series of loose text fragments inside one becomes a row of flex items
  instead of a sentence.
- **The calendar grid's drag maths depend on constants that must match CSS.**
  `HOUR_HEIGHT` (52) and `GUTTER_WIDTH` (56) in `CalendarView.tsx` are paired
  with `.gutter { width: 56px }` in `styles.css`. Change one, change both.
- **The UI works in the user's _configured_ timezone, not the browser's.**
  `time.ts` converts both ways through the configured zone —
  `toLocalInputValue`/`fromLocalInputValue` exist because
  `<input type="datetime-local">` speaks browser-local time.
- **`assertValidTimezone` throws `TypeError`, not `ValidationError`.** Anything
  on an HTTP path must catch and rethrow, or an invalid timezone becomes a 500.
- **Errors reaching the API should be `ValidationError`** (or another
  `packages/core/src/errors.ts` type) so `asyncRoute` maps them to a proper
  status and code.

## 9. Recent work

Two sessions of changes beyond the original MVP, both fully tested and built.

### UI redesign against DESIGN.md

The interface was a dark, dense, 11–13px slate layout with lowercase
micro-buttons. It is now the light Cal.com-style system described in §7:
tokenised stylesheet, 64px top nav with date stepper and a nav-pill-group view
switcher, tabbed left rail (Tasks / Calendars), collapsible task form, risk
badges, quality meters, chat bubbles, a dark footer status strip, and a
responsive layout that scrolls as one document below 1100px.

Scheduling logic, drag maths and every API call were left untouched; only
`HOUR_HEIGHT` and `GUTTER_WIDTH` changed, in step with the CSS.

### Runtime settings panel

Gear icon in the top bar → `SettingsDialog.tsx`, six sections: General, Hours,
Scheduling, Automation, Model, Event rules. Backed by the two stores in §6.

What it required beyond the UI:

- new `AppSettings` domain type + `SettingsRepository` port + implementations +
  migration `0002_app_settings`;
- `SettingsService` (get / view / update / apply) and the live-rewiring pieces
  in §6;
- an LLM provider catalogue in `packages/config/src/llm-providers.ts`, which is
  now the single source of default models and credential env-var names;
- **validation on `PUT /api/preferences`**, which previously merged the raw
  request body straight into the object the scheduler reads on every run;
- `Logger.setLevel?()` so the log-level setting actually takes effect.

The Anthropic _default_ model moved from `claude-sonnet-4-5` to
`claude-sonnet-5`. It only applies when a provider is set with no model.

### Grid gestures

`CalendarView` runs one pointer gesture at a time, modelled as a `create` |
`move` | `resize` union. All three work in minutes-past-local-midnight rather
than pixels, so the maths survives a DST boundary, and all three snap to
`SNAP_MINUTES`.

- Empty space: drag to draw a range, or click for `DEFAULT_NEW_EVENT_MINUTES`.
  A live draft shows the range and turns amber when it overlaps something.
- Entries: drag the body to move, drag either edge to resize. Resizing clamps
  to a `SNAP_MINUTES` minimum rather than inverting.
- Both move and resize commit through `commitEntry`, so an event with other
  attendees always opens the editor instead of writing silently.
- Escape cancels an in-flight gesture; `pointercancel` clears it, which is what
  lets a touch drag scroll the grid instead of drawing an event.

### Rails that do not shift

The left rail is a `Tasks | Calendars` tab group whose shape never changes, and
the right rail always holds `ProposalPanel` - which renders an empty state
rather than unmounting, so an arriving proposal never shoves the layout around.
The rail tabs are sticky at the top and the proposal's Approve/Discard row is
sticky at the bottom, so the decision stays reachable however long the diff is.

### Hiding the side panels

Two toggles in the top nav hide either rail; the expand button next to them is
the one-click "both". App holds `hidden: {left, right}` and puts `hide-left` /
`hide-right` on `.app`, alongside `--rail-left` / `--rail-right`, so the
variants can drop a column from the grid rather than zero it.

Hidden columns are removed from `grid-template-columns` rather than zeroed, so
the grid gap goes with them. It is component state, not a stored setting - a
moment, not a preference.

Escape leaves it, but **only when nothing nearer the front is listening**. The
editor, settings dialog and assistant all dismiss on Escape, so App holds
`assistantOpen` (lifted out of `AssistantDock` for exactly this) and the handler
returns early while any of them is open.

### Reply composition

`AgentService.execute` collects one line per command, then appends the re-plan.
Two rules keep that readable:

- `renderProposal` returns `undefined` when the re-plan has no news, so a turn
  that already said something ("Updated ...") ends there instead of trailing a
  "no changes are needed" block;
- if that leaves the reply empty, the no-op _is_ the answer and gets one plain
  sentence. A turn must never answer with nothing.

The reply is surface-neutral: the `+/~/-/!` lines and the change-set summary are
shared, while "Approve with: calendar-agent approve ..." lives in the CLI, since
the web has buttons. The CLI's own `schedule` report (`apps/cli/src/format.ts`)
still prints a `PROPOSED CHANGES` heading - that is a report, not a reply.

### Agent calendar edits

`update_event` resolves an `eventRef` (id, or a title fragment matched against
now -7d/+60d) and then applies `evaluateEventMove` from
`core/src/planning/change-set.ts`:

- a `never` policy refuses and explains - which covers read-only mode, protected
  events, and the `FIXED` classification an event with other attendees gets;
- `ask` and `auto` both apply, because an explicit instruction naming the event
  _is_ the confirmation. The policy exists to gate moves the agent decides on
  its own, not ones the user dictated;
- the gate only applies when `start`/`end` change. Renaming or relocating is not
  a scheduling decision;
- `notifyAttendees` is always `false`. Telling other people is the user's call,
  and the reply says so when the event has any.

Ambiguous refs raise rather than guess - picking the wrong meeting to move is
expensive, which is the same reason unmatched events classify as `UNKNOWN`.

### Conversation threading

A turn only has memory if **both** ends cooperate, and both were broken until
2026-08-25:

- the client must pass the `conversationId` it got back (`App` holds it in
  state) - without it every turn opens a fresh conversation row;
- `AgentService.handle` must read the thread back and pass it as
  `ParseRequest.history`, which it does _before_ recording the incoming turn so
  the parser does not see the message it is being asked to interpret.

History only helps the LLM parser; `HeuristicCommandParser` matches single
utterances and ignores it, so follow-ups do not resolve when `llm.provider` is
`none`.

### The assistant is docked, not railed

Scheduling never needs the LLM, so the chat is not given permanent screen space.
`AssistantDock` is a fixed bottom-right launcher ("Talk to your assistant") that
opens a floating panel reusing `ChatPanel` whole. It sits over the right rail's
corner, so `.rail-right` takes a `margin-bottom` - margin and not padding,
because padding leaves the scrollport extending under the launcher and a strip
of scrolling content shows below the sticky Approve/Discard row - `ChatPanel` takes an optional
`onClose` purely so the dock can render a close button in its header. The
launcher carries an unread count, which matters because `sync()` can append an
assistant message while the dock is shut.

### Motion

Transitions are short (200-240ms) and exist to stop batches of state landing at
once, not to decorate:

- `.entry` and `.diff li` animate in with a capped per-index stagger, so
  approving a plan lands its blocks in sequence instead of all at once. The
  keyframes use `animation-fill-mode: backwards` so a delayed item stays hidden
  through its delay rather than flashing first.
- `.entry` transitions `top`/`height`, but only via
  `.calendar-body:not(.gesturing)` - during a drag the pointer drives the
  geometry and a transition would just add lag. The create draft opts out of
  both for the same reason.
- The chat shows a `thinking` bubble driven by App's `thinking` flag, which is
  deliberately separate from `busy` (true for _any_ mutation) so only a chat
  turn in flight shows the indicator.
- Every one of these is disabled under `prefers-reduced-motion`; keep that list
  in sync when adding another.

### Event detail

An event carried far more than the UI showed: guests, RSVPs, the organiser, a
description and a conferencing link were all stored and none of them were
visible. `EntryEditor` now edits location, description, busy/free and the guest
list, and shows the facts it does not edit (calendar, organiser, join link) in a
strip above the form. The grid puts the location and guest count on entries tall
enough for a third line, and the rest in the hover title.

The guest list is the part with teeth:

- **`attendees` is the whole list, not a delta.** Google and Graph both replace
  the collection, so an omitted guest is an uninvited one and `[]` clears the
  list. `CalendarEventUpdate.attendees` is therefore optional in the "leave it
  alone" sense - `undefined` never reaches the provider body.
- **An RSVP is echoed back, never authored.** `fromAttendee` sends each guest's
  existing `responseStatus`; without that, adding one guest would reset
  everyone else to "no response".
- The editor only sends `attendees` when the list actually changed
  (`guestKey`), so a rename or a drag cannot disturb the guests.
- `notifyAttendees` still defaults to false everywhere. Telling other people is
  the user's call, and the checkbox only appears when there is someone to tell.

`conferenceData` stays `unknown` through the domain - it is provider-shaped and
nothing below the UI reads it. `meetingUrl` in `apps/web/src/event.ts` unpicks
Google's `entryPoints` and Graph's `joinUrl` defensively, as a display concern.

**On the grid, every entry now has `cursor: pointer`,** not just the draggable
ones: a read-only event still opens its editor on click. `grabbing` is kept for
the drag that is actually in flight (`.calendar-body.gesturing`).

### Floating tasks, and rule conditions

Two capabilities that the engine already had and nothing could reach.

**`Task.preferredWindows` / `preferredDays`** are read by the placement filter
(`constrainWindows` in `greedy-scheduler.ts`) and scored by `quality.ts`, but
`POST /api/tasks` dropped them and the task form had no control. Both are now
on the HTTP surface and in the create form as a time range plus weekday
toggles. The semantics are the useful part and worth not breaking: preferences
are applied as a **hard filter, then the whole pass is retried without them**
when nothing fits (`hasPreferences && candidates.length === 0` → `relaxed`), so
a task with a window floats inside it and moves out only under pressure - "at
this time of day, unless it has to move".

They are parsed rather than merged: `PATCH /tasks/:id` spreads the request body
straight into `TaskService.update`, so an unvalidated window would reach the
scheduler as whatever JSON was posted. `dailyWindowList` and `weekdayList` in
`preferences-input.ts` are the same guard `PUT /preferences` already had, for
the same reason.

**Classification-rule conditions.** `EventClassificationRule` supports
`hasOtherAttendees`, `isAllDay` and `createdByAgent`, `classifyEvent` honours
them and `PUT /preferences` validated them - but the Event rules panel only
rendered id, classification and title pattern, so they were YAML-or-curl only.
Guests and length are now selects in the panel. A condition is **three-state**:
unset means "do not care", which is why `triState`/`fromTriState` speak strings
rather than a checkbox.

This matters because **user rules beat the built-in heuristics**, including the
"has other attendees → FIXED" one. Two ordered rules therefore express
something the heuristics cannot:

```yaml
- { id: lunch-with-someone, classification: FIXED, title_pattern: lunch, has_other_attendees: true }
- { id: lunch-solo, classification: MOVABLE, title_pattern: lunch, has_other_attendees: false }
```

First match wins, so the narrower rule has to come first. `classification.test.ts`
pins this pair.

One thing the names invite you to get wrong: **`MOVABLE` does not make the
scheduler move an event.** `plan()` only ever moves its own task blocks;
`MOVABLE` is read by `evaluateEventMove`, which decides whether a move someone
_asked for_ is permitted. A calendar event never floats on its own - only a
task block does.

### Moving a task block through the agent pins it

An event that mirrors a scheduled task block has two halves, and
`AgentService`'s `update_event` only ever patched one. Moving the calendar copy
left the `ScheduleBlock` where it was and unpinned, so the next `plan()` moved
the event straight back - the instruction silently undid itself.

Timing changes on a block-backed event (`event.blockId !== undefined`) now go
through `SchedulingService.moveBlock`, which updates the block, patches the
provider event and **pins** the block. Pinning is the point: an instruction that
names a time is a decision, not a suggestion, so a re-plan has to leave it
alone. Title, location and description still go through `calendars.updateEvent`,
and when there are none the second provider write is skipped entirely.

### The buffer covers meetings, not just blocks

`bufferBetweenBlocksMinutes` was only ever applied in `AvailabilityLedger.reserve`,
which runs when the scheduler places one of its **own** blocks - and only on the
trailing edge. Nothing padded the calendar events availability is carved out of,
so with a 30-minute buffer set, work still started the second a meeting ended
and ran right up to the second the next one began. On a calendar made mostly of
meetings that is every block, which made the setting look inert.

`computeAvailability` now subtracts a **padded** copy of the busy set, and
`reserve` pads **both** sides (a later block can be placed before an earlier one
under `best_fit`). Two things are deliberate:

- **`busyIntervals` is still returned unpadded.** It answers "is this time
  taken", which is what `partitionBlocks` uses to decide whether an existing
  block is still valid. Padding it would release blocks that merely sit inside
  the buffer rather than colliding with anything.
- **Sleep, recurring blocks and blocked periods are not padded.** They are time
  the user declared unavailable, not commitments to recover from.

The buffer genuinely reduces capacity, so a dense calendar plus a large buffer
will surface more at-risk deadlines. That is the honest reading, not a
regression.

### `update_task` dropped the fields that decide when work lands

`taskFields` in the agent command schema has always carried `preferredWindows`
and `preferredDays`, and `create_task` passed them through. `update_task` did
not - nor `minimumBlockMinutes`, `maximumBlockMinutes` or `allowSplitting`. The
command validated, the handler dropped them, and the agent answered `Updated
"..."` having changed nothing. "Move my reading to tomorrow afternoon" was
therefore a silent no-op. All five now reach `TaskService.update`.

### Week layout

`AppSettings.weekStart` is `rolling` (today leftmost) or `sunday` (calendar
week), surfaced on `/api/state` so the grid can read it without a second fetch.
It applies **only** to the 7-day view; day and 3-day always roll from the
anchor. `startOfWeek` in `time.ts` steps back from local noon rather than from
the instant, so a DST change cannot land it on the wrong calendar day. Adding a
Monday start is a one-line change to the `WeekStart` union plus an option.

### Two daily caps, deliberately separate

`SchedulingPreferences.maxDailyTaskMinutes` caps **all** task work on a day.
`Task.maxDailyMinutes` caps **one task's** share of it, so eight hours of
revision can be paced across a fortnight. The placement loop takes whichever
budget bites first.

Three things make it behave:

- `AvailabilityLedger` tracks per-task day usage alongside the shared total.
  Retained blocks are seeded into the per-task map through
  `recordTaskDayUsage`, which does **not** touch `dayUsage` - a replan would
  otherwise top a capped task back up on a day it had already filled. The
  global cap's existing blind spot to retained blocks is left as it was;
  folding them in would quietly tighten a separate, long-standing budget.
- `capacityForTask` clamps each day's contribution to the cap, so risk sees the
  real ceiling. Without it a task capped at 2h/day against eight free hours
  would be reported on track when it cannot possibly land.
- `TaskService` rejects a cap below the task's minimum block, which would
  otherwise be an unschedulable task whose only explanation is "nothing fitted".

### Clearing an optional task field

`TaskService.update` merges through `stripUndefined`, so an absent key means
"unchanged". That left no way to *remove* a deadline: `PATCH {deadline: null}`
was flattened to `undefined` and silently dropped, and the field survived. An
explicit `null` now clears any field in `CLEARABLE_TASK_FIELDS`; the route
passes the null through rather than converting it.

## 10. Open threads

- No web UI tests exist. Any UI regression is caught by eye, not by CI.
- The grid drops already-happened events after any task mutation: `refresh()`
  overwrites `state.events` with `/state`'s forward-only horizon, and the wider
  `api.agenda` fetch in `App.tsx` only re-runs when the visible window changes.
- `weights`, `risk`, `stability` and `blocked_periods` are configurable in YAML
  but absent from the settings panel — a deliberate scope call, not an oversight.
- Adding an API key still requires editing `.env` and restarting the server.
  The panel reports presence and names the variable, but cannot set it.
- The agent cannot **delete** a calendar event; `update_event` covers moving,
  resizing, renaming and relocating, but removing a commitment is still manual.
- [ROADMAP.md](ROADMAP.md) has the product-level list.
