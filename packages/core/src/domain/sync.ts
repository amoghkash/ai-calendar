import type { Instant } from '../time/instant.js';
import type { CalendarId, EventId, UserId } from './ids.js';
import type { CalendarProviderId } from './calendar.js';

export type SyncDirection = 'inbound' | 'outbound';

/**
 * Per-calendar synchronisation cursor. Providers that support incremental sync
 * store their token here; the rest fall back to a time-window refresh.
 */
export interface SyncState {
  readonly id: string;
  readonly userId: UserId;
  readonly provider: CalendarProviderId;
  readonly calendarId: CalendarId;
  readonly syncToken?: string;
  readonly deltaLink?: string;
  readonly lastSyncedAt?: Instant;
  readonly lastSuccessAt?: Instant;
  readonly lastError?: string;
  readonly failureCount: number;
  readonly windowStart?: Instant;
  readonly windowEnd?: Instant;
}

/**
 * What we last wrote to (or read from) the provider for a single event.
 * Comparing these fields against a freshly fetched event tells us whether a
 * change came from us or from the user, which is how update loops are avoided.
 */
export interface EventSyncRecord {
  readonly userId: UserId;
  readonly provider: CalendarProviderId;
  readonly calendarId: CalendarId;
  readonly externalId: string;
  readonly localEventId?: EventId;
  readonly lastKnownStart: Instant;
  readonly lastKnownEnd: Instant;
  readonly lastKnownEtag?: string;
  /** Instant of the last write this application performed. */
  readonly lastLocalWriteAt?: Instant;
  /** Etag observed right after our own write; used to ignore our echo. */
  readonly lastWrittenEtag?: string;
  readonly lastSeenAt: Instant;
}

export type ExternalChangeKind = 'created' | 'moved' | 'updated' | 'deleted' | 'unchanged';

export interface ExternalChange {
  readonly kind: ExternalChangeKind;
  readonly externalId: string;
  readonly calendarId: CalendarId;
  readonly provider: CalendarProviderId;
  /** True when the change was caused by this application's own write. */
  readonly selfInflicted: boolean;
  readonly previous?: { readonly start: Instant; readonly end: Instant };
  readonly current?: { readonly start: Instant; readonly end: Instant };
}
