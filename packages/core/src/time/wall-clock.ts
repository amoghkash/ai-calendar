import { DateTime } from 'luxon';
import type { Instant } from './instant.js';
import type { Interval, NamedInterval } from './interval.js';
import { clamp, isEmpty, mergeIntervals } from './interval.js';

/**
 * Wall-clock rules (working hours, sleep, deep work) are expressed in local
 * time plus an IANA timezone. This module is the only place that converts
 * between wall-clock rules and Instants, so DST handling lives in one spot.
 */

export type Weekday =
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export const WEEKDAYS: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/** Luxon uses 1 = Monday .. 7 = Sunday. */
const WEEKDAY_BY_LUXON_INDEX: readonly Weekday[] = WEEKDAYS;

export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

const TIME_OF_DAY_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

export function parseTimeOfDay(value: string): TimeOfDay {
  const match = TIME_OF_DAY_PATTERN.exec(value.trim());
  if (!match) throw new TypeError(`Invalid time-of-day: "${value}" (expected HH:MM)`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new TypeError(`Invalid time-of-day: "${value}"`);
  }
  return { hour, minute };
}

export const formatTimeOfDay = (t: TimeOfDay): string =>
  `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

export const timeOfDayMinutes = (t: TimeOfDay): number => t.hour * 60 + t.minute;

/**
 * A window inside a local day. When `end` is not after `start` the window is
 * treated as crossing midnight (e.g. sleep 23:00 -> 07:00).
 */
export interface DailyWindow {
  readonly start: TimeOfDay;
  readonly end: TimeOfDay;
  readonly label?: string;
}

export type WeeklySchedule = {
  readonly [K in Weekday]?: readonly DailyWindow[];
};

export const dailyWindow = (start: string, end: string, label?: string): DailyWindow => ({
  start: parseTimeOfDay(start),
  end: parseTimeOfDay(end),
  ...(label === undefined ? {} : { label }),
});

/** Build a weekly schedule that applies the same windows on the given days. */
export function weeklySchedule(
  days: readonly Weekday[],
  windows: readonly DailyWindow[],
): WeeklySchedule {
  const result: Record<string, readonly DailyWindow[]> = {};
  for (const day of days) result[day] = windows;
  return result as WeeklySchedule;
}

export const isValidTimezone = (timezone: string): boolean =>
  DateTime.local().setZone(timezone).isValid;

export function assertValidTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) throw new TypeError(`Unknown IANA timezone: "${timezone}"`);
}

/** Local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDayKey(instant: Instant, timezone: string): string {
  const dt = DateTime.fromMillis(instant, { zone: timezone });
  return dt.toISODate() ?? '';
}

export function weekdayOf(instant: Instant, timezone: string): Weekday {
  const dt = DateTime.fromMillis(instant, { zone: timezone });
  return WEEKDAY_BY_LUXON_INDEX[dt.weekday - 1] ?? 'monday';
}

export function weekdayOfDayKey(dayKey: string, timezone: string): Weekday {
  const dt = DateTime.fromISO(dayKey, { zone: timezone });
  return WEEKDAY_BY_LUXON_INDEX[dt.weekday - 1] ?? 'monday';
}

/**
 * Convert a local wall-clock time on a local day to an Instant.
 *
 * DST notes (delegated to Luxon):
 *  - times that do not exist (spring forward) are shifted forward past the gap;
 *  - ambiguous times (fall back) resolve to the first (pre-transition) offset.
 * `hour` may be 24 to denote midnight at the end of the day.
 */
export function zonedInstant(dayKey: string, time: TimeOfDay, timezone: string): Instant {
  const base = DateTime.fromISO(dayKey, { zone: timezone });
  if (!base.isValid) throw new TypeError(`Invalid local day: "${dayKey}"`);
  const dt =
    time.hour === 24
      ? base.plus({ days: 1 }).startOf('day')
      : base.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  if (!dt.isValid) throw new TypeError(`Invalid local time ${formatTimeOfDay(time)} on ${dayKey}`);
  return dt.toMillis();
}

/** The instant range covered by a local calendar day (23h, 24h or 25h under DST). */
export function localDayInterval(dayKey: string, timezone: string): Interval {
  const start = DateTime.fromISO(dayKey, { zone: timezone }).startOf('day');
  const end = start.plus({ days: 1 });
  return { start: start.toMillis(), end: end.toMillis() };
}

/** Every local calendar day touched by `range`, inclusive, as `YYYY-MM-DD`. */
export function eachLocalDay(range: Interval, timezone: string): string[] {
  const days: string[] = [];
  let cursor = DateTime.fromMillis(range.start, { zone: timezone }).startOf('day');
  const last = DateTime.fromMillis(Math.max(range.start, range.end - 1), {
    zone: timezone,
  }).startOf('day');
  // Guard against pathological ranges; a planning horizon is days, not decades.
  for (let guard = 0; cursor <= last && guard < 3660; guard += 1) {
    const key = cursor.toISODate();
    if (key) days.push(key);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

/** Expand one daily window on one local day into an Instant interval. */
export function expandWindowOnDay(
  dayKey: string,
  window: DailyWindow,
  timezone: string,
): Interval | null {
  const start = zonedInstant(dayKey, window.start, timezone);
  const crossesMidnight = timeOfDayMinutes(window.end) <= timeOfDayMinutes(window.start);
  const endDay = crossesMidnight
    ? (DateTime.fromISO(dayKey, { zone: timezone }).plus({ days: 1 }).toISODate() ?? dayKey)
    : dayKey;
  const end = zonedInstant(endDay, window.end, timezone);
  if (end <= start) return null;
  return { start, end };
}

/**
 * Expand a weekly schedule into concrete instant intervals covering `range`.
 * The day before the range is included so windows crossing midnight are kept.
 */
export function expandWeeklySchedule(
  schedule: WeeklySchedule,
  range: Interval,
  timezone: string,
): Interval[] {
  const padded: Interval = { start: range.start - 86_400_000, end: range.end + 86_400_000 };
  const result: Interval[] = [];
  for (const dayKey of eachLocalDay(padded, timezone)) {
    const weekday = weekdayOfDayKey(dayKey, timezone);
    for (const window of schedule[weekday] ?? []) {
      const expanded = expandWindowOnDay(dayKey, window, timezone);
      if (!expanded) continue;
      const clipped = clamp(expanded, range);
      if (clipped && !isEmpty(clipped)) result.push(clipped);
    }
  }
  return mergeIntervals(result);
}

/** Expand the same windows on every day of the range. */
export function expandDailyWindows(
  windows: readonly DailyWindow[],
  range: Interval,
  timezone: string,
): Interval[] {
  return expandWeeklySchedule(weeklySchedule(WEEKDAYS, windows), range, timezone);
}

/** Human-friendly `Mon 09:00–10:30` label for logs, CLI output and diffs. */
export function describeInterval(i: Interval, timezone: string): string {
  const start = DateTime.fromMillis(i.start, { zone: timezone });
  const end = DateTime.fromMillis(i.end, { zone: timezone });
  const sameDay = start.toISODate() === end.toISODate();
  return sameDay
    ? `${start.toFormat('ccc dd LLL HH:mm')}–${end.toFormat('HH:mm')}`
    : `${start.toFormat('ccc dd LLL HH:mm')}–${end.toFormat('ccc dd LLL HH:mm')}`;
}

export function describeInstant(instant: Instant, timezone: string): string {
  return DateTime.fromMillis(instant, { zone: timezone }).toFormat('ccc dd LLL HH:mm');
}

/** Format an instant in a zone as an ISO string that keeps the local offset. */
export function toZonedISO(instant: Instant, timezone: string): string {
  return DateTime.fromMillis(instant, { zone: timezone }).toISO() ?? '';
}

/**
 * Parse an ISO string that may be naive (no offset). Naive strings are
 * interpreted in `timezone` - the only place where that is allowed.
 */
export function parseZonedISO(value: string, timezone: string): Instant {
  const dt = DateTime.fromISO(value, { zone: timezone, setZone: false });
  if (!dt.isValid) throw new TypeError(`Invalid ISO timestamp: "${value}"`);
  return dt.toMillis();
}

export type { NamedInterval };
