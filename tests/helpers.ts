export { instantFromISO, instantToISO } from '@calendar-agent/core';

interface DayParts {
  readonly hour: number;
  readonly minute: number;
  readonly weekday: string;
}

/** Local wall-clock parts of an instant, used to assert scheduling results. */
export function dayParts(instant: number, timezone: string): DayParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(instant));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0';
  return {
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: get('weekday').toLowerCase(),
  };
}
