/** Formatting helpers. All timestamps from the API are epoch milliseconds. */

export const startOfDay = (instant: number, timezone: string): number => {
  const parts = dayParts(instant, timezone);
  return instant - (parts.hour * 3600 + parts.minute * 60 + parts.second) * 1000;
};

interface DayParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

export function dayParts(instant: number, timezone: string): DayParts {
  const parts = formatter(timezone).formatToParts(new Date(instant));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday').toLowerCase(),
  };
}

export const dayKey = (instant: number, timezone: string): string => {
  const parts = dayParts(instant, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

export const timeLabel = (instant: number, timezone: string): string => {
  const parts = dayParts(instant, timezone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
};

export const dateLabel = (instant: number, timezone: string): string => {
  const parts = dayParts(instant, timezone);
  return `${capitalise(parts.weekday)} ${parts.day}/${parts.month}`;
};

export const rangeLabel = (start: number, end: number, timezone: string): string =>
  `${dateLabel(start, timezone)} ${timeLabel(start, timezone)}-${timeLabel(end, timezone)}`;

export function minutesFromMidnight(instant: number, timezone: string): number {
  const parts = dayParts(instant, timezone);
  return parts.hour * 60 + parts.minute;
}

export const formatMinutes = (total: number): string => {
  const rounded = Math.round(total);
  if (rounded <= 0) return '0m';
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const SHORT_TO_LONG: Record<string, string> = {
  mon: 'monday',
  tue: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  fri: 'friday',
  sat: 'saturday',
  sun: 'sunday',
};

export const weekdayOf = (instant: number, timezone: string): string =>
  SHORT_TO_LONG[dayParts(instant, timezone).weekday] ?? 'monday';

/**
 * `<input type="datetime-local">` speaks the browser's local time, but the app
 * works in the user's *configured* timezone, which may differ. These two
 * helpers convert both ways through the configured zone so a laptop in another
 * country still edits the right instant.
 */
export function toLocalInputValue(instant: number, timezone: string): string {
  const p = dayParts(instant, timezone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Minutes that `timezone` is ahead of UTC at a given instant. */
function offsetMinutes(instant: number, timezone: string): number {
  const p = dayParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

export function fromLocalInputValue(value: string, timezone: string): number {
  const naive = Date.parse(`${value}:00Z`);
  if (Number.isNaN(naive)) return Number.NaN;
  // Solve for the instant whose wall clock in `timezone` matches the input.
  // A second pass settles the DST boundary cases.
  let instant = naive - offsetMinutes(naive, timezone) * 60_000;
  const corrected = naive - offsetMinutes(instant, timezone) * 60_000;
  if (corrected !== instant) instant = corrected;
  return instant;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const month = (parts: DayParts): string => MONTHS[parts.month - 1] ?? '';

/** Heading for the visible range, e.g. "24 - 30 Aug 2026". */
export function spanLabel(start: number, days: number, timezone: string): string {
  const from = dayParts(start, timezone);
  if (days <= 1) {
    return `${capitalise(from.weekday)} ${from.day} ${month(from)} ${from.year}`;
  }
  const to = dayParts(start + (days - 1) * 86_400_000, timezone);
  if (from.month === to.month && from.year === to.year) {
    return `${from.day} - ${to.day} ${month(to)} ${to.year}`;
  }
  if (from.year === to.year) {
    return `${from.day} ${month(from)} - ${to.day} ${month(to)} ${to.year}`;
  }
  return `${from.day} ${month(from)} ${from.year} - ${to.day} ${month(to)} ${to.year}`;
}

/** Weekday and day-of-month for a calendar column header. */
export function dayHead(instant: number, timezone: string): { weekday: string; day: number } {
  const parts = dayParts(instant, timezone);
  return { weekday: parts.weekday.toUpperCase(), day: parts.day };
}

/** Relative day wording used on task deadlines: "today", "in 3 days", "2 days ago". */
export function relativeDay(instant: number, now: number, timezone: string): string {
  const days = Math.round((startOfDay(instant, timezone) - startOfDay(now, timezone)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days} days ago`;
  return `in ${days} days`;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * The Sunday that starts the week containing `instant`.
 *
 * Stepping back from local noon rather than from the instant itself keeps the
 * result on the intended calendar day when a DST change shifts the clock.
 */
export function startOfWeek(instant: number, timezone: string): number {
  const index = WEEKDAY_INDEX[weekdayOf(instant, timezone)] ?? 0;
  const noon = startOfDay(instant, timezone) + 12 * 3_600_000;
  return startOfDay(noon - index * 86_400_000, timezone);
}
