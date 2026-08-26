# How the scheduler works

The scheduling engine lives in `packages/core/src/scheduling/` and is a pure,
deterministic module. Given the same input it always produces the same plan,
with the same block ids and the same explanations. It never performs I/O and it
never consults a model.

```ts
interface Scheduler {
  plan(input: SchedulingInput): SchedulingPlan;
}
```

## Input

```ts
{
  now, horizon, timezone,
  tasks,           // everything the user has to do
  events,          // normalised calendar events
  existingBlocks,  // what is already scheduled
  preferences,     // working hours, deep work, weights, automation, stability
  taskIds?,        // limit the run to specific tasks
  rebuild?         // discard the current plan and start over
}
```

## Step 1 - classify existing blocks

Every block already in the horizon is sorted into one of three buckets.

| Bucket   | When                                                                                       | Effect                         |
| -------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| frozen   | pinned, already started, inside the stability freeze window, or out of the requested scope | kept exactly as-is             |
| retained | still valid: inside working hours, no conflict, before the deadline                        | kept, but could move if needed |
| released | its task is finished, or it became invalid                                                 | freed for re-planning          |

Released blocks go into a per-task pool. When the task is re-placed, ids are
reused so the diff reports a **move** rather than a delete plus an add - which
means the calendar event is patched, not recreated.

## Step 2 - availability

```text
working hours
  − sleep hours
  − recurring blocks (lunch, gym, commute)
  − one-off blocked periods
  − busy calendar events
  − frozen and retained blocks
  = free windows
```

Windows are then split on local-day boundaries and deep-work boundaries, and
tagged with `dayKey` and `deepWork`. Splitting on local days is what makes daily
caps and DST-correct reporting possible.

Events do not consume time if they are cancelled, marked transparent/free, or
declined by the user. All-day events do not block time unless
`all_day_events_block_time` is set.

## Step 3 - score the tasks

There is no single opaque number. Each component is normalised to 0..1,
multiplied by a configurable weight, and carries the sentence that explains it:

| Component         | Measures                                           | Default weight |
| ----------------- | -------------------------------------------------- | -------------- |
| `deadlineUrgency` | how close the deadline is, relative to the horizon | 3              |
| `priority`        | declared priority (low → urgent)                   | 2              |
| `importance`      | long-term importance, independent of deadlines     | 1              |
| `deadlineRisk`    | remaining work ÷ capacity before the deadline      | 2.5            |
| `ageBonus`        | how long the task has been waiting                 | 0.5            |

```text
total = Σ weight × normalised
```

Ties break on deadline, then priority, then id, so the ordering is stable.
Dependencies are then applied: a task never precedes something it depends on.

The remaining weights (`fragmentationPenalty`, `contextSwitchPenalty`,
`earlyStartPreference`, `stabilityBonus`, `deepWorkAffinity`) are used when
choosing _where_ to place work rather than _what_ to place first.

## Step 4 - place the blocks

For each task in order:

1. Restrict candidate windows to `[max(now, earliestStart), min(deadline, horizon)]`.
2. Apply preferred days and preferred windows as a hard constraint. If nothing
   fits, retry without them and record `relaxedPreferences: true` in the reason.
3. Order the windows:
   - `earliest_fit` (default) - earliest day first, preferring deep-work windows
     within that day for focus-heavy tasks;
   - `best_fit` - a weighted score over earliness, contiguity, deep-work match
     and same-day continuity.
4. Take a chunk of `min(remaining, windowCapacity, maxBlock, dailyRemaining)`,
   snapped to the configured granularity, never smaller than the effective
   minimum block (which is itself capped by the work that is left, so a 20 minute
   remainder is still placeable).
5. If the leftover would be an unusable sliver, extend the chunk to swallow it.
6. Reserve the time (plus any inter-block buffer) and repeat until the task is
   done or no window fits.

Tasks that forbid splitting need a single window large enough for the whole job;
for those, the maximum block size is deliberately ignored.

## Step 5 - keep what cannot be improved

If a task ends up with unscheduled work and it had released blocks, those blocks
are restored provided they do not collide with a meeting or with anything newly
placed. A constrained search that fails never destroys work the user already had
scheduled.

## Step 6 - deadline risk

Risk is computed per task from remaining work, what the plan managed to schedule,
and the _suitable capacity before the deadline_ (measured ignoring competition
from other tasks).

| Level        | Condition                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `IMPOSSIBLE` | the deadline has passed, or capacity < remaining work                                                    |
| `CRITICAL`   | work is left unscheduled because higher-priority tasks took the time, or cover < `critical_ratio` (1.15) |
| `AT_RISK`    | cover < `at_risk_ratio` (1.5), or the last block ends within `deadline_buffer_minutes` of the deadline   |
| `SAFE`       | otherwise                                                                                                |

Each level comes with a sentence built from the actual numbers:

```text
"Distributed Systems Assignment" cannot be completed: 6h of work remains but only
3h 30m of suitable availability exists before Fri 13 Mar 17:00.
```

## Step 7 - quality

Seven metrics, each 0..1 with its own explanation, combined into a weighted
overall score:

`deadlineSatisfaction`, `priorityAlignment`, `stability`, `deepWorkPreservation`,
`fragmentation`, `contextSwitching`, `preferenceSatisfaction`.

`compareQuality(a, b)` answers "why is this schedule better than the previous
one?" with per-metric deltas - which is what makes it safe to swap in a smarter
algorithm later and actually measure whether it helped.

## Step 8 - diff and trace

The plan carries a structured diff (`added`, `moved`, `removed`, `unchanged`),
never a text blob, and a full trace: availability, ranking, every placement
decision, and every score component. `calendar-agent schedule --explain` prints
it.

## Stability

A schedule that churns is worse than one that is slightly suboptimal. Three
mechanisms protect it:

- valid blocks are retained by default;
- `stability.freeze_window_minutes` (default 120) freezes anything starting soon;
- `stability.max_moves_per_run` bounds how much a single run may rearrange.

Blocks the user moved by hand in their own calendar are pinned by the sync layer
and are never moved again.
