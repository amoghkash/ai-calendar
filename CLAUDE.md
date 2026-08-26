# CLAUDE.md

Read [CONTEXT.md](./CONTEXT.md) first. It is the orientation page for this repo:
how to run it, how to verify a change, the invariants that must not break, and
the traps that are not visible from the code.

Two things that matter before you touch anything:

- **The scheduling engine is deterministic; the LLM is optional.** Never make
  scheduling, risk or planning depend on a model being reachable.
- **This checkout talks to real calendars.** `.env` points at PostgreSQL, and
  that database holds live Google OAuth tokens, so approving a change set or
  creating an event writes to the owner's actual calendar. Planning only
  simulates. See CONTEXT.md §4.

Before claiming a change works:

```bash
npm run typecheck && npx eslint . && npm test && npm run build
```
