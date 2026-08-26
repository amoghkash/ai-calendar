import { describe, expect, it } from 'vitest';
import { instantFromISO } from '@calendar-agent/core';
import { createTestApp } from './testing.js';

const ISO = (value: string): number => instantFromISO(value);

/** Put a plain solo event on the calendar for the agent to act on. */
async function givenEvent(
  harness: Awaited<ReturnType<typeof createTestApp>>,
  title: string,
  start: string,
  end: string,
) {
  const target = await harness.app.calendars.taskTarget(harness.userId);
  return harness.app.calendars.createEvent({
    userId: harness.userId,
    calendarId: target!.calendarId,
    title,
    start: ISO(start),
    end: ISO(end),
  });
}

describe('update_event on a scheduled task block', () => {
  const scheduleLunch = async (harness: Awaited<ReturnType<typeof createTestApp>>) => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Lunch',
      estimatedMinutes: 45,
      allowSplitting: false,
      preferredWindows: [{ start: { hour: 12, minute: 0 }, end: { hour: 14, minute: 0 } }],
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });
    return proposal.plan.blocks[0]!.id;
  };

  it('moves the block itself and pins it, so a re-plan leaves it alone', async () => {
    const harness = await createTestApp();
    const blockId = await scheduleLunch(harness);

    await harness.app.agent.execute(harness.userId, [
      {
        type: 'update_event',
        eventRef: 'Lunch',
        changes: {
          title: 'Lunch with Sam',
          start: '2026-03-09T13:00:00Z',
          end: '2026-03-09T14:00:00Z',
        },
      },
    ]);

    // Both halves move together: patching only the calendar copy would leave
    // the block behind and the next plan would drag the event back.
    const block = await harness.app.db.blocks.get(blockId);
    expect(block?.start).toBe(ISO('2026-03-09T13:00:00Z'));
    expect(block?.end).toBe(ISO('2026-03-09T14:00:00Z'));
    expect(block?.pinned).toBe(true);
    expect(harness.provider.list()[0]?.start).toBe(ISO('2026-03-09T13:00:00Z'));

    const replan = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(replan.plan.diff.moved).toHaveLength(0);
  });

  it('says that it pinned the block', async () => {
    const harness = await createTestApp();
    await scheduleLunch(harness);
    const result = await harness.app.agent.execute(harness.userId, [
      {
        type: 'update_event',
        eventRef: 'Lunch',
        changes: { start: '2026-03-09T13:00:00Z', end: '2026-03-09T13:45:00Z' },
      },
    ]);
    expect(result.reply).toMatch(/pinned/i);
  });
});

describe('update_event', () => {
  it('moves and resizes an existing commitment', async () => {
    const harness = await createTestApp();
    const event = await givenEvent(
      harness,
      'Climbing gym with Ronit',
      '2026-03-09T15:00:00Z',
      '2026-03-09T17:00:00Z',
    );

    const result = await harness.app.agent.execute(harness.userId, [
      {
        type: 'update_event',
        eventRef: 'climbing',
        changes: { start: '2026-03-09T14:30:00Z', end: '2026-03-09T15:30:00Z' },
      },
    ]);

    const stored = await harness.app.db.events.get(event.id);
    expect(stored?.start).toBe(ISO('2026-03-09T14:30:00Z'));
    expect(stored?.end).toBe(ISO('2026-03-09T15:30:00Z'));
    expect(result.reply).toContain('Climbing gym with Ronit');
  });

  it('resolves by id as well as by title', async () => {
    const harness = await createTestApp();
    const event = await givenEvent(
      harness,
      'Dentist',
      '2026-03-10T09:00:00Z',
      '2026-03-10T10:00:00Z',
    );

    await harness.app.agent.execute(harness.userId, [
      { type: 'update_event', eventRef: event.id, changes: { title: 'Dentist check-up' } },
    ]);

    expect((await harness.app.db.events.get(event.id))?.title).toBe('Dentist check-up');
  });

  it('refuses an ambiguous reference instead of guessing', async () => {
    const harness = await createTestApp();
    await givenEvent(harness, 'Standup', '2026-03-09T09:00:00Z', '2026-03-09T09:15:00Z');
    await givenEvent(harness, 'Standup', '2026-03-10T09:00:00Z', '2026-03-10T09:15:00Z');

    await expect(
      harness.app.agent.execute(harness.userId, [
        { type: 'update_event', eventRef: 'standup', changes: { end: '2026-03-09T09:30:00Z' } },
      ]),
    ).rejects.toThrow(/matches 2 events/);
  });

  it('will not move an event that involves other people', async () => {
    const harness = await createTestApp();
    const target = await harness.app.calendars.taskTarget(harness.userId);
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId: target!.calendarId,
      title: 'Design review',
      start: ISO('2026-03-09T13:00:00Z'),
      end: ISO('2026-03-09T14:00:00Z'),
      attendees: [{ email: 'me@example.com', self: true }, { email: 'sam@example.com' }],
    });

    const result = await harness.app.agent.execute(harness.userId, [
      {
        type: 'update_event',
        eventRef: 'Design review',
        changes: { start: '2026-03-09T16:00:00Z', end: '2026-03-09T17:00:00Z' },
      },
    ]);

    // Refused, and the calendar is untouched.
    expect(result.reply).toMatch(/never moves FIXED|protected/i);
    expect((await harness.app.db.events.get(event.id))?.start).toBe(ISO('2026-03-09T13:00:00Z'));
  });

  it('renames an event the policy would not let it move', async () => {
    const harness = await createTestApp();
    const target = await harness.app.calendars.taskTarget(harness.userId);
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId: target!.calendarId,
      title: 'Design review',
      start: ISO('2026-03-09T13:00:00Z'),
      end: ISO('2026-03-09T14:00:00Z'),
      attendees: [{ email: 'me@example.com', self: true }, { email: 'sam@example.com' }],
    });

    // Renaming is not a scheduling decision, so the move policy does not apply.
    await harness.app.agent.execute(harness.userId, [
      { type: 'update_event', eventRef: event.id, changes: { location: 'Room 4' } },
    ]);

    expect((await harness.app.db.events.get(event.id))?.location).toBe('Room 4');
  });

  it('never notifies attendees on the agent’s behalf', async () => {
    const harness = await createTestApp();
    const target = await harness.app.calendars.taskTarget(harness.userId);
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId: target!.calendarId,
      title: 'Coffee',
      start: ISO('2026-03-09T15:00:00Z'),
      end: ISO('2026-03-09T15:30:00Z'),
      attendees: [{ email: 'me@example.com', self: true }, { email: 'ronit@example.com' }],
    });

    const result = await harness.app.agent.execute(harness.userId, [
      { type: 'update_event', eventRef: event.id, changes: { title: 'Coffee with Ronit' } },
    ]);

    expect(result.reply).toContain('not notified');
  });

  it('is refused entirely in read-only mode', async () => {
    const harness = await createTestApp();
    const event = await givenEvent(harness, 'Gym', '2026-03-09T18:00:00Z', '2026-03-09T19:00:00Z');

    // Switch after seeding: read-only blocks the write that sets the test up.
    const current = await harness.app.preferences.get(harness.userId);
    await harness.app.preferences.update(harness.userId, {
      automation: { ...current.automation, mode: 'read_only' },
    });

    const result = await harness.app.agent.execute(harness.userId, [
      {
        type: 'update_event',
        eventRef: 'Gym',
        changes: { start: '2026-03-09T17:00:00Z', end: '2026-03-09T18:00:00Z' },
      },
    ]);

    expect(result.reply).toMatch(/read-only/i);
    expect((await harness.app.db.events.get(event.id))?.start).toBe(ISO('2026-03-09T18:00:00Z'));
  });
});

