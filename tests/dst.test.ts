import { describe, expect, it } from 'vitest';
import { createTestApp } from '@calendar-agent/app';
import { dayParts, instantFromISO, instantToISO } from './helpers.js';

/**
 * DST is the classic source of "the scheduler put it at the wrong time" bugs.
 * These tests drive the whole application, not just the time helpers.
 */
describe('daylight saving transitions', () => {
  const workingHours = {
    monday: '09:00-17:00',
    tuesday: '09:00-17:00',
    wednesday: '09:00-17:00',
    thursday: '09:00-17:00',
    friday: '09:00-17:00',
    saturday: '09:00-17:00',
    sunday: '09:00-17:00',
  };

  it('keeps 09:00 local across the US spring-forward', async () => {
    // 2026-03-08 is the US switch; plan from the Friday before it.
    const harness = await createTestApp({
      now: '2026-03-06T12:00:00Z',
      config: {
        timezone: 'America/New_York',
        working_hours: workingHours,
        deep_work: { enabled: false },
      },
    });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Daily study',
      // Enough work to span the transition: Friday through Monday.
      estimatedMinutes: 30 * 60,
      minimumBlockMinutes: 60,
      maximumBlockMinutes: 480,
    });
    const result = await harness.app.scheduling.plan({ userId: harness.userId });

    // Every block sits inside 09:00-17:00 local time on both sides of the
    // transition, even though the UTC offset changes half way through.
    for (const block of result.plan.blocks) {
      const start = dayParts(block.start, 'America/New_York');
      expect(start.hour).toBeGreaterThanOrEqual(9);
      expect(start.hour).toBeLessThan(17);
    }

    // Keep the first block of each day; blocks arrive in chronological order.
    const byDay = new Map<string, (typeof result.plan.blocks)[number]>();
    for (const block of result.plan.blocks) {
      const key = instantToISO(block.start).slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, block);
    }
    expect(byDay.size).toBeGreaterThan(2);
    // Friday is still EST (UTC-5): 09:00 local is 14:00 UTC.
    expect(instantToISO(byDay.get('2026-03-06')!.start)).toBe('2026-03-06T14:00:00.000Z');
    // Monday is EDT (UTC-4): the same 09:00 local is now 13:00 UTC.
    expect(instantToISO(byDay.get('2026-03-09')!.start)).toBe('2026-03-09T13:00:00.000Z');
  });

  it('produces a 23-hour Sunday and still fills the working window', async () => {
    const harness = await createTestApp({
      now: '2026-03-08T05:00:00Z',
      config: {
        timezone: 'America/New_York',
        working_hours: workingHours,
        deep_work: { enabled: false },
      },
    });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Sunday project',
      estimatedMinutes: 8 * 60,
      minimumBlockMinutes: 60,
      maximumBlockMinutes: 480,
      deadline: instantFromISO('2026-03-09T02:00:00Z'),
    });
    const result = await harness.app.scheduling.plan({ userId: harness.userId });
    const first = result.plan.blocks[0]!;
    // 09:00 EDT on the transition day is 13:00 UTC (offset already changed).
    expect(instantToISO(first.start)).toBe('2026-03-08T13:00:00.000Z');
  });

  it('keeps 09:00 local across the autumn fall-back', async () => {
    const harness = await createTestApp({
      now: '2026-10-30T12:00:00Z',
      config: {
        timezone: 'America/New_York',
        working_hours: workingHours,
        deep_work: { enabled: false },
      },
    });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Weekend work',
      estimatedMinutes: 6 * 60,
      minimumBlockMinutes: 60,
      maximumBlockMinutes: 120,
    });
    const result = await harness.app.scheduling.plan({ userId: harness.userId });
    for (const block of result.plan.blocks) {
      expect(dayParts(block.start, 'America/New_York').hour).toBeGreaterThanOrEqual(9);
    }
    // 2026-11-01 is the switch back: 09:00 local is 14:00 UTC again.
    const sunday = result.plan.blocks.find(
      (block) => instantToISO(block.start).slice(0, 10) === '2026-11-01',
    );
    if (sunday) expect(instantToISO(sunday.start).slice(11, 16)).toBe('14:00');
  });

  it('handles a zone with a half-hour offset', async () => {
    const harness = await createTestApp({
      now: '2026-03-09T00:00:00Z',
      config: {
        timezone: 'Asia/Kolkata',
        working_hours: workingHours,
        deep_work: { enabled: false },
      },
    });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Work',
      estimatedMinutes: 60,
    });
    const result = await harness.app.scheduling.plan({ userId: harness.userId });
    // 09:00 IST is 03:30 UTC.
    expect(instantToISO(result.plan.blocks[0]!.start)).toBe('2026-03-09T03:30:00.000Z');
  });
});
