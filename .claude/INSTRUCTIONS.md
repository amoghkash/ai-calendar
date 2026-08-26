# Build an Open-Source AI Calendar / Scheduling Assistant

You are building an open-source alternative to the AI calendar functionality of Motion.

The goal is to create a **local-first, modular personal scheduling agent** that connects to a user's existing calendars (initially Google Calendar and Microsoft Outlook), understands tasks and deadlines, automatically schedules work, detects scheduling risks, and can move calendar events when necessary.

The system should feel like having an automated executive assistant, but it must be:

- Open source
- Modular
- Self-hostable
- Model/provider agnostic
- Calendar-provider agnostic
- Usable from both a web UI and CLI
- Designed so deterministic scheduling logic does NOT depend on an LLM
- Safe around calendar mutations
- Extensible to additional integrations later

Do not tightly couple business logic to React, a specific LLM provider, Google Calendar, or Outlook.

---

# 1. Core Product Concept

The system manages three fundamental things:

### Tasks

A task represents work that needs to get done.

Example:

```text
Task:
  title: "Finish distributed systems assignment"
  duration: 180 minutes
  deadline: Friday 11:59 PM
  priority: high
  preferred_work_hours: [09:00, 23:00]
  minimum_block: 60 minutes
  status: incomplete
```

Tasks can have:

- Title
- Description
- Estimated duration
- Remaining duration
- Deadline
- Priority
- Importance
- Urgency
- Preferred times
- Earliest start
- Latest start
- Minimum scheduling block
- Whether splitting is allowed
- Tags/categories
- Dependencies
- Calendar/project association
- Status

---

# 2. Calendar Events

Calendar events come from external calendar providers.

The internal application should normalize all providers into a common model.

For example:

```typescript
interface CalendarEvent {
  id: string;
  provider: CalendarProvider;
  calendarId: string;

  title: string;

  start: DateTime;
  end: DateTime;

  timezone: string;

  location?: string;
  description?: string;

  attendees?: Attendee[];

  isAllDay: boolean;
  isRecurring: boolean;

  status: EventStatus;

  // Important for scheduling
  isMovable: boolean;
  isProtected: boolean;

  externalId: string;
}
```

Do NOT make the scheduling engine understand Google Calendar or Outlook-specific objects.

---

# 3. Scheduling Engine

This is the most important part of the system.

The scheduling engine should be a **deterministic, testable module**.

It should NOT require an LLM.

Given:

```text
Tasks
Calendar events
Working hours
Preferences
Deadlines
Current time
Scheduling constraints
```

it should produce:

```text
SchedulingPlan
```

containing:

```text
Task A -> Monday 10:00-11:30
Task B -> Monday 14:00-15:00
Task C -> Tuesday 09:00-11:00
```

and explain why.

The engine should be capable of:

### Finding free time

Identify available scheduling windows while respecting:

- Existing calendar events
- Working hours
- Sleep hours
- User-defined blocked periods
- Minimum work block size
- Existing task blocks

### Prioritizing tasks

Tasks should be ranked based on configurable factors such as:

- Deadline proximity
- Priority
- Importance
- Estimated duration
- Remaining duration
- How difficult it is to fit the task
- Whether the task is already overdue
- Dependencies
- User preferences

Do NOT hard-code a single opaque score.

Create a scoring system that is configurable and explainable.

For example:

```typescript
interface SchedulingWeights {
  deadlineUrgency: number;
  priority: number;
  importance: number;
  deadlineRisk: number;
  fragmentationPenalty: number;
  contextSwitchPenalty: number;
}
```

---

# 4. Deadline Risk

The system should detect when a task is at risk.

For example:

```text
Task:
  6 hours remaining
  Deadline: tomorrow at 5 PM

Available time before deadline:
  3 hours

Risk:
  CRITICAL
```

The engine should distinguish:

- Safe
- At risk
- Critical
- Impossible

