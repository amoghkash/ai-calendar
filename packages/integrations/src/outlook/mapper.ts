import { DateTime } from 'luxon';
import type {
  Attendee,
  AttendeeResponse,
  CalendarEventInput,
  CalendarEventUpdate,
  NormalizedEvent,
  ProviderCalendar,
  RecurrenceKind,
  Transparency,
} from '@calendar-agent/core';
import { PROVIDER_MICROSOFT } from '@calendar-agent/core';
import type { GraphAttendee, GraphCalendar, GraphDateTime, GraphEvent } from './types.js';

/**
 * Namespace used for our private metadata. Graph has no direct equivalent of
 * Google's extended properties, so named single-value extended properties in a
 * dedicated GUID namespace are used instead.
 */
export const EXTENDED_PROPERTY_GUID = '{2fbb5c3a-6b0b-4c4e-9f0a-0d0c5f4b3a21}';

export const extendedPropertyId = (name: string): string =>
  `String ${EXTENDED_PROPERTY_GUID} Name ${name}`;

export const METADATA_KEYS = [
  'calendarAgentManaged',
  'calendarAgentTaskId',
  'calendarAgentBlockId',
];

export function graphTimeToInstant(value: GraphDateTime | undefined, fallback: string): number {
  if (!value?.dateTime) return 0;
  const zone = normaliseZone(value.timeZone) ?? fallback;
  // Graph sends naive local times plus a separate zone field.
  return DateTime.fromISO(value.dateTime, { zone }).toMillis();
}

/** Graph reports Windows zone names unless `Prefer: outlook.timezone` is set. */
function normaliseZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  if (zone === 'UTC' || zone.includes('/')) return zone;
  return WINDOWS_ZONE_ALIASES[zone];
}

const WINDOWS_ZONE_ALIASES: Record<string, string> = {
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Warsaw',
  'India Standard Time': 'Asia/Kolkata',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
};

const RESPONSE_MAP: Record<string, AttendeeResponse> = {
  none: 'needsAction',
  notResponded: 'needsAction',
  organizer: 'accepted',
  accepted: 'accepted',
  declined: 'declined',
  tentativelyAccepted: 'tentative',
};

function toAttendee(raw: GraphAttendee, selfEmail?: string): Attendee {
  const email = raw.emailAddress?.address ?? '';
  return {
    email,
    name: raw.emailAddress?.name,
    optional: raw.type === 'optional',
    response: raw.status?.response ? RESPONSE_MAP[raw.status.response] : undefined,
    self: selfEmail !== undefined && email.toLowerCase() === selfEmail.toLowerCase(),
  };
}

/** `showAs` decides whether the event consumes time. */
function toTransparency(showAs: GraphEvent['showAs']): Transparency {
  return showAs === 'free' || showAs === 'workingElsewhere' ? 'transparent' : 'opaque';
}

function toRecurrenceKind(type: GraphEvent['type']): RecurrenceKind {
  if (type === 'seriesMaster') return 'series_master';
  if (type === 'occurrence' || type === 'exception') return 'instance';
  return 'single';
}

