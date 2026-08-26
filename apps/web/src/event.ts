/**
 * Reading the parts of an event the grid and the editor display: guests, the
 * conferencing link, and the labels that go with them.
 *
 * `conferenceData` is provider-shaped and typed `unknown` all the way through
 * the domain, so unpicking it is a display concern and lives here rather than
 * widening the model with a provider's schema.
 */

import type { Attendee, AttendeeResponse, CalendarEvent } from './api';

/** Everyone but the account holder - the people an edit would disturb. */
export const guestsOf = (event: Pick<CalendarEvent, 'attendees'>): Attendee[] =>
  event.attendees.filter((attendee) => attendee.self !== true);

/** Display name for a guest, falling back to the local part of their address. */
export const attendeeLabel = (attendee: Attendee): string =>
  attendee.name?.trim() || (attendee.email.split('@')[0] ?? attendee.email);

const RESPONSE_LABELS: Record<AttendeeResponse, string> = {
  accepted: 'Going',
  declined: 'Declined',
  tentative: 'Maybe',
  needsAction: 'No reply',
};

export const responseLabel = (response: AttendeeResponse | undefined): string =>
  response === undefined ? RESPONSE_LABELS.needsAction : RESPONSE_LABELS[response];

/** One-line RSVP tally, or undefined when nobody has been invited. */
export function rsvpSummary(event: Pick<CalendarEvent, 'attendees'>): string | undefined {
  const guests = guestsOf(event);
  if (guests.length === 0) return undefined;
  const counted = (response: AttendeeResponse): number =>
    guests.filter((guest) => (guest.response ?? 'needsAction') === response).length;
  const parts = [
    `${counted('accepted')} going`,
    `${counted('declined')} declined`,
    `${counted('tentative') + counted('needsAction')} awaiting`,
  ];
  return `${guests.length} guest${guests.length === 1 ? '' : 's'} - ${parts.join(', ')}`;
}

/**
 * The join link, if the provider attached one. Google nests it under
 * `entryPoints`; Graph puts it on the online-meeting object. Neither shape is
 * guaranteed, so every step is checked rather than asserted.
 */
export function meetingUrl(event: Pick<CalendarEvent, 'conferenceData'>): string | undefined {
  const data = event.conferenceData;
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;

  const entryPoints = record.entryPoints;
  if (Array.isArray(entryPoints)) {
    for (const entry of entryPoints) {
      if (typeof entry !== 'object' || entry === null) continue;
      const uri = (entry as Record<string, unknown>).uri;
      if (typeof uri === 'string' && /^https?:/.test(uri)) return uri;
    }
  }

  for (const key of ['joinUrl', 'joinWebUrl']) {
    const value = record[key];
    if (typeof value === 'string' && /^https?:/.test(value)) return value;
  }
  return undefined;
}

/** Host label for a link, so a long meeting URL does not blow out the modal. */
export function linkLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