and provide an explanation.

Example:

```text
"Distributed Systems Assignment is at risk because you have
6 hours of work remaining but only 3.5 hours of suitable
calendar availability before the deadline."
```

This should be deterministic.

---

# 5. Automatic Rescheduling

The system should be able to reorganize tasks when calendar conditions change.

Example:

Current schedule:

```text
09:00 - 10:30 Deep Work
10:30 - 11:00 Break
11:00 - 12:00 Meeting
14:00 - 16:00 Deep Work
```

Then a new meeting appears:

```text
09:30 - 11:00
```

The system should be able to:

1. Detect conflicts
2. Determine which task blocks are movable
3. Find alternative windows
4. Move affected tasks
5. Preserve deadlines
6. Minimize unnecessary changes
7. Produce a proposed plan
8. Apply the changes to the external calendar

The engine should optimize for **schedule stability**.

Do not constantly move everything around.

A schedule should only change when there is a meaningful reason.

---

# 6. Deep Work Protection

Users should be able to configure protected time.

Example:

```text
Deep work:
Monday-Friday
09:00-12:00
```

The scheduler should avoid placing meetings inside protected blocks unless explicitly allowed.

It should also be possible to designate specific calendar events as:

```text
protected
```

Protected events cannot be automatically moved.

---

# 7. Calendar Integration Architecture

Create an abstraction:

```typescript
interface CalendarProvider {
  authenticate(): Promise<void>;

  getCalendars(): Promise<Calendar[]>;

  getEvents(range: DateRange): Promise<CalendarEvent[]>;

  createEvent(event: CalendarEventInput): Promise<CalendarEvent>;

  updateEvent(eventId: string, changes: CalendarEventUpdate): Promise<CalendarEvent>;

  deleteEvent(eventId: string): Promise<void>;
}
```

The scheduling engine should only interact with this interface.

Implement:

```text
GoogleCalendarProvider
OutlookCalendarProvider
```

Do not allow provider-specific logic to leak into the scheduling engine.

Design the interfaces so Apple Calendar / CalDAV / other providers can be added later.

---

# 8. Google Calendar

Implement Google Calendar OAuth.

Requirements:

- OAuth2
- Secure token storage
- Calendar selection
- Event synchronization
- Event creation
- Event modification
- Event deletion
- Recurring event support where practical
- Timezone handling
- Attendee preservation
- External event IDs

Do not overwrite fields unnecessarily when modifying an existing event.

For example, moving an event should preserve:

- Title
- Description
- Attendees
- Location
- Recurrence
- Conference information

unless intentionally changed.

---

# 9. Microsoft Outlook

Implement Microsoft Graph calendar integration.

Use the same provider abstraction.

The application should be unaware of whether an event originated from Google or Outlook.

---

# 10. Synchronization

Create a synchronization layer.

The system needs to deal with external changes.

For example:

```text
Application schedules task
        ↓
Google Calendar updated
        ↓
User manually moves event
        ↓
Sync detects change
        ↓
Internal state updated
        ↓
Scheduler recalculates if necessary
```

Avoid infinite update loops.

Track:

- External event ID
- Last synchronized version
- Last known start/end
- Last local modification
- Provider
- Sync timestamps

Design for eventual consistency.

---

# 11. LLM Architecture

The LLM must NOT be responsible for the core scheduling algorithm.

The LLM should be an optional intelligence layer.

Create an abstraction such as:

```typescript
interface LLMProvider {
  generate(request: LLMRequest): Promise<LLMResponse>;
}
```

Support providers such as:

```text
OpenAI
Anthropic
Google Gemini
OpenRouter
Local models
```

The exact providers should be pluggable.

The application should be able to run without an LLM for core scheduling functionality.

---

# 12. What the LLM Should Do

The LLM can handle:

### Natural language task creation

User:

> "I need to finish my machine learning project by Thursday. It'll probably take around 8 hours."