export function toNormalizedEvent(
  raw: GraphEvent,
  calendarExternalId: string,
  fallbackTimezone: string,
  selfEmail?: string,
): NormalizedEvent {
  const metadata: Record<string, string> = {};
  for (const property of raw.singleValueExtendedProperties ?? []) {
    const name = property.id.split(' Name ')[1];
    if (name) metadata[name] = property.value;
  }
  const recurrenceKind = toRecurrenceKind(raw.type);
  const timezone = normaliseZone(raw.start?.timeZone) ?? fallbackTimezone;

  return {
    provider: PROVIDER_MICROSOFT,
    calendarExternalId,
    externalId: raw.id,
    title: raw.subject ?? '(no title)',
    description: raw.body?.content ?? raw.bodyPreview,
    location: raw.location?.displayName,
    start: graphTimeToInstant(raw.start, fallbackTimezone),
    end: graphTimeToInstant(raw.end, fallbackTimezone),
    timezone,
    isAllDay: raw.isAllDay === true,
    isRecurring: recurrenceKind !== 'single',
    recurrenceKind,
    seriesExternalId: raw.seriesMasterId,
    status:
      raw.isCancelled === true
        ? 'cancelled'
        : raw.showAs === 'tentative'
          ? 'tentative'
          : 'confirmed',
    transparency: toTransparency(raw.showAs),
    attendees: (raw.attendees ?? []).map((a) => toAttendee(a, selfEmail)),
    organizer: raw.organizer?.emailAddress
      ? {
          email: raw.organizer.emailAddress.address ?? '',
          name: raw.organizer.emailAddress.name,
          organizer: true,
        }
      : undefined,
    isOrganizer: raw.isOrganizer === true,
    metadata,
    etag: raw['@odata.etag'],
    conferenceData: raw.onlineMeeting,
    createdAt: raw.createdDateTime ? Date.parse(raw.createdDateTime) : 0,
    updatedAt: raw.lastModifiedDateTime ? Date.parse(raw.lastModifiedDateTime) : 0,
  };
}

export function toGraphCreate(input: CalendarEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subject: input.title,
    start: toGraphTime(input.start, input.timezone),
    end: toGraphTime(input.end, input.timezone),
    isAllDay: input.isAllDay ?? false,
    showAs: input.transparency === 'transparent' ? 'free' : 'busy',
  };
  if (input.description !== undefined) {
    body.body = { contentType: 'text', content: input.description };
  }
  if (input.location !== undefined) body.location = { displayName: input.location };
  if (input.attendees?.length) body.attendees = input.attendees.map(fromAttendee);
  const metadata = input.metadata ?? {};
  if (Object.keys(metadata).length > 0) {
    body.singleValueExtendedProperties = Object.entries(metadata).map(([name, value]) => ({
      id: extendedPropertyId(name),
      value,
    }));
  }
  return body;
}

/** Partial update: only the supplied fields are sent, everything else stays. */
export function toGraphPatch(
  changes: CalendarEventUpdate,
  fallbackTimezone: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const timezone = changes.timezone ?? fallbackTimezone;
  if (changes.start !== undefined) body.start = toGraphTime(changes.start, timezone);
  if (changes.end !== undefined) body.end = toGraphTime(changes.end, timezone);
  if (changes.title !== undefined) body.subject = changes.title;
  if (changes.description !== undefined) {
    body.body = { contentType: 'text', content: changes.description };
  }
  if (changes.location !== undefined) body.location = { displayName: changes.location };
  if (changes.transparency !== undefined) {
    body.showAs = changes.transparency === 'transparent' ? 'free' : 'busy';
  }
  // Graph replaces the whole collection, so this is only ever the full list.
  if (changes.attendees !== undefined) body.attendees = changes.attendees.map(fromAttendee);
  if (changes.metadata !== undefined) {
    body.singleValueExtendedProperties = Object.entries(changes.metadata).map(([name, value]) => ({
      id: extendedPropertyId(name),
      value,
    }));
  }
  return body;
}

/** The inverse of `toAttendee`. Graph infers the RSVP, so it is not sent. */
function fromAttendee(attendee: Attendee): GraphAttendee {
  return {
    type: attendee.optional === true ? 'optional' : 'required',
    emailAddress: {
      address: attendee.email,
      ...(attendee.name === undefined ? {} : { name: attendee.name }),
    },
  };
}

function toGraphTime(instant: number, timezone: string): GraphDateTime {
  const dt = DateTime.fromMillis(instant, { zone: timezone });
  return {
    dateTime: dt.toISO({ includeOffset: false, suppressMilliseconds: true }) ?? '',
    timeZone: timezone,
  };
}

export function toProviderCalendar(raw: GraphCalendar): ProviderCalendar {
  return {
    externalId: raw.id,
    name: raw.name ?? raw.id,
    timezone: 'UTC',
    isPrimary: raw.isDefaultCalendar === true,
    isWritable: raw.canEdit !== false,
    color: raw.hexColor,
  };
}
