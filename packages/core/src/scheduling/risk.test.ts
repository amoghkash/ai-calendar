import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_THRESHOLDS } from '../domain/preferences.js';
import { at, taskFixture } from '../testing/fixtures.js';
import { assessRisk } from './risk.js';

const base = {
  now: at('2026-03-09T09:00:00Z'),
  timezone: 'UTC',
  thresholds: DEFAULT_RISK_THRESHOLDS,
};

describe('assessRisk', () => {
  it('is SAFE when there is no work left', () => {
    const task = taskFixture({ estimatedMinutes: 60, completedMinutes: 60 });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 0,
      availableMinutesBeforeDeadline: 0,
    });
    expect(risk.level).toBe('SAFE');
    expect(risk.reason.code).toBe('risk.no_work_remaining');
  });

  it('is IMPOSSIBLE when capacity is below the remaining work', () => {
    const task = taskFixture({
      title: 'Distributed Systems Assignment',
      estimatedMinutes: 360,
      deadline: at('2026-03-10T17:00:00Z'),
    });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 210,
      availableMinutesBeforeDeadline: 210,
    });
    expect(risk.level).toBe('IMPOSSIBLE');
    expect(risk.explanation).toBe(
      '"Distributed Systems Assignment" cannot be completed: 6h of work remains but only 3h 30m of suitable availability exists before Tue 10 Mar 17:00.',
    );
  });

  it('is IMPOSSIBLE when the deadline already passed', () => {
    const task = taskFixture({ estimatedMinutes: 60, deadline: at('2026-03-08T17:00:00Z') });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 0,
      availableMinutesBeforeDeadline: 0,
    });
    expect(risk.reason.code).toBe('risk.overdue');
  });

  it('is CRITICAL when other work consumed the capacity', () => {
    const task = taskFixture({ estimatedMinutes: 240, deadline: at('2026-03-10T17:00:00Z') });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 120,
      availableMinutesBeforeDeadline: 600,
    });
    expect(risk.level).toBe('CRITICAL');
    expect(risk.reason.code).toBe('risk.contended_capacity');
  });

  it('is CRITICAL when cover is barely above 1x', () => {
    const task = taskFixture({ estimatedMinutes: 240, deadline: at('2026-03-10T17:00:00Z') });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 240,
      availableMinutesBeforeDeadline: 250,
    });
    expect(risk.level).toBe('CRITICAL');
    expect(risk.capacityRatio).toBeCloseTo(1.042, 3);
  });

  it('is AT_RISK with thin slack', () => {
    const task = taskFixture({ estimatedMinutes: 240, deadline: at('2026-03-10T17:00:00Z') });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 240,
      availableMinutesBeforeDeadline: 320,
    });
    expect(risk.level).toBe('AT_RISK');
    expect(risk.reason.code).toBe('risk.low_slack');
  });

  it('is AT_RISK when work finishes right before the deadline', () => {
    const task = taskFixture({ estimatedMinutes: 60, deadline: at('2026-03-10T17:00:00Z') });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 60,
      availableMinutesBeforeDeadline: 600,
      lastBlockEnd: at('2026-03-10T16:00:00Z'),
    });
    expect(risk.level).toBe('AT_RISK');
    expect(risk.reason.code).toBe('risk.finishes_near_deadline');
  });

  it('is SAFE with comfortable cover', () => {
    const task = taskFixture({ estimatedMinutes: 60, deadline: at('2026-03-13T17:00:00Z') });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 60,
      availableMinutesBeforeDeadline: 900,
      lastBlockEnd: at('2026-03-09T10:00:00Z'),
    });
    expect(risk.level).toBe('SAFE');
  });

  it('flags unscheduled work even without a deadline', () => {
    const task = taskFixture({ estimatedMinutes: 120 });
    const risk = assessRisk({
      ...base,
      task,
      scheduledMinutes: 30,
      availableMinutesBeforeDeadline: 0,
    });
    expect(risk.level).toBe('AT_RISK');
    expect(risk.capacityRatio).toBeNull();
  });
});
