import { DateTime } from 'luxon';
import type {
  Attendee,
  AttendeeResponse,
  CalendarEventInput,
  CalendarEventUpdate,
  NormalizedEvent,
  ProviderCalendar,
} from '@calendar-agent/core';
import { PROVIDER_GOOGLE } from '@calendar-agent/core';
import type { GoogleAttendee, GoogleCalendarListEntry, GoogleEvent } from './types.js';

/** Convert a Google date/dateTime pair into an instant. */
export function googleTimeToInstant(
  value: { date?: string; dateTime?: string; timeZone?: string } | undefined,
  fallbackTimezone: string,
  endOfDay = false,
): number {
  if (!value) return 0;
  if (value.dateTime) {
    const parsed = DateTime.fromISO(value.dateTime, {
      zone: value.timeZone ?? fallbackTimezone,
      setZone: true,
    });
    return parsed.toMillis();
  }
  if (value.date) {
    // All-day events use naive dates that must be read in the calendar's zone.
    const day = DateTime.fromISO(value.date, { zone: value.timeZone ?? fallbackTimezone });
    return (endOfDay ? day : day).toMillis();
  }
  return 0;
}

const RESPONSE_MAP: Record<string, AttendeeResponse> = {
  needsAction: 'needsAction',
  declined: 'declined',
  tentative: 'tentative',
  accepted: 'accepted',
};

function toAttendee(raw: GoogleAttendee): Attendee {
  return {
    email: raw.email ?? '',
    name: raw.displayName,
    optional: raw.optional,
    response: raw.responseStatus ? RESPONSE_MAP[raw.responseStatus] : undefined,
    self: raw.self,
    organizer: raw.organizer,
  };
}

export function toNormalizedEvent(
  raw: GoogleEvent,
  calendarExternalId: string,
  calendarTimezone: string,
): NormalizedEvent {
  const isAllDay = Boolean(raw.start?.date);
  const timezone = raw.start?.timeZone ?? calendarTimezone;
  const recurrenceKind = raw.recurrence?.length
    ? 'series_master'
    : raw.recurringEventId
      ? 'instance'
      : 'single';

  return {
    provider: PROVIDER_GOOGLE,
    calendarExternalId,
    externalId: raw.id,
    title: raw.summary ?? '(no title)',
    description: raw.description,
    location: raw.location,
    start: googleTimeToInstant(raw.start, calendarTimezone),
    end: googleTimeToInstant(raw.end, calendarTimezone, true),
    timezone,
    isAllDay,
    isRecurring: recurrenceKind !== 'single',
    recurrenceKind,
    seriesExternalId: raw.recurringEventId,
    recurrenceRules: raw.recurrence,
    status: raw.status ?? 'confirmed',
    transparency: raw.transparency === 'transparent' ? 'transparent' : 'opaque',
    attendees: (raw.attendees ?? []).map(toAttendee),
    organizer: raw.organizer ? toAttendee(raw.organizer) : undefined,
    isOrganizer: raw.organizer?.self === true,
    metadata: raw.extendedProperties?.private ?? {},
    etag: raw.etag,
    conferenceData: raw.conferenceData,
    createdAt: raw.created ? Date.parse(raw.created) : 0,
    updatedAt: raw.updated ? Date.parse(raw.updated) : 0,
  };
}

/** Body for `events.insert`. */
export function toGoogleInsert(input: CalendarEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.title,
    start: toGoogleTime(input.start, input.timezone, input.isAllDay ?? false),
    end: toGoogleTime(input.end, input.timezone, input.isAllDay ?? false),
  };
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.transparency !== undefined) body.transparency = input.transparency;
  if (input.attendees?.length) body.attendees = input.attendees.map(fromAttendee);
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    body.extendedProperties = { private: input.metadata };
  }
  return body;
}

/**
 * Body for `events.patch`. Only the fields that are actually changing are
 * included, so title, description, attendees, recurrence and conferencing data
 * are preserved by the API's patch semantics.
 */
export function toGooglePatch(
  changes: CalendarEventUpdate,
  fallbackTimezone: string,
  isAllDay = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const timezone = changes.timezone ?? fallbackTimezone;
  if (changes.start !== undefined) body.start = toGoogleTime(changes.start, timezone, isAllDay);
  if (changes.end !== undefined) body.end = toGoogleTime(changes.end, timezone, isAllDay);
  if (changes.title !== undefined) body.summary = changes.title;
  if (changes.description !== undefined) body.description = changes.description;
  if (changes.location !== undefined) body.location = changes.location;
  if (changes.transparency !== undefined) body.transparency = changes.transparency;
  // Google replaces the whole list, so this is only ever the full guest list.
  // Existing RSVPs survive because `fromAttendee` sends each one back.
  if (changes.attendees !== undefined) body.attendees = changes.attendees.map(fromAttendee);
  if (changes.metadata !== undefined) body.extendedProperties = { private: changes.metadata };
  return body;
}

/** The inverse of `toAttendee`; omits fields Google would reject as empty. */
function fromAttendee(attendee: Attendee): GoogleAttendee {
  return {
    email: attendee.email,
    ...(attendee.name === undefined ? {} : { displayName: attendee.name }),
    ...(attendee.optional === undefined ? {} : { optional: attendee.optional }),
    ...(attendee.response === undefined ? {} : { responseStatus: attendee.response }),
  };
}

function toGoogleTime(
  instant: number,
  timezone: string,
  isAllDay: boolean,
): Record<string, string> {
  const dt = DateTime.fromMillis(instant, { zone: timezone });
  if (isAllDay) return { date: dt.toISODate() ?? '' };
  return { dateTime: dt.toISO({ suppressMilliseconds: true }) ?? '', timeZone: timezone };
}

export function toProviderCalendar(entry: GoogleCalendarListEntry): ProviderCalendar {
  return {
    externalId: entry.id,
    name: entry.summaryOverride ?? entry.summary ?? entry.id,
    description: entry.description,
    timezone: entry.timeZone ?? 'UTC',
    isPrimary: entry.primary === true,
    isWritable: entry.accessRole === 'owner' || entry.accessRole === 'writer',
    color: entry.backgroundColor,
  };
}
