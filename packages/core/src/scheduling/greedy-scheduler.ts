import type { CalendarEvent } from '../domain/calendar.js';
import type { BlockId, TaskId } from '../domain/ids.js';
import type { SchedulingPreferences } from '../domain/preferences.js';
import type { ScheduleBlock } from '../domain/schedule.js';
import { blockMinutes, isLiveBlock } from '../domain/schedule.js';
import type { Task } from '../domain/task.js';
import {
  effectiveMaximumBlockMinutes,
  effectiveMinimumBlockMinutes,
  isSchedulable,
  remainingMinutes,
  unmetDependencies,
} from '../domain/task.js';
import { formatMinutes, round } from '../time/format.js';
import type { Instant } from '../time/instant.js';
import { ceilToMinutes, minutes as msFromMinutes, toMinutes } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import {
  clamp,
  contains,
  durationMinutes,
  isEmpty,
  mergeIntervals,
  overlaps,
} from '../time/interval.js';
import { describeInterval, expandWindowOnDay, localDayKey, weekdayOf } from '../time/wall-clock.js';
import type { AvailabilityResult, FreeWindow } from './availability.js';
import { AvailabilityLedger, capacityWithin, computeAvailability } from './availability.js';
import { buildScheduleDiff } from './diff.js';
import { stableHash } from './hash.js';
import { evaluateQuality } from './quality.js';
import { assessRisk } from './risk.js';
import { orderByDependencies, rankTasks } from './scoring.js';
import type {
  PlannedBlock,
  SchedulingInput,
  SchedulingPlan,
  Scheduler,
  TaskRisk,
  TaskScore,
  TraceStep,
  UnscheduledTask,
} from './types.js';
import { reason } from './types.js';

interface RetainedBlock {
  readonly block: ScheduleBlock;
  readonly frozen: boolean;
  readonly interval: Interval;
}

interface PlacementContext {
  readonly now: Instant;
  readonly horizon: Interval;
  readonly timezone: string;
  readonly prefs: SchedulingPreferences;
}

/**
 * Deterministic greedy scheduler.
 *
 * Tasks are ranked by an explainable score, then placed into the earliest
 * suitable window (or the best-scoring window, depending on the configured
 * strategy). Existing blocks are retained wherever they are still valid, so
 * the schedule only changes when there is a reason for it.
 *
 * This class performs no I/O and depends on nothing outside the domain.
 */
export class GreedyScheduler implements Scheduler {
  readonly name = 'greedy';

