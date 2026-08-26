import type { Instant } from '../time/instant.js';
import type { EventContactLinkId, EventId, UserId } from './ids.js';

/**
 * How a link between an event and a person came to exist.
 *
 *  manual      - a human confirmed it
 *  title_match - proposed from the event title; never applied without confirmation
 *  attendee    - derived from a calendar attendee whose address resolved to a contact
 */
export type ContactLinkSource = 'manual' | 'title_match' | 'attendee';

/**
 * The local record that an event involves a particular person.
 *
 * This exists because the calendar does not know. Plans made over text have no
 * attendees, no invite and no RSVP, so nothing on the provider's copy of the
 * event says a human is on the other end. The link is that missing fact, and it
 * is deliberately local: it is never written back to a calendar provider, so a
 * friend's phone number does not travel to Google in order to schedule lunch.
 */
export interface EventContactLink {
  readonly id: EventContactLinkId;
  readonly userId: UserId;
  readonly eventId: EventId;
  /** Opaque identifier from the contact source. */
  readonly contactId: string;
  readonly displayName: string;
  /** Normalised handle - the thing to message. Never compare on a raw value. */
  readonly handle: string;
  readonly source: ContactLinkSource;
  readonly createdAt: Instant;
}
