import type {
  Calendar,
  CalendarAccount,
  CalendarEvent,
  CalendarAccountId,
  CalendarId,
  CalendarTarget,
  Clock,
  Database,
  EventId,
  IdGenerator,
  Instant,
  Interval,
  Logger,
  NormalizedEvent,
  SchedulingPreferences,
  StoredTokens,
  UserId,
} from '@calendar-agent/core';
import {
  METADATA_BLOCK_ID,
  METADATA_TASK_ID,
  NotFoundError,
  PermissionDeniedError,
  UnsupportedError,
  ValidationError,
  classifyEvent,
} from '@calendar-agent/core';
import type { ProviderRegistry } from '../provider-registry.js';
import type { PreferencesService } from './preferences-service.js';

export interface ConnectAccountInput {
  readonly userId: UserId;
  readonly provider: string;
  readonly tokens: StoredTokens;
  /** Identity reported by the provider; looked up when omitted. */
  readonly externalAccountId?: string;
  readonly displayName?: string;
}

export interface RemovedCalendar {
  readonly id: string;
  readonly name: string;
  readonly events: number;
  readonly blocksDetached: number;
}

export interface CalendarReconciliation {
  readonly calendars: Calendar[];
  readonly added: Calendar[];
  readonly removed: RemovedCalendar[];
}

export interface CalendarOptionsUpdate {
  readonly selected?: boolean;
  readonly isTaskTarget?: boolean;
  readonly includeInAvailability?: boolean;
}

/**
 * Owns calendar accounts, calendar selection and the normalised event store.
 * Everything provider-specific stops at the CalendarProvider interface.
 */
/** Just the part of the link service that classification needs. */
export interface EventContactLinkLookup {
  handlesForEvent(eventId: string | undefined): Promise<readonly string[]>;
}

export class CalendarService {
  constructor(
    private readonly db: Database,
    private readonly registry: ProviderRegistry,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly preferences: PreferencesService,
    private readonly logger?: Logger,
    private readonly contactLinks?: EventContactLinkLookup,
  ) {}

  listAccounts(userId: UserId): Promise<CalendarAccount[]> {
    return this.db.accounts.list(userId);
  }

  listCalendars(userId: UserId): Promise<Calendar[]> {
    return this.db.calendars.list(userId);
  }

  listEvents(userId: UserId, range: Interval): Promise<CalendarEvent[]> {
    return this.db.events.list({ userId, range });
  }