describe('update_event through the model', () => {
  it('accepts the plan a model would emit, and sees the event in its prompt', async () => {
    const { MockLLMProvider, LLMCommandParser } = await import('@calendar-agent/agent');
    // A phrase the heuristic cannot answer, so the LLM path is actually used.
    const llm = new MockLLMProvider([
      {
        intent: 'Shorten the climbing session and start it at 14:30',
        commands: [
          {
            type: 'update_event',
            eventRef: 'Climbing gym with Ronit',
            changes: { start: '2026-03-09T14:30:00Z', end: '2026-03-09T15:30:00Z' },
          },
        ],
      },
    ]);
    const harness = await createTestApp({ parser: new LLMCommandParser({ llm }) });
    const event = await givenEvent(
      harness,
      'Climbing gym with Ronit',
      '2026-03-09T15:00:00Z',
      '2026-03-09T17:00:00Z',
    );

    const reply = await harness.app.agent.handle({
      userId: harness.userId,
      text: 'make climbing one hour instead, starting at 2:30pm',
    });

    expect(reply.commands.map((command) => command.type)).toEqual(['update_event']);
    const stored = await harness.app.db.events.get(event.id);
    expect(stored?.start).toBe(ISO('2026-03-09T14:30:00Z'));
    expect(stored?.end).toBe(ISO('2026-03-09T15:30:00Z'));

    // The prompt has to carry both the vocabulary and the event's id, or the
    // model has no way to name what it is changing.
    const prompt = llm.requests[0]?.system ?? '';
    expect(prompt).toContain('update_event');
    expect(prompt).toContain('use these ids for eventRef');
    expect(prompt).toContain(event.id);
  });
});

describe('reply shape', () => {
  it('says what happened and stops, when the re-plan has no news', async () => {
    const harness = await createTestApp();
    await givenEvent(
      harness,
      'Climbing gym with Ronit',
      '2026-03-09T15:00:00Z',
      '2026-03-09T17:00:00Z',
    );

    const result = await harness.app.agent.execute(harness.userId, [
      {
        type: 'update_event',
        eventRef: 'climbing',
        changes: { start: '2026-03-09T14:15:00Z', end: '2026-03-09T15:15:00Z' },
      },
    ]);

    expect(result.reply).toContain('Updated "Climbing gym with Ronit"');
    // None of the old boilerplate survives a no-op re-plan.
    expect(result.reply).not.toContain('PROPOSED CHANGES');
    expect(result.reply).not.toMatch(/No changes are needed/i);
    expect(result.reply).not.toMatch(/No calendar changes are required/i);
    expect(result.reply).not.toMatch(/calendar-agent approve/);
    expect(result.reply.trim().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('still reports the re-plan when it actually moved something', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Algorithms assignment',
      estimatedMinutes: 120,
    });

    const result = await harness.app.agent.execute(harness.userId, [
      { type: 'schedule', taskRefs: ['Algorithms assignment'] },
    ]);

    expect(result.reply).toMatch(/new block/);
    expect(result.reply).toContain('Algorithms assignment');
  });

  it('never answers with nothing at all', async () => {
    const harness = await createTestApp();
    const result = await harness.app.agent.execute(harness.userId, [{ type: 'schedule' }]);
    expect(result.reply.trim().length).toBeGreaterThan(0);
  });
});
