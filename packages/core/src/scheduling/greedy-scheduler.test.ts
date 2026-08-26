import { describe, expect, it } from 'vitest';
import type { SchedulingPreferences } from '../domain/preferences.js';
import type { Task } from '../domain/task.js';
import {
  at,
  blockFixture,
  eventFixture,
  preferencesFixture,
  taskFixture,
} from '../testing/fixtures.js';
import { instantToISO } from '../time/instant.js';
import { dailyWindow, weeklySchedule } from '../time/wall-clock.js';
import { GreedyScheduler } from './greedy-scheduler.js';
import type { SchedulingInput } from './types.js';

const WORKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;
const MONDAY = at('2026-03-09T00:00:00Z');
const HORIZON = { start: MONDAY, end: at('2026-03-14T00:00:00Z') };

function prefs(partial: Partial<SchedulingPreferences> = {}): SchedulingPreferences {
  return preferencesFixture({
    timezone: 'UTC',
    workingHours: weeklySchedule(WORKDAYS, [dailyWindow('09:00', '17:00')]),
    deepWork: {
      enabled: false,
      schedule: {},
      allowMeetings: false,
      reserveForFocusTasks: false,
    },
    ...partial,
  });
}

function input(partial: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    now: MONDAY,
    horizon: HORIZON,
    tasks: [],
    events: [],
    existingBlocks: [],
    preferences: prefs(),
    ...partial,
  };
}

const scheduler = new GreedyScheduler();
const times = (plan: { blocks: readonly { start: number; end: number }[] }): string[] =>
  plan.blocks.map((b) => `${instantToISO(b.start)}/${instantToISO(b.end)}`);

