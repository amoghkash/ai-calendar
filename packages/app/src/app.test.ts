import { beforeEach, describe, expect, it } from 'vitest';
import { instantFromISO, instantToISO } from '@calendar-agent/core';
import { mockEvent } from '@calendar-agent/integrations';
import { MockLLMProvider, mockText, mockToolCalls } from '@calendar-agent/agent';
import type { TestApp } from './testing.js';
import { createTestApp } from './testing.js';

const at = instantFromISO;

describe('application services', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  it('connects a calendar account and imports its calendars', async () => {
    const calendars = await harness.app.calendars.listCalendars(harness.userId);
    expect(calendars).toHaveLength(1);
    expect(calendars[0]!.isTaskTarget).toBe(true);
    expect(harness.account.status).toBe('connected');
  });

  it('plans without writing anything (simulation is the default)', async () => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Algorithms assignment',
      estimatedMinutes: 180,
      deadline: at('2026-03-11T17:00:00Z'),
    });

    const result = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(result.dryRun).toBe(true);
    expect(result.plan.blocks.length).toBeGreaterThan(0);
    expect(result.changeSet.pending.length).toBeGreaterThan(0);
    // Nothing has been written to the calendar or the block store yet.
    expect(harness.provider.list()).toHaveLength(0);
    expect(await harness.app.db.blocks.list({ userId: harness.userId })).toHaveLength(0);
  });

  it('applies an approved plan to the calendar', async () => {
    const task = await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Algorithms assignment',
      estimatedMinutes: 120,
      deadline: at('2026-03-11T17:00:00Z'),
    });

    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    const applied = await harness.app.scheduling.approve(proposal.changeSetId, {
      userId: harness.userId,
    });

    expect(applied.failures).toHaveLength(0);
    expect(applied.appliedMutations).toBe(1);

    const events = harness.provider.list();
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('Algorithms assignment');
    expect(events[0]!.metadata.calendarAgentManaged).toBe('true');

    const blocks = await harness.app.db.blocks.list({ userId: harness.userId });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.taskId).toBe(task.id);
    expect(blocks[0]!.externalEventId).toBe(events[0]!.externalId);
    expect(blocks[0]!.status).toBe('synced');

    const stored = await harness.app.db.changeSets.get(proposal.changeSetId);
    expect(stored?.status).toBe('applied');
  });

  it('refuses to apply anything in read-only mode', async () => {
    await harness.app.preferences.update(harness.userId, {
      automation: {
        ...(await harness.app.preferences.get(harness.userId)).automation,
        mode: 'read_only',
      },
    });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Reading',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(proposal.changeSet.autoApply).toHaveLength(0);
    expect(proposal.changeSet.blocked[0]!.reason.code).toBe('policy.read_only');
    await expect(
      harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId }),
    ).rejects.toThrow(/read-only/i);
  });

  it('detects an externally added meeting and proposes a move', async () => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Algorithms assignment',
      estimatedMinutes: 120,
      // Tomorrow, so the block sits outside the "do not touch" freeze window.
      earliestStart: at('2026-03-10T00:00:00Z'),
      deadline: at('2026-03-13T17:00:00Z'),
    });
    const first = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(first.changeSetId, { userId: harness.userId });
    const originalStart = first.plan.blocks[0]!.start;

    // Someone books a meeting straight over the scheduled block.
    harness.provider.seed(
      mockEvent({
        externalId: 'meeting-1',
        title: 'Product review',
        start: originalStart,
        end: originalStart + 90 * 60_000,
        attendees: [{ email: 'me@example.com', self: true }, { email: 'boss@example.com' }],
      }),
    );

    const report = await harness.app.sync.sync({ userId: harness.userId });
    expect(report.errors).toHaveLength(0);
    expect(report.needsReplan).toBe(true);

    const events = await harness.app.calendars.listEvents(harness.userId, {
      start: at('2026-03-09T00:00:00Z'),
      end: at('2026-03-14T00:00:00Z'),
    });
    const meeting = events.find((event) => event.externalId === 'meeting-1')!;
    // Other attendees mean the meeting is FIXED and must never be moved.
    expect(meeting.classification).toBe('FIXED');

    const second = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(second.plan.diff.moved).toHaveLength(1);
    expect(second.plan.diff.moved[0]!.reason.message).toContain('no longer usable');
  });

  it('ignores the echo of its own calendar write', async () => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Writing',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });

    const report = await harness.app.sync.sync({ userId: harness.userId });
    const meaningful = report.externalChanges.filter((change) => !change.selfInflicted);
    expect(meaningful.filter((change) => change.kind === 'moved')).toHaveLength(0);
    expect(report.needsReplan).toBe(false);
  });

  it('follows and pins a block the user moved in their calendar', async () => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Studying',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });
    await harness.app.sync.sync({ userId: harness.userId });

    const external = harness.provider.list()[0]!;
    harness.provider.moveExternally(
      external.externalId,
      at('2026-03-10T15:00:00Z'),
      at('2026-03-10T16:00:00Z'),
    );

    const report = await harness.app.sync.sync({ userId: harness.userId });
    expect(report.externalChanges.some((change) => change.kind === 'moved')).toBe(true);

    const blocks = await harness.app.db.blocks.list({ userId: harness.userId });
    expect(instantToISO(blocks[0]!.start)).toBe('2026-03-10T15:00:00.000Z');
    expect(blocks[0]!.pinned).toBe(true);

    // A pinned block is left alone by the next planning run.
    const replan = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(replan.plan.diff.moved).toHaveLength(0);
  });

  it('reports deadline risk deterministically', async () => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Distributed systems assignment',
      estimatedMinutes: 360,
      deadline: at('2026-03-09T12:30:00Z'),
    });
    const risks = await harness.app.scheduling.risks(harness.userId);
    expect(risks[0]!.level).toBe('IMPOSSIBLE');
    expect(risks[0]!.explanation).toContain('6h of work remains');
  });

  it('finds candidate slots for a duration', async () => {
    const slots = await harness.app.scheduling.findSlots({
      userId: harness.userId,
      durationMinutes: 120,
      range: { start: at('2026-03-10T00:00:00Z'), end: at('2026-03-11T00:00:00Z') },
    });
    expect(slots).toHaveLength(1);
    expect(instantToISO(slots[0]!.start)).toBe('2026-03-10T09:00:00.000Z');
  });

  it('works with no calendar connected at all', async () => {
    const local = await createTestApp({ withoutCalendar: true });
    await local.app.tasks.create({
      userId: local.userId,
      title: 'Local only',
      estimatedMinutes: 60,
    });
    const proposal = await local.app.scheduling.plan({ userId: local.userId });
    expect(proposal.plan.blocks).toHaveLength(1);
    // No writable calendar means no calendar mutations, but the plan still holds.
    expect(proposal.changeSet.autoApply).toHaveLength(0);
    expect(proposal.changeSet.pending).toHaveLength(0);
    const applied = await local.app.scheduling.approve(proposal.changeSetId, {
      userId: local.userId,
    });
    expect(applied.blocks).toHaveLength(1);
  });
});

