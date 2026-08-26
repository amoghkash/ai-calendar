# Roadmap

## Status

All eight MVP phases are implemented and tested.

| Phase | Scope                                                       | Status |
| ----- | ----------------------------------------------------------- | ------ |
| 1     | Repository, domain models, configuration, services, tests   | done   |
| 2     | `CalendarProvider` interface, Google Calendar, OAuth, sync  | done   |
| 3     | Task CRUD, constraints, schedule blocks                     | done   |
| 4     | Availability, scoring, scheduling, risk, explanations, diff | done   |
| 5     | Web UI: calendar, tasks, risks, proposals, confirmation     | done   |
| 6     | CLI: tasks, schedule, risks, sync, natural language         | done   |
| 7     | LLM abstraction, typed commands, NL creation and scheduling | done   |
| 8     | Microsoft Graph provider                                    | done   |

## Next

Roughly in the order they would pay off.

### Scheduling quality

- **Rolling look-ahead** - the greedy pass is deadline-safe but not optimal;
  a constraint or local-search scheduler behind the same `Scheduler` interface
  could improve fragmentation and context switching without changing anything
  above it.
- **Time-of-day energy profiles** - `Task.focus` and deep-work windows already
  exist; learning when a person actually does deep work is the next step.
- **Travel and buffer time** - `CalendarEvent.location` is already modelled.
- **Habits and recurring work** - recurring tasks that regenerate each period.

### Calendar

- **Apple Calendar / CalDAV provider** - the interface is ready; this is the
  main missing integration.
- **Webhooks / push notifications** - replace polling sync with Google
  `watch` channels and Graph subscriptions.
- **Full recurring-series editing** - today the system deliberately only
  modifies single instances.
- **Free/busy queries** for calendars the user can see but not read in detail.

### Product

- **Projects** - `Task.projectId` exists but has no UI.
- **Multi-user** - every repository is keyed by `userId`; what is missing is
  authentication and session handling.
- **Task extraction from email, Slack, Linear, Notion, GitHub, Todoist** -
  each is an adapter that produces `CreateTask` commands.
- **Meeting preparation** - a task automatically scheduled before a meeting.
- **Feedback-based scheduling** - `SchedulingWeights` is data, so learned
  weights are a natural extension.

### Engineering

- **Postgres integration tests in CI** (a compose service and a tagged suite).
- **Structured log shipping** and a scheduling-decision viewer.
- **Rate-limit-aware sync scheduling** per provider.
