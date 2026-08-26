import { DateTime } from 'luxon';
import type { Instant, Interval, TimeOfDay, Weekday } from '@calendar-agent/core';
import { WEEKDAYS } from '@calendar-agent/core';

/**
 * Deterministic parsing of the time expressions people actually type.
 *
 * This exists so natural-language input keeps working without an LLM, and so
 * CLI flags such as `--due friday` and `--duration 90m` share one implementation.
 */

/** "tomorrow" is one of the most misspelled words people type at a calendar. */
export const TOMORROW = /\btom+or+ow\b/i;

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  half: 0.5,
};

const DURATION_PATTERN =
  /(\d+(?:[.,]\d+)?|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)\s*(hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/gi;

/** `"1h30m"`, `"90 minutes"`, `"two hours"` -> minutes. */
export function parseDurationMinutes(text: string): number | undefined {
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(DURATION_PATTERN)) {
    const rawAmount = match[1]!.toLowerCase();
    const amount = WORD_NUMBERS[rawAmount] ?? Number(rawAmount.replace(',', '.'));
    if (!Number.isFinite(amount)) continue;
    const unit = match[2]!.toLowerCase();
    total += unit.startsWith('h') ? amount * 60 : amount;
    matched = true;
  }
  return matched && total > 0 ? Math.round(total) : undefined;
}

/**
 * Clock forms people actually type, most specific first: `12:30pm`, `1230pm`,
 * `3pm`, `15:30`, `at 1230`, `at 12`.
 */
const CLOCK_FORMS: readonly { readonly pattern: RegExp; readonly compact?: boolean }[] = [
  { pattern: /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i },
  { pattern: /\b(\d{1,2})(\d{2})\s*(am|pm)\b/i, compact: true },
  { pattern: /\b(\d{1,2})\s*(am|pm)\b/i },
  { pattern: /\b(\d{1,2}):(\d{2})\b/ },
  // Bare hours only after "at", so "2 hours" is never read as a time.
  { pattern: /\bat\s+(\d{1,2})(\d{2})\b/i, compact: true },
  { pattern: /\bat\s+(\d{1,2})\b(?!\s*(?:h\b|hours?|m\b|mins?|minutes?))/i },
];

/** `"3pm"`, `"1230pm"`, `"15:30"`, `"at 12"`, `"noon"` -> a time of day. */
export function parseClockTime(text: string): TimeOfDay | undefined {
  const lower = text.toLowerCase();
  if (/\bnoon\b|\bmidday\b/.test(lower)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(lower)) return { hour: 0, minute: 0 };

  for (const form of CLOCK_FORMS) {
    const match = form.pattern.exec(lower);
    if (!match) continue;
    const groups = match.slice(1).filter((value): value is string => value !== undefined);
    const meridiem = groups.find((value) => value === 'am' || value === 'pm');
    const numbers = groups.filter((value) => value !== 'am' && value !== 'pm');

    let hour = Number(numbers[0]);
    const minute = numbers.length > 1 ? Number(numbers[1]) : 0;
    if (!Number.isFinite(hour) || hour > 24 || minute > 59) continue;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour: hour % 24, minute };
  }
  return undefined;
}

export interface NamedWindow {
  readonly start: TimeOfDay;
  readonly end: TimeOfDay;
  readonly label: string;
}

const NAMED_WINDOWS: readonly { pattern: RegExp; window: NamedWindow }[] = [
  {
    pattern: /\bmornings?\b/i,
    window: { start: { hour: 6, minute: 0 }, end: { hour: 12, minute: 0 }, label: 'morning' },
  },
  {
    pattern: /\bafternoons?\b/i,
    window: { start: { hour: 12, minute: 0 }, end: { hour: 18, minute: 0 }, label: 'afternoon' },
  },
  {
    pattern: /\bevenings?\b|\btonight\b/i,
    window: { start: { hour: 18, minute: 0 }, end: { hour: 22, minute: 0 }, label: 'evening' },
  },
];

