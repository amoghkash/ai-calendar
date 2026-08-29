import type { CalendarEvent } from '../domain/calendar.js';
import { blocksTime, eventInterval } from '../domain/calendar.js';
import type { SchedulingPreferences } from '../domain/preferences.js';
import type { Instant } from '../time/instant.js';
import { minutes as msFromMinutes, toMinutes } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import {
  clamp,
  durationMinutes,
  intersectIntervals,
  isEmpty,
  mergeIntervals,
  sortIntervals,
  subtractIntervals,
} from '../time/interval.js';
import {
  eachLocalDay,
  expandWeeklySchedule,
  localDayInterval,
  localDayKey,
} from '../time/wall-clock.js';

/** A contiguous piece of schedulable time, tagged for reporting and placement. */
export interface FreeWindow extends Interval {
  /** Local calendar day the window belongs to (`YYYY-MM-DD`). */
  readonly dayKey: string;
  /** True when the window lies inside a configured deep-work period. */
  readonly deepWork: boolean;
}

/**
 * What counts as time you could in principle use.
 *
 * `working_hours` is right for work: the scheduler places task blocks, and it
 * has no business filling your evening. `waking_hours` is right for everything
 * else - a friend's lunch on a Saturday, dinner at 7 - where the working-hours
 * basis would report no availability at all and be confidently wrong about it.
 *
 * Sleep, recurring blocks, blocked periods and real events are subtracted from
 * either basis, so `waking_hours` is a wider question, not a laxer one.
 */
export type AvailabilityBasis = 'working_hours' | 'waking_hours';

export interface AvailabilityRequest {
  readonly range: Interval;
  readonly now: Instant;
  readonly timezone: string;
  readonly preferences: SchedulingPreferences;
  readonly events: readonly CalendarEvent[];
  /** Already-committed time (retained task blocks, pending placements). */
  readonly reserved?: readonly Interval[];
  /** Defaults to `working_hours`, which is what task scheduling wants. */
  readonly basis?: AvailabilityBasis;
}

export interface AvailabilityResult {
  readonly windows: readonly FreeWindow[];
  /** Free time before it is split by local day and deep-work boundaries. */
  readonly freeIntervals: readonly Interval[];
  /** The basis before anything was subtracted from it. */
  readonly workingIntervals: readonly Interval[];
  readonly busyIntervals: readonly Interval[];
  readonly deepWorkIntervals: readonly Interval[];
  readonly totalFreeMinutes: number;
}

/**
 * Turn working hours, sleep, recurring blocks, one-off blocks and calendar
 * events into the set of windows in which task work may be placed.
 *
 * Pure: same inputs always produce the same windows.
 */
export function computeAvailability(request: AvailabilityRequest): AvailabilityResult {
  const { preferences: prefs, timezone, range } = request;
  const effectiveRange: Interval = {
    start: Math.max(range.start, request.now),
    end: range.end,
  };
  if (isEmpty(effectiveRange)) {
    return {
      windows: [],
      freeIntervals: [],
      workingIntervals: [],
      busyIntervals: [],
      deepWorkIntervals: [],
      totalFreeMinutes: 0,
    };
  }

  // The whole span for a waking-hours question; sleep and commitments are
  // subtracted below either way.
  const working =
    request.basis === 'waking_hours'
      ? [effectiveRange]
      : expandWeeklySchedule(prefs.workingHours, effectiveRange, timezone);
  const sleep = expandWeeklySchedule(prefs.sleepHours, effectiveRange, timezone);
  const recurring = expandWeeklySchedule(prefs.recurringBlocks, effectiveRange, timezone);
  const oneOff = prefs.blockedPeriods
    .map((p) => clamp({ start: p.start, end: p.end }, effectiveRange))
    .filter((i): i is Interval => i !== null);

  const busy = prefs.protectExistingEvents
    ? mergeIntervals(
        request.events
          .filter((e) => blocksTime(e, { allDayBlocksTime: prefs.allDayEventsBlockTime }))
          .map(eventInterval)
          .map((i) => clamp(i, effectiveRange))
          .filter((i): i is Interval => i !== null),
      )
    : [];

  /**
   * Placement keeps clear of a commitment by the buffer on each side, so work
   * never starts the second a meeting ends or run right up to the second one
   * begins. The unpadded `busy` set is kept separately and returned as-is:
   * "is this time taken" is a different question from "may work start here",
   * and the caller uses the first to decide whether an existing block is still
   * valid.
   */
  const bufferMs = msFromMinutes(Math.max(0, prefs.bufferBetweenBlocksMinutes));
  const busyForPlacement =
    bufferMs === 0
      ? busy
      : mergeIntervals(busy.map((i) => ({ start: i.start - bufferMs, end: i.end + bufferMs })));

  const reserved = mergeIntervals([...(request.reserved ?? [])]);

  const free = subtractIntervals(working, [
    ...sleep,
    ...recurring,
    ...oneOff,
    ...busyForPlacement,
    ...reserved,
  ]);

  const deepWorkIntervals = prefs.deepWork.enabled
    ? expandWeeklySchedule(prefs.deepWork.schedule, effectiveRange, timezone)
    : [];

  const windows = tagWindows(free, deepWorkIntervals, timezone);

  return {
    windows,
    freeIntervals: free,
    workingIntervals: working,
    busyIntervals: busy,
    deepWorkIntervals,
    totalFreeMinutes: windows.reduce((sum, w) => sum + durationMinutes(w), 0),
  };
}