Convert that into structured data:

```json
{
  "title": "Machine learning project",
  "estimated_minutes": 480,
  "deadline": "...",
  "priority": "normal"
}
```

### Natural language scheduling requests

Examples:

> "Find time for this tomorrow."

> "Push this until next week."

> "I need Friday afternoon completely free."

> "Move my work around so I can leave by 4."

### Explain scheduling decisions

Example:

> "Why did you schedule this at 8 AM?"

The LLM can turn structured scheduler explanations into natural language.

### Conflict resolution

If there are ambiguous preferences, the LLM can help interpret them.

---

# 13. Structured LLM Calls

Do NOT allow arbitrary LLM-generated actions.

LLM outputs must map to strongly typed commands.

For example:

```typescript
type AgentCommand =
  | CreateTask
  | UpdateTask
  | DeleteTask
  | ScheduleTask
  | RescheduleTask
  | BlockTime
  | UnblockTime
  | ExplainSchedule
  | RequestConfirmation;
```

The LLM proposes commands.

The application validates them.

The scheduling engine determines whether they are valid.

Only then can mutations occur.

---

# 14. Safety / Confirmation Model

Calendar mutations are consequential.

Implement three modes:

### Read-only

The system can analyze calendars but cannot modify anything.

### Suggest

The system generates changes but requires user confirmation.

Example:

```text
I recommend:

Move:
  "Study for Algorithms"
  Tuesday 2:00 PM → Tuesday 4:00 PM

Reason:
  A new meeting conflicts with the existing block.

[Approve] [Reject]
```

### Autonomous

The system can automatically apply changes according to user-configured rules.

Users should be able to configure which events may be moved.

For example:

```text
Meetings:
  Never move

Personal tasks:
  Automatically move

Deep work:
  Automatically move

Protected events:
  Never move
```

---

# 15. Schedule Change Diff

Every proposed schedule modification should have a diff.

Example:

```text
BEFORE

Monday
09:00 - 11:00  Algorithms

AFTER

Monday
10:00 - 12:00  Algorithms
```

Reason:

```text
A meeting was added from 09:00-10:00.
The task was moved to preserve the 2-hour work block.
```

This should be represented as structured data, not just text.

---

# 16. UI

Build a clean web UI.

For now, focus on functionality rather than visual polish.

The UI should have:

### Calendar view

Day/week view showing:

- External events
- Scheduled task blocks
- Protected time
- At-risk tasks
- Current time

### Tasks panel

Show:

```text
Task
Priority
Deadline
Remaining time
Risk
Scheduled time
```

### AI / command interface

Provide a chat/command interface where I can type:

> Schedule my database assignment.

> Move everything tomorrow so I can leave at 3.

> What deadlines are at risk?

> Why is my Friday so full?

> Give me two hours for research tomorrow morning.

### Proposed changes

Show a confirmation UI for schedule mutations.

---

# 17. CLI

The same application functionality should be exposed through a CLI.

For example:

```bash
calendar-agent tasks
calendar-agent tasks add "Finish ML project" --duration 4h --due Thursday
calendar-agent schedule
calendar-agent schedule --task "Finish ML project"
calendar-agent risks
calendar-agent today
calendar-agent tomorrow
calendar-agent sync
calendar-agent doctor
```

Also support natural language:

```bash
calendar-agent "find me 2 hours tomorrow for my ML project"
```

The CLI should call the same application services as the web UI.

Do NOT duplicate business logic inside CLI commands.

---

# 18. Core Application Architecture

Use a clean architecture similar to:

