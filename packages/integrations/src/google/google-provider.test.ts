import { describe, expect, it } from 'vitest';
import { instantFromISO, instantToISO } from '@calendar-agent/core';
import { FetchRecorder, MemoryTokenStore } from '../testing.js';
import { createGoogleOAuthClient, GoogleCalendarProvider } from './google-provider.js';

function build(recorder: FetchRecorder) {
  const tokens = new MemoryTokenStore({
    acc: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 9_999_999_999_999 },
  });
  const oauth = createGoogleOAuthClient({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://localhost/cb',
    fetch: recorder.fetch,
  });
  return new GoogleCalendarProvider({
    accountId: 'acc',
    tokens,
    oauth,
    fetch: recorder.fetch,
    defaultTimezone: 'America/New_York',
  });
}

describe('GoogleCalendarProvider', () => {
  it('lists calendars and reports writability from the access role', async () => {
    const recorder = new FetchRecorder().on('calendarList', {
      body: {
        items: [
          {
            id: 'primary',
            summary: 'Personal',
            timeZone: 'America/New_York',
            primary: true,
            accessRole: 'owner',
          },
          { id: 'team', summary: 'Team', timeZone: 'UTC', accessRole: 'reader' },
        ],
      },
    });
    const calendars = await build(recorder).getCalendars();
    expect(calendars).toEqual([
      {
        externalId: 'primary',
        name: 'Personal',
        description: undefined,
        timezone: 'America/New_York',
        isPrimary: true,
        isWritable: true,
        color: undefined,
      },
      {
        externalId: 'team',
        name: 'Team',
        description: undefined,
        timezone: 'UTC',
        isPrimary: false,
        isWritable: false,
        color: undefined,
      },
    ]);
  });

  it('normalises events, including all-day and recurring instances', async () => {
    const recorder = new FetchRecorder()
      .on('calendarList', {
        body: { items: [{ id: 'primary', timeZone: 'America/New_York', accessRole: 'owner' }] },
      })
      .on('/events', {
        body: {
          items: [
            {
              id: 'e1',
              etag: '"abc"',
              summary: 'Standup',
              status: 'confirmed',
              start: { dateTime: '2026-03-09T09:00:00-04:00', timeZone: 'America/New_York' },
              end: { dateTime: '2026-03-09T09:30:00-04:00', timeZone: 'America/New_York' },
              recurringEventId: 'series-1',
              attendees: [
                { email: 'me@example.com', self: true, responseStatus: 'accepted' },
                { email: 'other@example.com', responseStatus: 'needsAction' },
              ],
              organizer: { email: 'me@example.com', self: true },
              extendedProperties: { private: { calendarAgentBlockId: 'blk-1' } },
              created: '2026-03-01T10:00:00Z',
              updated: '2026-03-02T10:00:00Z',
            },
            {
              id: 'e2',
              summary: 'Holiday',
              start: { date: '2026-03-10' },
              end: { date: '2026-03-11' },
              transparency: 'transparent',
            },
            { id: 'e3', status: 'cancelled' },
          ],
          nextSyncToken: 'sync-1',
        },
      });

    const provider = build(recorder);
    await provider.getCalendars();
    const result = await provider.getEvents({
      calendarExternalId: 'primary',
      range: {
        start: instantFromISO('2026-03-09T00:00:00Z'),
        end: instantFromISO('2026-03-16T00:00:00Z'),
      },
    });

    expect(result.nextSyncToken).toBe('sync-1');
    expect(result.deletedExternalIds).toEqual(['e3']);
    const [standup, holiday] = result.events;
    expect(standup!.title).toBe('Standup');
    expect(instantToISO(standup!.start)).toBe('2026-03-09T13:00:00.000Z');
    expect(standup!.recurrenceKind).toBe('instance');
    expect(standup!.seriesExternalId).toBe('series-1');
    expect(standup!.isOrganizer).toBe(true);
    expect(standup!.attendees.find((a) => a.self)?.response).toBe('accepted');
    expect(standup!.metadata.calendarAgentBlockId).toBe('blk-1');

    // All-day dates are read in the calendar's zone, not UTC (EDT on this date).
    expect(holiday!.isAllDay).toBe(true);
    expect(instantToISO(holiday!.start)).toBe('2026-03-10T04:00:00.000Z');
    expect(holiday!.transparency).toBe('transparent');
  });

  it('sends a sync token instead of a time window on incremental fetches', async () => {
    const recorder = new FetchRecorder().on('/events', {
      body: { items: [], nextSyncToken: 's2' },
    });
    await build(recorder).getEvents({
      calendarExternalId: 'primary',
      range: { start: 0, end: 1 },
      syncToken: 's1',
    });
    const request = recorder.find('/events')!;
    expect(request.url).toContain('syncToken=s1');
    expect(request.url).not.toContain('timeMin');
  });

  it('asks for a full resync when the sync token expired', async () => {
    const recorder = new FetchRecorder().on('/events', { status: 410, body: { error: 'gone' } });
    const result = await build(recorder).getEvents({
      calendarExternalId: 'primary',
      range: { start: 0, end: 1 },
      syncToken: 'stale',
    });
    expect(result.resyncRequired).toBe(true);
  });

  it('creates events with private metadata', async () => {
    const recorder = new FetchRecorder().on('/events', (request) => ({
      body: { id: 'new-1', etag: '"1"', ...(request.body as Record<string, unknown>) },
    }));
    await build(recorder).createEvent({
      calendarExternalId: 'primary',
      title: 'Deep work',
      start: instantFromISO('2026-03-09T14:00:00Z'),
      end: instantFromISO('2026-03-09T16:00:00Z'),
      timezone: 'America/New_York',
      metadata: { calendarAgentManaged: 'true', calendarAgentBlockId: 'blk-9' },
    });
    const request = recorder.find('/events')!;
    expect(request.method).toBe('POST');
    const body = request.body as Record<string, any>;
    expect(body.summary).toBe('Deep work');
    expect(body.start).toEqual({
      dateTime: '2026-03-09T10:00:00-04:00',
      timeZone: 'America/New_York',
    });
    expect(body.extendedProperties.private.calendarAgentBlockId).toBe('blk-9');
  });

  it('moves an event with PATCH so other fields survive', async () => {
    const recorder = new FetchRecorder().on('/events/', { body: { id: 'e1', etag: '"2"' } });
    await build(recorder).updateEvent(
      { calendarExternalId: 'primary', externalId: 'e1', etag: '"1"' },
      {
        start: instantFromISO('2026-03-09T15:00:00Z'),
        end: instantFromISO('2026-03-09T16:00:00Z'),
      },
    );
    const request = recorder.find('/events/')!;
    expect(request.method).toBe('PATCH');
    expect(request.headers['if-match']).toBe('"1"');
    expect(Object.keys(request.body as object).sort()).toEqual(['end', 'start']);
  });

  it('sends the whole guest list on a patch, RSVPs included', async () => {
    const recorder = new FetchRecorder().on('/events/', { body: { id: 'e1', etag: '"2"' } });
    await build(recorder).updateEvent(
      { calendarExternalId: 'primary', externalId: 'e1' },
      {
        attendees: [
          { email: 'ada@example.com', name: 'Ada', response: 'accepted' },
          { email: 'new@example.com', optional: true },
        ],
        notifyAttendees: true,
      },
    );
    const request = recorder.find('/events/')!;
    // Google replaces the list, so an existing guest keeps their reply only
    // because it is sent straight back.
    expect((request.body as { attendees: unknown[] }).attendees).toEqual([
      { email: 'ada@example.com', displayName: 'Ada', responseStatus: 'accepted' },
      { email: 'new@example.com', optional: true },
    ]);
    expect(request.url).toContain('sendUpdates=all');
  });

  it('leaves the guest list alone when a patch does not mention it', async () => {
    const recorder = new FetchRecorder().on('/events/', { body: { id: 'e1', etag: '"2"' } });
    await build(recorder).updateEvent(
      { calendarExternalId: 'primary', externalId: 'e1' },
      { location: 'Room 2' },
    );
    expect(Object.keys(recorder.find('/events/')!.body as object)).toEqual(['location']);
  });

  it('deletes events', async () => {
    const recorder = new FetchRecorder().on('/events/', { status: 204 });
    await build(recorder).deleteEvent({ calendarExternalId: 'primary', externalId: 'e1' });
    expect(recorder.find('/events/')!.method).toBe('DELETE');
  });

  it('builds an offline-capable authorization url', () => {
    const url = createGoogleOAuthClient({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost/cb',
    }).buildAuthorizationUrl('state-1');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('state=state-1');
    expect(decodeURIComponent(url)).toContain('https://www.googleapis.com/auth/calendar');
  });
});
