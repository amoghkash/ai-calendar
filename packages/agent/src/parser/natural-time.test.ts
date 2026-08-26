import { describe, expect, it } from 'vitest';
import { instantFromISO, instantToISO } from '@calendar-agent/core';
import {
  parseClockTime,
  parseDayRange,
  parseDeadline,
  parseDurationMinutes,
  parseNamedWindow,
} from './natural-time.js';

// Monday 2026-03-09, 09:00 UTC.
const NOW = instantFromISO('2026-03-09T09:00:00Z');
const TZ = 'UTC';

describe('parseDurationMinutes', () => {
  it.each([
    ['2 hours', 120],
    ['90 minutes', 90],
    ['1h30m', 90],
    ['two hours', 120],
    ['45m', 45],
    ['1.5 hours', 90],
    ['an hour', 60],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMinutes(input)).toBe(expected);
  });

  it('returns undefined when there is no duration', () => {
    expect(parseDurationMinutes('schedule my assignment')).toBeUndefined();
  });
});

describe('parseClockTime', () => {
  it.each([
    ['leave at 3pm', { hour: 15, minute: 0 }],
    ['by 4 pm', { hour: 16, minute: 0 }],
    ['at 09:30', { hour: 9, minute: 30 }],
    ['at noon', { hour: 12, minute: 0 }],
    ['12am', { hour: 0, minute: 0 }],
  ])('parses %s', (input, expected) => {
    expect(parseClockTime(input)).toEqual(expected);
  });
});

describe('parseDayRange', () => {
  it('resolves relative days', () => {
    expect(instantToISO(parseDayRange('tomorrow', NOW, TZ)!.start)).toBe(
      '2026-03-10T00:00:00.000Z',
    );
    expect(instantToISO(parseDayRange('today', NOW, TZ)!.start)).toBe('2026-03-09T00:00:00.000Z');
  });

  it('resolves the next occurrence of a weekday', () => {
    expect(instantToISO(parseDayRange('friday', NOW, TZ)!.start)).toBe('2026-03-13T00:00:00.000Z');
    // Today is Monday, so "monday" means today; "next monday" is a week away.
    expect(instantToISO(parseDayRange('monday', NOW, TZ)!.start)).toBe('2026-03-09T00:00:00.000Z');
    expect(instantToISO(parseDayRange('next monday', NOW, TZ)!.start)).toBe(
      '2026-03-16T00:00:00.000Z',
    );
  });

  it.each(['tomorrow', 'tommorow', 'tomorow', 'tommorrow'])(
    'tolerates the spelling %s',
    (spelling) => {
      expect(instantToISO(parseDayRange(spelling, NOW, TZ)!.start)).toBe(
        '2026-03-10T00:00:00.000Z',
      );
    },
  );

  it('still distinguishes the day after tomorrow', () => {
    expect(instantToISO(parseDayRange('day after tommorow', NOW, TZ)!.start)).toBe(
      '2026-03-11T00:00:00.000Z',
    );
  });

  it('handles next week', () => {
    expect(instantToISO(parseDayRange('next week', NOW, TZ)!.start)).toBe(
      '2026-03-16T00:00:00.000Z',
    );
  });

  it('respects the local timezone', () => {
    // Midnight in New York on 2026-03-10, which is already EDT (UTC-4).
    const range = parseDayRange('tomorrow', NOW, 'America/New_York')!;
    expect(instantToISO(range.start)).toBe('2026-03-10T04:00:00.000Z');
  });
});

describe('parseDeadline', () => {
  it('treats a bare day as the end of that day', () => {
    expect(instantToISO(parseDeadline('by thursday', NOW, TZ)!)).toBe('2026-03-12T23:59:00.000Z');
  });

  it('combines a day with a clock time', () => {
    expect(instantToISO(parseDeadline('friday at 5pm', NOW, TZ)!)).toBe('2026-03-13T17:00:00.000Z');
  });

  it('rolls a past time forward to tomorrow', () => {
    expect(instantToISO(parseDeadline('by 8am', NOW, TZ)!)).toBe('2026-03-10T08:00:00.000Z');
  });
});

describe('parseNamedWindow', () => {
  it('maps parts of the day to windows', () => {
    expect(parseNamedWindow('tomorrow morning')?.label).toBe('morning');
    expect(parseNamedWindow('friday afternoon')?.label).toBe('afternoon');
    expect(parseNamedWindow('lunch')).toBeUndefined();
  });
});
