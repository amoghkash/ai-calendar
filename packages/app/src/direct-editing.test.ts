import { beforeEach, describe, expect, it } from 'vitest';
import { instantFromISO, instantToISO } from '@calendar-agent/core';
import { mockEvent } from '@calendar-agent/integrations';
import type { TestApp } from './testing.js';
import { createTestApp } from './testing.js';

const at = instantFromISO;

/** Editing a calendar directly, as opposed to through a scheduling proposal. */
describe('direct event editing', () => {
  let harness: TestApp;

  const givenEvent = async () => {
    const target = await harness.app.calendars.taskTarget(harness.userId);
    return harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId: target!.calendarId,
      title: 'Design review',
      start: at('2026-03-09T15:00:00Z'),
      end: at('2026-03-09T16:00:00Z'),
      attendees: [{ email: 'ada@example.com', name: 'Ada', response: 'accepted' }],
    });
  };

  beforeEach(async () => {
    harness = await createTestApp();
  });

  it('carries the guest list and the details onto the provider', async () => {
    const event = await givenEvent();
    expect(harness.provider.list()[0]!.attendees).toHaveLength(1);

    await harness.app.calendars.updateEvent(harness.userId, event.id, {
      location: 'Room 2',
      description: 'Bring the mocks.',
      transparency: 'transparent',
      attendees: [
        { email: 'ada@example.com', name: 'Ada', response: 'accepted' },
        { email: 'grace@example.com' },
      ],
    });

    const stored = await harness.app.db.events.get(event.id);
    expect(stored?.location).toBe('Room 2');
    expect(stored?.description).toBe('Bring the mocks.');
    expect(stored?.transparency).toBe('transparent');
    expect(stored?.attendees.map((a) => a.email)).toEqual(['ada@example.com', 'grace@example.com']);
    // An existing guest's reply survives an edit that only adds someone.
    expect(stored?.attendees[0]?.response).toBe('accepted');
  });

  it('leaves the guest list alone when an edit does not mention it', async () => {
    const event = await givenEvent();
    await harness.app.calendars.updateEvent(harness.userId, event.id, { title: 'Design sync' });

    const stored = await harness.app.db.events.get(event.id);
    expect(stored?.title).toBe('Design sync');
    expect(stored?.attendees.map((a) => a.email)).toEqual(['ada@example.com']);
  });

  it('removes a guest when the list comes back shorter', async () => {
    const event = await givenEvent();
    await harness.app.calendars.updateEvent(harness.userId, event.id, { attendees: [] });
    expect((await harness.app.db.events.get(event.id))?.attendees).toEqual([]);
  });
});

