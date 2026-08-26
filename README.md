# calendar-agent

An open-source, local-first AI scheduling assistant. It connects to your existing
calendars, understands your tasks and deadlines, finds time for your work,
detects deadlines that are at risk, and reorganises your schedule when your
calendar changes.

It is an independent alternative to the AI-scheduling part of tools like Motion,
built around one principle:

> **The scheduling engine is deterministic. The LLM is optional.**

Every scheduling decision - which task goes where, why, and what is at risk - is
made by a pure, testable module with no model in the loop. An LLM, if you
configure one, only translates your words into typed commands and turns
structured explanations into prose.

> **Picking this up cold?** [CONTEXT.md](./CONTEXT.md) is the orientation page:
> how to run it, how to verify a change, the invariants, and the traps that are
> not visible from the code.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Installation](#3-installation)
4. [Google Calendar setup](#4-google-calendar-setup)
5. [Outlook setup](#5-microsoft-outlook-setup)
6. [LLM provider setup](#6-llm-provider-setup)
7. [Running the web UI](#7-running-the-web-ui)
8. [Running the CLI](#8-running-the-cli)
9. [Running the tests](#9-running-the-tests)
10. [Adding a calendar provider](#10-adding-a-calendar-provider)
11. [Adding an LLM provider](#11-adding-an-llm-provider)
12. [How the scheduler works](#12-how-the-scheduler-works)

---

## 1. What it does

- **Tasks with real constraints** - estimate, deadline, priority, importance,
  minimum block size, splitting rules, preferred days and times, dependencies,
  focus level.
- **Automatic scheduling** - finds free time around your existing calendar,
  working hours, sleep, blocked periods and deep-work windows.
- **Deadline risk** - deterministic `SAFE` / `AT_RISK` / `CRITICAL` /
  `IMPOSSIBLE` classification with an explanation containing the actual numbers.
- **Rescheduling** - when a meeting appears on top of your work, the affected
  blocks move; everything else stays exactly where it was.
- **Simulation first** - `calendar-agent schedule` shows what _would_ change and
  writes nothing. Calendar changes require approval unless you opt into
  autonomous mode.
- **Explainable** - every block, move and risk carries a structured reason, and
  the full scheduling trace is available with `--explain`.
- **Provider-agnostic** - Google Calendar and Microsoft Outlook today, behind an
  interface built so Apple/CalDAV can be added without touching the scheduler.
- **Web UI and CLI** - both call exactly the same application services.
- **Categories** - colour and group tasks and events, by hand or by a title
  pattern. Purely descriptive: a category never changes what the agent may move.
- **Data management** - see what is stored, find stale rows, prune old history,
  or delete by scope. Every destructive operation simulates first.
- **Periodic sync** - the server refreshes your calendars on a timer and
  re-plans around anything that changed, without applying more than your
  automation mode already allows.
- **Local-first** - runs on a single JSON file with no infrastructure at all;
  PostgreSQL is there when you want a server deployment.

```text
$ calendar-agent schedule

PROPOSED CHANGES

+ Mon 09 Mar 09:00–11:00  Algorithms assignment
    Scheduled 2h of "Algorithms assignment" at Mon 09 Mar 09:00–11:00 inside a deep-work window.
~ Tue 10 Mar 09:00–11:00 -> Tue 10 Mar 14:00–16:00  Study
    Moved "Study" because the original slot was no longer usable.
! Database coursework
    "Database coursework" cannot be completed: 6h of work remains but only 3h 30m
    of suitable availability exists before Fri 13 Mar 17:00.

Schedule quality 91% - Deadline satisfaction 100%, Priority alignment 100%, ...
2 new block(s), 1 move(s): 0 to apply automatically, 3 awaiting approval, 0 blocked by policy.
No calendar changes were made.
Apply with: calendar-agent approve cs_9f21…
```

---

## 2. Architecture

```text
             ┌───────────┐        ┌───────────┐
             │  Web UI   │        │    CLI    │
             └─────┬─────┘        └─────┬─────┘
                   │   HTTP             │  direct
                   └────────┬───────────┘
                            ▼
                  ┌──────────────────┐
                  │  Application     │  packages/app
                  │  services        │
                  └────────┬─────────┘
          ┌────────────────┼─────────────────┐
          ▼                ▼                 ▼
 ┌────────────────┐ ┌────────────┐ ┌──────────────────┐
 │  Scheduling    │ │   Agent    │ │   Tasks / Sync   │
 │  engine (pure) │ │  (LLM)     │ │                  │
 └────────┬───────┘ └─────┬──────┘ └────────┬─────────┘
          │               ▼                 │
          │        ┌────────────┐           │
          │        │ LLMProvider│           │
          │        └────────────┘           │
          ▼                                 ▼
 ┌────────────────────┐            ┌──────────────────┐
 │ CalendarProvider   │            │    Database      │
 │ (port)             │            │    (port)        │
 └────────┬───────────┘            └──────────────────┘
    ┌─────┴──────┬───────────┐       memory │ json │ postgres
    ▼            ▼           ▼
 Google      Outlook       Mock
```

The dependency direction is enforced, and checked by an eslint rule:
`packages/core` may not import React, Express, `pg`, any provider SDK, any LLM
SDK, or any other workspace package. See [ARCHITECTURE.md](./ARCHITECTURE.md).

```text
/
├── apps/
│   ├── cli/          calendar-agent command line interface
│   ├── server/       HTTP API + OAuth callbacks + static web hosting
│   └── web/          React UI
├── packages/
│   ├── core/         domain model, time, scheduling engine, ports  (no deps)
│   ├── config/       YAML + env configuration
│   ├── database/     repositories: memory, JSON file, PostgreSQL
│   ├── integrations/ Google Calendar, Microsoft Graph, mock provider
│   ├── agent/        LLM providers, prompts, typed commands, parsers
│   └── app/          application services that wire it all together
├── tests/            end-to-end, DST and scheduler-invariant suites
├── docs/             deeper documentation
└── docker/           Dockerfile and compose stack
```

---

## 3. Installation

Requirements: **Node.js 20.11+** (Node 22+ recommended). No database required.

```bash
git clone <your fork> calendar-agent
cd calendar-agent
npm install
npm run build
```

Try it immediately - no configuration, no calendar, no API key:

```bash
node apps/cli/dist/bin.js tasks add "Finish ML project" --duration 4h --due friday
node apps/cli/dist/bin.js schedule
node apps/cli/dist/bin.js risks
```

Then create a configuration file and an `.env`:

```bash
cp calendar-agent.example.yaml calendar-agent.yaml
cp .env.example .env
```

`calendar-agent.yaml` holds preferences (working hours, deep work, automation
mode). `.env` holds secrets (OAuth client secrets, LLM API keys). Neither is
required to start, and secrets are never written to the config file.

### Docker

```bash
cp .env.example .env
docker compose up --build
```

This starts PostgreSQL, runs the migrations and serves the UI and API on
<http://localhost:4319>.

---

## 4. Google Calendar setup

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/).
2. Enable the **Google Calendar API**.
3. Configure the OAuth consent screen (External + your own account as a test
   user is enough for personal use).
4. Create an **OAuth client ID** of type _Web application_ with the redirect URI:

   ```text
   http://localhost:4319/api/oauth/google/callback
   ```

5. Put the credentials in `.env`:

   ```bash
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

6. Start the server (`npm start`) and open
   <http://localhost:4319/api/oauth/google/start> in your browser.
   `calendar-agent connect google` prints that URL for you.

The scope requested is `https://www.googleapis.com/auth/calendar` because the
agent has to create and move its own events. Tokens are stored in your database
(JSON file or Postgres) and never logged.

Moving an event uses `PATCH`, so the title, description, attendees, location,
recurrence and conferencing details of an existing event are preserved.

## 5. Microsoft Outlook setup

1. Register an application in the
   [Entra admin center](https://entra.microsoft.com/) → _App registrations_.
2. Add a **Web** redirect URI:

   ```text
   http://localhost:4319/api/oauth/microsoft/callback
   ```

3. Add the delegated Microsoft Graph permissions `Calendars.ReadWrite`,
   `User.Read`, `MailboxSettings.Read`, and enable `offline_access`.
4. Create a client secret and put both values in `.env`:

   ```bash
   MICROSOFT_CLIENT_ID=...
   MICROSOFT_CLIENT_SECRET=...
   MICROSOFT_TENANT_ID=common   # or your tenant id
   ```

5. Visit <http://localhost:4319/api/oauth/microsoft/start>.

Once connected, the rest of the application cannot tell whether an event came
from Google or Outlook: both are normalised into the same model.

## 6. LLM provider setup

**Everything below works without an LLM.** Scheduling, risk analysis, rescheduling,
diffs and the CLI all run on the deterministic engine. With no model configured,
natural language is handled by a built-in rule parser that understands the common
phrasings.

When a model _is_ configured it interprets every request - the rule parser is not
consulted, so one phrasing always behaves one way. Note that this means every
natural-language message costs a model call.

To enable the intelligence layer, set one key in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...      # or
OPENAI_API_KEY=sk-...             # or
OPENROUTER_API_KEY=sk-or-...      # or
GEMINI_API_KEY=...
```

Or configure it explicitly in `calendar-agent.yaml`:

```yaml
llm:
  provider: anthropic # none | anthropic | openai | gemini | openrouter | ollama
  model: claude-opus-5
```

Local models work through any OpenAI-compatible endpoint:

```yaml
llm:
  provider: ollama
  model: llama3.1
  base_url: http://localhost:11434/v1
```

The LLM is only ever asked to return a list of **typed commands**, which are
validated against a schema before anything happens. It cannot invent an action,
touch the database, or call a calendar API.

## 7. Running the web UI

```bash
npm run build && npm start   # API + UI on http://localhost:4319
```

For hot reload while developing the UI:

```bash
npm run dev            # builds, then runs API (4319) and Vite (5173) together
```

- API + built UI: <http://localhost:4319>
- Vite dev server with hot reload: <http://localhost:5173> (proxies `/api`)

The UI has a day/week calendar (external events, task blocks, deep-work bands,
at-risk highlighting and the current-time line), a task panel with risk, a
proposed-changes panel with approve/reject, a calendar-inclusion panel, and a
command box.

**Editing directly.** Drag a task block or an event to move it; click one to
edit it; click empty space to create an event. Dragging a task block pins it, so
the scheduler stops moving it - unpin from the block dialog to hand it back.
Moving an event that has other attendees opens the dialog first, so you can
decide whether to email them. Recurring series are never edited as a whole.

**Settings.** The gear icon in the top bar opens a settings panel covering
working hours, sleep, recurring blocks, deep work, block sizing and placement,
automation policy, event classification rules, the language model, and the log
level - most of `calendar-agent.yaml`, editable while the app runs. Changes are
stored per user in the database and take effect immediately; the YAML file seeds
a fresh database and remains the reference for the rest. API keys are the one
thing the panel will not take: they stay in `.env`, and the panel only reports
whether one is present. See [docs/configuration.md](docs/configuration.md).

**Which calendars count.** The Calendars panel separates three questions:
_show_ (display it here), _busy_ (its events consume time when planning), and
_tasks_ (where scheduled blocks are written). A colleague's calendar can be
visible without making you unavailable.

## 8. Running the CLI

`npm install` links the executable into `node_modules/.bin`, so after a build
you can run it directly:

```bash
npm run build
./node_modules/.bin/calendar-agent doctor

# or put it on your PATH for this shell
export PATH="$PWD/node_modules/.bin:$PATH"

# or install it globally from this checkout
npm link --workspace @calendar-agent/cli

calendar-agent tasks
calendar-agent tasks add "Finish ML project" --duration 4h --due thursday --priority high
calendar-agent tasks done <task>
calendar-agent schedule                      # simulation - writes nothing
calendar-agent schedule --task "ML project"  # plan a single task
calendar-agent schedule --explain            # full scheduling trace
calendar-agent schedule --apply              # actually write to the calendar
calendar-agent approve <changeSetId>
calendar-agent risks
calendar-agent today
calendar-agent tomorrow
calendar-agent agenda --days 14
calendar-agent free 2h --deep
calendar-agent sync
calendar-agent calendars --use <calendarId>
calendar-agent connect google
calendar-agent categories                       # colours and groupings
calendar-agent categories add "Deep work" --color '#7a5cc4' --match 'focus|writing'
calendar-agent data stats                       # what is stored, what looks stale
calendar-agent data prune --days 90             # simulation; add --yes to apply
calendar-agent data reset --scope events --yes  # delete by scope
calendar-agent doctor
calendar-agent config

# natural language
calendar-agent "find me 2 hours tomorrow for my ML project"
calendar-agent "what deadlines are at risk?"
```

Add `--json` to any command for machine-readable output.

## 9. Running the tests

```bash
npm test           # 260+ tests: unit, integration, DST, invariants, HTTP, CLI
npm run typecheck  # tsc project references + the test project
npm run lint       # eslint, including the core-purity boundary rule
```

Tests never call a real model or a real calendar: the LLM is mocked, and the
calendar providers are exercised through a scripted `fetch`.

## 10. Adding a calendar provider

1. Implement [`CalendarProvider`](./packages/core/src/ports/calendar-provider.ts)
   in `packages/integrations/src/<provider>/`. Only three things are required:
   normalise events into `NormalizedEvent`, apply partial updates without
   clobbering untouched fields, and report `capabilities` honestly.
2. Register it in
   [`DefaultProviderRegistry`](./packages/app/src/provider-registry.ts).
3. Add the OAuth endpoints and scopes to the configuration schema.

`MockCalendarProvider` is the reference implementation and doubles as the test
double. Nothing in `packages/core` changes.

## 11. Adding an LLM provider

1. Implement [`LLMProvider`](./packages/agent/src/llm/types.ts) - a single
   `generate(request)` method. Honour `jsonSchema` if the provider supports
   structured output; otherwise return text and let `extractJson` handle it.
2. Register it in [`createLLMProvider`](./packages/agent/src/llm/factory.ts).

## 12. How the scheduler works

See [docs/scheduling.md](./docs/scheduling.md) for the full description. In short,
`GreedyScheduler.plan()` is a pure function that:

1. classifies existing blocks into _frozen_, _retained_ and _released_;
2. computes availability = working hours − sleep − blocked − meetings − retained;
3. scores every task from configurable, individually explained components;
4. orders tasks by score, respecting dependencies;
5. places each task into the earliest (or best-fitting) suitable window,
   honouring minimum/maximum block sizes, splitting rules, deadlines,
   preferred windows and daily caps;
6. restores blocks it could not improve on, so a failed search never destroys
   existing work;
7. assesses deadline risk against capacity before the deadline;
8. measures schedule quality across seven metrics;
9. emits a structured diff and a full decision trace.

---

## Licence

MIT - see [LICENSE](./LICENSE).