/** Split free intervals on local-day and deep-work boundaries, then tag them. */
function tagWindows(
  free: readonly Interval[],
  deepWorkIntervals: readonly Interval[],
  timezone: string,
): FreeWindow[] {
  // Split on deep-work boundaries first, then on local days. Doing it in this
  // order matters: the interval helpers re-merge adjacent pieces, which would
  // otherwise undo the day split at midnight.
  const deepParts = splitByLocalDay(intersectIntervals(free, deepWorkIntervals), timezone);
  const shallowParts = splitByLocalDay(subtractIntervals(free, deepWorkIntervals), timezone);
  const windows: FreeWindow[] = [
    ...deepParts.map((i) => ({ ...i, dayKey: localDayKey(i.start, timezone), deepWork: true })),
    ...shallowParts.map((i) => ({ ...i, dayKey: localDayKey(i.start, timezone), deepWork: false })),
  ];
  return windows.filter((w) => !isEmpty(w)).sort((a, b) => a.start - b.start || a.end - b.end);
}

export function splitByLocalDay(intervals: readonly Interval[], timezone: string): Interval[] {
  const result: Interval[] = [];
  for (const i of sortIntervals(intervals)) {
    for (const dayKey of eachLocalDay(i, timezone)) {
      const piece = clamp(i, localDayInterval(dayKey, timezone));
      if (piece && !isEmpty(piece)) result.push(piece);
    }
  }
  return result;
}

/**
 * Mutable view over the available windows used while placing blocks.
 * Reserving time removes it (plus any configured buffer) from the ledger.
 */
export class AvailabilityLedger {
  private windows: FreeWindow[];
  private readonly dayUsage = new Map<string, number>();
  /** Per-task day usage, keyed by `taskDayKey`. Backs the per-task daily cap. */
  private readonly taskDayUsage = new Map<string, number>();

  constructor(windows: readonly FreeWindow[]) {
    this.windows = [...windows].sort((a, b) => a.start - b.start);
  }

  list(): readonly FreeWindow[] {
    return this.windows;
  }

  totalMinutes(): number {
    return this.windows.reduce((sum, w) => sum + durationMinutes(w), 0);
  }

  minutesUsedOnDay(dayKey: string): number {
    return this.dayUsage.get(dayKey) ?? 0;
  }

  /** Minutes of one task already committed to one local day. */
  minutesUsedOnDayByTask(taskId: string, dayKey: string): number {
    return this.taskDayUsage.get(taskDayKey(taskId, dayKey)) ?? 0;
  }

  /** Remove `used`, padded by `bufferMinutes` on **both** sides, from availability. */
  reserve(used: Interval, bufferMinutes = 0, dayKey?: string, taskId?: string): void {
    const day = dayKey ?? localDayKeyOf(used.start, this.windows);
    // Both sides, not just the end: a later block can be placed before an
    // earlier one under `best_fit`, and would otherwise butt straight up to it.
    const pad = msFromMinutes(bufferMinutes);
    const cut: Interval = { start: used.start - pad, end: used.end + pad };
    const next: FreeWindow[] = [];
    for (const window of this.windows) {
      if (window.end <= cut.start || window.start >= cut.end) {
        next.push(window);
        continue;
      }
      if (window.start < cut.start) {
        next.push({ ...window, end: cut.start });
      }
      if (cut.end < window.end) {
        next.push({ ...window, start: cut.end });
      }
    }
    this.windows = next.filter((w) => !isEmpty(w));
    if (day !== undefined) {
      this.recordDayUsage(day, durationMinutes(used), taskId);
    }
  }

  /** Record usage against a specific local day (used with the daily caps). */
  recordDayUsage(dayKey: string, minutesUsed: number, taskId?: string): void {
    this.dayUsage.set(dayKey, (this.dayUsage.get(dayKey) ?? 0) + minutesUsed);
    if (taskId !== undefined) this.recordTaskDayUsage(taskId, dayKey, minutesUsed);
  }

  /**
   * Charge one task's daily allowance without touching the shared day total.
   *
   * Used to seed retained blocks, which have already consumed a task's cap but
   * were never counted against the global one; folding them into `dayUsage`
   * here would quietly tighten that separate, pre-existing budget.
   */
  recordTaskDayUsage(taskId: string, dayKey: string, minutesUsed: number): void {
    const key = taskDayKey(taskId, dayKey);
    this.taskDayUsage.set(key, (this.taskDayUsage.get(key) ?? 0) + minutesUsed);
  }

  clone(): AvailabilityLedger {
    const copy = new AvailabilityLedger(this.windows);
    for (const [day, used] of this.dayUsage) copy.dayUsage.set(day, used);
    for (const [key, used] of this.taskDayUsage) copy.taskDayUsage.set(key, used);
    return copy;
  }
}

/** Task ids are caller-supplied, so the two halves are joined by a unit
 * separator rather than by a delimiter an id could itself contain. */
const taskDayKey = (taskId: string, dayKey: string): string =>
  `${taskId}\u001f${dayKey}`;

function localDayKeyOf(instant: Instant, windows: readonly FreeWindow[]): string | undefined {
  return windows.find((w) => w.start <= instant && instant < w.end)?.dayKey;
}

/** Total minutes available inside a set of windows, restricted to `bounds`. */
export function capacityWithin(
  windows: readonly Interval[],
  bounds: Interval,
  minimumChunkMinutes = 0,
): number {
  return windows
    .map((w) => clamp(w, bounds))
    .filter((w): w is Interval => w !== null && !isEmpty(w))
    .filter((w) => durationMinutes(w) >= minimumChunkMinutes)
    .reduce((sum, w) => sum + durationMinutes(w), 0);
}

export const minutesBetween = (a: Instant, b: Instant): number => toMinutes(Math.max(0, b - a));
