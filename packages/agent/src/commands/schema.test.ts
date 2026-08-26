import { describe, expect, it } from 'vitest';
import { safeParseAgentPlan } from './schema.js';

describe('agent command validation', () => {
  it('accepts a well-formed plan', () => {
    const result = safeParseAgentPlan({
      intent: 'Create and schedule the ML project',
      commands: [
        {
          type: 'create_task',
          title: 'Machine learning project',
          estimatedMinutes: 480,
          deadline: '2026-03-12T23:59:00Z',
          priority: 'normal',
        },
        { type: 'schedule' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown command type', () => {
    const result = safeParseAgentPlan({ commands: [{ type: 'delete_calendar' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects a create_task without a duration', () => {
    const result = safeParseAgentPlan({ commands: [{ type: 'create_task', title: 'X' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/estimatedMinutes/);
  });

  it('rejects out-of-range values', () => {
    expect(
      safeParseAgentPlan({
        commands: [{ type: 'create_task', title: 'X', estimatedMinutes: -5 }],
      }).ok,
    ).toBe(false);
    expect(
      safeParseAgentPlan({
        commands: [{ type: 'create_task', title: 'X', estimatedMinutes: 30, importance: 500 }],
      }).ok,
    ).toBe(false);
  });

  it('strips nothing but refuses malformed time-of-day windows', () => {
    const result = safeParseAgentPlan({
      commands: [
        {
          type: 'create_task',
          title: 'X',
          estimatedMinutes: 30,
          preferredWindows: [{ start: 'morning', end: '12:00' }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('caps the number of commands', () => {
    const commands = Array.from({ length: 11 }, () => ({ type: 'list_risks' }));
    expect(safeParseAgentPlan({ commands }).ok).toBe(false);
  });
});
