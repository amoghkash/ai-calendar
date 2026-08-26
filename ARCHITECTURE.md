# Architecture

This document describes how calendar-agent is put together, which boundaries are
load-bearing, and the decisions behind them.

## 1. The one rule

**Deterministic scheduling never depends on an LLM.**

`packages/core` contains the domain model and the scheduling engine. It is a
pure TypeScript package whose only runtime dependency is Luxon (for timezone and
DST arithmetic). It imports no framework, no database driver, no provider SDK
and no other workspace package. An eslint `no-restricted-imports` rule fails the
build if that changes.

Everything else is arranged so that this stays true.

## 2. Layers

```text
transport      apps/web, apps/cli, apps/server
application    packages/app          - services, orchestration, policy
domain         packages/core         - model, scheduling, planning, ports
adapters       packages/database, packages/integrations, packages/agent
configuration  packages/config
```

Dependencies point downwards only:

| Package        | May import                                            |
| -------------- | ----------------------------------------------------- |
| `core`         | nothing (except Luxon)                                |
| `imessage-contract` | nothing (except zod)                             |
| `config`       | `core`                                                |
| `database`     | `core`                                                |
| `integrations` | `core`, `imessage-contract`                           |
| `agent`        | `core`                                                |
| `app`          | `core`, `config`, `database`, `integrations`, `agent` |
| `apps/*`       | `app`, `core`, `config`                               |

`apps/imessage-bridge` is the exception that proves the rule: it imports only
`imessage-contract`, because it is a separate long-lived process with its own
lifecycle and its own macOS permission grants. See
[docs/imessage-bridge.md](./docs/imessage-bridge.md).

TypeScript project references encode this; `npm run typecheck` enforces it.

## 3. Ports and adapters

The domain defines the interfaces; the adapters implement them.

| Port                         | Implementations                                  |
| ---------------------------- | ------------------------------------------------ |
| `CalendarProvider`           | Google, Microsoft Graph, Mock                    |
| `Database` (10 repositories) | Memory, JSON file, PostgreSQL                    |
| `LLMProvider`                | Anthropic, OpenAI-compatible, Gemini, Mock, Null |
| `Clock`                      | System, Fixed                                    |
| `Logger`                     | Structured (JSON), Memory, Noop                  |
| `IdGenerator`                | Random (UUID), Sequential                        |
| `Scheduler`                  | `GreedyScheduler` (more can be added)            |
| `CommandParser`              | Heuristic (rules), LLM                           |

Every one of them is injectable through `createApp(config, overrides)`, which is
why the test suite can run the entire application - HTTP API included - with a
fixed clock, an in-memory database and a scripted calendar in milliseconds.

## 4. Time

Time handling is a first-class concern and is confined to two modules.

- `Instant` is epoch milliseconds - always UTC, never a naive string.
- Wall-clock rules ("Monday 09:00–17:00") live as `WeeklySchedule` plus an IANA
  timezone. `time/wall-clock.ts` is the _only_ place that converts between them.
- DST is therefore handled once: a spring-forward day is 23 hours, a fall-back
  day is 25, and 09:00 local stays 09:00 local on both sides of a transition.
- Non-existent local times (inside the spring-forward gap) shift forward;
  ambiguous times resolve to the first occurrence.

`tests/dst.test.ts` drives the full application across both US transitions, the
European transition on its different date, and a half-hour-offset zone.

## 5. The scheduling engine

`GreedyScheduler.plan(input) -> SchedulingPlan` is a pure function: identical
input always produces an identical plan, including the generated block ids
(derived from a stable hash of the input, never from randomness or the clock).

Its structure is deliberately boring, because a scheduler you cannot reason
about is a scheduler you cannot trust:

```text
availability   working hours − sleep − recurring blocks − blocked periods
               − busy events − already-committed blocks
scoring        deadlineUrgency, priority, importance, deadlineRisk, ageBonus
               each normalised to 0..1 and multiplied by a configurable weight
ordering       score desc, dependency-safe, deterministic tie-breaks
placement      earliest-fit (default) or best-fit, honouring min/max block,
               splitting rules, deadlines, preferred windows, daily caps
stability      existing blocks are kept unless they became invalid; a failed
               search restores what it released
risk           capacity before deadline vs remaining work
quality        seven metrics, weighted, each with its own explanation
diff           structured added / moved / removed / unchanged
trace          every step and every score component, ready to log or print
```

See [docs/scheduling.md](./docs/scheduling.md) for details and worked examples.

## 6. Safety model

Calendar mutations are consequential, so they are funnelled through one type:
`ChangeSet`, produced by `buildChangeSet()`.

- **read_only** - every mutation is blocked, with a reason.
- **suggest** (default) - mutations are produced but held as `pending` until the
  user approves them.
- **autonomous** - mutations whose class policy is `auto` are applied; the rest
  still wait. A change set larger than `max_auto_mutations` always waits.