```text
                    ┌─────────────────┐
                    │       UI        │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   Application   │
                    │    Services     │
                    └────────┬────────┘
                             │
             ┌───────────────┼────────────────┐
             │               │                │
      ┌──────▼──────┐ ┌─────▼─────┐ ┌────────▼────────┐
      │ Scheduling  │ │   Agent   │ │   Task Manager  │
      │   Engine    │ │ / LLM     │ │                 │
      └──────┬──────┘ └─────┬─────┘ └────────┬────────┘
             │              │                │
             └──────────────┼────────────────┘
                            │
                     ┌──────▼──────┐
                     │ Domain / DB │
                     └──────┬──────┘
                            │
                  ┌─────────┴─────────┐
                  │                   │
           ┌──────▼──────┐     ┌──────▼──────┐
           │   Google    │     │   Outlook   │
           │  Calendar   │     │  Calendar   │
           └─────────────┘     └─────────────┘
```

Keep these boundaries strict.

---

# 19. Recommended Repository Structure

Use a monorepo if appropriate.

A reasonable starting structure:

```text
/
├── apps/
│   ├── web/
│   └── cli/
│
├── packages/
│   ├── core/
│   │   ├── domain/
│   │   ├── scheduling/
│   │   ├── tasks/
│   │   └── planning/
│   │
│   ├── agent/
│   │   ├── providers/
│   │   ├── prompts/
│   │   ├── tools/
│   │   └── commands/
│   │
│   ├── integrations/
│   │   ├── google-calendar/
│   │   └── outlook/
│   │
│   ├── database/
│   │
│   └── config/
│
├── tests/
│
├── docs/
│
├── docker/
│
└── README.md
```

You may adjust this structure if you have a better architectural reason, but maintain the separation of concerns.

---

# 20. Database

Use a relational database.

Prefer PostgreSQL for the primary implementation.

Create models for at least:

```text
User
CalendarAccount
Calendar
CalendarEvent
Task
TaskSchedule
ScheduleBlock
SchedulingPreference
SyncState
AgentConversation
AgentMessage
ScheduleChange
```

The system should be designed for multiple users eventually, but do not over-engineer multi-tenancy for the MVP.

---

# 21. Time Handling

Time handling must be treated as a first-class concern.

Support:

- Timezones
- DST
- All-day events
- Recurring events
- Working hours
- User-local time
- Calendar-local time

Internally, use a consistent representation such as UTC timestamps plus explicit timezone metadata.

Do not implement scheduling with naive date strings.

Add extensive tests around DST transitions.

---

# 22. Scheduling Algorithm

Start with a simple but robust algorithm rather than attempting to reproduce Motion's proprietary behavior.

The first version should:

1. Load calendar events
2. Load tasks
3. Determine available windows
4. Calculate task urgency
5. Sort tasks
6. Allocate task blocks
7. Respect constraints
8. Detect tasks that cannot fit
9. Produce a proposed schedule
10. Calculate schedule quality
11. Return an explanation

Create an interface:

```typescript
interface Scheduler {
  plan(input: SchedulingInput): SchedulingPlan;
}
```

Make it possible to replace the scheduler later.

Potential future implementations:

```text
GreedyScheduler
ConstraintScheduler
OptimizationScheduler
LLMAssistedScheduler
```

The MVP can use a deterministic greedy/constraint-based scheduler.

---

# 23. Schedule Quality

Create a measurable scoring system.

For example:

```text
deadline satisfaction
priority satisfaction
schedule stability
deep-work preservation
context switching
fragmentation
preference satisfaction
```

The scheduler should be able to answer:

```text
Why is this schedule better than the previous one?
```

This will be important later if we introduce more advanced optimization algorithms.

---

# 24. Event Classification

The system needs to distinguish between:

```text
MOVABLE
PROTECTED
FIXED
UNKNOWN
```

For example:

```text
Doctor appointment → PROTECTED
Team meeting → FIXED
"Work on project" → MOVABLE
Lunch → configurable
```

Do not automatically move events unless the user has authorized that class of event.

---

# 25. Recurring Events

Be conservative with recurring events.

The system should initially avoid automatically modifying an entire recurring series.

Prefer modifying individual instances when supported.

