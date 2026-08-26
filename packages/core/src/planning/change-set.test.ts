import { describe, expect, it } from 'vitest';
import { METADATA_BLOCK_ID, METADATA_MANAGED } from '../domain/calendar.js';
import { DEFAULT_AUTOMATION } from '../domain/preferences.js';
import { GreedyScheduler } from '../scheduling/greedy-scheduler.js';
import type { SchedulingInput } from '../scheduling/types.js';
import {
  at,
  blockFixture,
  eventFixture,
  preferencesFixture,
  taskFixture,
} from '../testing/fixtures.js';
import { dailyWindow, weeklySchedule } from '../time/wall-clock.js';
import { buildChangeSet, evaluateEventMove } from './change-set.js';

const WORKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;
const MONDAY = at('2026-03-09T00:00:00Z');
const scheduler = new GreedyScheduler();

const preferences = preferencesFixture({
  timezone: 'UTC',
  workingHours: weeklySchedule(WORKDAYS, [dailyWindow('09:00', '17:00')]),
  deepWork: { enabled: false, schedule: {}, allowMeetings: false, reserveForFocusTasks: false },
});

const target = () => ({ calendarId: 'cal-1', calendarExternalId: 'primary', timezone: 'UTC' });

function planFor(partial: Partial<SchedulingInput>) {
  return scheduler.plan({
    now: MONDAY,
    horizon: { start: MONDAY, end: at('2026-03-14T00:00:00Z') },
    tasks: [],
    events: [],
    existingBlocks: [],
    preferences,
    ...partial,
  });
}

describe('buildChangeSet', () => {
  const task = taskFixture({ id: 'algo', title: 'Algorithms', estimatedMinutes: 120 });

  it('creates events for new blocks and carries our metadata', () => {
    const plan = planFor({ tasks: [task] });
    const changeSet = buildChangeSet({
      id: 'cs1',
      userId: 'user',
      now: MONDAY,
      plan,
      previousBlocks: [],
      taskTitles: new Map([['algo', 'Algorithms']]),
      resolveTarget: target,
      automation: { ...DEFAULT_AUTOMATION, mode: 'autonomous' },
      timezone: 'UTC',
    });
    expect(changeSet.autoApply).toHaveLength(1);
    const mutation = changeSet.autoApply[0]!;
    expect(mutation.kind).toBe('create_event');
    if (mutation.kind === 'create_event') {
      expect(mutation.input.metadata?.[METADATA_MANAGED]).toBe('true');
      expect(mutation.input.metadata?.[METADATA_BLOCK_ID]).toBe(plan.blocks[0]!.id);
      expect(mutation.input.title).toBe('Algorithms');
    }
  });

  it('only changes the timing when moving an existing event', () => {
    const existing = blockFixture({
      id: 'b1',
      taskId: 'algo',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T11:00:00Z'),
      externalEventId: 'ext-1',
    });
    const conflict = eventFixture({
      start: at('2026-03-10T09:30:00Z'),
      end: at('2026-03-10T11:00:00Z'),
    });
    const plan = planFor({ tasks: [task], existingBlocks: [existing], events: [conflict] });
    const changeSet = buildChangeSet({
      id: 'cs2',
      userId: 'user',
      now: MONDAY,
      plan,
      previousBlocks: [existing],
      taskTitles: new Map([['algo', 'Algorithms']]),
      resolveTarget: target,
      automation: { ...DEFAULT_AUTOMATION, mode: 'autonomous' },
      timezone: 'UTC',
    });
    const mutation = changeSet.autoApply.find((m) => m.kind === 'update_event');
    expect(mutation).toBeDefined();
    if (mutation?.kind === 'update_event') {
      expect(Object.keys(mutation.changes).sort()).toEqual(['end', 'start', 'timezone']);
      expect(mutation.externalId).toBe('ext-1');
    }
  });

  it('blocks everything in read-only mode', () => {
    const plan = planFor({ tasks: [task] });
    const changeSet = buildChangeSet({
      id: 'cs3',
      userId: 'user',
      now: MONDAY,
      plan,
      previousBlocks: [],
      taskTitles: new Map(),
      resolveTarget: target,
      automation: { ...DEFAULT_AUTOMATION, mode: 'read_only' },
      timezone: 'UTC',
    });
    expect(changeSet.autoApply).toHaveLength(0);
    expect(changeSet.pending).toHaveLength(0);
    expect(changeSet.blocked[0]!.reason.code).toBe('policy.read_only');
  });

  it('requires approval in suggest mode', () => {
    const plan = planFor({ tasks: [task] });
    const changeSet = buildChangeSet({
      id: 'cs4',
      userId: 'user',
      now: MONDAY,
      plan,
      previousBlocks: [],
      taskTitles: new Map(),
      resolveTarget: target,
      automation: DEFAULT_AUTOMATION,
      timezone: 'UTC',
    });
    expect(changeSet.autoApply).toHaveLength(0);
    expect(changeSet.pending).toHaveLength(1);
    expect(changeSet.summary).toContain('awaiting approval');
  });

  it('holds back an oversized autonomous change set', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      taskFixture({ id: `t${i}`, title: `T${i}`, estimatedMinutes: 60 }),
    );
    const plan = planFor({ tasks: many });
    const changeSet = buildChangeSet({
      id: 'cs5',
      userId: 'user',
      now: MONDAY,
      plan,
      previousBlocks: [],
      taskTitles: new Map(many.map((t) => [t.id, t.title])),
      resolveTarget: target,
      automation: { ...DEFAULT_AUTOMATION, mode: 'autonomous', maxAutoMutations: 3 },
      timezone: 'UTC',
    });
    expect(changeSet.autoApply).toHaveLength(0);
    expect(changeSet.pending).toHaveLength(6);
  });
});

describe('evaluateEventMove', () => {
  it('never moves protected or fixed events', () => {
    expect(
      evaluateEventMove(
        { classification: 'PROTECTED', title: 'Doctor', isProtected: true },
        DEFAULT_AUTOMATION,
      ).policy,
    ).toBe('never');
    expect(
      evaluateEventMove(
        { classification: 'FIXED', title: 'Team sync', isProtected: false },
        DEFAULT_AUTOMATION,
      ).policy,
    ).toBe('never');
  });

  it('asks before moving unclassified events', () => {
    expect(
      evaluateEventMove(
        { classification: 'UNKNOWN', title: 'Lunch', isProtected: false },
        DEFAULT_AUTOMATION,
      ).policy,
    ).toBe('ask');
  });

  it('moves its own blocks automatically', () => {
    expect(
      evaluateEventMove(
        { classification: 'MOVABLE', title: 'Study', isProtected: false },
        DEFAULT_AUTOMATION,
      ).policy,
    ).toBe('auto');
  });
});
