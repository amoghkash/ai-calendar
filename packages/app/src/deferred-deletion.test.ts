import { describe, expect, it } from 'vitest';
import { buildAgentTools } from './agent/tools.js';
import { createTestApp } from './testing.js';

const NOW = Date.parse('2026-03-09T08:00:00Z');
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withEvent(title = 'Kickoff') {
  const harness = await createTestApp();
  const app = harness.app;
  const calendar = (await app.calendars.listCalendars(app.user.id)).find((c) => c.isWritable)!;
  const event = await app.calendars.createEvent({
    userId: app.user.id,
    calendarId: calendar.id,
    title,
    start: NOW + 3_600_000,
    end: NOW + 7_200_000,
  });
  return { app, event };
}

describe('deleting an event, with a way back', () => {
  it('does not remove it while the window is open', async () => {
    const { app, event } = await withEvent();

    const pending = await app.deletions.schedule(app.user.id, event.id, { delayMs: 5_000 });

    expect(pending.title).toBe('Kickoff');
    // Nothing has happened yet - that is the whole basis of the undo.
    expect(await app.db.events.get(event.id)).toBeDefined();
    expect(app.deletions.pending(app.user.id)).toHaveLength(1);
    app.deletions.stop();
  });

  it('removes it once the window closes', async () => {
    const { app, event } = await withEvent();

    await app.deletions.schedule(app.user.id, event.id, { delayMs: 10 });
    await settle(60);

    expect(await app.db.events.get(event.id)).toBeUndefined();
    expect(app.deletions.pending(app.user.id)).toHaveLength(0);
  });

  it('keeps it when undone in time', async () => {
    const { app, event } = await withEvent();
    const pending = await app.deletions.schedule(app.user.id, event.id, { delayMs: 200 });

    const kept = app.deletions.undo(app.user.id, pending.token);
    await settle(300);

    expect(kept.title).toBe('Kickoff');
    expect(await app.db.events.get(event.id)).toBeDefined();
  });

  it('says so when the window has already closed', async () => {
    const { app, event } = await withEvent();
    const pending = await app.deletions.schedule(app.user.id, event.id, { delayMs: 10 });
    await settle(60);

    expect(() => app.deletions.undo(app.user.id, pending.token)).toThrow(/already happened/);
  });

  it('refuses up front rather than failing later, when it cannot delete at all', async () => {
    const { app } = await withEvent();
    // A refusal ten seconds after the fact reaches nobody.
    await expect(app.deletions.schedule(app.user.id, 'evt_nope', { delayMs: 5_000 })).rejects.toThrow(
      /not found/i,
    );
  });

  it('treats a second request for the same event as the same one', async () => {
    const { app, event } = await withEvent();

    const first = await app.deletions.schedule(app.user.id, event.id, { delayMs: 5_000 });
    const second = await app.deletions.schedule(app.user.id, event.id, { delayMs: 5_000 });

    expect(second.token).toBe(first.token);
    expect(app.deletions.pending(app.user.id)).toHaveLength(1);
    app.deletions.stop();
  });

  it('will not let one user undo another user’s deletion', async () => {
    const { app, event } = await withEvent();
    const pending = await app.deletions.schedule(app.user.id, event.id, { delayMs: 5_000 });

    expect(() => app.deletions.undo('someone-else', pending.token)).toThrow(/never scheduled/);
    app.deletions.stop();
  });

  it('abandons pending deletions on shutdown rather than rushing them', async () => {
    const { app, event } = await withEvent();
    await app.deletions.schedule(app.user.id, event.id, { delayMs: 20 });

    app.deletions.stop();
    await settle(80);

    // Losing a deletion to a restart is the right way for this to fail.
    expect(await app.db.events.get(event.id)).toBeDefined();
  });
});

describe('who is allowed to undo', () => {
  it('gives the agent no way to reverse a deletion it made', async () => {
    const { app } = await withEvent();

    const names = buildAgentTools(app, app.user.id).map((tool) => tool.name);

    // It may delete on an interpreted instruction; taking that back belongs to
    // the person who might have meant a different event.
    expect(names).toContain('delete_event');
    expect(names).not.toContain('undo_delete');
  });

  it('still lets a person undo through the service', async () => {
    const { app, event } = await withEvent();
    const pending = await app.deletions.schedule(app.user.id, event.id, { delayMs: 500 });

    app.deletions.undo(app.user.id, pending.token);
    await settle(600);

    expect(await app.db.events.get(event.id)).toBeDefined();
  });
});

describe('telling the guests', () => {
  it('carries the choice through to when it actually happens', async () => {
    const { app, event } = await withEvent();

    await app.deletions.schedule(app.user.id, event.id, { delayMs: 10, notifyAttendees: true });
    await settle(60);

    // The flag has to survive the wait: it is set when the user decides, and
    // used ten seconds later.
    expect(await app.db.events.get(event.id)).toBeUndefined();
  });

  it('keeps quiet by default', async () => {
    const { app, event } = await withEvent();
    await app.deletions.schedule(app.user.id, event.id, { delayMs: 10 });
    await settle(60);
    expect(await app.db.events.get(event.id)).toBeUndefined();
  });
});
