import type { DailyWindow } from '../time/wall-clock.js';
import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import { expandDailyWindows, localDayInterval, localDayKey } from '../time/wall-clock.js';

export interface SlotProposalOptions {
  readonly durationMinutes: number;
  readonly timezone: string;
  /** Time-of-day bands the activity belongs in, e.g. 11:30-14:00 for lunch. */
  readonly preferredWindows?: readonly DailyWindow[];
  readonly maxSlots?: number;
  /** Offering three times on one day reads as pestering, not as flexibility. */
  readonly maxPerDay?: number;
  readonly granularityMinutes?: number;
  /** Nobody can answer a text and show up ten minutes later. */
  readonly leadTimeMinutes?: number;
}

const DEFAULTS = {
  maxSlots: 3,
  maxPerDay: 1,
  granularityMinutes: 15,
  leadTimeMinutes: 120,
} as const;

/**
 * Turn free time into a few times you could actually offer someone.
 *
 * This exists because free/busy and a proposal are different things. The
 * availability engine answers "when am I not busy", which for a normal week is
 * an enormous span. A message has to name two or three specific times, spread
 * across different days, at hours that suit the activity.
 *
 * It is pure and deterministic: the same calendar always yields the same offer,
 * which matters because the alternative is a message whose contents nobody can
 * reproduce or explain.
 */
export function proposeSlots(
  free: readonly Interval[],
  now: Instant,
  options: SlotProposalOptions,
): readonly Interval[] {
  const maxSlots = options.maxSlots ?? DEFAULTS.maxSlots;
  const maxPerDay = options.maxPerDay ?? DEFAULTS.maxPerDay;
  const granularity = options.granularityMinutes ?? DEFAULTS.granularityMinutes;
  const lead = (options.leadTimeMinutes ?? DEFAULTS.leadTimeMinutes) * 60_000;
  const duration = options.durationMinutes * 60_000;
  if (free.length === 0 || duration <= 0 || maxSlots <= 0) return [];

  const usable = restrictToBands(free, options);
  const earliest = now + lead;

  const perDay = new Map<string, Interval[]>();
  for (const window of [...usable].sort((a, b) => a.start - b.start)) {
    // Walk the window rather than taking only its first slot: "lunch tomorrow"
    // has one window to offer from, and one option reads as take-it-or-leave-it.
    let cursor = snapUp(Math.max(window.start, earliest), granularity, options.timezone);
    while (cursor + duration <= window.end) {
      const dayKey = localDayKey(cursor, options.timezone);
      const taken = perDay.get(dayKey) ?? [];
      if (taken.length >= maxPerDay) break;

      const slot = { start: cursor, end: cursor + duration };
      const clashes = taken.some((other) => slot.start < other.end && other.start < slot.end);
      if (!clashes) {
        taken.push(slot);
        perDay.set(dayKey, taken);
      }
      cursor = snapUp(cursor + duration, granularity, options.timezone);
    }
  }

  return [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, slots]) => slots)
    .sort((a, b) => a.start - b.start)
    .slice(0, maxSlots);
}

/**
 * The longest stretch that was available inside the activity's own hours.
 *
 * When nothing fits, this is the difference between "no free time" - which
 * reads as broken to someone looking at an obviously empty calendar - and "the
 * longest gap was 45 minutes", which is actionable.
 */
export function longestUsableMinutes(
  free: readonly Interval[],
  options: SlotProposalOptions,
): number {
  const usable = restrictToBands(free, options);
  let longest = 0;
  for (const interval of usable) {
    longest = Math.max(longest, (interval.end - interval.start) / 60_000);
  }
  return Math.floor(longest);
}

/** Clip free time down to the hours the activity belongs in. */
function restrictToBands(
  free: readonly Interval[],
  options: SlotProposalOptions,
): readonly Interval[] {
  const windows = options.preferredWindows;
  if (windows === undefined || windows.length === 0) return free;

  const span = {
    start: Math.min(...free.map((interval) => interval.start)),
    end: Math.max(...free.map((interval) => interval.end)),
  };
  const bands = expandDailyWindows(windows, span, options.timezone);

  const clipped: Interval[] = [];
  for (const interval of free) {
    for (const band of bands) {
      const start = Math.max(interval.start, band.start);
      const end = Math.min(interval.end, band.end);
      if (end > start) clipped.push({ start, end });
    }
  }
  return clipped;
}

/**
 * Round up to the next tidy local time.
 *
 * Snapping against local midnight rather than the epoch keeps ":30" meaning
 * half past the hour in zones offset by a fraction of an hour.
 */
function snapUp(instant: Instant, granularityMinutes: number, timezone: string): Instant {
  const dayStart = localDayInterval(localDayKey(instant, timezone), timezone).start;
  const step = granularityMinutes * 60_000;
  const offset = instant - dayStart;
  return dayStart + Math.ceil(offset / step) * step;
}