On top of that:

- events are classified `MOVABLE` / `PROTECTED` / `FIXED` / `UNKNOWN`, and the
  move policy is per class - anything unrecognised defaults to _never move_;
- events starting inside the freeze window are never moved automatically;
- `plan()` never writes anything: simulation is the default, not a flag.

## 6b. Categories vs classification

Two things could be mistaken for each other, so they are kept apart:

- **`EventClassification`** (`MOVABLE` / `PROTECTED` / `FIXED` / `UNKNOWN`) is a
  _safety_ decision: what the scheduler is allowed to touch.
- **`Category`** ("Work", "Study") is _presentation_: a colour and a grouping.

Renaming or recolouring a category can never change what the agent may move.
Category membership is resolved lazily - explicit assignment, then calendar,
then title pattern, then the default - so editing a pattern recolours existing
items instead of requiring a migration.

## 6c. Stale data

Deleting a calendar used to leave its events behind, where they kept blocking
time in the scheduler. Removal now cascades: `deleteCalendar` drops the events
and sync cursors and detaches the blocks that pointed at it, and disconnecting
an account does that for each of its calendars.

Calendars deleted on the provider are reconciled on every sync: the list is
re-fetched, new calendars are imported and vanished ones are removed with their
events. Without this the mirror kept phantom calendars whose events went on
blocking time forever. An empty provider response is treated as suspicious and
never used as grounds for removal.

`MaintenanceService` covers the rest: `stats` reports row counts and the four
stale-data indicators (blocks whose task is gone, detached blocks, orphaned
events, orphaned sync cursors), `prune` drops old history and orphans, and
`reset` deletes by scope. All three are dry-run by default, and `reset` also
requires an explicit confirmation, because none of it can be undone.

## 7. Synchronisation

Each write records the etag it produced (`lastWrittenEtag`). During a sync, an
incoming event whose etag matches that value is our own echo and is ignored -
this is what prevents update loops. Anything else that moved is a genuine user
edit:

- if the user moved one of our task blocks, we follow it and pin the block, so
  the scheduler stops arguing with an explicit human decision;
- if the user deleted one, the block is detached and can be re-proposed;
- other changes simply update the local mirror and flag `needsReplan`.

Providers that support incremental sync store a cursor in `SyncState`; an
expired cursor triggers a transparent full resync.

## 8. The agent

The LLM never acts. It produces a JSON document that must satisfy a zod schema
of typed commands (`create_task`, `schedule`, `reschedule`, `block_time`,
`find_time`, `explain_schedule`, …). Invalid output is fed back once with the
validation errors, then rejected.

Validated commands are executed by the application services, which apply their
own validation and the automation policy. The result is that the worst an LLM
failure can do is produce a proposal the user declines.

A rule-based parser handles the common phrasings without any model at all. It
is used **only** when no model is configured: when one is set, it interprets
every request, and a failure is reported rather than silently answered by the
rule parser. One interpreter per request means identical phrasings always
behave identically.

## 9. Persistence

Three backends behind one `Database` port:

- **memory** - tests.
- **json** - the default. A single file, no infrastructure; the honest choice
  for a local-first single-user tool.
- **postgres** - a real relational schema with migrations, for server
  deployments. Timestamps are `bigint` epoch milliseconds so they round-trip
  with `Instant` without timezone reinterpretation. Value objects that are
  always read whole (attendees, preferences, change-set payloads) are `jsonb`.

## 10. Decisions worth knowing

| Decision                                       | Why                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| No Google/Microsoft SDKs; raw `fetch`          | Two small, explicit mappers beat two large dependency trees, and the request shape is directly testable. |
| Luxon rather than hand-rolled DST maths        | DST is a correctness problem, not a place to save a dependency.                                          |
| Block ids derived from a stable hash           | Plans are reproducible and diffable across runs.                                                         |
| Preferences stored as `jsonb`                  | It is a nested policy object, always read as a whole; normalising it would add joins and no value.       |
| JSON file as the default database              | Local-first should mean _runs with nothing installed_.                                                   |
| Task blocks are the unit of calendar writes    | A block maps 1:1 to an event, which makes moves, deletions and external edits tractable.                 |
| Unrecognised events are `UNKNOWN`, never moved | Being wrong about someone's calendar is expensive; being conservative is cheap.                          |
| `plan()` is side-effect free                   | Simulation-by-default falls out of the design instead of being bolted on.                                |

## 11. Extending it

The MVP intentionally stops here, but the seams are already in place for:
multiple users (every repository is keyed by `userId`), multiple calendars
(already modelled), projects and habits (`Task.projectId`, tags), travel time and
location (`CalendarEvent.location`), energy-aware scheduling (`Task.focus` plus
deep-work windows), learned preferences (`SchedulingWeights` is data, not code),
and better algorithms (implement `Scheduler` and swap it in `createApp`).
