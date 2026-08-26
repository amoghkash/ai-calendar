import { describe, expect, it } from 'vitest';
import { instantToISO } from './instant.js';
import { durationMinutes } from './interval.js';
import {
  dailyWindow,
  eachLocalDay,
  expandWeeklySchedule,
  expandWindowOnDay,
  localDayInterval,
  localDayKey,
  parseTimeOfDay,
  weeklySchedule,
  weekdayOf,
  zonedInstant,
} from './wall-clock.js';

const NY = 'America/New_York';
const BERLIN = 'Europe/Berlin';
const KOLKATA = 'Asia/Kolkata';

describe('time-of-day parsing', () => {
  it('parses HH:MM', () => {
    expect(parseTimeOfDay('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDay('9:05')).toEqual({ hour: 9, minute: 5 });
  });
  it('rejects nonsense', () => {
    expect(() => parseTimeOfDay('25:00')).toThrow();
    expect(() => parseTimeOfDay('nine')).toThrow();
  });
});

describe('zoned conversions', () => {
  it('converts local wall time to the right UTC instant', () => {
    // 2026-01-15 09:00 in New York is 14:00 UTC (EST, UTC-5).
    expect(instantToISO(zonedInstant('2026-01-15', { hour: 9, minute: 0 }, NY))).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    // Same wall time in July is 13:00 UTC (EDT, UTC-4).
    expect(instantToISO(zonedInstant('2026-07-15', { hour: 9, minute: 0 }, NY))).toBe(
      '2026-07-15T13:00:00.000Z',
    );
  });

  it('handles half-hour offset zones', () => {
    expect(instantToISO(zonedInstant('2026-01-15', { hour: 9, minute: 0 }, KOLKATA))).toBe(
      '2026-01-15T03:30:00.000Z',
    );
  });

  it('reports the correct weekday in the local zone', () => {
    // 2026-03-09T02:00Z is still Sunday evening in New York.
    const instant = Date.parse('2026-03-09T02:00:00Z');
    expect(weekdayOf(instant, 'UTC')).toBe('monday');
    expect(weekdayOf(instant, NY)).toBe('sunday');
    expect(localDayKey(instant, NY)).toBe('2026-03-08');
  });
});

describe('DST transitions', () => {
  it('spring-forward days are 23 hours long', () => {
    // US DST starts 2026-03-08.
    expect(durationMinutes(localDayInterval('2026-03-08', NY))).toBe(23 * 60);
    expect(durationMinutes(localDayInterval('2026-03-07', NY))).toBe(24 * 60);
  });

  it('fall-back days are 25 hours long', () => {
    // US DST ends 2026-11-01.
    expect(durationMinutes(localDayInterval('2026-11-01', NY))).toBe(25 * 60);
  });

  it('keeps working hours at the right wall-clock time across a transition', () => {
    const schedule = weeklySchedule(
      ['friday', 'saturday', 'sunday', 'monday'],
      [dailyWindow('09:00', '17:00')],
    );
    const range = {
      start: Date.parse('2026-03-06T00:00:00Z'),
      end: Date.parse('2026-03-10T12:00:00Z'),
    };
    const windows = expandWeeklySchedule(schedule, range, NY);
    // Friday before the switch: 09:00 EST = 14:00 UTC.
    expect(instantToISO(windows[0]!.start)).toBe('2026-03-06T14:00:00.000Z');
    // Monday after the switch: 09:00 EDT = 13:00 UTC. Same 8 hour duration.
    const monday = windows[windows.length - 1]!;
    expect(instantToISO(monday.start)).toBe('2026-03-09T13:00:00.000Z');
    expect(durationMinutes(monday)).toBe(480);
  });

  it('shortens a window that spans the spring-forward gap', () => {
    // 01:00 -> 04:00 local on the spring-forward day only lasts two real hours.
    const window = expandWindowOnDay('2026-03-08', dailyWindow('01:00', '04:00'), NY);
    expect(window).not.toBeNull();
    expect(durationMinutes(window!)).toBe(120);
  });

  it('lengthens a window that spans the fall-back repeat', () => {
    const window = expandWindowOnDay('2026-11-01', dailyWindow('01:00', '03:00'), NY);
    expect(durationMinutes(window!)).toBe(180);
  });

  it('handles the European transition on a different date', () => {
    // EU DST starts 2026-03-29; the US switched three weeks earlier.
    expect(durationMinutes(localDayInterval('2026-03-08', BERLIN))).toBe(24 * 60);
    expect(durationMinutes(localDayInterval('2026-03-29', BERLIN))).toBe(23 * 60);
  });

  it('resolves a non-existent local time forward past the gap', () => {
    // 02:30 does not exist on 2026-03-08 in New York.
    const instant = zonedInstant('2026-03-08', { hour: 2, minute: 30 }, NY);
    expect(instantToISO(instant)).toBe('2026-03-08T07:30:00.000Z');
  });
});

describe('windows crossing midnight', () => {
  it('extends into the next day', () => {
    const window = expandWindowOnDay('2026-01-15', dailyWindow('23:00', '07:00'), 'UTC');
    expect(instantToISO(window!.start)).toBe('2026-01-15T23:00:00.000Z');
    expect(instantToISO(window!.end)).toBe('2026-01-16T07:00:00.000Z');
  });

  it('is captured when the range starts mid-window', () => {
    const schedule = weeklySchedule(['thursday'], [dailyWindow('23:00', '07:00')]);
    const range = {
      start: Date.parse('2026-01-16T00:00:00Z'),
      end: Date.parse('2026-01-16T12:00:00Z'),
    };
    const windows = expandWeeklySchedule(schedule, range, 'UTC');
    expect(windows).toHaveLength(1);
    expect(instantToISO(windows[0]!.end)).toBe('2026-01-16T07:00:00.000Z');
  });
});

describe('eachLocalDay', () => {
  it('lists inclusive local days', () => {
    const range = {
      start: Date.parse('2026-03-06T14:00:00Z'),
      end: Date.parse('2026-03-09T02:00:00Z'),
    };
    expect(eachLocalDay(range, NY)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08']);
  });
});
