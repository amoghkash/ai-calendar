import type {
  Attendee,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProviderId,
  EventStatus,
  RecurrenceKind,
  Transparency,
} from '../domain/calendar.js';
import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';

/**
 * Event shape returned by a provider after normalisation. It carries external
 * identifiers only; local ids and classification are applied above this layer.
 */
export interface NormalizedEvent {
  readonly provider: CalendarProviderId;
  readonly calendarExternalId: string;
  readonly externalId: string;

  readonly title: string;
  readonly description?: string;
  readonly location?: string;

  readonly start: Instant;
  readonly end: Instant;
  readonly timezone: string;

  readonly isAllDay: boolean;
  readonly isRecurring: boolean;
  readonly recurrenceKind: RecurrenceKind;
  readonly seriesExternalId?: string;
  readonly recurrenceRules?: readonly string[];

  readonly status: EventStatus;
  readonly transparency: Transparency;

  readonly attendees: readonly Attendee[];
  readonly organizer?: Attendee;
  readonly isOrganizer: boolean;

  /** Private key/value data round-tripped through the provider. */
  readonly metadata: Readonly<Record<string, string>>;

  readonly etag?: string;
  readonly conferenceData?: unknown;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface ProviderCalendar {
  readonly externalId: string;
  readonly name: string;
  readonly description?: string;
  readonly timezone: string;
  readonly isPrimary: boolean;
  readonly isWritable: boolean;
  readonly color?: string;
}

export interface ProviderAccount {
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly scopes: readonly string[];
}

export interface EventRef {
  readonly calendarExternalId: string;
  readonly externalId: string;
  /** Concurrency token from the last read; providers reject stale writes. */
  readonly etag?: string;
  /** Whether to email attendees when deleting. Defaults to false. */
  readonly notifyAttendees?: boolean;
}

export interface FetchEventsOptions {
  readonly calendarExternalId: string;
  readonly range: Interval;
  /** Opaque cursor from a previous fetch, when the provider supports it. */
  readonly syncToken?: string;
  /** Expand recurring series into individual instances. Defaults to true. */
  readonly expandRecurrence?: boolean;
}

export interface FetchEventsResult {
  readonly events: readonly NormalizedEvent[];
  readonly deletedExternalIds: readonly string[];
  readonly nextSyncToken?: string;
  /** True when the provider invalidated the cursor and a full resync is needed. */
  readonly resyncRequired?: boolean;
}

export interface CalendarProviderCapabilities {
  readonly incrementalSync: boolean;
  readonly privateMetadata: boolean;
  readonly recurringInstanceUpdates: boolean;
  readonly freeBusy: boolean;
}

/**
 * The single boundary between the application and any calendar service.
 * Adding Apple/CalDAV later means implementing this interface and nothing else.
 */
export interface CalendarProvider {
  readonly id: CalendarProviderId;
  readonly capabilities: CalendarProviderCapabilities;

  /** Verify (and if necessary refresh) credentials. */
  authenticate(): Promise<ProviderAccount>;

  getCalendars(): Promise<readonly ProviderCalendar[]>;

  getEvents(options: FetchEventsOptions): Promise<FetchEventsResult>;

  createEvent(input: CalendarEventInput): Promise<NormalizedEvent>;

  /** Partial update: unspecified fields must be left untouched. */
  updateEvent(ref: EventRef, changes: CalendarEventUpdate): Promise<NormalizedEvent>;

  deleteEvent(ref: EventRef): Promise<void>;
}

/** Factory used by the application to build providers for stored accounts. */
export interface CalendarProviderFactory {
  readonly id: CalendarProviderId;
  create(context: CalendarProviderContext): Promise<CalendarProvider>;
}

export interface CalendarProviderContext {
  readonly accountId: string;
  readonly userId: string;
  /** Reads and persists OAuth credentials for the account. */
  readonly tokens: TokenStore;
}

export interface TokenStore {
  read(accountId: string): Promise<StoredTokens | undefined>;
  write(accountId: string, tokens: StoredTokens): Promise<void>;
}

export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: Instant;
  readonly scope?: string;
  readonly tokenType?: string;
}

export type { CalendarEventInput, CalendarEventUpdate };
