import { describe, expect, it } from 'vitest';
import { eventFixture, preferencesFixture, at } from '../testing/fixtures.js';
import { dailyWindow, weeklySchedule } from '../time/wall-clock.js';
import { computeAvailability } from './availability.js';

const MONDAY = 'monday';

const basePrefs = () =>
  preferencesFixture({
    timezone: 'UTC',
    workingHours: weeklySchedule([MONDAY], [dailyWindow('09:00', '17:00')]),
    deepWork: {
      enabled: true,
      schedule: weeklySchedule([MONDAY], [dailyWindow('09:00', '12:00')]),
      allowMeetings: false,
      reserveForFocusTasks: false,
    },
  });

const MONDAY_RANGE = {
  start: at('2026-03-09T00:00:00Z'),
  end: at('2026-03-10T00:00:00Z'),
};

describe('computeAvailability', () => {
  it('returns working hours when nothing is booked', () => {
    const result = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: basePrefs(),
      events: [],
    });
    expect(result.totalFreeMinutes).toBe(480);
    // Split at the deep-work boundary: 09:00-12:00 and 12:00-17:00.
    expect(result.windows).toHaveLength(2);
    expect(result.windows.filter((w) => w.deepWork)).toHaveLength(1);
  });

  it('pads busy events by the buffer for placement, but reports them unpadded', () => {
    const result = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: { ...basePrefs(), bufferBetweenBlocksMinutes: 30 },
      events: [
        eventFixture({
          start: at('2026-03-09T13:00:00Z'),
          end: at('2026-03-09T14:00:00Z'),
        }),
      ],
    });

    // 8h working - 1h meeting - 2x30m buffer.
    expect(result.totalFreeMinutes).toBe(360);
    const gap = result.freeIntervals.find((i) => i.end === at('2026-03-09T12:30:00Z'));
    expect(gap).toBeDefined();
    expect(result.freeIntervals.some((i) => i.start === at('2026-03-09T14:30:00Z'))).toBe(true);

    // The reported busy set stays the truth: it answers "is this time taken",
    // which is what decides whether an existing block is still valid.
    expect(result.busyIntervals).toEqual([
      { start: at('2026-03-09T13:00:00Z'), end: at('2026-03-09T14:00:00Z') },
    ]);
  });

  it('removes busy events', () => {
    const result = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: basePrefs(),
      events: [
        eventFixture({
          start: at('2026-03-09T11:00:00Z'),
          end: at('2026-03-09T12:00:00Z'),
        }),
      ],
    });
    expect(result.totalFreeMinutes).toBe(420);
  });

  it('ignores transparent, cancelled and declined events', () => {
    const result = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: basePrefs(),
      events: [
        eventFixture({
          start: at('2026-03-09T10:00:00Z'),
          end: at('2026-03-09T11:00:00Z'),
          transparency: 'transparent',
        }),
        eventFixture({
          start: at('2026-03-09T11:00:00Z'),
          end: at('2026-03-09T12:00:00Z'),
          status: 'cancelled',
        }),
        eventFixture({
          start: at('2026-03-09T13:00:00Z'),
          end: at('2026-03-09T14:00:00Z'),
          attendees: [{ email: 'me@example.com', self: true, response: 'declined' }],
        }),
      ],
    });
    expect(result.totalFreeMinutes).toBe(480);
  });

  it('ignores all-day events unless configured otherwise', () => {
    const allDay = eventFixture({
      start: at('2026-03-09T00:00:00Z'),
      end: at('2026-03-10T00:00:00Z'),
      isAllDay: true,
    });
    const free = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: basePrefs(),
      events: [allDay],
    });
    expect(free.totalFreeMinutes).toBe(480);

    const blocked = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: { ...basePrefs(), allDayEventsBlockTime: true },
      events: [allDay],
    });
    expect(blocked.totalFreeMinutes).toBe(0);
  });

  it('subtracts sleep, recurring blocks and one-off blocked periods', () => {
    const prefs = {
      ...basePrefs(),
      recurringBlocks: weeklySchedule([MONDAY], [dailyWindow('12:00', '13:00', 'lunch')]),
      blockedPeriods: [
        { start: at('2026-03-09T15:00:00Z'), end: at('2026-03-09T16:00:00Z'), label: 'gym' },
      ],
    };
    const result = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: prefs,
      events: [],
    });
    expect(result.totalFreeMinutes).toBe(360);
  });

  it('never schedules in the past', () => {
    const result = computeAvailability({
      range: MONDAY_RANGE,
      now: at('2026-03-09T13:00:00Z'),
      timezone: 'UTC',
      preferences: basePrefs(),
      events: [],
    });
    expect(result.totalFreeMinutes).toBe(240);
  });

  it('honours reserved intervals', () => {
    const result = computeAvailability({
      range: MONDAY_RANGE,
      now: MONDAY_RANGE.start,
      timezone: 'UTC',
      preferences: basePrefs(),
      events: [],
      reserved: [{ start: at('2026-03-09T09:00:00Z'), end: at('2026-03-09T10:00:00Z') }],
    });
    expect(result.totalFreeMinutes).toBe(420);
  });

  it('splits windows on local day boundaries', () => {
    const prefs = {
      ...basePrefs(),
      workingHours: weeklySchedule(['monday', 'tuesday'], [dailyWindow('22:00', '02:00')]),
      deepWork: { ...basePrefs().deepWork, enabled: false },
    };
    const result = computeAvailability({
      range: { start: at('2026-03-09T00:00:00Z'), end: at('2026-03-11T00:00:00Z') },
      now: at('2026-03-09T00:00:00Z'),
      timezone: 'UTC',
      preferences: prefs,
      events: [],
    });
    // Monday 22:00-00:00, Tuesday 00:00-02:00, Tuesday 22:00-00:00 (clipped).
    expect(result.windows.map((w) => w.dayKey)).toEqual(['2026-03-09', '2026-03-10', '2026-03-10']);
  });

  describe('the waking-hours basis', () => {
    it('offers the evening, which working hours never can', () => {
      const result = computeAvailability({
        range: MONDAY_RANGE,
        now: MONDAY_RANGE.start,
        timezone: 'UTC',
        preferences: basePrefs(),
        events: [],
        basis: 'waking_hours',
      });

      // 17:00-24:00 exists here and cannot exist under working hours; it is
      // where most plans with other people actually happen.
      const evening = result.freeIntervals.some(
        (interval) => interval.end > at('2026-03-09T17:00:00Z'),
      );
      expect(evening).toBe(true);
    });

    it('still refuses to schedule you while you are asleep', () => {
      const result = computeAvailability({
        range: MONDAY_RANGE,
        now: MONDAY_RANGE.start,
        timezone: 'UTC',
        preferences: preferencesFixture({
          timezone: 'UTC',
          workingHours: weeklySchedule([MONDAY], [dailyWindow('09:00', '17:00')]),
          sleepHours: weeklySchedule([MONDAY], [dailyWindow('00:00', '07:00')]),
        }),
        events: [],
        basis: 'waking_hours',
      });

      const asleep = result.freeIntervals.some(
        (interval) => interval.start < at('2026-03-09T07:00:00Z'),
      );
      expect(asleep).toBe(false);
    });

    it('still keeps clear of a real commitment', () => {
      const dinner = eventFixture({
        start: at('2026-03-09T19:00:00Z'),
        end: at('2026-03-09T20:00:00Z'),
      });
      const result = computeAvailability({
        range: MONDAY_RANGE,
        now: MONDAY_RANGE.start,
        timezone: 'UTC',
        preferences: basePrefs(),
        events: [dinner],
        basis: 'waking_hours',
      });

      const clash = result.freeIntervals.some(
        (interval) =>
          interval.start < at('2026-03-09T20:00:00Z') &&
          at('2026-03-09T19:00:00Z') < interval.end,
      );
      expect(clash).toBe(false);
    });

    it('leaves the working-hours question exactly as it was', () => {
      const shared = {
        range: MONDAY_RANGE,
        now: MONDAY_RANGE.start,
        timezone: 'UTC',
        preferences: basePrefs(),
        events: [],
      };
      expect(computeAvailability(shared).freeIntervals).toEqual(
        computeAvailability({ ...shared, basis: 'working_hours' }).freeIntervals,
      );
    });
  });
});
