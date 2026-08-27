import { describe, expect, it } from 'vitest';
import { proposeSlots } from './slot-proposal.js';
import { dailyWindow } from '../time/wall-clock.js';

const t = (iso: string): number => Date.parse(iso);
const w = (start: string, end: string) => ({ start: t(start), end: t(end) });
const at = (slots: readonly { start: number }[]): string[] =>
  slots.map((slot) => new Date(slot.start).toISOString());

const MON_08 = t('2026-03-09T08:00:00Z');
const WEEK = [
  w('2026-03-09T09:00:00Z', '2026-03-09T17:00:00Z'),
  w('2026-03-10T09:00:00Z', '2026-03-10T17:00:00Z'),
  w('2026-03-11T09:00:00Z', '2026-03-11T17:00:00Z'),
];
const base = { durationMinutes: 60, timezone: 'UTC' };

describe('proposing times to offer someone', () => {
  it('spreads the offer across different days', () => {
    // Three times on one afternoon reads as pestering, not as flexibility.
    expect(at(proposeSlots(WEEK, MON_08, base))).toEqual([
      '2026-03-09T10:00:00.000Z',
      '2026-03-10T09:00:00.000Z',
      '2026-03-11T09:00:00.000Z',
    ]);
  });

  it('leaves enough notice to actually answer', () => {
    const slots = proposeSlots(WEEK, MON_08, base);
    expect(slots[0]!.start).toBeGreaterThanOrEqual(MON_08 + 120 * 60_000);
  });

  it('keeps the activity in the right part of the day', () => {
    const lunch = [dailyWindow('11:30', '14:00')];
    expect(at(proposeSlots(WEEK, MON_08, { ...base, preferredWindows: lunch }))).toEqual([
      '2026-03-09T11:30:00.000Z',
      '2026-03-10T11:30:00.000Z',
      '2026-03-11T11:30:00.000Z',
    ]);
  });

  it('skips a day whose window has already passed', () => {
    // Asked at 13:30 with two hours' notice, today's lunch is gone.
    const lunch = [dailyWindow('11:30', '14:00')];
    const slots = proposeSlots(WEEK, t('2026-03-09T13:30:00Z'), {
      ...base,
      preferredWindows: lunch,
    });
    expect(at(slots)[0]).toBe('2026-03-10T11:30:00.000Z');
  });

  it('rounds up to a time a person would say out loud', () => {
    const messy = [w('2026-03-09T09:07:00Z', '2026-03-09T17:00:00Z')];
    const slots = proposeSlots(messy, t('2026-03-09T06:00:00Z'), {
      ...base,
      leadTimeMinutes: 0,
    });
    expect(at(slots)).toEqual(['2026-03-09T09:15:00.000Z']);
  });

  it('will not offer a window too short for the activity', () => {
    const brief = [w('2026-03-10T12:00:00Z', '2026-03-10T12:20:00Z')];
    expect(proposeSlots(brief, MON_08, base)).toEqual([]);
  });

  it('caps how many times it offers', () => {
    expect(proposeSlots(WEEK, MON_08, { ...base, maxSlots: 2 })).toHaveLength(2);
  });

  it('offers several times on one day when the day is all there is', () => {
    // One window, three offers - which is what "lunch tomorrow" needs.
    const oneDay = [w('2026-03-10T11:30:00Z', '2026-03-10T15:00:00Z')];
    expect(at(proposeSlots(oneDay, MON_08, { ...base, maxPerDay: 3 }))).toEqual([
      '2026-03-10T11:30:00.000Z',
      '2026-03-10T12:30:00.000Z',
      '2026-03-10T13:30:00.000Z',
    ]);
  });

  it('does not offer overlapping times', () => {
    const oneDay = [w('2026-03-10T11:30:00Z', '2026-03-10T15:00:00Z')];
    const slots = proposeSlots(oneDay, MON_08, { ...base, maxPerDay: 3 });
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.start).toBeGreaterThanOrEqual(slots[i - 1]!.end);
    }
  });

  it('still gives one per day by default, across days', () => {
    expect(at(proposeSlots(WEEK, MON_08, base))).toEqual([
      '2026-03-09T10:00:00.000Z',
      '2026-03-10T09:00:00.000Z',
      '2026-03-11T09:00:00.000Z',
    ]);
  });

  it('returns nothing rather than guessing when there is no free time', () => {
    expect(proposeSlots([], MON_08, base)).toEqual([]);
  });

  it('is deterministic', () => {
    expect(proposeSlots(WEEK, MON_08, base)).toEqual(proposeSlots(WEEK, MON_08, base));
  });

  it('snaps against local midnight, not the epoch', () => {
    // Kathmandu is +05:45, so epoch-aligned rounding would land on :45 offsets.
    const free = [w('2026-03-09T04:07:00Z', '2026-03-09T12:00:00Z')];
    const slots = proposeSlots(free, t('2026-03-09T00:00:00Z'), {
      ...base,
      timezone: 'Asia/Kathmandu',
      leadTimeMinutes: 0,
    });
    const local = new Date(slots[0]!.start).toISOString();
    // 04:07Z is 09:52 local; the next quarter hour local is 10:00 = 04:15Z.
    expect(local).toBe('2026-03-09T04:15:00.000Z');
  });
});