  plan(input: SchedulingInput): SchedulingPlan {
    const prefs = input.preferences;
    const timezone = input.timezone ?? prefs.timezone;
    const now = input.now;
    const horizon: Interval = {
      start: Math.max(input.horizon.start, now),
      end: input.horizon.end,
    };
    const steps: TraceStep[] = [];
    const runId =
      input.runId ??
      `run_${stableHash([now, horizon.start, horizon.end, ...input.tasks.map((t) => `${t.id}:${t.updatedAt}`)])}`;

    const tasksById = new Map(input.tasks.map((t) => [t.id, t]));
    const titles = new Map(input.tasks.map((t) => [t.id, t.title]));
    const scopeFilter = input.taskIds ? new Set(input.taskIds) : undefined;

    // ---- 1. classify existing blocks ------------------------------------
    const liveBlocks = input.existingBlocks.filter(isLiveBlock);
    const liveBlockIds = new Set(liveBlocks.map((b) => b.id));
    const inScope = liveBlocks.filter((b) => b.end > now && b.start < horizon.end);
    const previousForDiff = inScope;

    // Calendar events that mirror one of our own blocks must not be counted
    // twice: the ScheduleBlock is the source of truth for that time.
    const externalEvents = input.events.filter(
      (e: CalendarEvent) => e.blockId === undefined || !liveBlockIds.has(e.blockId),
    );

    // Availability ignoring our own blocks: used for validity checks, for
    // per-task capacity, and as the basis for placement.
    const baseAvailability = computeAvailability({
      range: horizon,
      now,
      timezone,
      preferences: prefs,
      events: externalEvents,
      reserved: [],
    });
    steps.push({
      step: 'availability',
      message: `${formatMinutes(baseAvailability.totalFreeMinutes)} of working time available across ${baseAvailability.windows.length} windows.`,
      details: {
        windows: baseAvailability.windows.length,
        freeMinutes: round(baseAvailability.totalFreeMinutes),
        busyIntervals: baseAvailability.busyIntervals.length,
      },
    });

    const { retained, released } = this.partitionBlocks({
      blocks: inScope,
      tasksById,
      scopeFilter,
      rebuild: input.rebuild ?? false,
      now,
      prefs,
      free: baseAvailability.freeIntervals,
      steps,
      timezone,
    });

    // ---- 2. work out which tasks to place --------------------------------
    const retainedMinutesByTask = new Map<TaskId, number>();
    for (const item of retained) {
      const usable = clamp(item.interval, { start: now, end: horizon.end });
      if (!usable) continue;
      retainedMinutesByTask.set(
        item.block.taskId,
        (retainedMinutesByTask.get(item.block.taskId) ?? 0) + durationMinutes(usable),
      );
    }

    const unscheduled: UnscheduledTask[] = [];
    const candidates: Task[] = [];
    for (const task of input.tasks) {
      if (scopeFilter && !scopeFilter.has(task.id)) continue;
      if (!isSchedulable(task)) {
        if (task.status === 'blocked') {
          unscheduled.push(
            this.blockedTask(task, retainedMinutesByTask.get(task.id) ?? 0, 'blocked'),
          );
        }
        continue;
      }
      const unmet = unmetDependencies(task, tasksById);
      if (unmet.length > 0) {
        unscheduled.push(
          this.blockedTask(task, retainedMinutesByTask.get(task.id) ?? 0, 'dependency', unmet),
        );
        continue;
      }
      candidates.push(task);
    }

    // ---- 3. rank ----------------------------------------------------------
    const capacityByTask = new Map<TaskId, number>();
    for (const task of candidates) {
      capacityByTask.set(
        task.id,
        this.capacityForTask(task, baseAvailability, now, horizon, prefs),
      );
    }
    const ranked = orderByDependencies(
      rankTasks(candidates, {
        now,
        horizonMs: Math.max(1, horizon.end - horizon.start),
        weights: prefs.weights,
        capacityByTask,
      }),
      candidates,
    );
    steps.push({
      step: 'ranking',
      message: `Ranked ${ranked.length} schedulable tasks.`,
      details: { order: ranked.map((s) => `${s.title} (${s.total})`) },
    });

    // ---- 4. place ---------------------------------------------------------
    const ledger = new AvailabilityLedger(
      subtractReserved(
        baseAvailability.windows,
        retained.map((r) => r.interval),
      ),
    );
    const releasedByTask = new Map<TaskId, ScheduleBlock[]>();
    for (const block of released) {
      const list = releasedByTask.get(block.taskId);
      if (list) list.push(block);
      else releasedByTask.set(block.taskId, [block]);
    }

    const idFactory = new BlockIdFactory(runId, liveBlockIds);
    const placed: PlannedBlock[] = [];
    const ctx: PlacementContext = { now, horizon, timezone, prefs };

    for (const score of ranked) {
      const task = tasksById.get(score.taskId);
      if (!task) continue;
      const alreadyRetained = retainedMinutesByTask.get(task.id) ?? 0;
      const needed = Math.max(0, remainingMinutes(task) - alreadyRetained);
      const startSequence = retained.filter((r) => r.block.taskId === task.id).length ?? 0;
      if (needed <= 0) {
        steps.push({
          step: 'placement',
          message: `"${task.title}" is already fully covered by retained blocks.`,
          details: { taskId: task.id, retainedMinutes: alreadyRetained },
        });
        continue;
      }
      const result = this.placeTask({
        task,
        needed,
        ledger,
        ctx,
        pool: releasedByTask.get(task.id) ?? [],
        idFactory,
        startSequence,
      });
      placed.push(...result.blocks);
      steps.push({
        step: 'placement',
        message: result.blocks.length
          ? `Scheduled ${formatMinutes(result.scheduledMinutes)} of "${task.title}" across ${result.blocks.length} block(s).`
          : `Could not schedule "${task.title}": ${result.failure?.message ?? 'no suitable window'}`,
        details: { taskId: task.id, scheduledMinutes: result.scheduledMinutes, needed },
      });
      const missing = needed - result.scheduledMinutes;
      if (missing > 0) {
        unscheduled.push({
          taskId: task.id,
          title: task.title,
          remainingMinutes: remainingMinutes(task),
          scheduledMinutes: result.scheduledMinutes + alreadyRetained,
          missingMinutes: round(missing),
          reason:
            result.failure ??
            reason(
              'placement.insufficient_capacity',
              `Only ${formatMinutes(result.scheduledMinutes)} of ${formatMinutes(needed)} could be placed before the deadline.`,
              { taskId: task.id, missingMinutes: round(missing) },
            ),
        });
      }
    }

    // Released blocks that were never reused would otherwise disappear. Work
    // the user already had scheduled is only dropped when it was actually
    // replaced: if a task could not be placed, its old block is restored so a
    // failed constrained search never destroys existing plans.
    const usedPoolIds = new Set(placed.filter((b) => b.origin === 'moved').map((b) => b.id));
    const shortfall = new Map(unscheduled.map((entry) => [entry.taskId, entry]));
    const occupied: Interval[] = [
      ...retained.map((item) => item.interval),
      ...placed.map((block) => ({ start: block.start, end: block.end })),
    ];

    for (const block of released) {
      if (usedPoolIds.has(block.id)) continue;
      const missing = shortfall.get(block.taskId);
      const usable: Interval = { start: Math.max(block.start, now), end: block.end };

      const restorable =
        missing !== undefined &&
        missing.missingMinutes > 0 &&
        !isEmpty(usable) &&
        !baseAvailability.busyIntervals.some((busy) => overlaps(busy, usable)) &&
        !occupied.some((taken) => overlaps(taken, usable));

      if (restorable) {
        retained.push({ block, frozen: true, interval: usable });
        occupied.push(usable);
        const kept = durationMinutes(usable);
        const remaining = round(missing.missingMinutes - kept, 4);
        shortfall.set(block.taskId, { ...missing, missingMinutes: Math.max(0, remaining) });
        steps.push({
          step: 'release',
          message: `Kept the existing block for "${titles.get(block.taskId) ?? block.taskId}" at ${describeInterval(block, timezone)} because no better slot was found.`,
          details: { blockId: block.id, restored: true },
        });
        continue;
      }

      steps.push({
        step: 'release',
        message: `Dropped block for "${titles.get(block.taskId) ?? block.taskId}" at ${describeInterval(block, timezone)}.`,
        details: { blockId: block.id },
      });
    }

    // Drop shortfall entries that restoration fully covered.
    for (let i = unscheduled.length - 1; i >= 0; i -= 1) {
      const entry = unscheduled[i]!;
      const updated = shortfall.get(entry.taskId);
      if (updated === undefined || updated === entry) continue;
      if (updated.missingMinutes <= 0) unscheduled.splice(i, 1);
      else unscheduled[i] = updated;
    }

    const retainedPlanned: PlannedBlock[] = retained.map((item) => ({
      id: item.block.id,
      taskId: item.block.taskId,
      sequence: item.block.sequence,
      start: item.block.start,
      end: item.block.end,
      timezone,
      minutes: blockMinutes(item.block),
      origin: 'retained' as const,
      deepWork: isInsideDeepWork(item.interval, baseAvailability),
      reason: reason(
        item.frozen ? 'placement.frozen' : 'placement.retained',
        item.frozen
          ? `Kept at ${describeInterval(item.block, timezone)}: the block is pinned, already started, or no better slot was found.`
          : `Kept at ${describeInterval(item.block, timezone)}: it is still valid, so it was not moved.`,
        { blockId: item.block.id, frozen: item.frozen },
      ),
    }));

    const blocks = [...retainedPlanned, ...placed].sort((a, b) => a.start - b.start);

    // ---- 5. risk, quality, diff ------------------------------------------
    const scheduledByTask = new Map<TaskId, number>();
    const lastEndByTask = new Map<TaskId, Instant>();
    for (const block of blocks) {
      scheduledByTask.set(block.taskId, (scheduledByTask.get(block.taskId) ?? 0) + block.minutes);
      lastEndByTask.set(block.taskId, Math.max(lastEndByTask.get(block.taskId) ?? 0, block.end));
    }

    const risks: TaskRisk[] = [];
    for (const task of input.tasks) {
      if (!isSchedulable(task) && task.status !== 'blocked') continue;
      if (scopeFilter && !scopeFilter.has(task.id) && !scheduledByTask.has(task.id)) continue;
      const capacity =
        capacityByTask.get(task.id) ??
        this.capacityForTask(task, baseAvailability, now, horizon, prefs);
      const lastEnd = lastEndByTask.get(task.id);
      risks.push(
        assessRisk({
          task,
          now,
          timezone,
          scheduledMinutes: scheduledByTask.get(task.id) ?? 0,
          availableMinutesBeforeDeadline: capacity,
          thresholds: prefs.riskThresholds,
          ...(lastEnd === undefined ? {} : { lastBlockEnd: lastEnd }),
        }),
      );
    }

    const diff = buildScheduleDiff({
      previous: previousForDiff,
      planned: blocks,
      titles,
      timezone,
    });
    const quality = evaluateQuality({
      blocks,
      tasks: candidates,
      previousBlocks: previousForDiff,
      scores: ranked,
      unscheduled,
      timezone,
    });

    return {
      runId,
      generatedAt: now,
      horizon,
      timezone,
      blocks,
      unscheduled,
      risks: risks.sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity)),
      quality,
      diff,
      remainingWindows: ledger.list(),
      trace: {
        runId,
        generatedAt: now,
        input: {
          now,
          horizon,
          timezone,
          taskCount: input.tasks.length,
          eventCount: input.events.length,
          existingBlockCount: input.existingBlocks.length,
          availableMinutes: round(baseAvailability.totalFreeMinutes),
        },
        scores: ranked as readonly TaskScore[],
        steps,
      },
    };
  }

  // --------------------------------------------------------------------------

  private blockedTask(
    task: Task,
    scheduledMinutes: number,
    kind: 'blocked' | 'dependency',
    unmet: readonly TaskId[] = [],
  ): UnscheduledTask {
    const remaining = remainingMinutes(task);
    return {
      taskId: task.id,
      title: task.title,
      remainingMinutes: remaining,
      scheduledMinutes,
      missingMinutes: Math.max(0, remaining - scheduledMinutes),
      reason:
        kind === 'blocked'
          ? reason('task.blocked', `"${task.title}" is marked as blocked and was not scheduled.`, {
              taskId: task.id,
            })
          : reason(
              'task.blocked_by_dependency',
              `"${task.title}" waits on ${unmet.length} unfinished dependency task(s).`,
              { taskId: task.id, dependsOn: [...unmet] },
            ),
    };
  }

  /** Suitable capacity for a task before its deadline, ignoring other tasks. */
  private capacityForTask(
    task: Task,
    availability: AvailabilityResult,
    now: Instant,
    horizon: Interval,
    prefs: SchedulingPreferences,
  ): number {
    const bounds: Interval = {
      start: Math.max(now, task.earliestStart ?? now),
      end: Math.min(task.deadline ?? horizon.end, horizon.end),
    };
    if (isEmpty(bounds)) return 0;
    const minChunk = effectiveMinimumBlockMinutes(task, prefs.minimumBlockMinutes);
    const windows = this.constrainWindows(
      availability.windows,
      task,
      bounds,
      prefs.timezone,
      false,
    );
    return capacityWithin(windows, bounds, minChunk);
  }

  /** Apply per-task constraints to the candidate windows. */
  private constrainWindows(
    windows: readonly FreeWindow[],
    task: Task,
    bounds: Interval,
    timezone: string,
    strictPreferences: boolean,
  ): FreeWindow[] {
    const result: FreeWindow[] = [];
    for (const window of windows) {
      const clipped = clamp(window, bounds);
      if (!clipped || isEmpty(clipped)) continue;
      let candidate: FreeWindow = { ...window, start: clipped.start, end: clipped.end };
      if (strictPreferences) {
        if (task.preferredDays.length > 0) {
          const weekday = weekdayOf(candidate.start, timezone);
          if (!task.preferredDays.includes(weekday)) continue;
        }
        if (task.preferredWindows.length > 0) {
          const dayKey = localDayKey(candidate.start, timezone);
          let matched: FreeWindow | null = null;
          for (const preferred of task.preferredWindows) {
            const expanded = expandWindowOnDay(dayKey, preferred, timezone);
            if (!expanded) continue;
            const overlap = clamp(candidate, expanded);
            if (overlap && !isEmpty(overlap)) {
              matched = { ...candidate, start: overlap.start, end: overlap.end };
              break;
            }
          }
          if (!matched) continue;
          candidate = matched;
        }
      }
      result.push(candidate);
    }
    return result;
  }

  private orderWindows(
    windows: readonly FreeWindow[],
    task: Task,
    ctx: PlacementContext,
    lastPlacedDay: string | undefined,
  ): FreeWindow[] {
    const prefersDeep = task.focus === 'deep' && ctx.prefs.deepWork.enabled;
    const reserved = ctx.prefs.deepWork.reserveForFocusTasks && task.focus !== 'deep';
    const focusPenalty = (w: FreeWindow): number => {
      if (prefersDeep) return w.deepWork ? 0 : 1;
      if (reserved) return w.deepWork ? 1 : 0;
      return 0;
    };

    if (ctx.prefs.placementStrategy === 'earliest_fit') {
      return [...windows].sort(
        (a, b) =>
          a.dayKey.localeCompare(b.dayKey) ||
          focusPenalty(a) - focusPenalty(b) ||
          a.start - b.start,
      );
    }

    const span = Math.max(1, ctx.horizon.end - ctx.horizon.start);
    const w = ctx.prefs.weights;
    const score = (window: FreeWindow): number => {
      const earliness = 1 - (window.start - ctx.horizon.start) / span;
      const capacity = durationMinutes(window);
      const contiguity = Math.min(1, capacity / Math.max(1, ctx.prefs.maximumBlockMinutes));
      const deepMatch = prefersDeep
        ? window.deepWork
          ? 1
          : 0
        : reserved && window.deepWork
          ? -1
          : 0;
      const continuity = lastPlacedDay !== undefined && window.dayKey === lastPlacedDay ? 1 : 0;
      return (
        w.earlyStartPreference * earliness +
        w.fragmentationPenalty * contiguity +
        w.deepWorkAffinity * deepMatch +
        w.contextSwitchPenalty * continuity
      );
    };
    return [...windows].sort((a, b) => score(b) - score(a) || a.start - b.start);
  }

  private placeTask(params: {
    task: Task;
    needed: number;
    ledger: AvailabilityLedger;
    ctx: PlacementContext;
    pool: readonly ScheduleBlock[];
    idFactory: BlockIdFactory;
    startSequence: number;
  }): { blocks: PlannedBlock[]; scheduledMinutes: number; failure?: ReturnType<typeof reason> } {
    const { task, ctx, ledger, idFactory } = params;
    const prefs = ctx.prefs;
    const bounds: Interval = {
      start: Math.max(ctx.now, task.earliestStart ?? ctx.now),
      end: Math.min(task.deadline ?? ctx.horizon.end, ctx.horizon.end),
    };

    if (isEmpty(bounds)) {
      return {
        blocks: [],
        scheduledMinutes: 0,
        failure: reason(
          'placement.no_time_range',
          `"${task.title}" has no usable time range before its deadline.`,
          { taskId: task.id, bounds },
        ),
      };
    }

    const hasPreferences = task.preferredWindows.length > 0 || task.preferredDays.length > 0;
    let relaxed = false;
    let candidates = this.constrainWindows(
      ledger.list(),
      task,
      bounds,
      ctx.timezone,
      hasPreferences,
    );
    if (hasPreferences && candidates.length === 0) {
      relaxed = true;
      candidates = this.constrainWindows(ledger.list(), task, bounds, ctx.timezone, false);
    }

    const splittable = task.allowSplitting && prefs.allowTaskSplitting;
    const minBlockBase = effectiveMinimumBlockMinutes(task, prefs.minimumBlockMinutes);
    const maxBlock = splittable
      ? effectiveMaximumBlockMinutes(task, prefs.maximumBlockMinutes)
      : Number.POSITIVE_INFINITY;
    const granularity = Math.max(1, prefs.granularityMinutes);

    const blocks: PlannedBlock[] = [];
    const pool = [...params.pool].sort((a, b) => a.sequence - b.sequence);
    let remaining = params.needed;
    let sequence = params.startSequence;
    let lastDay: string | undefined;
    let attempted = 0;

    while (remaining > 0) {
      const ordered = this.orderWindows(
        this.constrainWindows(
          ledger.list(),
          task,
          bounds,
          ctx.timezone,
          hasPreferences && !relaxed,
        ),
        task,
        ctx,
        lastDay,
      );
      const minBlock = Math.min(minBlockBase, remaining);
      let placedThisRound = false;

      const isFirstBlock = params.startSequence === 0 && blocks.length === 0;
      for (const window of ordered) {
        attempted += 1;
        const start = ceilToMinutes(window.start, granularity);
        const capacity = toMinutes(window.end - start);
        if (capacity < minBlock) continue;
        // A task with a latest-start must actually begin by then.
        if (isFirstBlock && task.latestStart !== undefined && start > task.latestStart) continue;

        const dayRemaining =
          prefs.maxDailyTaskMinutes === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, prefs.maxDailyTaskMinutes - ledger.minutesUsedOnDay(window.dayKey));
        if (dayRemaining < minBlock) continue;

        if (!splittable && capacity < remaining) continue;

        let chunk = Math.min(remaining, capacity, maxBlock, dayRemaining);
        if (chunk < remaining) chunk = Math.floor(chunk / granularity) * granularity;
        if (chunk < minBlock) continue;

        // Avoid leaving a sliver of time too small to ever be used.
        const slack = capacity - chunk;
        if (chunk < remaining && slack > 0 && slack < minBlockBase) {
          chunk = Math.min(capacity, maxBlock, dayRemaining, remaining);
        }

        const interval: Interval = { start, end: start + msFromMinutes(chunk) };
        const recycled = pool.shift();
        const id = recycled ? recycled.id : idFactory.next();
        blocks.push({
          id,
          taskId: task.id,
          sequence,
          start: interval.start,
          end: interval.end,
          timezone: ctx.timezone,
          minutes: chunk,
          origin: recycled ? 'moved' : 'new',
          deepWork: window.deepWork,
          ...(recycled ? { previous: { start: recycled.start, end: recycled.end } } : {}),
          reason: reason(
            recycled ? 'placement.moved' : 'placement.new',
            recycled
              ? `Moved "${task.title}" from ${describeInterval(recycled, ctx.timezone)} to ${describeInterval(interval, ctx.timezone)} because the original slot was no longer usable.`
              : `Scheduled ${formatMinutes(chunk)} of "${task.title}" at ${describeInterval(interval, ctx.timezone)}${window.deepWork ? ' inside a deep-work window' : ''}${relaxed ? ', relaxing the preferred-time constraint because nothing else fitted' : ''}.`,
            {
              taskId: task.id,
              minutes: chunk,
              strategy: prefs.placementStrategy,
              deepWork: window.deepWork,
              relaxedPreferences: relaxed,
              windowMinutes: round(durationMinutes(window)),
            },
          ),
        });

        ledger.reserve(interval, prefs.bufferBetweenBlocksMinutes, window.dayKey);
        remaining = round(remaining - chunk, 4);
        sequence += 1;
        lastDay = window.dayKey;
        placedThisRound = true;
        break;
      }

      if (!placedThisRound) break;
      if (!splittable) break;
    }

    const scheduledMinutes = round(params.needed - Math.max(0, remaining), 4);
    if (blocks.length === 0) {
      return {
        blocks,
        scheduledMinutes: 0,
        failure: reason(
          splittable ? 'placement.no_window' : 'placement.no_contiguous_window',
          splittable
            ? `No free window of at least ${formatMinutes(Math.min(minBlockBase, params.needed))} was found for "${task.title}" before its deadline.`
            : `"${task.title}" cannot be split and no single free window of ${formatMinutes(params.needed)} exists before its deadline.`,
          { taskId: task.id, windowsConsidered: attempted },
        ),
      };
    }
    return { blocks, scheduledMinutes };
  }

  /** Decide which existing blocks stay put and which are freed for re-planning. */
  private partitionBlocks(params: {
    blocks: readonly ScheduleBlock[];
    tasksById: ReadonlyMap<TaskId, Task>;
    scopeFilter: ReadonlySet<TaskId> | undefined;
    rebuild: boolean;
    now: Instant;
    prefs: SchedulingPreferences;
    free: readonly Interval[];
    steps: TraceStep[];
    timezone: string;
  }): { retained: RetainedBlock[]; released: ScheduleBlock[] } {
    const retained: RetainedBlock[] = [];
    const released: ScheduleBlock[] = [];
    const freezeUntil = params.now + msFromMinutes(params.prefs.stability.freezeWindowMinutes);
    const free = mergeIntervals(params.free);
    let moves = 0;

    for (const block of params.blocks) {
      const task = params.tasksById.get(block.taskId);
      const usable: Interval = { start: Math.max(block.start, params.now), end: block.end };

      if (!task || !isSchedulable(task)) {
        released.push(block);
        params.steps.push({
          step: 'retention',
          message: `Released block at ${describeInterval(block, params.timezone)}: its task is no longer active.`,
          details: { blockId: block.id, taskId: block.taskId },
        });
        continue;
      }

      const outOfScope = params.scopeFilter !== undefined && !params.scopeFilter.has(block.taskId);
      const started = block.start <= params.now;
      const frozen =
        outOfScope || started || block.pinned || task.pinned || block.start < freezeUntil;

      if (frozen) {
        retained.push({ block, frozen: true, interval: usable });
        continue;
      }

      if (params.rebuild) {
        released.push(block);
        continue;
      }

      const valid = this.isBlockStillValid(block, free, task);
      if (!valid) {
        // Churn budget: once this run has moved enough, leave the rest alone
        // and let the next run deal with them.
        if (moves >= params.prefs.stability.maxMovesPerRun) {
          retained.push({ block, frozen: true, interval: usable });
          params.steps.push({
            step: 'retention',
            message: `Left block at ${describeInterval(block, params.timezone)} in place: this run has already reached its move limit.`,
            details: { blockId: block.id, maxMovesPerRun: params.prefs.stability.maxMovesPerRun },
          });
          continue;
        }
        moves += 1;
        released.push(block);
        params.steps.push({
          step: 'retention',
          message: `Released block at ${describeInterval(block, params.timezone)}: it conflicts with the current calendar or constraints.`,
          details: { blockId: block.id, taskId: block.taskId },
        });
        continue;
      }

      retained.push({ block, frozen: false, interval: usable });
    }

    return { retained, released };
  }

  private isBlockStillValid(block: ScheduleBlock, free: readonly Interval[], task: Task): boolean {
    if (task.deadline !== undefined && block.end > task.deadline) return false;
    if (task.earliestStart !== undefined && block.start < task.earliestStart) return false;
    return free.some((window) => contains(window, { start: block.start, end: block.end }));
  }
}

