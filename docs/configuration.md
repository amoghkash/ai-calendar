# Configuration

Configuration comes from three places, in increasing order of precedence:

1. built-in defaults,
2. `calendar-agent.yaml` (or the path in `--config` / `CALENDAR_AGENT_CONFIG`),
3. environment variables (including a `.env` file in the working directory).

Those three seed the **first** run. From then on the database is the source of
truth for everything the settings panel can edit, so a change made in the web UI
is not silently reverted by the file on the next restart. See
[Settings at runtime](#settings-at-runtime).

Secrets belong in the environment. Nothing in the YAML file needs to be secret,
and `calendar-agent config` redacts anything sensitive.

The file is searched for as `calendar-agent.yaml`, `calendar-agent.yml`,
`config/calendar-agent.yaml`, `.calendar-agent.yaml`, then
`~/.calendar-agent/config.yaml`.

## Full example

```yaml
timezone: Europe/Berlin

user:
  name: Your Name
  email: you@example.com

database:
  driver: json # memory | json | postgres
  path: .data/calendar-agent.json
  # url: postgres://calendar:calendar@localhost:5432/calendar_agent

working_hours:
  monday: '09:00-17:00'
  tuesday: ['09:00-12:00', '13:00-18:00']
  wednesday: '09:00-17:00'
  thursday: '09:00-17:00'
  friday: '09:00-15:00'

sleep_hours:
  monday: '23:00-07:00' # windows may cross midnight

recurring_blocks:
  monday: '12:00-13:00' # lunch

blocked_periods:
  - start: '2026-03-20T00:00:00Z'
    end: '2026-03-27T00:00:00Z'
    label: holiday

deep_work:
  enabled: true
  preferred_start: '09:00'
  preferred_end: '12:00'
  allow_meetings: false
  reserve_for_focus_tasks: false

scheduling:
  minimum_block_minutes: 30
  maximum_block_minutes: 180
  allow_task_splitting: true
  buffer_between_blocks_minutes: 0
  max_daily_task_minutes: 360
  protect_existing_events: true
  all_day_events_block_time: false
  granularity_minutes: 15
  planning_horizon_days: 14
  placement_strategy: earliest_fit # earliest_fit | best_fit

weights:
  deadline_urgency: 3
  priority: 2
  importance: 1
  deadline_risk: 2.5
  age_bonus: 0.5
  fragmentation_penalty: 1
  context_switch_penalty: 0.5
  early_start_preference: 0.75
  stability_bonus: 2
  deep_work_affinity: 1

risk:
  critical_ratio: 1.15
  at_risk_ratio: 1.5
  deadline_buffer_minutes: 120

automation:
  mode: suggest # read_only | suggest | autonomous
  move_policy:
    MOVABLE: auto # our own task blocks
    PROTECTED: never # real-world commitments
    FIXED: never # anything with other attendees
    UNKNOWN: ask
  create_blocks: auto
  delete_blocks: auto
  freeze_window_minutes: 60
  max_auto_mutations: 25

stability:
  minimum_improvement: 0.05
  freeze_window_minutes: 120
  max_moves_per_run: 20

classification_rules:
  - id: doctor
    classification: PROTECTED
    title_pattern: 'doctor|dentist|therapy'
  - id: personal-calendar
    classification: MOVABLE
    calendar_id: cal_personal

llm:
  provider: none # none | anthropic | openai | gemini | openrouter | ollama
  model: claude-opus-5
  temperature: 0
  max_tokens: 2048

server:
  host: 127.0.0.1
  port: 4319
  public_url: http://localhost:4319
  cors_origins: ['http://localhost:5173']

logging:
  level: info # debug | info | warn | error
```

## Settings at runtime

Most of this file can also be edited in the web UI, under the gear icon in the
top bar. Two stores back it:

| Store                    | Endpoint                     | Covers                                                                                                                          |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `scheduling_preferences` | `GET`/`PUT /api/preferences` | `timezone`, `working_hours`, `sleep_hours`, `recurring_blocks`, `deep_work`, `scheduling`, `automation`, `classification_rules` |
| `app_settings`           | `GET`/`PUT /api/settings`    | `llm`, `logging.level`                                                                                                          |

Both are per user and both take effect immediately - changing the model does not
need a restart. The YAML file still seeds a fresh database and still documents
the full surface, including the parts the panel does not expose (`weights`,
`risk`, `stability`, `blocked_periods`).

**API keys are never part of this.** `PUT /api/settings` rejects a request that
carries one. Keys are read from the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`), so a credential can
neither be submitted to nor read back from the HTTP API. The panel shows only
whether a key is present, and the server must be restarted after adding one.

If a provider is selected before its key exists, the assistant does not break:
the deterministic parser answers instead and the failure is logged as
`agent.llm_unavailable`. Scheduling never depended on the model to begin with.

## Environment variables

| Variable                                                                                          | Effect                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `CALENDAR_AGENT_CONFIG`                                                                           | path to the YAML file                                       |
| `CALENDAR_AGENT_TIMEZONE`                                                                         | override the timezone                                       |
| `CALENDAR_AGENT_DB_DRIVER` / `CALENDAR_AGENT_DB_PATH`                                             | database backend and file                                   |
| `DATABASE_URL`                                                                                    | Postgres connection string (implies the postgres driver)    |
| `CALENDAR_AGENT_PORT` / `PORT`, `CALENDAR_AGENT_HOST`, `CALENDAR_AGENT_PUBLIC_URL`                | server binding                                              |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`                                 | Google OAuth                                                |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI` | Microsoft OAuth                                             |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`                     | selects and configures the LLM when `llm.provider` is unset |
| `CALENDAR_AGENT_LLM_PROVIDER`, `..._MODEL`, `..._API_KEY`, `..._BASE_URL`                         | explicit LLM configuration                                  |
| `CALENDAR_AGENT_LOG_LEVEL`                                                                        | log level                                                   |

Run `calendar-agent config` to see everything as resolved, and
`calendar-agent doctor` to check that it actually works.
