import { describe, expect, it } from 'vitest';
import { createTestApp } from '@calendar-agent/app';
import { instantFromISO, instantToISO } from '@calendar-agent/core';
import { mockEvent } from '@calendar-agent/integrations';
import { buildProgram } from '@calendar-agent/cli';

const at = instantFromISO;

/**
 * The definition of done, exercised end to end against the mock calendar:
 * connect, create work, ask in plain language, understand the proposal,
 * approve it, change the calendar externally, re-sync and re-plan.
 */
describe('end to end', () => {
  it('walks the whole loop from task to calendar and back', async () => {
    const harness = await createTestApp();
    const app = harness.app;
    const userId = harness.userId;

    // 1. A calendar is connected and its calendars imported.
    const calendars = await app.calendars.listCalendars(userId);
    expect(calendars).toHaveLength(1);

    // 2. Existing commitments are visible after a sync.
    harness.provider.seed(
      mockEvent({
        externalId: 'standup',
        title: 'Team standup',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T09:30:00Z'),
        attendees: [{ email: 'me@example.com', self: true }, { email: 'lead@example.com' }],
      }),
    );
    await app.sync.sync({ userId });
    const events = await app.calendars.listEvents(userId, {
      start: at('2026-03-09T00:00:00Z'),
      end: at('2026-03-16T00:00:00Z'),
    });
    expect(events.map((event) => event.title)).toContain('Team standup');
    expect(events[0]!.classification).toBe('FIXED');

    // 3. Create a task with a deadline and an estimate.
    const task = await app.tasks.create({
      userId,
      title: 'Algorithms assignment',
      estimatedMinutes: 240,
      deadline: at('2026-03-13T17:00:00Z'),
      priority: 'high',
      minimumBlockMinutes: 60,
    });

    // 4. Ask in plain language.
    const turn = await app.agent.handle({
      userId,
      text: 'Schedule my algorithms assignment',
    });
    expect(turn.commands).toEqual([{ type: 'schedule', taskRefs: [task.id] }]);

    // 5. The deterministic scheduler found time...
    const plan = turn.plan!;
    expect(plan.blocks.length).toBeGreaterThan(0);
    expect(plan.blocks.reduce((sum, block) => sum + block.minutes, 0)).toBe(240);

    // ...it does not collide with the meeting...
    for (const block of plan.blocks) {
      const overlapsStandup =
        block.start < at('2026-03-10T09:30:00Z') && block.end > at('2026-03-10T09:00:00Z');
      expect(overlapsStandup).toBe(false);
    }

    // 6/7. ...and every block explains itself.
    for (const entry of plan.diff.added) {
      expect(entry.reason.message.length).toBeGreaterThan(10);
      expect(entry.reason.code).toBe('placement.new');
    }

    // 8/9. Approve, and the blocks land on the calendar.
    const applied = await app.scheduling.approve(turn.changeSetId!, { userId });
    expect(applied.failures).toHaveLength(0);
    const written = harness.provider
      .list()
      .filter((event) => event.metadata.calendarAgentManaged === 'true');
    expect(written).toHaveLength(plan.blocks.length);
    expect(written[0]!.title).toBe('Algorithms assignment');

    // 10. A new meeting appears in the external calendar, over a block.
    const victim = plan.blocks[plan.blocks.length - 1]!;
    harness.provider.seed(
      mockEvent({
        externalId: 'review',
        title: 'Design review',
        start: victim.start,
        end: victim.end,
        attendees: [{ email: 'me@example.com', self: true }, { email: 'boss@example.com' }],
      }),
    );

    // 11/12. Sync detects it.
    const report = await app.sync.sync({ userId });
    expect(report.needsReplan).toBe(true);

    // 13. The scheduler proposes a new plan that avoids the conflict.
    const replan = await app.scheduling.plan({ userId });
    expect(replan.plan.diff.moved.length).toBeGreaterThan(0);
    for (const block of replan.plan.blocks) {
      const clashes = block.start < victim.end && block.end > victim.start;
      expect(clashes).toBe(false);
    }

    // 14/15. Risk questions get accurate, deterministic answers.
    const risks = await app.agent.handle({ userId, text: 'What deadlines are at risk?' });
    expect(risks.risks!.find((risk) => risk.taskId === task.id)!.level).toBe('SAFE');

    await app.tasks.create({
      userId,
      title: 'Impossible essay',
      estimatedMinutes: 3000,
      deadline: at('2026-03-11T09:00:00Z'),
    });
    const worse = await app.scheduling.risks(userId);
    const impossible = worse.find((risk) => risk.title === 'Impossible essay')!;
    expect(impossible.level).toBe('IMPOSSIBLE');
    expect(impossible.explanation).toMatch(/cannot be completed/);
  });

  it('exposes the same behaviour through the CLI', async () => {
    const harness = await createTestApp();
    (harness.app as { shutdown: () => Promise<void> }).shutdown = async () => {};
    const output: string[] = [];
    const run = async (...argv: string[]): Promise<string> => {
      output.length = 0;
      const program = buildProgram({
        appFactory: async () => harness.app,
        out: (line) => output.push(line),
        errOut: (line) => output.push(line),
      });
      await program.parseAsync(['node', 'calendar-agent', ...argv]);
      return output.join('\n');
    };

    await run('tasks', 'add', 'Algorithms assignment', '--duration', '4h', '--due', 'friday');

    // Simulation first: nothing is written.
    const simulated = await run('schedule');
    expect(simulated).toContain('PROPOSED CHANGES');
    expect(simulated).toContain('No calendar changes were made.');
    expect(harness.provider.list()).toHaveLength(0);

    // Then apply.
    const appliedText = await run('schedule', '--apply');
    expect(appliedText).toContain('Changes applied to your calendar.');
    expect(harness.provider.list().length).toBeGreaterThan(0);

    // Natural language goes through the same services.
    const nl = await run('schedule my algorithms assignment');
    expect(nl).toMatch(/new block|blocks? moved|already/);

    const risks = await run('risks');
    expect(risks).toMatch(/on track|AT_RISK|CRITICAL|IMPOSSIBLE/);
  });

  it('keeps working with no calendar connected at all', async () => {
    const harness = await createTestApp({ withoutCalendar: true });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Offline work',
      estimatedMinutes: 120,
    });
    const result = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(result.plan.blocks).toHaveLength(1);
    expect(instantToISO(result.plan.blocks[0]!.start)).toBe('2026-03-09T09:00:00.000Z');
  });
});
