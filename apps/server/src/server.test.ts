import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '@calendar-agent/app';
import { createTestApp } from '@calendar-agent/app';
import { createServer } from './server.js';

describe('HTTP API', () => {
  let harness: TestApp;
  let server: Server;
  let base: string;

  const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
  };

  beforeEach(async () => {
    harness = await createTestApp();
    const express = createServer(harness.app, { webRoot: undefined });
    server = express.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('reports health', async () => {
    const { status, body } = await api('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('returns the bootstrap state', async () => {
    const { body } = await api('/state');
    expect(body.user.id).toBe(harness.userId);
    expect(body.timezone).toBe('UTC');
    expect(body.calendars).toHaveLength(1);
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it('creates, updates and deletes a task', async () => {
    const created = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Write proposal',
        estimatedMinutes: 120,
        deadline: '2026-03-13T17:00:00Z',
        priority: 'high',
      }),
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const updated = await api(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estimatedMinutes: 180 }),
    });
    expect(updated.body.estimatedMinutes).toBe(180);

    const listed = await api('/tasks');
    expect(listed.body).toHaveLength(1);

    const removed = await api(`/tasks/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await api('/tasks')).body).toHaveLength(0);
  });

  it('rejects an invalid task with a structured error', async () => {
    const { status, body } = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ estimatedMinutes: 60 }),
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('plans and applies a schedule', async () => {
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Reading', estimatedMinutes: 90 }),
    });

    const planned = await api('/schedule/plan', { method: 'POST', body: JSON.stringify({}) });
    expect(planned.body.plan.blocks).toHaveLength(1);
    expect(planned.body.dryRun).toBe(true);
    expect(harness.provider.list()).toHaveLength(0);

    const applied = await api('/schedule/apply', {
      method: 'POST',
      body: JSON.stringify({ changeSetId: planned.body.changeSetId }),
    });
    expect(applied.body.failures).toHaveLength(0);
    expect(harness.provider.list()).toHaveLength(1);
  });

  it('rejects a proposal', async () => {
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Reading', estimatedMinutes: 60 }),
    });
    const planned = await api('/schedule/plan', { method: 'POST', body: JSON.stringify({}) });
    const rejected = await api('/schedule/reject', {
      method: 'POST',
      body: JSON.stringify({ changeSetId: planned.body.changeSetId }),
    });
    expect(rejected.status).toBe(204);
    expect(harness.provider.list()).toHaveLength(0);
  });

  it('answers an agent message', async () => {
    const { body } = await api('/agent/message', {
      method: 'POST',
      body: JSON.stringify({ text: 'what deadlines are at risk?' }),
    });
    expect(body.commands).toEqual([{ type: 'list_risks' }]);
    expect(typeof body.reply).toBe('string');
  });

  it('returns risks, free windows and the agenda', async () => {
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Big thing',
        estimatedMinutes: 2400,
        deadline: '2026-03-10T12:00:00Z',
      }),
    });
    expect((await api('/risks')).body[0].level).toBe('IMPOSSIBLE');
    expect((await api('/free?minutes=120')).body.length).toBeGreaterThan(0);
    expect((await api('/agenda')).body).toHaveProperty('events');
  });

  it('moves a block and pins it', async () => {
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Reading', estimatedMinutes: 60 }),
    });
    const planned = await api('/schedule/plan', { method: 'POST', body: JSON.stringify({}) });
    await api('/schedule/apply', {
      method: 'POST',
      body: JSON.stringify({ changeSetId: planned.body.changeSetId }),
    });
    const blockId = planned.body.plan.blocks[0].id as string;

    const moved = await api(`/blocks/${blockId}`, {
      method: 'PATCH',
      body: JSON.stringify({ start: '2026-03-11T14:00:00Z', end: '2026-03-11T15:00:00Z' }),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.pinned).toBe(true);
    expect(new Date(moved.body.start).toISOString()).toBe('2026-03-11T14:00:00.000Z');
    expect(harness.provider.list()[0].start).toBe(Date.parse('2026-03-11T14:00:00Z'));
  });

  it('rejects a block move without times', async () => {
    const { status, body } = await api('/blocks/whatever', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unpins and deletes a block', async () => {
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Reading', estimatedMinutes: 60 }),
    });
    const planned = await api('/schedule/plan', { method: 'POST', body: JSON.stringify({}) });
    await api('/schedule/apply', {
      method: 'POST',
      body: JSON.stringify({ changeSetId: planned.body.changeSetId }),
    });
    const blockId = planned.body.plan.blocks[0].id as string;

    const pinned = await api(`/blocks/${blockId}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned: false }),
    });
    expect(pinned.body.pinned).toBe(false);

    expect((await api(`/blocks/${blockId}`, { method: 'DELETE' })).status).toBe(204);
    expect(harness.provider.list()).toHaveLength(0);
  });

  it('still shows an event that already finished today', async () => {
    // The clock is fixed at 08:00 UTC, so this one is over. A horizon anchored
    // to `now` drops it and the morning reads as having been deleted.
    const calendars = await api('/calendars');
    const calendarId = calendars.body.calendars[0].id as string;
    await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId,
        title: 'Standup',
        start: '2026-03-09T06:00:00Z',
        end: '2026-03-09T06:15:00Z',
      }),
    });

    const { body } = await api('/state');

    expect(body.events.map((event: any) => event.title)).toContain('Standup');
  });

  it('does not reach back beyond the start of the local day', async () => {
    const calendars = await api('/calendars');
    const calendarId = calendars.body.calendars[0].id as string;
    await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId,
        title: 'Yesterday',
        start: '2026-03-08T18:00:00Z',
        end: '2026-03-08T19:00:00Z',
      }),
    });

    const { body } = await api('/state');

    // Bootstrap stays a bounded payload; older days come from /agenda.
    expect(body.events.map((event: any) => event.title)).not.toContain('Yesterday');
  });

  it('serves an arbitrary past window through the agenda', async () => {
    const calendars = await api('/calendars');
    const calendarId = calendars.body.calendars[0].id as string;
    await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId,
        title: 'Last week',
        start: '2026-03-02T15:00:00Z',
        end: '2026-03-02T16:00:00Z',
      }),
    });

    const { body } = await api('/agenda?start=2026-03-01T00:00:00Z&end=2026-03-05T00:00:00Z');

    expect(body.events.map((event: any) => event.title)).toContain('Last week');
  });

  it('creates, edits and deletes a calendar event', async () => {
    const calendars = await api('/calendars');
    const calendarId = calendars.body.calendars[0].id as string;

    const created = await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId,
        title: 'Coffee',
        start: '2026-03-10T15:00:00Z',
        end: '2026-03-10T16:00:00Z',
      }),
    });
    expect(created.status).toBe(201);
    expect(harness.provider.list()).toHaveLength(1);

    const renamed = await api(`/events/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Coffee with Sam' }),
    });
    expect(renamed.body.title).toBe('Coffee with Sam');
    // A rename must not disturb the timing.
    expect(new Date(renamed.body.start).toISOString()).toBe('2026-03-10T15:00:00.000Z');

    expect((await api(`/events/${created.body.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(harness.provider.list()).toHaveLength(0);
  });

  it('invites, uninvites and marks an event free', async () => {
    const calendars = await api('/calendars');
    const calendarId = calendars.body.calendars[0].id as string;

    const created = await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId,
        title: 'Design review',
        start: '2026-03-10T15:00:00Z',
        end: '2026-03-10T16:00:00Z',
        location: 'Room 2',
        description: 'Bring the mocks.',
        attendees: [{ email: 'ada@example.com', name: 'Ada' }],
        transparency: 'busy',
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.attendees).toHaveLength(1);
    expect(created.body.location).toBe('Room 2');

    const invited = await api(`/events/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        attendees: [{ email: 'ada@example.com' }, { email: 'grace@example.com' }],
        transparency: 'free',
      }),
    });
    expect(invited.body.attendees.map((a: { email: string }) => a.email)).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
    expect(invited.body.transparency).toBe('transparent');

    // An empty list is a real instruction: it clears the guests.
    const cleared = await api(`/events/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ attendees: [] }),
    });
    expect(cleared.body.attendees).toEqual([]);
  });

  it('rejects a guest without a usable email address', async () => {
    const calendars = await api('/calendars');
    const calendarId = calendars.body.calendars[0].id as string;
    const { status, body } = await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId,
        title: 'Coffee',
        start: '2026-03-10T15:00:00Z',
        end: '2026-03-10T16:00:00Z',
        attendees: [{ email: 'ada@example.com' }, { email: 'not-an-address' }],
      }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/Guest 2/);
    expect(harness.provider.list()).toHaveLength(0);
  });

  it('keeps a task inside its preferred window and days', async () => {
    const created = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Lunch',
        estimatedMinutes: 45,
        preferredWindows: [{ start: '12:00', end: '14:00' }],
        preferredDays: ['monday', 'tuesday', 'monday'],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.preferredWindows).toEqual([
      { start: { hour: 12, minute: 0 }, end: { hour: 14, minute: 0 } },
    ]);
    // Duplicates collapse; the scheduler reads this as a set.
    expect(created.body.preferredDays).toEqual(['monday', 'tuesday']);

    const plan = await api('/schedule/plan', { method: 'POST', body: JSON.stringify({}) });
    const block = plan.body.plan.blocks.find(
      (b: { taskId: string }) => b.taskId === created.body.id,
    );
    const start = new Date(block.start);
    expect(start.getUTCHours()).toBeGreaterThanOrEqual(12);
    expect(start.getUTCHours()).toBeLessThan(14);

    const widened = await api(`/tasks/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ preferredWindows: [], preferredDays: [] }),
    });
    expect(widened.body.preferredWindows).toEqual([]);
  });

  it('rejects a preferred window that ends before it starts', async () => {
    const { status, body } = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Lunch',
        estimatedMinutes: 45,
        preferredWindows: [{ start: '14:00', end: '12:00' }],
      }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/end after it starts/);
  });

  it('rejects a preferred day that is not a weekday name', async () => {
    const { status, body } = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Lunch', estimatedMinutes: 45, preferredDays: ['someday'] }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/weekday/);
  });

  it('rejects an event without a title', async () => {
    const { status, body } = await api('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId: 'x',
        start: '2026-03-10T15:00:00Z',
        end: '2026-03-10T16:00:00Z',
      }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/title/);
  });

  it('toggles whether a calendar blocks time', async () => {
    const calendars = await api('/calendars');
    const calendarId = calendars.body.calendars[0].id as string;
    const updated = await api(`/calendars/${calendarId}`, {
      method: 'PATCH',
      body: JSON.stringify({ includeInAvailability: false }),
    });
    expect(updated.body.includeInAvailability).toBe(false);
    expect(updated.body.selected).toBe(true);
  });

  it('syncs calendars', async () => {
    const { body } = await api('/sync', { method: 'POST', body: JSON.stringify({}) });
    expect(body.errors).toHaveLength(0);
    expect(body.calendars).toHaveLength(1);
  });

  it('exposes diagnostics', async () => {
    const { body } = await api('/doctor');
    expect(body.checks.some((check: { name: string }) => check.name === 'database')).toBe(true);
  });

  it('reports an unknown OAuth provider clearly', async () => {
    const { status, body } = await api('/oauth/google/start?json=true');
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/No OAuth credentials configured/);
  });
});
