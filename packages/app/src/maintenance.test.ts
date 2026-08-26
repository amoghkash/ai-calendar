import { describe, expect, it } from 'vitest';
import { days, instantFromISO } from '@calendar-agent/core';
import { mockEvent } from '@calendar-agent/integrations';
import { createTestApp } from './testing.js';

const at = instantFromISO;

describe('data maintenance', () => {
  it('reports what is stored', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Something',
      estimatedMinutes: 60,
    });
    const stats = await harness.app.maintenance.stats(harness.userId);
    expect(stats.counts.tasks).toBe(1);
    expect(stats.counts.calendars).toBe(1);
    expect(stats.staleBlocks).toBe(0);
  });

  it('spots blocks whose task is gone', async () => {
    const harness = await createTestApp();
    await harness.app.db.blocks.save({
      id: 'orphan',
      userId: harness.userId,
      taskId: 'task-that-never-existed',
      kind: 'task',
      start: at('2026-03-10T09:00:00Z'),
      end: at('2026-03-10T10:00:00Z'),
      timezone: 'UTC',
      sequence: 0,
      status: 'confirmed',
      pinned: false,
      createdAt: 0,
      updatedAt: 0,
    });
    expect((await harness.app.maintenance.stats(harness.userId)).staleBlocks).toBe(1);
  });

  it('simulates a prune by default and deletes nothing', async () => {
    const harness = await createTestApp();
    harness.provider.seed(
      mockEvent({
        externalId: 'ancient',
        title: 'Old meeting',
        start: at('2020-01-01T09:00:00Z'),
        end: at('2020-01-01T10:00:00Z'),
      }),
    );
    await harness.app.sync.sync({
      userId: harness.userId,
      range: { start: at('2019-01-01T00:00:00Z'), end: at('2027-01-01T00:00:00Z') },
    });

    const dry = await harness.app.maintenance.prune({ userId: harness.userId });
    expect(dry.dryRun).toBe(true);
    expect(dry.events).toBe(1);
    expect((await harness.app.maintenance.stats(harness.userId)).counts.events).toBe(1);

    const wet = await harness.app.maintenance.prune({ userId: harness.userId, dryRun: false });
    expect(wet.events).toBe(1);
    expect((await harness.app.maintenance.stats(harness.userId)).counts.events).toBe(0);
  });

  it('keeps recent history when pruning', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Recent',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });

    const report = await harness.app.maintenance.prune({
      userId: harness.userId,
      before: harness.clock.now() - days(90),
      dryRun: false,
    });
    expect(report.blocks).toBe(0);
    expect((await harness.app.db.blocks.list({ userId: harness.userId })).length).toBe(1);
  });

  it('refuses to reset without an explicit confirmation', async () => {
    const harness = await createTestApp();
    await expect(
      harness.app.maintenance.reset({
        userId: harness.userId,
        scopes: ['tasks'],
        confirm: false,
        dryRun: false,
      }),
    ).rejects.toThrow(/explicit confirmation/);
  });

  it('rejects an unknown scope', async () => {
    const harness = await createTestApp();
    await expect(
      harness.app.maintenance.reset({
        userId: harness.userId,
        scopes: ['everything' as never],
        confirm: true,
        dryRun: false,
      }),
    ).rejects.toThrow(/Unknown scope/);
  });

  it('resets only the scopes asked for', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Keep me?',
      estimatedMinutes: 60,
    });

    const dry = await harness.app.maintenance.reset({
      userId: harness.userId,
      scopes: ['tasks'],
      confirm: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(await harness.app.tasks.list(harness.userId)).toHaveLength(1);

    await harness.app.maintenance.reset({
      userId: harness.userId,
      scopes: ['tasks'],
      confirm: true,
      dryRun: false,
    });
    expect(await harness.app.tasks.list(harness.userId)).toHaveLength(0);
    // Categories were not in scope, so they survive.
    expect((await harness.app.categories.list(harness.userId)).length).toBeGreaterThan(0);
  });

  it('clears everything with resetAll', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Gone',
      estimatedMinutes: 60,
    });
    await harness.app.maintenance.resetAll(harness.userId, true, false);
    expect(await harness.app.tasks.list(harness.userId)).toHaveLength(0);
    expect(await harness.app.categories.list(harness.userId)).toHaveLength(0);
    expect(await harness.app.calendars.listCalendars(harness.userId)).toHaveLength(0);
  });
});

