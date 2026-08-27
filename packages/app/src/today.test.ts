import { describe, expect, it } from 'vitest';
import type { ContactDirectory, MessagingProvider } from '@calendar-agent/core';
import { createTestApp } from './testing.js';

const PRIYA = {
  id: 'AB:3',
  displayName: 'Priya Raman',
  handles: [{ kind: 'phone' as const, value: '(415) 555-7777', normalized: '+14155557777' }],
};
const directory: ContactDirectory = { search: () => Promise.resolve([PRIYA]) };
const messaging: MessagingProvider = {
  id: 'fake',
  capabilities: () =>
    Promise.resolve({ available: true, canReadMessages: true, canReadContacts: true, canSend: false }),
  thread: () => Promise.resolve(undefined),
  recentMessages: () => Promise.resolve([]),
};

/** The harness clock is fixed at Monday 2026-03-09 08:00 UTC. */
const NOW = Date.parse('2026-03-09T08:00:00Z');
const at = (hours: number): number => Date.parse('2026-03-09T00:00:00Z') + hours * 3_600_000;

const harness = () => createTestApp({ messaging: { directory, provider: messaging } });

async function withEvent(app: Awaited<ReturnType<typeof harness>>['app'], title: string, from: number, to: number) {
  const calendar = (await app.calendars.listCalendars(app.user.id)).find((c) => c.isWritable)!;
  return app.calendars.createEvent({
    userId: app.user.id,
    calendarId: calendar.id,
    title,
    start: from,
    end: to,
  });
}

describe('the day at a glance', () => {
  it('lists what is on today, in order', async () => {
    const app = (await harness()).app;
    await withEvent(app, 'Later', at(15), at(16));
    await withEvent(app, 'Earlier', at(10), at(11));

    const view = await app.today.get(app.user.id);

    expect(view.entries.map((entry) => entry.title)).toEqual(['Earlier', 'Later']);
  });

  it('leaves out what is not today', async () => {
    const app = (await harness()).app;
    await withEvent(app, 'Tomorrow', at(30), at(31));

    expect((await app.today.get(app.user.id)).entries).toEqual([]);
  });

  it('names the next thing still to come', async () => {
    const app = (await harness()).app;
    await withEvent(app, 'Done already', at(6), at(7));
    await withEvent(app, 'Coming up', at(15), at(16));

    const view = await app.today.get(app.user.id);

    expect(view.now).toBe(NOW);
    expect(view.next?.title).toBe('Coming up');
  });

  it('offers to confirm a meeting that is with somebody', async () => {
    const app = (await harness()).app;
    const event = await withEvent(app, 'Lunch', at(12), at(13));
    await app.contactLinks.link({
      userId: app.user.id,
      eventId: event.id,
      contactId: PRIYA.id,
      displayName: PRIYA.displayName,
      handle: '+14155557777',
    });

    const entry = (await app.today.get(app.user.id)).entries[0];

    expect(entry?.people[0]?.name).toBe('Priya Raman');
    expect(entry?.canConfirm).toBe(true);
  });

  it('does not offer to confirm something nobody is on', async () => {
    const app = (await harness()).app;
    await withEvent(app, 'Solo work', at(12), at(13));

    expect((await app.today.get(app.user.id)).entries[0]?.canConfirm).toBe(false);
  });

  it('stops offering once it has been asked, and says where it got to', async () => {
    const app = (await harness()).app;
    const event = await withEvent(app, 'Lunch', at(12), at(13));
    await app.contactLinks.link({
      userId: app.user.id,
      eventId: event.id,
      contactId: PRIYA.id,
      displayName: PRIYA.displayName,
      handle: '+14155557777',
    });
    await app.outreach.confirmMeeting(app.user.id, event.id);

    const entry = (await app.today.get(app.user.id)).entries[0];

    expect(entry?.canConfirm).toBe(false);
    expect(entry?.confirmation?.state).toBe('draft');
  });

  it('will not offer to confirm something already over', async () => {
    const app = (await harness()).app;
    const event = await withEvent(app, 'Breakfast', at(6), at(7));
    await app.contactLinks.link({
      userId: app.user.id,
      eventId: event.id,
      contactId: PRIYA.id,
      displayName: PRIYA.displayName,
      handle: '+14155557777',
    });

    expect((await app.today.get(app.user.id)).entries[0]?.canConfirm).toBe(false);
  });

  it('surfaces drafts and escalations as things needing you', async () => {
    const app = (await harness()).app;
    const outcome = await app.outreach.draft({
      userId: app.user.id,
      person: 'Priya',
      activity: 'lunch',
    });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');

    const view = await app.today.get(app.user.id);

    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]).toMatchObject({ kind: 'unsent_draft', person: 'Priya Raman' });
  });

  it('reports free time left in the day', async () => {
    const app = (await harness()).app;
    const view = await app.today.get(app.user.id);
    expect(view.freeWindows.length).toBeGreaterThan(0);
    expect(view.freeWindows.every((window) => window.start >= view.now)).toBe(true);
  });

  it('says nothing is outstanding on an empty day', async () => {
    const app = (await harness()).app;
    const view = await app.today.get(app.user.id);
    expect(view.entries).toEqual([]);
    expect(view.actions).toEqual([]);
    expect(view.pendingChangeSetId).toBeUndefined();
  });
});
