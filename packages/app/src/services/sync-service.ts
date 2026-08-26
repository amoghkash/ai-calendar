import type {
  Calendar,
  CalendarEvent,
  Clock,
  Database,
  ExternalChange,
  IdGenerator,
  Instant,
  Interval,
  Logger,
  NormalizedEvent,
  UserId,
} from '@calendar-agent/core';
import { DomainError, days, isLiveBlock } from '@calendar-agent/core';
import type { CalendarService } from './calendar-service.js';
import type { PreferencesService } from './preferences-service.js';

export interface CalendarSyncReport {
  readonly calendarId: string;
  readonly name: string;
  readonly fetched: number;
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly incremental: boolean;
}

export interface SyncReport {
  readonly startedAt: Instant;
  /** Calendars newly discovered on the provider. */
  readonly calendarsAdded: readonly string[];
  /** Calendars deleted on the provider and therefore removed locally. */
  readonly calendarsRemoved: readonly string[];
  readonly finishedAt: Instant;
  readonly calendars: readonly CalendarSyncReport[];
  readonly externalChanges: readonly ExternalChange[];
  readonly errors: readonly { readonly calendarId: string; readonly message: string }[];
  /** True when something changed that the scheduler should react to. */
  readonly needsReplan: boolean;
}

export interface SyncOptions {
  readonly userId: UserId;
  readonly range?: Interval;
  /** Ignore stored sync cursors and refetch the whole window. */
  readonly full?: boolean;
}

/**
 * Pulls calendars into the local store and detects changes the user made
 * outside the application.
 *
 * Loop avoidance: every write records the etag it produced, so an echo of our
 * own change is recognised and ignored rather than treated as user intent.
 */
export class SyncService {
  constructor(
    private readonly db: Database,
    private readonly calendars: CalendarService,
    private readonly preferences: PreferencesService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
  ) {}

  async sync(options: SyncOptions): Promise<SyncReport> {
    const startedAt = this.clock.now();
    const preferences = await this.preferences.get(options.userId);
    const range = options.range ?? {
      start: startedAt - days(2),
      end: startedAt + days(preferences.planningHorizonDays + 7),
    };

    const reports: CalendarSyncReport[] = [];
    const externalChanges: ExternalChange[] = [];
    const errors: { calendarId: string; message: string }[] = [];
    const calendarsAdded: string[] = [];
    const calendarsRemoved: string[] = [];

    for (const account of await this.db.accounts.list(options.userId)) {
      let provider;
      try {
        provider = await this.calendars.providerFor(account);
      } catch (error) {
        errors.push({ calendarId: account.id, message: describeError(error) });
        continue;
      }

      // Refresh the calendar list first. Without this, a calendar deleted on
      // the provider stayed in the mirror forever: every sync failed for it and
      // its events kept blocking time in the scheduler.
      try {
        const reconciliation = await this.calendars.importCalendars(account);
        calendarsAdded.push(...reconciliation.added.map((calendar) => calendar.name));
        calendarsRemoved.push(...reconciliation.removed.map((calendar) => calendar.name));
      } catch (error) {
        errors.push({ calendarId: account.id, message: describeError(error) });
      }

      const calendars = (await this.db.calendars.list(options.userId)).filter(
        (calendar) => calendar.accountId === account.id && calendar.selected,
      );

      for (const calendar of calendars) {
        try {
          const state = await this.db.syncState.get(options.userId, calendar.id);
          const useToken = !options.full && state?.syncToken !== undefined;
          let result = await provider.getEvents({
            calendarExternalId: calendar.externalId,
            range,
            ...(useToken ? { syncToken: state!.syncToken! } : {}),
          });
          let incremental = useToken;
          if (result.resyncRequired) {
            this.logger.warn('sync.resync_required', { calendarId: calendar.id });
            result = await provider.getEvents({
              calendarExternalId: calendar.externalId,
              range,
            });
            incremental = false;
          }

          let created = 0;
          let updated = 0;
          for (const normalized of result.events) {
            const outcome = await this.upsertEvent(
              options.userId,
              calendar,
              normalized,
              preferences,
            );
            if (outcome.change) externalChanges.push(outcome.change);
            if (outcome.created) created += 1;
            else updated += 1;
          }

          const deleted = await this.removeDeleted(
            options.userId,
            calendar,
            result.deletedExternalIds,
            externalChanges,
          );

          await this.db.syncState.save({
            id: state?.id ?? this.ids.next('sync'),
            userId: options.userId,
            provider: account.provider,
            calendarId: calendar.id,
            ...(result.nextSyncToken === undefined ? {} : { syncToken: result.nextSyncToken }),
            lastSyncedAt: this.clock.now(),
            lastSuccessAt: this.clock.now(),
            failureCount: 0,
            windowStart: range.start,
            windowEnd: range.end,
          });

          reports.push({
            calendarId: calendar.id,
            name: calendar.name,
            fetched: result.events.length,
            created,
            updated,
            deleted,
            incremental,
          });
        } catch (error) {
          const message = describeError(error);
          this.logger.error('sync.calendar_failed', { calendarId: calendar.id, message });
          errors.push({ calendarId: calendar.id, message });
          const state = await this.db.syncState.get(options.userId, calendar.id);
          await this.db.syncState.save({
            id: state?.id ?? this.ids.next('sync'),
            userId: options.userId,
            provider: account.provider,
            calendarId: calendar.id,
            ...(state?.syncToken === undefined ? {} : { syncToken: state.syncToken }),
            lastSyncedAt: this.clock.now(),
            lastError: message,
            failureCount: (state?.failureCount ?? 0) + 1,
          });
        }
      }
    }

    const finishedAt = this.clock.now();
    const meaningful = externalChanges.filter((change) => !change.selfInflicted);
    this.logger.info('sync.complete', {
      calendars: reports.length,
      calendarsAdded: calendarsAdded.length,
      calendarsRemoved: calendarsRemoved.length,
      externalChanges: meaningful.length,
      errors: errors.length,
    });
    return {
      startedAt,
      finishedAt,
      calendarsAdded,
      calendarsRemoved,
      calendars: reports,
      externalChanges,
      errors,
      needsReplan: meaningful.length > 0 || calendarsRemoved.length > 0,
    };
  }