describe('calendar and account removal', () => {
  it('removes a calendar along with its events and detaches its blocks', async () => {
    const harness = await createTestApp();
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Work',
      estimatedMinutes: 60,
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });
    await harness.app.sync.sync({ userId: harness.userId });

    const calendar = (await harness.app.calendars.listCalendars(harness.userId))[0]!;
    const result = await harness.app.calendars.deleteCalendar(harness.userId, calendar.id);

    expect(result.events).toBeGreaterThan(0);
    expect(result.blocksDetached).toBe(1);
    expect(await harness.app.calendars.listCalendars(harness.userId)).toHaveLength(0);

    // No residue: the old events no longer block time for the scheduler.
    const stats = await harness.app.maintenance.stats(harness.userId);
    expect(stats.counts.events).toBe(0);
    expect(stats.orphanedEvents).toBe(0);

    // The block kept its time but lost the dead calendar link.
    const blocks = await harness.app.db.blocks.list({ userId: harness.userId });
    expect(blocks[0]!.calendarId).toBeUndefined();
    expect(blocks[0]!.externalEventId).toBeUndefined();
  });

  it('cleans up everything when an account is disconnected', async () => {
    const harness = await createTestApp();
    harness.provider.seed(
      mockEvent({
        externalId: 'e1',
        title: 'Meeting',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });

    const result = await harness.app.calendars.disconnectAccount(harness.account.id);
    expect(result.calendars).toBe(1);
    expect(result.events).toBeGreaterThan(0);

    const stats = await harness.app.maintenance.stats(harness.userId);
    expect(stats.counts.accounts).toBe(0);
    expect(stats.counts.calendars).toBe(0);
    expect(stats.counts.events).toBe(0);
    expect(stats.orphanedEvents).toBe(0);
  });
});

describe('calendars deleted on the provider', () => {
  it('are removed locally on the next sync, with their events', async () => {
    const harness = await createTestApp();
    // Two calendars remotely; both get imported.
    harness.provider.addCalendar({ externalId: 'side', name: 'Side project' });
    await harness.app.sync.sync({ userId: harness.userId });
    expect(await harness.app.calendars.listCalendars(harness.userId)).toHaveLength(2);

    harness.provider.seed(
      mockEvent({
        externalId: 'side-event',
        calendarExternalId: 'side',
        title: 'Side standup',
        start: at('2026-03-10T09:00:00Z'),
        end: at('2026-03-10T10:00:00Z'),
      }),
    );
    await harness.app.sync.sync({ userId: harness.userId });
    expect((await harness.app.maintenance.stats(harness.userId)).counts.events).toBe(1);

    // The user deletes it in their calendar app.
    harness.provider.removeCalendar('side');
    const report = await harness.app.sync.sync({ userId: harness.userId });

    expect(report.calendarsRemoved).toEqual(['Side project']);
    expect(await harness.app.calendars.listCalendars(harness.userId)).toHaveLength(1);

    // Its events are gone too, so they stop blocking time.
    const stats = await harness.app.maintenance.stats(harness.userId);
    expect(stats.counts.events).toBe(0);
    expect(stats.orphanedEvents).toBe(0);
    // Availability changed, so a re-plan is warranted.
    expect(report.needsReplan).toBe(true);
  });

  it('discovers a newly added calendar', async () => {
    const harness = await createTestApp();
    harness.provider.addCalendar({ externalId: 'new-one', name: 'Book club' });
    const report = await harness.app.sync.sync({ userId: harness.userId });
    expect(report.calendarsAdded).toEqual(['Book club']);
  });

  it('never wipes calendars when the provider returns an empty list', async () => {
    const harness = await createTestApp();
    // A bad or partial response must not be read as "everything was deleted".
    harness.provider.removeCalendar('primary');
    const report = await harness.app.sync.sync({ userId: harness.userId });
    expect(report.calendarsRemoved).toEqual([]);
    expect(await harness.app.calendars.listCalendars(harness.userId)).toHaveLength(1);
  });
});