describe('GreedyScheduler: basic placement', () => {
  it('places a task in the first working window', () => {
    const task = taskFixture({ estimatedMinutes: 120 });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(times(plan)).toEqual(['2026-03-09T09:00:00.000Z/2026-03-09T11:00:00.000Z']);
    expect(plan.unscheduled).toHaveLength(0);
    expect(plan.blocks[0]!.reason.code).toBe('placement.new');
  });

  it('never schedules outside working hours', () => {
    const task = taskFixture({ estimatedMinutes: 600 });
    const plan = scheduler.plan(input({ tasks: [task] }));
    for (const block of plan.blocks) {
      const hour = new Date(block.start).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(new Date(block.end).getUTCHours()).toBeLessThanOrEqual(17);
    }
  });

  it('never schedules in the past', () => {
    const task = taskFixture({ estimatedMinutes: 60 });
    const plan = scheduler.plan(input({ tasks: [task], now: at('2026-03-09T13:00:00Z') }));
    expect(times(plan)).toEqual(['2026-03-09T13:00:00.000Z/2026-03-09T14:00:00.000Z']);
  });

  it('never overlaps an existing calendar event', () => {
    const task = taskFixture({ estimatedMinutes: 120 });
    const meeting = eventFixture({
      start: at('2026-03-09T09:00:00Z'),
      end: at('2026-03-09T10:30:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task], events: [meeting] }));
    expect(times(plan)).toEqual(['2026-03-09T10:30:00.000Z/2026-03-09T12:30:00.000Z']);
  });

  it('rounds block starts to the configured granularity', () => {
    const task = taskFixture({ estimatedMinutes: 60 });
    const meeting = eventFixture({
      start: at('2026-03-09T09:00:00Z'),
      end: at('2026-03-09T10:07:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task], events: [meeting] }));
    expect(times(plan)).toEqual(['2026-03-09T10:15:00.000Z/2026-03-09T11:15:00.000Z']);
  });
});

describe('GreedyScheduler: splitting', () => {
  it('splits long work across blocks bounded by the maximum block size', () => {
    const task = taskFixture({ estimatedMinutes: 480, minimumBlockMinutes: 60 });
    const plan = scheduler.plan(
      input({ tasks: [task], preferences: prefs({ maximumBlockMinutes: 180 }) }),
    );
    expect(plan.blocks.map((b) => b.minutes)).toEqual([180, 180, 120]);
    expect(plan.unscheduled).toHaveLength(0);
  });

  it('refuses to split when the task forbids it', () => {
    const task = taskFixture({ estimatedMinutes: 300, allowSplitting: false });
    const meeting = eventFixture({
      start: at('2026-03-09T11:00:00Z'),
      end: at('2026-03-09T13:00:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task], events: [meeting] }));
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]!.minutes).toBe(300);
    // Monday cannot hold 5 contiguous hours, so it lands on Tuesday.
    expect(instantToISO(plan.blocks[0]!.start)).toBe('2026-03-10T09:00:00.000Z');
  });

  it('reports an unsplittable task that never fits', () => {
    const task = taskFixture({ estimatedMinutes: 600, allowSplitting: false });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(plan.blocks).toHaveLength(0);
    expect(plan.unscheduled[0]!.reason.code).toBe('placement.no_contiguous_window');
  });

  it('skips windows smaller than the minimum block', () => {
    const task = taskFixture({ estimatedMinutes: 60, minimumBlockMinutes: 60 });
    const meeting = eventFixture({
      start: at('2026-03-09T09:00:00Z'),
      end: at('2026-03-09T16:30:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task], events: [meeting] }));
    expect(instantToISO(plan.blocks[0]!.start)).toBe('2026-03-10T09:00:00.000Z');
  });

  it('allows a final short block below the minimum when that is all that is left', () => {
    const task = taskFixture({ estimatedMinutes: 20, minimumBlockMinutes: 60 });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(plan.blocks.map((b) => b.minutes)).toEqual([20]);
  });

  it('keeps the buffer clear of existing calendar events, on both sides', () => {
    // The buffer used to apply only after a block the scheduler had just placed,
    // so work still started the second a meeting ended.
    const meeting = eventFixture({
      start: at('2026-03-09T11:00:00Z'),
      end: at('2026-03-09T12:00:00Z'),
    });
    const task = taskFixture({ estimatedMinutes: 240, minimumBlockMinutes: 30 });
    const plan = scheduler.plan(
      input({
        tasks: [task],
        events: [meeting],
        preferences: prefs({ bufferBetweenBlocksMinutes: 30, maximumBlockMinutes: 240 }),
      }),
    );
    expect(times(plan)).toEqual([
      '2026-03-09T09:00:00.000Z/2026-03-09T10:30:00.000Z',
      '2026-03-09T12:30:00.000Z/2026-03-09T15:00:00.000Z',
    ]);
  });

  it('inserts a buffer between consecutive blocks', () => {
    const task = taskFixture({ estimatedMinutes: 240, minimumBlockMinutes: 60 });
    const plan = scheduler.plan(
      input({
        tasks: [task],
        preferences: prefs({ maximumBlockMinutes: 120, bufferBetweenBlocksMinutes: 30 }),
      }),
    );
    expect(times(plan)).toEqual([
      '2026-03-09T09:00:00.000Z/2026-03-09T11:00:00.000Z',
      '2026-03-09T11:30:00.000Z/2026-03-09T13:30:00.000Z',
    ]);
  });
});

describe('GreedyScheduler: deadlines and priority', () => {
  it('never places work after the deadline', () => {
    const task = taskFixture({
      estimatedMinutes: 240,
      deadline: at('2026-03-09T12:00:00Z'),
      minimumBlockMinutes: 30,
    });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(plan.blocks).toHaveLength(1);
    for (const block of plan.blocks) expect(block.end).toBeLessThanOrEqual(task.deadline!);
    // 4h of work, 3h of runway: the hour that does not fit is reported.
    expect(plan.unscheduled[0]!.missingMinutes).toBe(60);
  });

  it('schedules the more urgent task first', () => {
    const urgent = taskFixture({
      id: 'urgent',
      title: 'Urgent',
      estimatedMinutes: 120,
      deadline: at('2026-03-09T17:00:00Z'),
      priority: 'high',
    });
    const relaxed = taskFixture({
      id: 'relaxed',
      title: 'Relaxed',
      estimatedMinutes: 120,
      deadline: at('2026-03-13T17:00:00Z'),
      priority: 'low',
    });
    const plan = scheduler.plan(input({ tasks: [relaxed, urgent] }));
    expect(plan.blocks[0]!.taskId).toBe('urgent');
    expect(plan.trace.scores[0]!.taskId).toBe('urgent');
  });

  it('honours earliestStart', () => {
    const task = taskFixture({
      estimatedMinutes: 60,
      earliestStart: at('2026-03-10T00:00:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(instantToISO(plan.blocks[0]!.start)).toBe('2026-03-10T09:00:00.000Z');
  });

  it('honours latestStart on the first block', () => {
    const task = taskFixture({
      estimatedMinutes: 60,
      // Work must begin on Monday, even though later days are wide open.
      latestStart: at('2026-03-09T12:00:00Z'),
      preferredDays: ['monday', 'wednesday'],
    });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(plan.blocks[0]!.start).toBeLessThanOrEqual(task.latestStart!);
  });

  it('reports a task whose latestStart cannot be met', () => {
    const task = taskFixture({
      estimatedMinutes: 60,
      latestStart: at('2026-03-09T08:00:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(plan.blocks).toHaveLength(0);
    expect(plan.unscheduled).toHaveLength(1);
  });

  it('flags a task that cannot fit before its deadline as IMPOSSIBLE', () => {
    const task = taskFixture({
      title: 'Distributed Systems Assignment',
      estimatedMinutes: 360,
      deadline: at('2026-03-09T12:30:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task] }));
    const risk = plan.risks[0]!;
    expect(risk.level).toBe('IMPOSSIBLE');
    expect(risk.explanation).toContain('6h');
    expect(risk.explanation).toContain('3h 30m');
    expect(plan.unscheduled).toHaveLength(1);
  });

  it('marks a fully scheduled task with little slack as at risk', () => {
    const task = taskFixture({
      estimatedMinutes: 360,
      deadline: at('2026-03-09T17:00:00Z'),
      minimumBlockMinutes: 60,
    });
    const plan = scheduler.plan(
      input({ tasks: [task], preferences: prefs({ maximumBlockMinutes: 480 }) }),
    );
    expect(plan.unscheduled).toHaveLength(0);
    expect(['AT_RISK', 'CRITICAL']).toContain(plan.risks[0]!.level);
  });

  it('reports the contended case when a lower-priority task loses its time', () => {
    const hog = taskFixture({
      id: 'hog',
      estimatedMinutes: 480,
      priority: 'urgent',
      deadline: at('2026-03-09T17:00:00Z'),
      minimumBlockMinutes: 60,
    });
    const loser = taskFixture({
      id: 'loser',
      estimatedMinutes: 240,
      priority: 'low',
      deadline: at('2026-03-09T17:00:00Z'),
      minimumBlockMinutes: 60,
    });
    const plan = scheduler.plan(
      input({ tasks: [hog, loser], preferences: prefs({ maximumBlockMinutes: 480 }) }),
    );
    const loserRisk = plan.risks.find((r) => r.taskId === 'loser')!;
    expect(loserRisk.level).toBe('CRITICAL');
    expect(loserRisk.reason.code).toBe('risk.contended_capacity');
  });
});

describe('GreedyScheduler: constraints', () => {
  it('respects preferred days and windows', () => {
    const task = taskFixture({
      estimatedMinutes: 60,
      preferredDays: ['wednesday'],
      preferredWindows: [dailyWindow('14:00', '16:00')],
    });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(times(plan)).toEqual(['2026-03-11T14:00:00.000Z/2026-03-11T15:00:00.000Z']);
  });

  it('relaxes preferences when nothing else fits, and says so', () => {
    const task = taskFixture({
      estimatedMinutes: 60,
      preferredDays: ['saturday'],
    });
    const plan = scheduler.plan(input({ tasks: [task] }));
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]!.reason.details?.relaxedPreferences).toBe(true);
  });

  it('caps the amount of task work per day', () => {
    const task = taskFixture({ estimatedMinutes: 480, minimumBlockMinutes: 60 });
    const plan = scheduler.plan(
      input({
        tasks: [task],
        preferences: prefs({ maxDailyTaskMinutes: 120, maximumBlockMinutes: 480 }),
      }),
    );
    expect(plan.blocks.map((b) => b.minutes)).toEqual([120, 120, 120, 120]);
    expect(new Set(plan.blocks.map((b) => instantToISO(b.start).slice(0, 10))).size).toBe(4);
  });

  it('does not schedule a task whose dependency is unfinished', () => {
    const first = taskFixture({ id: 'first', estimatedMinutes: 60 });
    const second = taskFixture({ id: 'second', estimatedMinutes: 60, dependsOn: ['first'] });
    const plan = scheduler.plan(input({ tasks: [first, second] }));
    expect(plan.blocks.map((b) => b.taskId)).toEqual(['first']);
    expect(plan.unscheduled[0]!.reason.code).toBe('task.blocked_by_dependency');
  });

  it('places focus work inside deep-work windows', () => {
    const focus = taskFixture({ id: 'focus', estimatedMinutes: 120, focus: 'deep' });
    const admin = taskFixture({ id: 'admin', estimatedMinutes: 120, priority: 'urgent' });
    const plan = scheduler.plan(
      input({
        tasks: [focus, admin],
        preferences: prefs({
          deepWork: {
            enabled: true,
            schedule: weeklySchedule(WORKDAYS, [dailyWindow('13:00', '17:00')]),
            allowMeetings: false,
            reserveForFocusTasks: false,
          },
        }),
      }),
    );
    const focusBlock = plan.blocks.find((b) => b.taskId === 'focus')!;
    expect(focusBlock.deepWork).toBe(true);
    expect(instantToISO(focusBlock.start)).toBe('2026-03-09T13:00:00.000Z');
  });
});

describe('GreedyScheduler: stability and rescheduling', () => {
  const task = (): Task =>
    taskFixture({ id: 'algorithms', title: 'Algorithms', estimatedMinutes: 120 });

  it('keeps existing valid blocks untouched', () => {
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T11:00:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [task()], existingBlocks: [existing] }));
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]!.origin).toBe('retained');
    expect(plan.diff.summary).toMatchObject({ addedCount: 0, movedCount: 0, removedCount: 0 });
    expect(plan.quality.metrics.find((m) => m.key === 'stability')!.value).toBe(1);
  });

  it('moves a block when a new meeting conflicts with it', () => {
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T11:00:00Z'),
      externalEventId: 'ext-1',
    });
    const meeting = eventFixture({
      title: 'New meeting',
      start: at('2026-03-10T09:30:00Z'),
      end: at('2026-03-10T11:00:00Z'),
    });
    const plan = scheduler.plan(
      input({ tasks: [task()], existingBlocks: [existing], events: [meeting] }),
    );
    expect(plan.diff.moved).toHaveLength(1);
    const moved = plan.diff.moved[0]!;
    expect(moved.blockId).toBe('b1');
    expect(instantToISO(moved.before!.start)).toBe('2026-03-10T09:00:00.000Z');
    expect(instantToISO(moved.after!.start)).toBe('2026-03-09T09:00:00.000Z');
    expect(moved.reason.message).toContain('no longer usable');
  });

  it('does not move a pinned block even when it conflicts', () => {
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T11:00:00Z'),
      pinned: true,
    });
    const meeting = eventFixture({
      start: at('2026-03-10T09:30:00Z'),
      end: at('2026-03-10T11:00:00Z'),
    });
    const plan = scheduler.plan(
      input({ tasks: [task()], existingBlocks: [existing], events: [meeting] }),
    );
    expect(plan.diff.moved).toHaveLength(0);
    expect(plan.blocks[0]!.reason.code).toBe('placement.frozen');
  });

  it('does not move a block that starts inside the freeze window', () => {
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-09T09:30:00Z'),
      end: at('2026-03-09T11:30:00Z'),
    });
    const meeting = eventFixture({
      start: at('2026-03-09T10:00:00Z'),
      end: at('2026-03-09T11:00:00Z'),
    });
    const plan = scheduler.plan(
      input({
        tasks: [task()],
        existingBlocks: [existing],
        events: [meeting],
        now: at('2026-03-09T09:00:00Z'),
      }),
    );
    expect(plan.blocks[0]!.reason.code).toBe('placement.frozen');
  });

  it('keeps an existing block when nothing better can be found', () => {
    // A task that is pinned to a window with no room must not lose the block
    // it already had: a failed search never destroys existing work.
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-10T14:00:00Z'),
      end: at('2026-03-10T16:00:00Z'),
    });
    const constrained = taskFixture({
      id: 'algorithms',
      title: 'Algorithms',
      estimatedMinutes: 120,
      preferredDays: ['tuesday'],
      preferredWindows: [dailyWindow('09:00', '10:00')],
    });
    const blocker = eventFixture({
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T10:00:00Z'),
    });
    const plan = scheduler.plan(
      input({ tasks: [constrained], existingBlocks: [existing], events: [blocker] }),
    );
    expect(plan.diff.removed).toHaveLength(0);
    expect(plan.blocks.map((b) => b.id)).toContain('b1');
  });

  it('respects the per-run move limit', () => {
    // Three conflicting blocks, but the run may only move one of them.
    const tasks = ['a', 'b', 'c'].map((id) =>
      taskFixture({ id, title: id.toUpperCase(), estimatedMinutes: 60 }),
    );
    const existing = ['a', 'b', 'c'].map((id, index) =>
      blockFixture({
        id: `blk-${id}`,
        taskId: id,
        start: at(`2026-03-12T${String(9 + index).padStart(2, '0')}:00:00Z`),
        end: at(`2026-03-12T${String(10 + index).padStart(2, '0')}:00:00Z`),
      }),
    );
    const meeting = eventFixture({
      start: at('2026-03-12T09:00:00Z'),
      end: at('2026-03-12T12:00:00Z'),
    });
    const preferences = prefs({
      stability: { minimumImprovement: 0.05, freezeWindowMinutes: 120, maxMovesPerRun: 1 },
    });
    const plan = scheduler.plan(
      input({ tasks, existingBlocks: existing, events: [meeting], preferences }),
    );
    expect(plan.diff.moved).toHaveLength(1);
    expect(plan.trace.steps.some((step) => step.message.includes('move limit'))).toBe(true);
  });

  it('rebuilds everything when asked', () => {
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-12T09:00:00Z'),
      end: at('2026-03-12T11:00:00Z'),
    });
    const plan = scheduler.plan(
      input({ tasks: [task()], existingBlocks: [existing], rebuild: true }),
    );
    expect(plan.diff.moved).toHaveLength(1);
    expect(instantToISO(plan.blocks[0]!.start)).toBe('2026-03-09T09:00:00.000Z');
  });

  it('removes blocks whose task is completed', () => {
    const done = taskFixture({ id: 'algorithms', status: 'completed', estimatedMinutes: 120 });
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T11:00:00Z'),
    });
    const plan = scheduler.plan(input({ tasks: [done], existingBlocks: [existing] }));
    expect(plan.diff.removed).toHaveLength(1);
    expect(plan.blocks).toHaveLength(0);
  });

  it('ignores the calendar event that mirrors its own block', () => {
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algorithms',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T11:00:00Z'),
      externalEventId: 'ext-1',
    });
    const mirror = eventFixture({
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T11:00:00Z'),
      blockId: 'b1',
      taskId: 'algorithms',
      classification: 'MOVABLE',
    });
    const plan = scheduler.plan(
      input({ tasks: [task()], existingBlocks: [existing], events: [mirror] }),
    );
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]!.origin).toBe('retained');
  });

  it('only replans the requested task', () => {
    const other = taskFixture({ id: 'other', estimatedMinutes: 60 });
    const otherBlock = blockFixture({
      id: 'b-other',
      taskId: 'other',
      start: at('2026-03-09T09:00:00Z'),
      end: at('2026-03-09T10:00:00Z'),
    });
    const plan = scheduler.plan(
      input({
        tasks: [task(), other],
        existingBlocks: [otherBlock],
        taskIds: ['algorithms'],
        now: at('2026-03-08T00:00:00Z'),
      }),
    );
    expect(plan.blocks.filter((b) => b.taskId === 'other')[0]!.origin).toBe('retained');
    expect(plan.blocks.filter((b) => b.taskId === 'algorithms')).toHaveLength(1);
  });
});

