import { describe, expect, it } from 'vitest';
import { instantFromISO, instantToISO } from '@calendar-agent/core';
import { FetchRecorder, MemoryTokenStore } from '../testing.js';
import { createMicrosoftOAuthClient, OutlookCalendarProvider } from './outlook-provider.js';
import { extendedPropertyId } from './mapper.js';

function build(recorder: FetchRecorder) {
  const tokens = new MemoryTokenStore({
    acc: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 9_999_999_999_999 },
  });
  const oauth = createMicrosoftOAuthClient({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://localhost/cb',
    fetch: recorder.fetch,
  });
  return new OutlookCalendarProvider({
    accountId: 'acc',
    tokens,
    oauth,
    fetch: recorder.fetch,
    defaultTimezone: 'Europe/Berlin',
  });
}

describe('OutlookCalendarProvider', () => {
  it('normalises Graph events into the same shape as Google', async () => {
    const recorder = new FetchRecorder()
      .on('/me?', { body: { displayName: 'Me', mail: 'me@example.com' } })
      .on(/\/me$/, { body: { displayName: 'Me', mail: 'me@example.com' } })
      .on('calendarView/delta', {
        body: {
          value: [
            {
              id: 'g1',
              '@odata.etag': 'W/"1"',
              subject: 'Design review',
              start: { dateTime: '2026-03-09T09:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-03-09T10:00:00.0000000', timeZone: 'UTC' },
              showAs: 'busy',
              type: 'occurrence',
              seriesMasterId: 'series-9',
              isOrganizer: false,
              attendees: [
                {
                  type: 'required',
                  emailAddress: { address: 'me@example.com' },
                  status: { response: 'accepted' },
                },
                {
                  type: 'optional',
                  emailAddress: { address: 'x@example.com' },
                  status: { response: 'none' },
                },
              ],
              organizer: { emailAddress: { address: 'boss@example.com', name: 'Boss' } },
              singleValueExtendedProperties: [
                { id: extendedPropertyId('calendarAgentBlockId'), value: 'blk-2' },
              ],
              createdDateTime: '2026-03-01T00:00:00Z',
              lastModifiedDateTime: '2026-03-02T00:00:00Z',
            },
            { id: 'g2', '@removed': { reason: 'deleted' } },
            {
              id: 'g3',
              subject: 'Focus',
              showAs: 'free',
              start: { dateTime: '2026-03-09T12:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-03-09T13:00:00.0000000', timeZone: 'UTC' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=abc',
        },
      });

    const provider = build(recorder);
    await provider.authenticate();
    const result = await provider.getEvents({
      calendarExternalId: 'cal-1',
      range: {
        start: instantFromISO('2026-03-09T00:00:00Z'),
        end: instantFromISO('2026-03-10T00:00:00Z'),
      },
    });

    expect(result.deletedExternalIds).toEqual(['g2']);
    expect(result.nextSyncToken).toBe('https://graph.microsoft.com/delta?token=abc');
    const [review, focus] = result.events;
    expect(review!.title).toBe('Design review');
    expect(instantToISO(review!.start)).toBe('2026-03-09T09:00:00.000Z');
    expect(review!.recurrenceKind).toBe('instance');
    expect(review!.seriesExternalId).toBe('series-9');
    expect(review!.attendees.find((a) => a.self)?.email).toBe('me@example.com');
    expect(review!.metadata.calendarAgentBlockId).toBe('blk-2');
    // showAs free means the event does not consume time.
    expect(focus!.transparency).toBe('transparent');
  });

  it('requests UTC timestamps and expands our metadata', async () => {
    const recorder = new FetchRecorder().on('calendarView/delta', { body: { value: [] } });
    await build(recorder).getEvents({
      calendarExternalId: 'cal-1',
      range: { start: 0, end: 1_000 },
    });
    const request = recorder.find('calendarView/delta')!;
    expect(request.headers.prefer).toBe('outlook.timezone="UTC"');
    expect(decodeURIComponent(request.url)).toContain('calendarAgentBlockId');
  });

  it('creates events with extended properties', async () => {
    const recorder = new FetchRecorder().on('/events', (request) => ({
      body: { id: 'new-1', ...(request.body as Record<string, unknown>) },
    }));
    await build(recorder).createEvent({
      calendarExternalId: 'cal-1',
      title: 'Study',
      start: instantFromISO('2026-03-09T08:00:00Z'),
      end: instantFromISO('2026-03-09T09:00:00Z'),
      timezone: 'Europe/Berlin',
      metadata: { calendarAgentManaged: 'true' },
    });
    const body = recorder.find('/events')!.body as Record<string, any>;
    expect(body.subject).toBe('Study');
    expect(body.start).toEqual({ dateTime: '2026-03-09T09:00:00', timeZone: 'Europe/Berlin' });
    expect(body.singleValueExtendedProperties[0].value).toBe('true');
  });

  it('moves an event with PATCH and an If-Match guard', async () => {
    const recorder = new FetchRecorder().on('/me/events/', { body: { id: 'g1' } });
    await build(recorder).updateEvent(
      { calendarExternalId: 'cal-1', externalId: 'g1', etag: 'W/"1"' },
      {
        start: instantFromISO('2026-03-09T10:00:00Z'),
        end: instantFromISO('2026-03-09T11:00:00Z'),
      },
    );
    const request = recorder.find('/me/events/')!;
    expect(request.method).toBe('PATCH');
    expect(request.headers['if-match']).toBe('W/"1"');
    expect(Object.keys(request.body as object).sort()).toEqual(['end', 'start']);
  });

  it('requests offline access in the authorization url', () => {
    const url = createMicrosoftOAuthClient({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost/cb',
      tenantId: 'common',
    }).buildAuthorizationUrl('state-2');
    expect(url).toContain('login.microsoftonline.com/common');
    expect(decodeURIComponent(url)).toContain('offline_access');
    expect(decodeURIComponent(url)).toContain('Calendars.ReadWrite');
  });
});