  /** Persist a freshly authorised account and import its calendars. */
  async connectAccount(input: ConnectAccountInput): Promise<{
    account: CalendarAccount;
    calendars: Calendar[];
  }> {
    const now = this.clock.now();
    const accountId = this.ids.next('acct');

    let externalAccountId = input.externalAccountId;
    let displayName = input.displayName;
    const draft: CalendarAccount = {
      id: accountId,
      userId: input.userId,
      provider: input.provider,
      externalAccountId: externalAccountId ?? accountId,
      displayName: displayName ?? input.provider,
      status: 'connected',
      scopes: [],
      createdAt: now,
      updatedAt: now,
    };

    // The account row must exist before its credentials: the tokens table has a
    // foreign key onto it. Writing tokens first works on the in-memory backends
    // and fails on PostgreSQL, so the order here is load-bearing.
    await this.db.accounts.save(draft);
    await this.db.accounts.writeTokens(accountId, input.tokens);

    try {
      const provider = await this.registry.create(draft);
      const identity = await provider.authenticate();
      externalAccountId = externalAccountId ?? identity.externalAccountId;
      displayName = displayName ?? identity.displayName;

      const account: CalendarAccount = {
        ...draft,
        externalAccountId,
        displayName,
        scopes: identity.scopes,
        updatedAt: this.clock.now(),
      };
      await this.db.accounts.save(account);

      const { calendars } = await this.importCalendars(account);
      return { account, calendars };
    } catch (error) {
      // Do not leave a half-connected account behind; the user should be able
      // to simply retry the authorisation.
      await this.db.accounts.delete(accountId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Fetch the account's calendar list and reconcile it with what we store:
   * new calendars are added, and calendars that no longer exist remotely are
   * removed along with their events.
   *
   * Removal matters for correctness, not tidiness: a deleted calendar's events
   * stayed in the mirror and kept blocking time in the scheduler forever.
   */
  async importCalendars(account: CalendarAccount): Promise<CalendarReconciliation> {
    const provider = await this.registry.create(account);
    const remote = await provider.getCalendars();

    const stored: Calendar[] = [];
    const added: Calendar[] = [];
    let hasTaskTarget = (await this.db.calendars.list(account.userId)).some(
      (calendar) => calendar.isTaskTarget,
    );

    for (const entry of remote) {
      const existing = await this.db.calendars.findByExternalId(
        account.userId,
        account.id,
        entry.externalId,
      );
      const isTaskTarget =
        existing?.isTaskTarget ?? (!hasTaskTarget && entry.isPrimary && entry.isWritable);
      if (isTaskTarget) hasTaskTarget = true;
      const calendar: Calendar = {
        id: existing?.id ?? this.ids.next('cal'),
        userId: account.userId,
        accountId: account.id,
        provider: account.provider,
        externalId: entry.externalId,
        name: entry.name,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        timezone: entry.timezone,
        isPrimary: entry.isPrimary,
        isWritable: entry.isWritable,
        includeInAvailability: existing?.includeInAvailability ?? true,
        isTaskTarget,
        ...(entry.color === undefined ? {} : { color: entry.color }),
        selected: existing?.selected ?? true,
      };
      const saved = await this.db.calendars.save(calendar);
      stored.push(saved);
      if (!existing) added.push(saved);
    }

    const removed = await this.removeVanished(
      account,
      remote.map((entry) => entry.externalId),
    );
    return { calendars: stored, added, removed };
  }

  /**
   * Delete local calendars whose remote counterpart is gone.
   *
   * Guarded against a bad response: an empty remote list is treated as
   * suspicious and never used as grounds for wiping every calendar.
   */
  private async removeVanished(
    account: CalendarAccount,
    remoteExternalIds: readonly string[],
  ): Promise<RemovedCalendar[]> {
    if (remoteExternalIds.length === 0) {
      this.logger?.warn('calendars.empty_remote_list', {
        accountId: account.id,
        detail: 'Refusing to remove local calendars from an empty provider response.',
      });
      return [];
    }

    const known = new Set(remoteExternalIds);
    const locals = (await this.db.calendars.list(account.userId)).filter(
      (calendar) => calendar.accountId === account.id && !known.has(calendar.externalId),
    );

    const removed: RemovedCalendar[] = [];
    for (const calendar of locals) {
      const cleanup = await this.deleteCalendar(account.userId, calendar.id);
      removed.push({ id: calendar.id, name: calendar.name, ...cleanup });
      this.logger?.info('calendars.removed_remotely', {
        calendarId: calendar.id,
        name: calendar.name,
        events: cleanup.events,
      });
    }
    return removed;
  }

  async updateCalendarOptions(
    calendarId: string,
    changes: CalendarOptionsUpdate,
  ): Promise<Calendar> {
    const calendar = await this.db.calendars.get(calendarId);
    if (!calendar) throw new NotFoundError('calendar', calendarId);
    if (changes.isTaskTarget) {
      // Only one calendar receives task blocks.
      for (const other of await this.db.calendars.list(calendar.userId)) {
        if (other.id !== calendarId && other.isTaskTarget) {
          await this.db.calendars.save({ ...other, isTaskTarget: false });
        }
      }
    }
    return this.db.calendars.save({ ...calendar, ...changes });
  }

  /**
   * Remove a calendar and everything that only existed because of it.
   *
   * Leaving the events behind was the main source of stale data: they kept
   * blocking time in the scheduler long after the calendar was gone.
   */
  async deleteCalendar(
    userId: UserId,
    calendarId: CalendarId,
  ): Promise<{ readonly events: number; readonly blocksDetached: number }> {
    const calendar = await this.db.calendars.get(calendarId);
    if (!calendar) throw new NotFoundError('calendar', calendarId);

    const events = (
      await this.db.events.list({ userId, range: { start: 0, end: Number.MAX_SAFE_INTEGER } })
    ).filter((event) => event.calendarId === calendarId);
    for (const event of events) {
      await this.db.events.delete(event.id);
      await this.db.syncState.deleteEventRecord(userId, calendarId, event.externalId);
    }

    // Blocks keep their scheduled time but lose the link to a calendar that no
    // longer exists, so the next apply re-creates them somewhere valid.
    const blocks = (await this.db.blocks.list({ userId })).filter(
      (block) => block.calendarId === calendarId,
    );
    for (const block of blocks) {
      await this.db.blocks.save({
        ...block,
        calendarId: undefined,
        provider: undefined,
        externalEventId: undefined,
        status: 'confirmed',
        updatedAt: this.clock.now(),
      });
    }

    // The calendar's own sync cursor dies with it, or it lingers as an orphan.
    await this.db.syncState.delete(userId, calendarId);
    await this.db.calendars.delete(calendarId);
    return { events: events.length, blocksDetached: blocks.length };
  }

  /** Disconnect an account and clean up everything it brought with it. */
  async disconnectAccount(accountId: CalendarAccountId): Promise<{
    readonly calendars: number;
    readonly events: number;
    readonly blocksDetached: number;
  }> {
    const account = await this.db.accounts.get(accountId);
    if (!account) throw new NotFoundError('calendar account', accountId);

    const calendars = (await this.db.calendars.list(account.userId)).filter(
      (calendar) => calendar.accountId === accountId,
    );

    let events = 0;
    let blocksDetached = 0;
    for (const calendar of calendars) {
      const removed = await this.deleteCalendar(account.userId, calendar.id);
      events += removed.events;
      blocksDetached += removed.blocksDetached;
    }

    await this.db.accounts.delete(accountId);
    return { calendars: calendars.length, events, blocksDetached };
  }

  /** Where new task blocks should be written, if anywhere. */
  async taskTarget(userId: UserId): Promise<CalendarTarget | undefined> {
    const calendars = await this.db.calendars.list(userId);
    const target =
      calendars.find((calendar) => calendar.isTaskTarget && calendar.isWritable) ??
      calendars.find((calendar) => calendar.isPrimary && calendar.isWritable) ??
      calendars.find((calendar) => calendar.isWritable);
    if (!target) return undefined;
    return {
      calendarId: target.id,
      calendarExternalId: target.externalId,
      timezone: target.timezone,
    };
  }

  /**
   * Local links this event has to people, for classification.
   *
   * Provider events carry no trace of a plan agreed over text, so without this
   * a re-sync would recompute the classification from attendees alone and quietly
   * downgrade a linked lunch back to `UNKNOWN`.
   */
  async linkedHandles(eventId: string | undefined): Promise<readonly string[]> {
    if (eventId === undefined || this.contactLinks === undefined) return [];
    return this.contactLinks.handlesForEvent(eventId);
  }

  /** Turn a provider event into the internal model, applying classification. */
  toCalendarEvent(
    normalized: NormalizedEvent,
    calendar: Calendar,
    preferences: SchedulingPreferences,
    existing?: CalendarEvent,
    linkedPeople: readonly string[] = [],
  ): CalendarEvent {
    const classification = classifyEvent(
      {
        title: normalized.title,
        calendarId: calendar.id,
        attendees: normalized.attendees,
        isOrganizer: normalized.isOrganizer,
        isAllDay: normalized.isAllDay,
        metadata: normalized.metadata,
        linkedPeople,
      },
      preferences.classificationRules,
    );

    return {
      id: existing?.id ?? this.ids.next('evt'),
      userId: calendar.userId,
      provider: normalized.provider,
      calendarId: calendar.id,
      externalId: normalized.externalId,
      title: normalized.title,
      ...(normalized.description === undefined ? {} : { description: normalized.description }),
      ...(normalized.location === undefined ? {} : { location: normalized.location }),
      start: normalized.start,
      end: normalized.end,
      timezone: normalized.timezone,
      isAllDay: normalized.isAllDay,
      isRecurring: normalized.isRecurring,
      recurrenceKind: normalized.recurrenceKind,
      ...(normalized.seriesExternalId === undefined
        ? {}
        : { seriesExternalId: normalized.seriesExternalId }),
      ...(normalized.recurrenceRules === undefined
        ? {}
        : { recurrenceRules: normalized.recurrenceRules }),
      status: normalized.status,
      transparency: normalized.transparency,
      attendees: normalized.attendees,
      ...(normalized.organizer === undefined ? {} : { organizer: normalized.organizer }),
      isOrganizer: normalized.isOrganizer,
      classification: classification.classification,
      isMovable: classification.isMovable,
      isProtected: classification.isProtected,
      ...(normalized.metadata[METADATA_TASK_ID] === undefined
        ? {}
        : { taskId: normalized.metadata[METADATA_TASK_ID] }),
      ...(normalized.metadata[METADATA_BLOCK_ID] === undefined
        ? {}
        : { blockId: normalized.metadata[METADATA_BLOCK_ID] }),
      ...(normalized.etag === undefined ? {} : { etag: normalized.etag }),
      ...(normalized.conferenceData === undefined
        ? {}
        : { conferenceData: normalized.conferenceData }),
      createdAt: existing?.createdAt ?? normalized.createdAt ?? this.clock.now(),
      updatedAt: normalized.updatedAt || this.clock.now(),
    };
  }

  providerFor(account: CalendarAccount) {
    return this.registry.create(account);
  }

  // ---- direct calendar editing --------------------------------------------

  /** Resolve everything needed to talk to the provider behind a calendar. */
  async resolveProvider(calendarId: CalendarId): Promise<{
    calendar: Calendar;
    account: CalendarAccount;
    provider: Awaited<ReturnType<ProviderRegistry['create']>>;
  }> {
    const calendar = await this.db.calendars.get(calendarId);
    if (!calendar) throw new NotFoundError('calendar', calendarId);
    const account = await this.db.accounts.get(calendar.accountId);
    if (!account) throw new NotFoundError('calendar account', calendar.accountId);
    return { calendar, account, provider: await this.registry.create(account) };
  }

  /** Refuse every write while the system is in read-only mode. */
  private async assertWritable(userId: UserId, calendar: Calendar): Promise<void> {
    const preferences = await this.preferences.get(userId);
    if (preferences.automation.mode === 'read_only') {
      throw new PermissionDeniedError(
        'The system is in read-only mode. Change automation.mode to edit your calendar.',
      );
    }
    if (!calendar.isWritable) {
      throw new PermissionDeniedError(
        `"${calendar.name}" is read-only for this account, so it cannot be edited here.`,
      );
    }
  }

  /** Record what we just wrote so the next sync recognises its own echo. */
  async recordWrite(
    userId: UserId,
    calendarId: CalendarId,
    event: Pick<NormalizedEvent, 'start' | 'end' | 'etag' | 'provider' | 'externalId'>,
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.syncState.saveEventRecord({
      userId,
      provider: event.provider,
      calendarId,
      externalId: event.externalId,
      lastKnownStart: event.start,
      lastKnownEnd: event.end,
      ...(event.etag === undefined
        ? {}
        : { lastKnownEtag: event.etag, lastWrittenEtag: event.etag }),
      lastLocalWriteAt: now,
      lastSeenAt: now,
    });
  }

  /** Create a plain calendar event (not a task block). */
  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    if (input.end <= input.start) {
      throw new ValidationError('An event must end after it starts.');
    }
    const { calendar, provider } = await this.resolveProvider(input.calendarId);
    await this.assertWritable(input.userId, calendar);
    const preferences = await this.preferences.get(input.userId);

    const created = await provider.createEvent({
      calendarExternalId: calendar.externalId,
      title: input.title,
      start: input.start,
      end: input.end,
      timezone: input.timezone ?? calendar.timezone,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.isAllDay === undefined ? {} : { isAllDay: input.isAllDay }),
      ...(input.transparency === undefined ? {} : { transparency: input.transparency }),
      ...(input.attendees === undefined ? {} : { attendees: input.attendees }),
      ...(input.notifyAttendees === undefined ? {} : { notifyAttendees: input.notifyAttendees }),
    });

    const event = this.toCalendarEvent(created, calendar, preferences);
    await this.db.events.save(event);
    await this.recordWrite(input.userId, calendar.id, created);
    return event;
  }

  /**
   * Edit an existing calendar event.
   *
   * Only the supplied fields are sent, so everything else survives. Recurring
   * series masters are refused: the system deliberately edits single instances
   * only, so one drag can never rewrite a whole series.
   */
  /**
   * Resolve an agent's `eventRef` to one event: an id, or a title fragment
   * matched against a window around now. Ambiguity is an error rather than a
   * guess - picking the wrong meeting to move is expensive.
   */
  async resolveEvent(userId: UserId, reference: string, range: Interval): Promise<CalendarEvent> {
    const trimmed = reference.trim();
    const byId = await this.db.events.get(trimmed);
    if (byId && byId.userId === userId) return byId;

    const events = await this.db.events.list({ userId, range });
    const lower = trimmed.toLowerCase();

    const exact = events.filter((event) => event.title.toLowerCase() === lower);
    const candidates =
      exact.length > 0
        ? exact
        : events.filter((event) => event.title.toLowerCase().includes(lower));

    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) {
      throw new NotFoundError('event', reference);
    }
    throw new ValidationError(
      `"${reference}" matches ${candidates.length} events. Say which one, or give its id.`,
      {
        details: {
          candidates: candidates
            .slice(0, 5)
            .map((event) => ({ id: event.id, title: event.title, start: event.start })),
        },
      },
    );
  }

