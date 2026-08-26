import { describe, expect, it } from 'vitest';
import type { ContactDirectory, MessagingProvider, ThreadSnapshot } from '@calendar-agent/core';
import { createTestApp } from './testing.js';

const SARAH = {
  id: 'AB:1',
  displayName: 'Sarah Chen',
  handles: [
    { kind: 'phone' as const, value: '(415) 555-1212', normalized: '+14155551212', label: 'mobile' },
  ],
};

const SARAH_J = {
  id: 'AB:2',
  displayName: 'Sarah Jones',
  handles: [{ kind: 'phone' as const, value: '(415) 555-9999', normalized: '+14155559999' }],
};
const MIKE = {
  id: 'AB:3',
  displayName: 'Mike Okafor',
  handles: [{ kind: 'phone' as const, value: '(415) 555-7777', normalized: '+14155557777' }],
};

const BOOK = [SARAH, SARAH_J, MIKE];

/** Substring-on-name, the same coarse filter the real bridge applies. */
const directory: ContactDirectory = {
  search: (query) =>
    Promise.resolve(BOOK.filter((c) => c.displayName.toLowerCase().includes(query.toLowerCase()))),
};

const NOW = Date.parse('2026-03-09T08:00:00Z');

const messagingWith = (snapshot?: ThreadSnapshot): MessagingProvider => ({
  id: 'fake',
  capabilities: () =>
    Promise.resolve({
      available: true,
      canReadMessages: true,
      canReadContacts: true,
      canSend: false,
    }),
  thread: () => Promise.resolve(snapshot),
});

async function harnessWithEvent(provider: MessagingProvider = messagingWith()) {
  const harness = await createTestApp({ messaging: { directory, provider } });
  const calendar = (await harness.app.calendars.listCalendars(harness.userId)).find(
    (c) => c.isWritable,
  )!;
  const event = await harness.app.calendars.createEvent({
    userId: harness.userId,
    calendarId: calendar.id,
    title: 'Lunch with Sarah',
    start: NOW + 86_400_000,
    end: NOW + 90_000_000,
  });
  return { harness, event };
}

const link = (harness: Awaited<ReturnType<typeof harnessWithEvent>>['harness'], eventId: string) =>
  harness.app.contactLinks.link({
    userId: harness.userId,
    eventId,
    contactId: SARAH.id,
    displayName: SARAH.displayName,
    handle: '+14155551212',
  });

describe('contact links', () => {
  it('leaves a solo event UNKNOWN, which the default policy lets the agent move', async () => {
    const { event } = await harnessWithEvent();
    expect(event.classification).toBe('UNKNOWN');
  });

  it('reclassifies the event to FIXED the moment a person is linked', async () => {
    const { harness, event } = await harnessWithEvent();

    await link(harness, event.id);

    const stored = await harness.app.db.events.get(event.id);
    expect(stored?.classification).toBe('FIXED');
    expect(stored?.isMovable).toBe(false);
  });

  it('returns the event to UNKNOWN when the last person is unlinked', async () => {
    const { harness, event } = await harnessWithEvent();
    const created = await link(harness, event.id);

    await harness.app.contactLinks.unlink(harness.userId, created.id);

    expect((await harness.app.db.events.get(event.id))?.classification).toBe('UNKNOWN');
  });

  it('is idempotent for the same handle on the same event', async () => {
    const { harness, event } = await harnessWithEvent();
    const first = await link(harness, event.id);
    const second = await link(harness, event.id);

    expect(second.id).toBe(first.id);
    expect(await harness.app.contactLinks.listForEvent(event.id)).toHaveLength(1);
  });

  it('reports posture from the thread without reading any message', async () => {
    const { harness, event } = await harnessWithEvent(
      messagingWith({
        handle: '+14155551212',
        normalized: '+14155551212',
        lastOutboundAt: NOW + 1_000,
      }),
    );
    await link(harness, event.id);

    const people = await harness.app.contactLinks.peopleOnEvent(event.id);
    expect(people).toHaveLength(1);
    expect(people[0]?.posture).toBe('awaiting_them');
  });

  it('keeps the link truthful when messaging is unreachable', async () => {
    const { harness, event } = await harnessWithEvent({
      ...messagingWith(),
      thread: () => Promise.reject(new Error('bridge down')),
    });
    await link(harness, event.id);

    const people = await harness.app.contactLinks.peopleOnEvent(event.id);
    expect(people[0]?.posture).toBe('unmentioned');
    expect((await harness.app.db.events.get(event.id))?.classification).toBe('FIXED');
  });

  it('refuses contact search when no messaging integration is configured', async () => {
    const harness = await createTestApp();
    await expect(harness.app.contactLinks.search('sarah')).rejects.toThrow(/npm run bridge/);
    expect((await harness.app.contactLinks.capabilities()).available).toBe(false);
  });

  it('offers the person the title names', async () => {
    const { harness } = await harnessWithEvent();
    const calendar = (await harness.app.calendars.listCalendars(harness.userId)).find(
      (c) => c.isWritable,
    )!;
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId: calendar.id,
      title: 'Lunch with Mike',
      start: NOW + 86_400_000,
      end: NOW + 90_000_000,
    });

    const suggestions = await harness.app.contactLinks.suggestForEvent(event.id);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ candidate: 'Mike', kind: 'unique' });
    expect(suggestions[0]?.contacts[0]?.displayName).toBe('Mike Okafor');
  });

  it('asks which one when the first name is shared', async () => {
    // "Lunch with Sarah" matches two people; picking either would be a guess.
    const { harness, event } = await harnessWithEvent();

    const suggestions = await harness.app.contactLinks.suggestForEvent(event.id);

    expect(suggestions[0]?.kind).toBe('ambiguous');
    expect(suggestions[0]?.contacts.map((c) => c.displayName)).toEqual([
      'Sarah Chen',
      'Sarah Jones',
    ]);
  });

  it('stops suggesting someone once they are linked', async () => {
    const { harness, event } = await harnessWithEvent();
    await link(harness, event.id);

    const suggestions = await harness.app.contactLinks.suggestForEvent(event.id);

    // Sarah Chen is on the event now, so only Sarah Jones is left - and one
    // match is no longer a tie.
    expect(suggestions[0]).toMatchObject({ kind: 'unique' });
    expect(suggestions[0]?.contacts[0]?.displayName).toBe('Sarah Jones');
  });

  it('suggests nothing when there is no messaging integration', async () => {
    const harness = await createTestApp();
    const calendar = (await harness.app.calendars.listCalendars(harness.userId)).find(
      (c) => c.isWritable,
    )!;
    const event = await harness.app.calendars.createEvent({
      userId: harness.userId,
      calendarId: calendar.id,
      title: 'Lunch with Mike',
      start: NOW + 86_400_000,
      end: NOW + 90_000_000,
    });

    expect(await harness.app.contactLinks.suggestForEvent(event.id)).toEqual([]);
  });
});
