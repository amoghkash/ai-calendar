import { describe, expect, it } from 'vitest';
import { MockCalendarProvider, mockEvent } from './mock-provider.js';

describe('MockCalendarProvider', () => {
  it('supports the full CRUD lifecycle', async () => {
    const provider = new MockCalendarProvider({ now: () => 1_000 });
    const created = await provider.createEvent({
      calendarExternalId: 'primary',
      title: 'Task block',
      description: 'Scheduled by the agent',
      start: 10_000,
      end: 20_000,
      timezone: 'UTC',
      metadata: { calendarAgentBlockId: 'blk-1' },
    });
    expect(created.externalId).toBe('mock-event-1');

    const moved = await provider.updateEvent(
      { calendarExternalId: 'primary', externalId: created.externalId },
      { start: 30_000, end: 40_000 },
    );
    // A move must not disturb any other field.
    expect(moved.title).toBe('Task block');
    expect(moved.description).toBe('Scheduled by the agent');
    expect(moved.metadata.calendarAgentBlockId).toBe('blk-1');
    expect(moved.start).toBe(30_000);
    expect(moved.etag).not.toBe(created.etag);

    await provider.deleteEvent({ calendarExternalId: 'primary', externalId: created.externalId });
    const fetched = await provider.getEvents({
      calendarExternalId: 'primary',
      range: { start: 0, end: 100_000 },
    });
    expect(fetched.events).toHaveLength(0);
    expect(fetched.deletedExternalIds).toEqual([created.externalId]);
  });

  it('only returns events overlapping the requested range', async () => {
    const provider = new MockCalendarProvider({
      events: [
        mockEvent({ externalId: 'a', title: 'A', start: 0, end: 1_000 }),
        mockEvent({ externalId: 'b', title: 'B', start: 5_000, end: 6_000 }),
      ],
    });
    const result = await provider.getEvents({
      calendarExternalId: 'primary',
      range: { start: 4_000, end: 7_000 },
    });
    expect(result.events.map((e) => e.externalId)).toEqual(['b']);
  });
});