  async updateEvent(
    userId: UserId,
    eventId: EventId,
    changes: UpdateEventInput,
  ): Promise<CalendarEvent> {
    const existing = await this.db.events.get(eventId);
    if (!existing) throw new NotFoundError('event', eventId);
    if (existing.userId !== userId) throw new NotFoundError('event', eventId);
    if (changes.start !== undefined && changes.end !== undefined && changes.end <= changes.start) {
      throw new ValidationError('An event must end after it starts.');
    }
    if (existing.recurrenceKind === 'series_master') {
      throw new UnsupportedError(
        `"${existing.title}" is a recurring series. Edit a single occurrence instead - this app never rewrites a whole series.`,
        { details: { eventId, seriesExternalId: existing.seriesExternalId } },
      );
    }

    const { calendar, provider } = await this.resolveProvider(existing.calendarId);
    await this.assertWritable(userId, calendar);
    const preferences = await this.preferences.get(userId);

    const updated = await provider.updateEvent(
      {
        calendarExternalId: calendar.externalId,
        externalId: existing.externalId,
        ...(existing.etag === undefined ? {} : { etag: existing.etag }),
      },
      {
        ...(changes.start === undefined ? {} : { start: changes.start }),
        ...(changes.end === undefined ? {} : { end: changes.end }),
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.location === undefined ? {} : { location: changes.location }),
        ...(changes.transparency === undefined ? {} : { transparency: changes.transparency }),
        ...(changes.attendees === undefined ? {} : { attendees: changes.attendees }),
        timezone: changes.timezone ?? existing.timezone,
        ...(changes.notifyAttendees === undefined
          ? {}
          : { notifyAttendees: changes.notifyAttendees }),
      },
    );