describe('direct block editing', () => {
  let harness: TestApp;

  const scheduleOneBlock = async (): Promise<string> => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Reading',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });
    return proposal.plan.blocks[0]!.id;
  };

  beforeEach(async () => {
    harness = await createTestApp();
  });

  it('moves the block, pins it, and patches the calendar event', async () => {
    const blockId = await scheduleOneBlock();
    const before = harness.provider.list()[0]!;

    const moved = await harness.app.scheduling.moveBlock(harness.userId, blockId, {
      start: at('2026-03-11T14:00:00Z'),
      end: at('2026-03-11T15:00:00Z'),
    });

    expect(instantToISO(moved.start)).toBe('2026-03-11T14:00:00.000Z');
    expect(moved.pinned).toBe(true);

    const after = harness.provider.list()[0]!;
    expect(instantToISO(after.start)).toBe('2026-03-11T14:00:00.000Z');
    // A move must not disturb anything else about the event.
    expect(after.title).toBe(before.title);
    expect(after.description).toBe(before.description);
    expect(after.metadata.calendarAgentBlockId).toBe(before.metadata.calendarAgentBlockId);
  });

  it('leaves the moved block alone on the next planning run', async () => {
    const blockId = await scheduleOneBlock();
    await harness.app.scheduling.moveBlock(harness.userId, blockId, {
      start: at('2026-03-11T14:00:00Z'),
      end: at('2026-03-11T15:00:00Z'),
    });
    const replan = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(replan.plan.diff.moved).toHaveLength(0);
    expect(replan.plan.diff.added).toHaveLength(0);
  });

  it('hands the block back to the scheduler when unpinned', async () => {
    const blockId = await scheduleOneBlock();
    await harness.app.scheduling.moveBlock(harness.userId, blockId, {
      start: at('2026-03-11T14:00:00Z'),
      end: at('2026-03-11T15:00:00Z'),
    });
    const unpinned = await harness.app.scheduling.setBlockPinned(harness.userId, blockId, false);
    expect(unpinned.pinned).toBe(false);

    // A conflicting meeting can now displace it again.
    harness.provider.seed(
      mockEvent({
        externalId: 'clash',
        title: 'Sudden meeting',
        start: at('2026-03-11T14:00:00Z'),
        end: at('2026-03-11T15:00:00Z'),
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });
    const replan = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(replan.plan.diff.moved).toHaveLength(1);
  });

  it('does not report its own move as an external change', async () => {
    const blockId = await scheduleOneBlock();
    await harness.app.sync.sync({ userId: harness.userId });
    await harness.app.scheduling.moveBlock(harness.userId, blockId, {
      start: at('2026-03-11T14:00:00Z'),
      end: at('2026-03-11T15:00:00Z'),
    });
    const report = await harness.app.sync.sync({ userId: harness.userId });
    expect(report.externalChanges.filter((change) => !change.selfInflicted)).toHaveLength(0);
    expect(report.needsReplan).toBe(false);
  });

  it('deletes a block and its calendar event', async () => {
    const blockId = await scheduleOneBlock();
    await harness.app.scheduling.deleteBlock(harness.userId, blockId);
    expect(await harness.app.db.blocks.get(blockId)).toBeUndefined();
    expect(harness.provider.list()).toHaveLength(0);
  });

  it('rejects a zero-length move', async () => {
    const blockId = await scheduleOneBlock();
    await expect(
      harness.app.scheduling.moveBlock(harness.userId, blockId, {
        start: at('2026-03-11T14:00:00Z'),
        end: at('2026-03-11T14:00:00Z'),
      }),
    ).rejects.toThrow(/must end after it starts/);
  });

  it('refuses to move anything in read-only mode', async () => {
    const blockId = await scheduleOneBlock();
    const preferences = await harness.app.preferences.get(harness.userId);
    await harness.app.preferences.update(harness.userId, {
      automation: { ...preferences.automation, mode: 'read_only' },
    });
    await expect(
      harness.app.scheduling.moveBlock(harness.userId, blockId, {
        start: at('2026-03-11T14:00:00Z'),
        end: at('2026-03-11T15:00:00Z'),
      }),
    ).rejects.toThrow(/read-only/i);
  });
});

describe('direct event editing', () => {
  let harness: TestApp;
  let calendarId: string;

  beforeEach(async () => {
    harness = await createTestApp();
    calendarId = (await harness.app.calendars.listCalendars(harness.userId))[0]!.id;
  });

  it('creates an event on the calendar', async () => {
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId,
      title: 'Coffee with Sam',
      start: at('2026-03-10T15:00:00Z'),
      end: at('2026-03-10T16:00:00Z'),
      location: 'Cafe',
    });
    expect(event.title).toBe('Coffee with Sam');
    expect(harness.provider.list()).toHaveLength(1);

    const listed = await harness.app.calendars.listEvents(harness.userId, {
      start: at('2026-03-09T00:00:00Z'),
      end: at('2026-03-16T00:00:00Z'),
    });
    expect(listed.map((e) => e.title)).toContain('Coffee with Sam');
  });

  it('makes a created event block time for the scheduler', async () => {
    await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId,
      title: 'Blocker',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T12:00:00Z'),
    });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Work',
      estimatedMinutes: 60,
      earliestStart: at('2026-03-10T00:00:00Z'),
    });
    const plan = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(instantToISO(plan.plan.blocks[0]!.start)).toBe('2026-03-10T12:00:00.000Z');
  });

  it('changes only the fields it is given', async () => {
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId,
      title: 'Standup',
      description: 'Daily sync',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T09:30:00Z'),
    });
    const updated = await harness.app.calendars.updateEvent(harness.userId, event.id, {
      start: at('2026-03-10T10:00:00Z'),
      end: at('2026-03-10T10:30:00Z'),
    });
    expect(instantToISO(updated.start)).toBe('2026-03-10T10:00:00.000Z');
    expect(updated.title).toBe('Standup');
    expect(updated.description).toBe('Daily sync');
  });

  it('renames an event', async () => {
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId,
      title: 'Old name',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T10:00:00Z'),
    });
    const updated = await harness.app.calendars.updateEvent(harness.userId, event.id, {
      title: 'New name',
    });
    expect(updated.title).toBe('New name');
    expect(instantToISO(updated.start)).toBe('2026-03-10T09:00:00.000Z');
  });

  it('deletes an event', async () => {
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId,
      title: 'Temporary',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T10:00:00Z'),
    });
    await harness.app.calendars.deleteEvent(harness.userId, event.id);
    expect(harness.provider.list()).toHaveLength(0);
    expect(await harness.app.db.events.get(event.id)).toBeUndefined();
  });

  it('refuses to edit a recurring series master', async () => {
    harness.provider.seed(
      mockEvent({
        externalId: 'series-1',
        title: 'Weekly review',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
        isRecurring: true,
        recurrenceKind: 'series_master',
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });
    const stored = (
      await harness.app.calendars.listEvents(harness.userId, {
        start: at('2026-03-09T00:00:00Z'),
        end: at('2026-03-16T00:00:00Z'),
      })
    ).find((event) => event.externalId === 'series-1')!;

    await expect(
      harness.app.calendars.updateEvent(harness.userId, stored.id, {
        start: at('2026-03-10T11:00:00Z'),
        end: at('2026-03-10T12:00:00Z'),
      }),
    ).rejects.toThrow(/recurring series/);
  });

  it('refuses to write to a read-only calendar', async () => {
    const calendar = (await harness.app.calendars.listCalendars(harness.userId))[0]!;
    await harness.app.db.calendars.save({ ...calendar, isWritable: false });
    await expect(
      harness.app.calendars.createEvent({
        userId: harness.userId,
        calendarId,
        title: 'Nope',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
      }),
    ).rejects.toThrow(/read-only for this account/);
  });

  it('refuses to write anything in read-only mode', async () => {
    const preferences = await harness.app.preferences.get(harness.userId);
    await harness.app.preferences.update(harness.userId, {
      automation: { ...preferences.automation, mode: 'read_only' },
    });
    await expect(
      harness.app.calendars.createEvent({
        userId: harness.userId,
        calendarId,
        title: 'Nope',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
      }),
    ).rejects.toThrow(/read-only mode/);
  });
});

