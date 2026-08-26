# Contributing

Thanks for wanting to help. This project aims to stay small, understandable and
correct - contributions that keep it that way are the most welcome kind.

## Getting set up

```bash
npm install
npm run build
npm test
```

Node 20.11+ is required. No database, no API key and no calendar account are
needed to develop or to run the full test suite.

## The rules that matter

1. **`packages/core` stays pure.** No React, no Express, no `pg`, no provider or
   model SDK, no other workspace package. An eslint rule enforces this; if you
   find yourself wanting to break it, the code probably belongs in
   `packages/app` instead.
2. **Scheduling stays deterministic.** `Scheduler.plan()` must be a pure
   function - no `Date.now()`, no `Math.random()`, no I/O. Take the clock and
   the id generator as input.
3. **The LLM never acts.** It may only produce commands that satisfy the zod
   schema in `packages/agent/src/commands/schema.ts`. Execution belongs to the
   application services.
4. **Calendar mutations flow through a `ChangeSet`.** Never call a provider
   directly from a service that is not `SchedulingService.applyPlan`.
5. **No naive date strings.** Use `Instant` (epoch ms) plus an IANA timezone;
   convert only in `time/wall-clock.ts`.
6. **Tests never call a real model or a real calendar.** Use `MockLLMProvider`
   and `MockCalendarProvider` / `FetchRecorder`.

## Workflow

```bash
npm run build       # tsc project references
npm run typecheck   # build + typecheck the tests project
npm run lint        # eslint, including the boundary rule
npm test            # vitest
npm run format      # prettier
```

Please run all four before opening a pull request.

### Testing against PostgreSQL

The default suite runs the repository contract against the memory and JSON
backends, which have **no foreign keys**. If you touch persistence or the order
in which rows are written, run the contract against a real database too:

```bash
docker compose up -d postgres
npm run test:postgres
```

A write order that the in-memory backends accept can still violate a foreign key
in PostgreSQL - that is a real bug that shipped once already.

## Where things live

| I want to change...               | Look in                                            |
| --------------------------------- | -------------------------------------------------- |
| how tasks are ranked              | `packages/core/src/scheduling/scoring.ts`          |
| where blocks are placed           | `packages/core/src/scheduling/greedy-scheduler.ts` |
| what counts as free time          | `packages/core/src/scheduling/availability.ts`     |
| deadline risk levels              | `packages/core/src/scheduling/risk.ts`             |
| schedule quality metrics          | `packages/core/src/scheduling/quality.ts`          |
| what may be written to a calendar | `packages/core/src/planning/change-set.ts`         |
| a calendar integration            | `packages/integrations/src/<provider>/`            |
| an LLM integration                | `packages/agent/src/llm/`                          |
| what the agent is allowed to do   | `packages/agent/src/commands/schema.ts`            |
| orchestration between the above   | `packages/app/src/services/`                       |
| CLI commands                      | `apps/cli/src/program.ts`                          |
| HTTP endpoints                    | `apps/server/src/routes.ts`                        |
| the UI                            | `apps/web/src/`                                    |

## Adding a scheduling feature

Scheduling changes need tests that state the rule in the test name, for example
"never places work after the deadline" or "keeps an existing block when nothing
better can be found". If the behaviour is configurable, add it to
`SchedulingPreferences` and to the config schema - magic numbers in the engine
are treated as bugs.

`tests/scheduler-invariants.test.ts` runs 40 seeded random scenarios against the
invariants that must always hold. If your change makes one of them fail, either
the change or the invariant is wrong; decide which, and say so in the PR.

## Commit and PR style

- Small, focused commits with an imperative subject line.
- Describe _why_, not just _what_.
- Mention any behaviour change a user would notice.