    const event = this.toCalendarEvent(
      updated,
      calendar,
      preferences,
      existing,
      await this.linkedHandles(existing.id),
    );
    await this.db.events.save(event);
    await this.recordWrite(userId, calendar.id, updated);
    return event;
  }

  /**
   * Everything that can refuse a deletion, checked without doing one.
   *
   * Shared with the deferred path so a refusal is reported when the user asks,
   * not ten seconds later when nobody is watching.
   */
  async assertDeletable(userId: UserId, eventId: EventId): Promise<CalendarEvent> {
    const existing = await this.db.events.get(eventId);
    if (!existing) throw new NotFoundError('event', eventId);
    if (existing.userId !== userId) throw new NotFoundError('event', eventId);
    if (existing.recurrenceKind === 'series_master') {
      throw new UnsupportedError(
        `"${existing.title}" is a recurring series. Delete a single occurrence instead.`,
      );
    }
    const { calendar } = await this.resolveProvider(existing.calendarId);
    await this.assertWritable(userId, calendar);
    return existing;
  }

  async deleteEvent(
    userId: UserId,
    eventId: EventId,
    options: { readonly notifyAttendees?: boolean } = {},
  ): Promise<void> {
    const existing = await this.assertDeletable(userId, eventId);
    const { calendar, provider } = await this.resolveProvider(existing.calendarId);

    await provider.deleteEvent({
      calendarExternalId: calendar.externalId,
      externalId: existing.externalId,
      ...(existing.etag === undefined ? {} : { etag: existing.etag }),
      ...(options.notifyAttendees === undefined
        ? {}
        : { notifyAttendees: options.notifyAttendees }),
    });
    await this.db.events.delete(existing.id);
    await this.db.syncState.deleteEventRecord(userId, calendar.id, existing.externalId);
  }
}

export interface CreateEventInput {
  readonly userId: UserId;
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly start: Instant;
  readonly end: Instant;
  readonly timezone?: string;
  readonly description?: string;
  readonly location?: string;
  readonly isAllDay?: boolean;
  readonly transparency?: CalendarEvent['transparency'];
  readonly attendees?: CalendarEvent['attendees'];
  readonly notifyAttendees?: boolean;
}

export interface UpdateEventInput {
  readonly start?: Instant;
  readonly end?: Instant;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly timezone?: string;
  readonly transparency?: CalendarEvent['transparency'];
  /** The complete guest list. Omitted leaves the remote list alone. */
  readonly attendees?: CalendarEvent['attendees'];
  readonly notifyAttendees?: boolean;
}
