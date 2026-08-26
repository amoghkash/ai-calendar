import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import type { BlockId, CalendarAccountId, CalendarId, EventId, TaskId, UserId } from './ids.js';

/** Identifier of a calendar integration. New providers only add a string here. */
export type CalendarProviderId = string;

export const PROVIDER_GOOGLE = 'google';
export const PROVIDER_MICROSOFT = 'microsoft';
export const PROVIDER_MOCK = 'mock';

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

/** Whether the event consumes time. `transparent` events do not block work. */
export type Transparency = 'opaque' | 'transparent';

/**
 * How the scheduler is allowed to treat an event.
 *
 *  MOVABLE   - the agent may reschedule it (typically its own task blocks)
 *  PROTECTED - real-world commitment; never moved, and it blocks time hard
 *  FIXED     - involves other people; never moved automatically
 *  UNKNOWN   - unclassified; treated conservatively (blocks time, never moved)
 */
export type EventClassification = 'MOVABLE' | 'PROTECTED' | 'FIXED' | 'UNKNOWN';

export const EVENT_CLASSIFICATIONS: readonly EventClassification[] = [
  'MOVABLE',
  'PROTECTED',
  'FIXED',
  'UNKNOWN',
];

export type AttendeeResponse = 'accepted' | 'declined' | 'tentative' | 'needsAction';

export interface Attendee {
  readonly email: string;
  readonly name?: string;
  readonly optional?: boolean;
  readonly response?: AttendeeResponse;
  readonly self?: boolean;
  readonly organizer?: boolean;
}

export interface Calendar {
  readonly id: CalendarId;
  readonly userId: UserId;
  readonly accountId: CalendarAccountId;
  readonly provider: CalendarProviderId;
  readonly externalId: string;
  readonly name: string;
  readonly description?: string;
  readonly timezone: string;
  readonly isPrimary: boolean;
  readonly isWritable: boolean;
  /** Whether events from this calendar are considered when finding free time. */
  readonly includeInAvailability: boolean;
  /** Whether the agent may write scheduled task blocks here. */
  readonly isTaskTarget: boolean;
  readonly color?: string;
  readonly selected: boolean;
}

export type CalendarAccountStatus = 'connected' | 'needs_reauth' | 'disconnected';

export interface CalendarAccount {
  readonly id: CalendarAccountId;
  readonly userId: UserId;
  readonly provider: CalendarProviderId;
  /** Account identity as reported by the provider (usually an email address). */
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly status: CalendarAccountStatus;
  readonly scopes: readonly string[];
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/** OAuth credentials. Stored by the database layer, never logged. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: Instant;
  readonly tokenType?: string;
  readonly scope?: string;
}

export type RecurrenceKind = 'single' | 'series_master' | 'instance';

/**
 * Provider-neutral calendar event. Google/Microsoft specific shapes are
 * normalised into this model by the integration packages; nothing below the
 * provider boundary ever sees a provider payload.
 */
export interface CalendarEvent {
  readonly id: EventId;
  readonly userId: UserId;
  readonly provider: CalendarProviderId;
  readonly calendarId: CalendarId;
  readonly externalId: string;

  readonly title: string;
  readonly description?: string;
  readonly location?: string;

  readonly start: Instant;
  readonly end: Instant;
  /** Timezone the event was authored in; kept for round-tripping and display. */
  readonly timezone: string;

  readonly isAllDay: boolean;
  readonly isRecurring: boolean;
  readonly recurrenceKind: RecurrenceKind;
  /** External id of the series this instance belongs to, when applicable. */
  readonly seriesExternalId?: string;
  readonly recurrenceRules?: readonly string[];

  readonly status: EventStatus;
  readonly transparency: Transparency;

  readonly attendees: readonly Attendee[];
  readonly organizer?: Attendee;
  readonly isOrganizer: boolean;

  readonly classification: EventClassification;
  readonly isMovable: boolean;
  readonly isProtected: boolean;

  /** Explicit category assignment; otherwise resolved from the rules. */
  readonly categoryId?: string;

  /** Set when this event is a task block created by the agent. */
  readonly taskId?: TaskId;
  readonly blockId?: BlockId;

  /** Provider concurrency token (Google etag / Graph changeKey). */
  readonly etag?: string;
  readonly conferenceData?: unknown;

  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/** Fields accepted when creating an event through a provider. */
export interface CalendarEventInput {
  readonly calendarExternalId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: Instant;
  readonly end: Instant;
  readonly timezone: string;
  readonly isAllDay?: boolean;
  readonly transparency?: Transparency;
  readonly attendees?: readonly Attendee[];
  /** Private key/value metadata used to recognise our own blocks on sync. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Whether to email attendees about this change. Defaults to false. */
  readonly notifyAttendees?: boolean;
}

/**
 * Partial update. Only the provided fields are sent to the provider so that
 * title, description, attendees, recurrence and conferencing survive a move.
 */
export interface CalendarEventUpdate {
  readonly start?: Instant;
  readonly end?: Instant;
  readonly timezone?: string;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly transparency?: Transparency;
  /**
   * The complete guest list, not a delta: providers replace the attendee list
   * wholesale, so a caller that omits someone is removing them. Undefined
   * leaves the remote list untouched.
   */
  readonly attendees?: readonly Attendee[];
  readonly metadata?: Readonly<Record<string, string>>;
  /** Concurrency token from the last read; providers reject stale writes. */
  readonly etag?: string;
  /**
   * Whether to email attendees about this change. Defaults to false, because
   * the scheduler moves its own blocks constantly; user-initiated edits to
   * events with other attendees should opt in.
   */
  readonly notifyAttendees?: boolean;
}

export const eventInterval = (event: CalendarEvent): Interval => ({
  start: event.start,
  end: event.end,
});

/** Whether an event should remove time from the availability calculation. */
export function blocksTime(
  event: CalendarEvent,
  options: { readonly allDayBlocksTime: boolean } = { allDayBlocksTime: false },
): boolean {
  if (event.status === 'cancelled') return false;
  if (event.transparency === 'transparent') return false;
  if (event.isAllDay && !options.allDayBlocksTime) return false;
  const self = event.attendees.find((a) => a.self);
  if (self?.response === 'declined') return false;
  return true;
}

export const METADATA_TASK_ID = 'calendarAgentTaskId';
export const METADATA_BLOCK_ID = 'calendarAgentBlockId';
export const METADATA_MANAGED = 'calendarAgentManaged';
