import type {
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderCapabilities,
  EventRef,
  FetchEventsOptions,
  FetchEventsResult,
  NormalizedEvent,
  ProviderAccount,
  ProviderCalendar,
} from '@calendar-agent/core';
import { NotFoundError, PROVIDER_MOCK, overlaps } from '@calendar-agent/core';

export interface MockCalendarSeed {
  readonly externalId: string;
  readonly name: string;
  readonly timezone?: string;
  readonly isPrimary?: boolean;
  readonly isWritable?: boolean;
}

export interface MockProviderOptions {
  readonly accountId?: string;
  readonly calendars?: readonly MockCalendarSeed[];
  readonly events?: readonly NormalizedEvent[];
  readonly now?: () => number;
}

/**
 * Fully functional in-memory calendar provider.
 *
 * It backs the demo/offline mode and the integration tests, and doubles as the
 * reference for what a new provider has to implement.
 */
export class MockCalendarProvider implements CalendarProvider {
  readonly id = PROVIDER_MOCK;
  readonly capabilities: CalendarProviderCapabilities = {
    incrementalSync: true,
    privateMetadata: true,
    recurringInstanceUpdates: true,
    freeBusy: true,
  };

  private readonly calendars: MockCalendarSeed[];
  private readonly events = new Map<string, NormalizedEvent>();
  private readonly deleted: string[] = [];
  private readonly now: () => number;
  private sequence = 0;
  private syncCounter = 0;

  constructor(private readonly options: MockProviderOptions = {}) {
    this.calendars = [
      ...(options.calendars ?? [
        { externalId: 'primary', name: 'Primary', isPrimary: true, isWritable: true },
      ]),
    ];
    this.now = options.now ?? (() => Date.now());
    for (const event of options.events ?? []) this.events.set(event.externalId, event);
  }

  async authenticate(): Promise<ProviderAccount> {
    return {
      externalAccountId: this.options.accountId ?? 'mock@example.com',
      displayName: 'Mock Account',
      scopes: ['calendar.readonly', 'calendar.events'],
    };
  }

  async getCalendars(): Promise<readonly ProviderCalendar[]> {
    return this.calendars.map((calendar) => ({
      externalId: calendar.externalId,
      name: calendar.name,
      timezone: calendar.timezone ?? 'UTC',
      isPrimary: calendar.isPrimary ?? false,
      isWritable: calendar.isWritable ?? true,
    }));
  }

  async getEvents(options: FetchEventsOptions): Promise<FetchEventsResult> {
    const events = [...this.events.values()].filter(
      (event) =>
        event.calendarExternalId === options.calendarExternalId &&
        overlaps({ start: event.start, end: event.end }, options.range),
    );
    this.syncCounter += 1;
    const deleted = [...this.deleted];
    this.deleted.length = 0;
    return {
      events,
      deletedExternalIds: deleted,
      nextSyncToken: `mock-sync-${this.syncCounter}`,
    };
  }

  async createEvent(input: CalendarEventInput): Promise<NormalizedEvent> {
    this.sequence += 1;
    const event: NormalizedEvent = {
      provider: this.id,
      calendarExternalId: input.calendarExternalId,
      externalId: `mock-event-${this.sequence}`,
      title: input.title,
      description: input.description,
      location: input.location,
      start: input.start,
      end: input.end,
      timezone: input.timezone,
      isAllDay: input.isAllDay ?? false,
      isRecurring: false,
      recurrenceKind: 'single',
      status: 'confirmed',
      transparency: input.transparency ?? 'opaque',
      attendees: input.attendees ?? [],
      isOrganizer: true,
      metadata: input.metadata ?? {},
      etag: `etag-${this.sequence}-1`,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.events.set(event.externalId, event);
    return event;
  }

  async updateEvent(ref: EventRef, changes: CalendarEventUpdate): Promise<NormalizedEvent> {
    const existing = this.events.get(ref.externalId);
    if (!existing) throw new NotFoundError('event', ref.externalId);
    const version = Number(existing.etag?.split('-').pop() ?? 1) + 1;
    // Only the supplied fields change: everything else is preserved verbatim.
    const updated: NormalizedEvent = {
      ...existing,
      start: changes.start ?? existing.start,
      end: changes.end ?? existing.end,
      timezone: changes.timezone ?? existing.timezone,
      title: changes.title ?? existing.title,
      description: changes.description ?? existing.description,
      location: changes.location ?? existing.location,
      transparency: changes.transparency ?? existing.transparency,
      attendees: changes.attendees ?? existing.attendees,
      metadata: { ...existing.metadata, ...changes.metadata },
      etag: `etag-${this.sequence}-${version}`,
      updatedAt: this.now(),
    };
    this.events.set(ref.externalId, updated);
    return updated;
  }

  async deleteEvent(ref: EventRef): Promise<void> {
    if (!this.events.delete(ref.externalId)) throw new NotFoundError('event', ref.externalId);
    this.deleted.push(ref.externalId);
  }

  // --- test helpers ---------------------------------------------------------

  /** Simulate the user creating a calendar. */
  addCalendar(seed: MockCalendarSeed): void {
    this.calendars.push(seed);
  }

  /** Simulate the user deleting a calendar in their calendar app. */
  removeCalendar(externalId: string): void {
    const index = this.calendars.findIndex((calendar) => calendar.externalId === externalId);
    if (index >= 0) this.calendars.splice(index, 1);
    for (const [key, event] of this.events) {
      if (event.calendarExternalId === externalId) this.events.delete(key);
    }
  }

  /** Simulate an externally created/changed event. */
  seed(event: NormalizedEvent): void {
    this.events.set(event.externalId, event);
  }

  /** Simulate the user dragging an event in their calendar UI. */
  moveExternally(externalId: string, start: number, end: number): NormalizedEvent {
    const existing = this.events.get(externalId);
    if (!existing) throw new NotFoundError('event', externalId);
    const moved: NormalizedEvent = {
      ...existing,
      start,
      end,
      etag: `${existing.etag ?? 'etag'}-moved`,
      updatedAt: this.now(),
    };
    this.events.set(externalId, moved);
    return moved;
  }

  list(): NormalizedEvent[] {
    return [...this.events.values()].sort((a, b) => a.start - b.start);
  }
}

/** Build a normalized event without repeating every field in tests/demos. */
export function mockEvent(
  partial: Partial<NormalizedEvent> &
    Pick<NormalizedEvent, 'externalId' | 'title' | 'start' | 'end'>,
): NormalizedEvent {
  return {
    provider: PROVIDER_MOCK,
    calendarExternalId: 'primary',
    timezone: 'UTC',
    isAllDay: false,
    isRecurring: false,
    recurrenceKind: 'single',
    status: 'confirmed',
    transparency: 'opaque',
    attendees: [],
    isOrganizer: true,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}