describe('calendar inclusion', () => {
  it('can show a calendar without letting it block time', async () => {
    const harness = await createTestApp();
    const calendar = (await harness.app.calendars.listCalendars(harness.userId))[0]!;

    harness.provider.seed(
      mockEvent({
        externalId: 'fyi',
        title: 'Someone else busy',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T12:00:00Z'),
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Work',
      estimatedMinutes: 60,
      earliestStart: at('2026-03-10T00:00:00Z'),
    });

    // Included: the event consumes the morning.
    const blocked = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(instantToISO(blocked.plan.blocks[0]!.start)).toBe('2026-03-10T12:00:00.000Z');

    // Excluded from availability, but still visible in the agenda.
    await harness.app.calendars.updateCalendarOptions(calendar.id, {
      includeInAvailability: false,
    });
    const free = await harness.app.scheduling.plan({ userId: harness.userId });
    expect(instantToISO(free.plan.blocks[0]!.start)).toBe('2026-03-10T09:00:00.000Z');

    const agenda = await harness.app.scheduling.agenda(harness.userId, {
      start: at('2026-03-10T00:00:00Z'),
      end: at('2026-03-11T00:00:00Z'),
    });
    expect(agenda.events.map((event) => event.title)).toContain('Someone else busy');
  });

  it('hides a deselected calendar entirely', async () => {
    const harness = await createTestApp();
    const calendar = (await harness.app.calendars.listCalendars(harness.userId))[0]!;
    harness.provider.seed(
      mockEvent({
        externalId: 'hidden',
        title: 'Hidden event',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });
    await harness.app.calendars.updateCalendarOptions(calendar.id, { selected: false });

    const agenda = await harness.app.scheduling.agenda(harness.userId, {
      start: at('2026-03-10T00:00:00Z'),
      end: at('2026-03-11T00:00:00Z'),
    });
    expect(agenda.events).toHaveLength(0);
  });
});

describe('agenda de-duplication', () => {
  it('shows a synced task block once, not as both a block and an event', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Lunch with Ronit',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });

    // Sync pulls our own block back as a calendar event.
    await harness.app.sync.sync({ userId: harness.userId });

    const agenda = await harness.app.scheduling.agenda(harness.userId, {
      start: at('2026-03-09T00:00:00Z'),
      end: at('2026-03-16T00:00:00Z'),
    });

    expect(agenda.blocks).toHaveLength(1);
    expect(agenda.events.filter((event) => event.title === 'Lunch with Ronit')).toHaveLength(0);
  });

  it('still shows ordinary events that are not task blocks', async () => {
    const harness = await createTestApp();
    harness.provider.seed(
      mockEvent({
        externalId: 'real-meeting',
        title: 'Team sync',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });
    const agenda = await harness.app.scheduling.agenda(harness.userId, {
      start: at('2026-03-09T00:00:00Z'),
      end: at('2026-03-16T00:00:00Z'),
    });
    expect(agenda.events.map((event) => event.title)).toContain('Team sync');
  });
});