describe('GreedyScheduler: determinism and explanation', () => {
  it('produces identical plans for identical input', () => {
    const tasks = [
      taskFixture({ id: 'a', estimatedMinutes: 90, deadline: at('2026-03-11T17:00:00Z') }),
      taskFixture({ id: 'b', estimatedMinutes: 150, priority: 'high' }),
      taskFixture({ id: 'c', estimatedMinutes: 45, importance: 90 }),
    ];
    const first = scheduler.plan(input({ tasks }));
    const second = scheduler.plan(input({ tasks }));
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it('records a traceable run', () => {
    const plan = scheduler.plan(input({ tasks: [taskFixture({ estimatedMinutes: 60 })] }));
    expect(plan.trace.steps.map((s) => s.step)).toContain('availability');
    expect(plan.trace.steps.map((s) => s.step)).toContain('ranking');
    expect(plan.trace.steps.map((s) => s.step)).toContain('placement');
    expect(plan.trace.input.availableMinutes).toBeGreaterThan(0);
  });

  it('explains every score component', () => {
    const plan = scheduler.plan(
      input({
        tasks: [taskFixture({ estimatedMinutes: 60, deadline: at('2026-03-10T17:00:00Z') })],
      }),
    );
    const score = plan.trace.scores[0]!;
    expect(score.components.map((c) => c.key)).toEqual([
      'deadlineUrgency',
      'priority',
      'importance',
      'deadlineRisk',
      'ageBonus',
    ]);
    for (const component of score.components) {
      expect(component.contribution).toBeCloseTo(component.weight * component.normalized, 3);
      expect(component.explanation.length).toBeGreaterThan(0);
    }
  });
});

describe('GreedyScheduler: timezones', () => {
  it('keeps working hours anchored to local time across a DST change', () => {
    const preferences = prefs({
      timezone: 'America/New_York',
      workingHours: weeklySchedule(WORKDAYS, [dailyWindow('09:00', '17:00')]),
      maximumBlockMinutes: 480,
    });
    const task = taskFixture({ estimatedMinutes: 480, minimumBlockMinutes: 60 });
    // Friday 2026-03-06 through the following Monday, spanning the US switch.
    const plan = scheduler.plan({
      now: at('2026-03-06T00:00:00Z'),
      horizon: { start: at('2026-03-06T00:00:00Z'), end: at('2026-03-10T00:00:00Z') },
      tasks: [task],
      events: [],
      existingBlocks: [],
      preferences,
      timezone: 'America/New_York',
    });
    expect(instantToISO(plan.blocks[0]!.start)).toBe('2026-03-06T14:00:00.000Z');

    const monday = scheduler.plan({
      now: at('2026-03-09T00:00:00Z'),
      horizon: { start: at('2026-03-09T00:00:00Z'), end: at('2026-03-13T00:00:00Z') },
      tasks: [task],
      events: [],
      existingBlocks: [],
      preferences,
      timezone: 'America/New_York',
    });
    // Same 09:00 local, one hour earlier in UTC now that EDT is in effect.
    expect(instantToISO(monday.blocks[0]!.start)).toBe('2026-03-09T13:00:00.000Z');
  });
});