Clearly represent:

```text
series event
instance event
```

---

# 26. Testing

This project should be heavily tested.

Especially test:

### Scheduling

- No calendar conflicts
- Deadlines respected
- Protected time respected
- Working hours respected
- Tasks split correctly
- Tasks not split when prohibited
- Impossible tasks identified
- Schedule stability
- Priority ordering

### Calendar providers

Mock provider APIs.

Test:

- Fetch
- Create
- Update
- Delete
- Sync
- Conflict handling

### Timezones

Test multiple timezones and DST.

### Agent

Test that natural-language requests produce valid structured commands.

Never make tests depend on an actual LLM response.

Mock the LLM.

---

# 27. Observability

Build structured logging from the beginning.

Every scheduling operation should have a traceable execution:

```text
Schedule run
  ↓
Input snapshot
  ↓
Tasks considered
  ↓
Calendar events considered
  ↓
Constraints
  ↓
Scheduling decisions
  ↓
Result
```

This will make debugging scheduling behavior dramatically easier.

Add a "why" / explanation object to scheduling decisions.

---

# 28. Configuration

Support configuration such as:

```yaml
working_hours:
  monday:
    start: '09:00'
    end: '17:00'

deep_work:
  enabled: true
  preferred_start: '09:00'
  preferred_end: '12:00'

scheduling:
  minimum_block_minutes: 30
  allow_task_splitting: true
  protect_existing_events: true

automation:
  mode: suggest
```

Do not hard-code these values.

---

# 29. Local Development

The entire application should be easy to run locally.

Provide:

```bash
docker compose up
```

or equivalent.

Include:

- Database
- Backend
- Frontend
- Local development configuration

Provide `.env.example`.

Never commit secrets.

---

# 30. Developer Experience

Create:

```text
README.md
CONTRIBUTING.md
ARCHITECTURE.md
docs/
```

The README should explain:

1. What the project does
2. Architecture
3. Installation
4. Google Calendar setup
5. Outlook setup
6. LLM provider setup
7. Running the UI
8. Running the CLI
9. Running tests
10. How to add a new calendar provider
11. How to add a new LLM provider
12. How the scheduler works

---

# 31. Important Architectural Principle

The following dependency direction should be enforced:

```text
UI ──────────────┐
CLI ─────────────┤
                 ▼
          Application Layer
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
   Scheduler   Agent     Tasks
       │         │
       │         ▼
       │      LLM Provider
       │
       ▼
Calendar Interface
       │
   ┌───┴────────┐
   ▼            ▼
 Google       Outlook
```

The scheduler must NEVER import:

```text
React
CLI code
Google SDK
Microsoft SDK
OpenAI SDK
Anthropic SDK
```

The LLM provider must NEVER directly mutate the database or calendar.

All mutations should flow through application/domain services.

---

# 32. MVP Scope

Do not attempt to build everything simultaneously.

Build the MVP in this order:

## Phase 1 — Foundation

- Repository
- Database
- Domain models
- Configuration
- Application services
- Basic tests

## Phase 2 — Calendar

- CalendarProvider interface
- Google Calendar integration
- OAuth
- Calendar sync
- Normalized events

## Phase 3 — Tasks

- Task CRUD
- Task constraints
- Task scheduling blocks

## Phase 4 — Scheduler

- Availability calculation
- Priority calculation
- Scheduling algorithm
- Deadline risk
- Schedule explanations
- Schedule diff

## Phase 5 — UI

- Calendar
- Tasks
- Schedule
- Risks
- Proposed changes
- Confirmation

## Phase 6 — CLI

- Tasks
- Schedule
- Risks
- Sync
- Natural language command

## Phase 7 — LLM

- LLM abstraction
- Tool/function calling
- Natural language task creation
- Natural language scheduling
- Schedule explanations

## Phase 8 — Outlook

- Microsoft Graph provider