  private async upsertEvent(
    userId: UserId,
    calendar: Calendar,
    normalized: NormalizedEvent,
    preferences: Parameters<CalendarService['toCalendarEvent']>[2],
  ): Promise<{ created: boolean; change?: ExternalChange }> {
    const existing = await this.db.events.findByExternalId(
      userId,
      normalized.provider,
      calendar.id,
      normalized.externalId,
    );
    const record = await this.db.syncState.getEventRecord(
      userId,
      calendar.id,
      normalized.externalId,
    );
    const now = this.clock.now();

    // An etag we wrote ourselves is our own echo, not a user edit.
    const selfInflicted =
      record?.lastWrittenEtag !== undefined && record.lastWrittenEtag === normalized.etag;
    const moved =
      record !== undefined &&
      (record.lastKnownStart !== normalized.start || record.lastKnownEnd !== normalized.end);

    const linked = await this.calendars.linkedHandles(existing?.id);
    const event = this.calendars.toCalendarEvent(
      normalized,
      calendar,
      preferences,
      existing,
      linked,
    );
    await this.db.events.save(event);
    await this.db.syncState.saveEventRecord({
      userId,
      provider: normalized.provider,
      calendarId: calendar.id,
      externalId: normalized.externalId,
      localEventId: event.id,
      lastKnownStart: normalized.start,
      lastKnownEnd: normalized.end,
      ...(normalized.etag === undefined ? {} : { lastKnownEtag: normalized.etag }),
      ...(record?.lastWrittenEtag === undefined ? {} : { lastWrittenEtag: record.lastWrittenEtag }),
      ...(record?.lastLocalWriteAt === undefined
        ? {}
        : { lastLocalWriteAt: record.lastLocalWriteAt }),
      lastSeenAt: now,
    });

    if (moved && !selfInflicted) {
      // If the user dragged one of our task blocks, follow them and pin it so
      // the scheduler stops arguing with an explicit human decision.
      if (event.blockId) {
        const block = await this.db.blocks.get(event.blockId);
        if (block && isLiveBlock(block)) {
          await this.db.blocks.save({
            ...block,
            start: normalized.start,
            end: normalized.end,
            pinned: true,
            status: 'synced',
            updatedAt: now,
          });
        }
      }
      return {
        created: existing === undefined,
        change: {
          kind: 'moved',
          externalId: normalized.externalId,
          calendarId: calendar.id,
          provider: normalized.provider,
          selfInflicted: false,
          previous: { start: record!.lastKnownStart, end: record!.lastKnownEnd },
          current: { start: normalized.start, end: normalized.end },
        },
      };
    }

    if (existing === undefined) {
      return {
        created: true,
        change: {
          kind: 'created',
          externalId: normalized.externalId,
          calendarId: calendar.id,
          provider: normalized.provider,
          selfInflicted,
          current: { start: normalized.start, end: normalized.end },
        },
      };
    }
    return { created: false };
  }

  private async removeDeleted(
    userId: UserId,
    calendar: Calendar,
    externalIds: readonly string[],
    changes: ExternalChange[],
  ): Promise<number> {
    if (externalIds.length === 0) return 0;
    const now = this.clock.now();
    for (const externalId of externalIds) {
      const event: CalendarEvent | undefined = await this.db.events.findByExternalId(
        userId,
        calendar.provider,
        calendar.id,
        externalId,
      );
      if (event?.blockId) {
        const block = await this.db.blocks.get(event.blockId);
        if (block) {
          // The user deleted our block in their calendar: detach it locally so
          // the next plan can propose a replacement rather than resurrect it.
          await this.db.blocks.save({
            ...block,
            status: 'detached',
            updatedAt: now,
          });
        }
      }
      changes.push({
        kind: 'deleted',
        externalId,
        calendarId: calendar.id,
        provider: calendar.provider,
        selfInflicted: false,
        ...(event ? { previous: { start: event.start, end: event.end } } : {}),
      });
      await this.db.syncState.deleteEventRecord(userId, calendar.id, externalId);
    }
    await this.db.events.deleteByExternalIds(userId, calendar.id, externalIds);
    return externalIds.length;
  }
}

function describeError(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
