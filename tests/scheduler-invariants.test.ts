import { describe, expect, it } from 'vitest';
import {
  GreedyScheduler,
  blocksTime,
  defaultPreferences,
  eventFixture,
  instantFromISO,
  makeTask,
  overlaps,
  dailyWindow,
  weeklySchedule,
} from '@calendar-agent/core';
import type { CalendarEvent, SchedulingInput, Task } from '@calendar-agent/core';

/**
 * Randomised (but seeded, so reproducible) inputs checked against the
 * invariants the scheduler must never violate.
 */

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const WORKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;
const MONDAY = instantFromISO('2026-03-09T00:00:00Z');
const HOUR = 3_600_000;
const scheduler = new GreedyScheduler();

function buildScenario(seed: number): SchedulingInput {
  const random = makeRandom(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;

  const preferences = {
    ...defaultPreferences('user', 'UTC'),
    workingHours: weeklySchedule(WORKDAYS, [dailyWindow('09:00', '17:00')]),
    deepWork: {
      enabled: random() > 0.5,
      schedule: weeklySchedule(WORKDAYS, [dailyWindow('09:00', '12:00')]),
      allowMeetings: false,
      reserveForFocusTasks: false,
    },
    minimumBlockMinutes: pick([15, 30, 60]),
    maximumBlockMinutes: pick([60, 120, 240]),
    granularityMinutes: pick([5, 15, 30]),
    bufferBetweenBlocksMinutes: pick([0, 0, 15]),
  };

  const tasks: Task[] = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) =>
    makeTask({
      id: `task-${index}`,
      userId: 'user',
      title: `Task ${index}`,
      estimatedMinutes: pick([30, 60, 90, 120, 240, 480]),
      priority: pick(['low', 'normal', 'high', 'urgent'] as const),
      importance: Math.floor(random() * 100),
      minimumBlockMinutes: pick([15, 30, 60]),
      allowSplitting: random() > 0.2,
      focus: pick(['any', 'deep', 'shallow'] as const),
      ...(random() > 0.35 ? { deadline: MONDAY + (1 + Math.floor(random() * 9)) * 24 * HOUR } : {}),
      createdAt: MONDAY - 24 * HOUR,
      updatedAt: MONDAY - 24 * HOUR,
    }),
  );

  const events: CalendarEvent[] = Array.from({ length: Math.floor(random() * 8) }, (_, index) => {
    const dayOffset = Math.floor(random() * 7);
    const hour = 9 + Math.floor(random() * 7);
    const start = MONDAY + dayOffset * 24 * HOUR + hour * HOUR;
    return eventFixture({
      id: `event-${index}`,
      start,
      end: start + pick([30, 60, 90]) * 60_000,
      transparency: random() > 0.85 ? 'transparent' : 'opaque',
    });
  });

  return {
    now: MONDAY,
    horizon: { start: MONDAY, end: MONDAY + 14 * 24 * HOUR },
    tasks,
    events,
    existingBlocks: [],
    preferences,
  };
}

describe('scheduler invariants', () => {
  const seeds = Array.from({ length: 40 }, (_, index) => index + 1);

  it.each(seeds)('holds for scenario %i', (seed) => {
    const input = buildScenario(seed);
    const plan = scheduler.plan(input);
    const tasksById = new Map(input.tasks.map((task) => [task.id, task]));

    // 1. Blocks never overlap each other.
    const sorted = [...plan.blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
    }

    // 2. Blocks never collide with a busy calendar event.
    const busy = input.events
      .filter((event) => blocksTime(event))
      .map((event) => ({ start: event.start, end: event.end }));
    for (const block of plan.blocks) {
      for (const interval of busy) {
        expect(overlaps(interval, block)).toBe(false);
      }
    }

    for (const block of plan.blocks) {
      const task = tasksById.get(block.taskId)!;

      // 3. Nothing is scheduled in the past or beyond the horizon.
      expect(block.start).toBeGreaterThanOrEqual(input.now);
      expect(block.end).toBeLessThanOrEqual(input.horizon.end);

      // 4. Working hours are respected (09:00-17:00 UTC here).
      const startHour = new Date(block.start).getUTCHours();
      const endMinutes =
        new Date(block.end).getUTCHours() * 60 + new Date(block.end).getUTCMinutes();
      expect(startHour).toBeGreaterThanOrEqual(9);
      expect(endMinutes).toBeLessThanOrEqual(17 * 60);

      // 5. Deadlines are never violated.
      if (task.deadline !== undefined) expect(block.end).toBeLessThanOrEqual(task.deadline);

      // 6. Splittable work respects the maximum block size. Unsplittable work
      // is deliberately exempt: it has to be placed in one piece or not at all.
      if (task.allowSplitting) {
        expect(block.minutes).toBeLessThanOrEqual(input.preferences.maximumBlockMinutes);
      }
    }

    // 7. Tasks that forbid splitting get at most one block.
    for (const task of input.tasks) {
      const own = plan.blocks.filter((block) => block.taskId === task.id);
      if (!task.allowSplitting) expect(own.length).toBeLessThanOrEqual(1);

      // 8. Never schedule more than the remaining work.
      const scheduled = own.reduce((sum, block) => sum + block.minutes, 0);
      expect(scheduled).toBeLessThanOrEqual(task.estimatedMinutes);
    }

    // 9. Every unscheduled task carries a reason.
    for (const entry of plan.unscheduled) {
      expect(entry.reason.code.length).toBeGreaterThan(0);
      expect(entry.reason.message.length).toBeGreaterThan(0);
    }

    // 10. Planning is a pure function of its input.
    expect(JSON.stringify(scheduler.plan(input))).toEqual(JSON.stringify(plan));
  });
});