export function parseNamedWindow(text: string): NamedWindow | undefined {
  return NAMED_WINDOWS.find((entry) => entry.pattern.test(text))?.window;
}

export interface DayRange extends Interval {
  readonly label: string;
}

const WEEKDAY_PATTERN = new RegExp(
  `\\b(${WEEKDAYS.join('|')}|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\\b`,
  'i',
);

const WEEKDAY_ALIASES: Record<string, Weekday> = {
  mon: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  fri: 'friday',
  sat: 'saturday',
  sun: 'sunday',
};

/** `"tomorrow"`, `"next week"`, `"friday"` -> a concrete local day range. */
export function parseDayRange(text: string, now: Instant, timezone: string): DayRange | undefined {
  const lower = text.toLowerCase();
  const today = DateTime.fromMillis(now, { zone: timezone }).startOf('day');

  const dayRange = (start: DateTime, days: number, label: string): DayRange => ({
    start: start.toMillis(),
    end: start.plus({ days }).toMillis(),
    label,
  });

  if (/\btoday\b|\btonight\b/.test(lower)) return dayRange(today, 1, 'today');
  if (TOMORROW.test(lower) && !/\bday after\b/.test(lower)) {
    return dayRange(today.plus({ days: 1 }), 1, 'tomorrow');
  }
  if (new RegExp(`\\bday after ${TOMORROW.source}`).test(lower)) {
    return dayRange(today.plus({ days: 2 }), 1, 'the day after tomorrow');
  }
  if (/\bnext week\b/.test(lower)) {
    return dayRange(today.plus({ weeks: 1 }).startOf('week'), 7, 'next week');
  }
  if (/\bthis week\b/.test(lower)) return dayRange(today.startOf('week'), 7, 'this week');
  if (/\bweekend\b/.test(lower)) {
    const saturday = today.plus({ days: (6 - today.weekday + 7) % 7 });
    return dayRange(saturday, 2, 'the weekend');
  }
  const inDays = /\bin (\d+) days?\b/.exec(lower);
  if (inDays) {
    const offset = Number(inDays[1]);
    return dayRange(today.plus({ days: offset }), 1, `in ${offset} days`);
  }

  const weekdayMatch = WEEKDAY_PATTERN.exec(lower);
  if (weekdayMatch) {
    const raw = weekdayMatch[1]!.toLowerCase();
    const weekday = (WEEKDAY_ALIASES[raw] ?? raw) as Weekday;
    const targetIndex = WEEKDAYS.indexOf(weekday) + 1;
    const wantsNext = /\bnext\b/.test(lower);
    let delta = (targetIndex - today.weekday + 7) % 7;
    if (delta === 0 && wantsNext) delta = 7;
    if (wantsNext && delta < 7 && delta !== 0) delta += 0;
    return dayRange(today.plus({ days: delta }), 1, weekday);
  }

  return undefined;
}

/**
 * Resolve a deadline phrase into an instant. A bare day means the end of that
 * day; a day plus a clock time means that exact moment.
 */
export function parseDeadline(text: string, now: Instant, timezone: string): Instant | undefined {
  const range = parseDayRange(text, now, timezone);
  const clock = parseClockTime(text);
  if (!range && !clock) return undefined;

  const day = range
    ? DateTime.fromMillis(range.start, { zone: timezone })
    : DateTime.fromMillis(now, { zone: timezone }).startOf('day');

  if (!clock) {
    // "by Friday" means the end of Friday.
    return day.plus({ days: 1 }).minus({ minutes: 1 }).toMillis();
  }
  const withTime = day.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 });
  // "by 5pm" with no day and a time already gone means tomorrow.
  if (!range && withTime.toMillis() <= now) return withTime.plus({ days: 1 }).toMillis();
  return withTime.toMillis();
}

/** Resolve an explicit clock time on a given day range. */
export function instantOnDay(range: DayRange, time: TimeOfDay, timezone: string): Instant {
  return DateTime.fromMillis(range.start, { zone: timezone })
    .set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 })
    .toMillis();
}