Do not move to the next phase until the previous phase has a working testable implementation.

---

# 33. Development Process

Before writing significant code:

1. Inspect the repository.
2. Determine what already exists.
3. Propose the architecture.
4. Identify important design decisions.
5. Create a concise implementation plan.
6. Then implement incrementally.

Do not rewrite working code unnecessarily.

After each major phase:

- Run tests
- Run type checking
- Run linting
- Verify the application actually starts
- Update documentation

If something is ambiguous, choose a sensible implementation and document the decision rather than blocking the entire project.

---

# 34. Coding Principles

Prefer:

- Strong typing
- Small modules
- Dependency injection
- Interfaces at integration boundaries
- Pure functions for scheduling logic
- Deterministic behavior
- Testability
- Explicit domain models
- Structured errors
- Structured logging

Avoid:

- Giant service classes
- Global state
- Provider-specific logic in the scheduler
- LLM-dependent business logic
- Magic scheduling numbers
- Hidden side effects
- Direct database access from UI components
- Direct calendar API calls from UI components

---

# 35. Critical Requirement: Simulation Mode

Before allowing automatic calendar modification, implement a simulation mode.

Example:

```bash
calendar-agent schedule --dry-run
```

Output:

```text
PROPOSED CHANGES

+ Monday 09:00-10:30
  Finish ML project

~ Tuesday 14:00-15:00
  Move "Study" from 10:00 → 14:00

! Wednesday
  Database assignment cannot be completed before deadline

No calendar changes were made.
```

This should be the default behavior during development.

---

# 36. Future Architecture

Do not implement these yet, but make the architecture capable of supporting:

- Multiple calendars
- Multiple users
- Projects
- Habits
- Email integration
- Slack
- Todoist
- Linear
- Notion
- GitHub
- Automatic task extraction
- Meeting preparation
- Travel time
- Location-aware scheduling
- Energy-aware scheduling
- Focus modes
- Learned user preferences
- Reinforcement/feedback-based scheduling
- More advanced optimization algorithms
- Local LLMs
- Multi-agent workflows

The MVP should remain simple.

---

# 37. Definition of Done

The MVP is successful when I can:

1. Connect my Google Calendar.
2. See my calendar events in the application.
3. Create tasks with deadlines and estimated durations.
4. Tell the application:

   > Schedule my algorithms assignment for this week.

5. Have the deterministic scheduler find suitable time.
6. See the proposed schedule.
7. Understand why the scheduler chose those times.
8. Approve the changes.
9. Have those blocks appear on Google Calendar.
10. Add a new calendar event externally.
11. Sync the application.
12. Have the scheduler detect resulting conflicts.
13. Automatically propose a new schedule.
14. Ask the UI:

> What deadlines are at risk?

15. Get an accurate answer.
16. Run the same functionality through:

```bash
calendar-agent risks
calendar-agent schedule
calendar-agent "schedule my algorithms assignment"
```

The same core application services must power both the UI and CLI.

---

# 38. Start Now

Start by inspecting the existing repository.

Do not immediately generate thousands of lines of code.

First:

1. Determine the current tech stack.
2. Determine what is already implemented.
3. Propose the architecture.
4. Create/update `ARCHITECTURE.md`.
5. Create an implementation roadmap.
6. Identify the smallest vertical slice that can prove the architecture.

Then implement the first vertical slice.

The first vertical slice should ideally be:

```text
Task
  +
Mock Calendar
  ↓
Deterministic Scheduler
  ↓
Scheduling Plan
  ↓
CLI / API
  ↓
Tests
```

Only after that works should real Google Calendar integration be introduced.

The priority is **a clean foundation and a genuinely good scheduling engine**, not superficial UI polish.

When making architectural decisions, optimize for:

> **A small, understandable open-source project that can eventually become a powerful personal scheduling agent.**

Do not attempt to copy Motion's implementation. Build an independent system based on the functional requirements described above.