/** Remove already-committed intervals from the tagged windows. */
function subtractReserved(
  windows: readonly FreeWindow[],
  reserved: readonly Interval[],
): FreeWindow[] {
  if (reserved.length === 0) return [...windows];
  const cuts = mergeIntervals(reserved);
  const result: FreeWindow[] = [];
  for (const window of windows) {
    let pieces: FreeWindow[] = [window];
    for (const cut of cuts) {
      const next: FreeWindow[] = [];
      for (const piece of pieces) {
        if (piece.end <= cut.start || piece.start >= cut.end) {
          next.push(piece);
          continue;
        }
        if (piece.start < cut.start) next.push({ ...piece, end: cut.start });
        if (cut.end < piece.end) next.push({ ...piece, start: cut.end });
      }
      pieces = next;
    }
    result.push(...pieces.filter((p) => !isEmpty(p)));
  }
  return result.sort((a, b) => a.start - b.start);
}

function isInsideDeepWork(interval: Interval, availability: AvailabilityResult): boolean {
  return availability.deepWorkIntervals.some((deep) => contains(deep, interval));
}

/** Generates deterministic, collision-free block ids for one planning run. */
class BlockIdFactory {
  private counter = 0;
  constructor(
    private readonly runId: string,
    private readonly taken: ReadonlySet<BlockId>,
  ) {}

  next(): BlockId {
    for (;;) {
      this.counter += 1;
      const id = `blk_${this.runId}_${this.counter}`;
      if (!this.taken.has(id)) return id;
    }
  }
}