describe('agent service', () => {
  it('answers a risk question without an LLM', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Databases coursework',
      estimatedMinutes: 600,
      deadline: at('2026-03-10T12:00:00Z'),
    });
    const result = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'What deadlines are at risk?',
    });
    expect(result.source).toBe('heuristic');
    expect(result.commands).toEqual([{ type: 'list_risks' }]);
    expect(result.reply).toMatch(/IMPOSSIBLE|CRITICAL|AT_RISK/);
  });

  it('schedules a named task from natural language', async () => {
    const harness = await createTestApp();
    const task = await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Algorithms assignment',
      estimatedMinutes: 120,
      deadline: at('2026-03-13T17:00:00Z'),
    });
    const result = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'Schedule my algorithms assignment',
    });
    expect(result.plan?.blocks.map((block) => block.taskId)).toEqual([task.id]);
    expect(result.needsConfirmation).toBe(true);
    // The reply leads with the outcome, not a section heading.
    expect(result.reply).toMatch(/1 new block/);
    expect(result.reply).toContain('Algorithms assignment');
  });

  it('creates a task and schedules it by calling tools in turn', async () => {
    // A configured model now drives the turn by calling tools and reading the
    // results, rather than emitting one fixed command plan.
    const llm = new MockLLMProvider([
      mockToolCalls([
        {
          name: 'create_task',
          input: {
            title: 'Machine learning project',
            estimatedMinutes: 480,
            deadline: '2026-03-12T23:59:00Z',
          },
        },
      ]),
      mockToolCalls([{ name: 'plan_schedule', input: {} }]),
      mockText('Added it and found time for it.'),
    ]);
    const harness = await createTestApp({ llm });

    const result = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'I need to finish my machine learning project by Thursday. It will take about 8 hours.',
    });

    expect(result.reply).toBe('Added it and found time for it.');
    const tasks = await harness.app.tasks.list(harness.userId);
    expect(tasks[0]?.estimatedMinutes).toBe(480);
    // plan_schedule proposes; nothing is written until approval.
    const pending = await harness.app.db.changeSets.list(harness.userId);
    expect(pending.length).toBeGreaterThan(0);
  });

  it('moves a task when told when to do it', async () => {
    // `update_task` accepted preferredWindows in its schema but dropped them on
    // the way to the service, so the agent said "Updated" and changed nothing.
    const harness = await createTestApp();
    const task = await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Reading',
      estimatedMinutes: 60,
      allowSplitting: false,
    });

    const before = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(new Date(before.plan.blocks[0]!.start).getUTCHours()).toBe(9);

    const result = await harness.app.agent.execute(harness.userId, [
      {
        type: 'update_task',
        taskRef: 'Reading',
        changes: { preferredWindows: [{ start: '14:00', end: '16:00' }] },
      },
    ]);

    const stored = await harness.app.tasks.get(task.id);
    expect(stored.preferredWindows).toEqual([
      { start: { hour: 14, minute: 0 }, end: { hour: 16, minute: 0 } },
    ]);
    // The re-plan that follows the update has to actually land it there.
    const hour = new Date(result.plan!.blocks[0]!.start).getUTCHours();
    expect(hour).toBeGreaterThanOrEqual(14);
    expect(hour).toBeLessThan(16);
  });

  it('keeps requested time free and reschedules around it', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Reading',
      estimatedMinutes: 240,
      minimumBlockMinutes: 60,
    });
    const result = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'I need Friday afternoon completely free',
    });
    expect(result.commands[0]!.type).toBe('block_time');
    const preferences = await harness.app.preferences.get(harness.userId);
    expect(preferences.blockedPeriods).toHaveLength(1);
    for (const block of result.plan!.blocks) {
      const isFridayAfternoon =
        block.start >= at('2026-03-13T12:00:00Z') && block.start < at('2026-03-13T18:00:00Z');
      expect(isFridayAfternoon).toBe(false);
    }
  });

  it('bounds the day when asked to leave early', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Report',
      estimatedMinutes: 300,
      minimumBlockMinutes: 30,
    });
    const result = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'Move my work around tomorrow so I can leave by 3pm',
    });
    const tomorrowBlocks = result.plan!.blocks.filter(
      (block) =>
        block.start >= at('2026-03-10T00:00:00Z') && block.start < at('2026-03-11T00:00:00Z'),
    );
    for (const block of tomorrowBlocks) {
      expect(block.end).toBeLessThanOrEqual(at('2026-03-10T15:00:00Z'));
    }
  });

  it('explains the schedule without an LLM', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Thesis',
      estimatedMinutes: 120,
    });
    const result = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'Why is my Monday so full?',
    });
    expect(result.commands[0]!.type).toBe('explain_schedule');
    expect(result.reply).toContain('Schedule quality');
  });

  it('stores the conversation', async () => {
    const harness = await createTestApp();
    const first = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'what is at risk?',
    });
    const messages = await harness.app.db.conversations.listMessages(first.conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});

describe('doctor', () => {
  it('reports a healthy local setup', async () => {
    const harness = await createTestApp();
    const report = await harness.app.doctor.run(harness.userId);
    expect(report.checks.find((check) => check.name === 'database')?.status).toBe('ok');
    expect(report.checks.find((check) => check.name === 'working hours')?.status).toBe('ok');
    // No LLM configured in tests, so the report warns rather than fails.
    expect(report.status).toBe('warn');
  });
});
