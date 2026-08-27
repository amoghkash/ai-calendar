import type { Clock, EventId, Instant, Logger, UserId } from '@calendar-agent/core';
import { ValidationError } from '@calendar-agent/core';
import type { CalendarService } from './calendar-service.js';

export interface PendingDeletion {
  readonly token: string;
  readonly eventId: EventId;
  readonly title: string;
  readonly deletesAt: Instant;
}

interface Scheduled extends PendingDeletion {
  readonly userId: UserId;
  /** Carried from the request: whether guests hear about it when it happens. */
  readonly notifyAttendees: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Long enough to say "wait, no", short enough not to feel broken. */
export const DEFAULT_DELETION_DELAY_MS = 10_000;

/**
 * Deleting an event, later.
 *
 * Undo works by *not having deleted yet*. Deleting from a calendar provider is
 * irreversible - there is no undelete, and recreating the event would lose its
 * id, its guests' replies and its history - so the only honest undo is a delay
 * before anything happens at all.
 *
 * The event therefore stays on the calendar during the window. That is not a
 * cosmetic delay hiding a completed action: nothing has happened, and if the
 * process stops before the timer fires, nothing ever will. Losing a deletion to
 * a restart is the right way for this to fail.
 */
export class DeferredDeletionService {
  private readonly scheduled = new Map<string, Scheduled>();

  constructor(
    private readonly calendars: CalendarService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly delayMs: number = DEFAULT_DELETION_DELAY_MS,
  ) {}

  /**
   * Check now, delete later.
   *
   * Everything that can refuse - a missing event, a read-only calendar, a
   * recurring series - is checked before the timer starts, so a refusal reaches
   * the caller rather than surfacing ten seconds later with nobody watching.
   */
  async schedule(
    userId: UserId,
    eventId: EventId,
    options: { readonly delayMs?: number; readonly notifyAttendees?: boolean } = {},
  ): Promise<PendingDeletion> {
    const delayMs = options.delayMs ?? this.delayMs;
    const existing = [...this.scheduled.values()].find(
      (item) => item.eventId === eventId && item.userId === userId,
    );
    if (existing) return strip(existing);

    const event = await this.calendars.assertDeletable(userId, eventId);

    const token = `del_${eventId}_${this.clock.now()}`;
    const deletesAt = this.clock.now() + delayMs;
    const timer = setTimeout(() => void this.run(token), delayMs);
    timer.unref?.();

    this.scheduled.set(token, {
      token,
      userId,
      eventId,
      title: event.title,
      deletesAt,
      timer,
      notifyAttendees: options.notifyAttendees === true,
    });
    this.logger.info('event.deletion_scheduled', { eventId, delayMs });
    return { token, eventId, title: event.title, deletesAt };
  }

  /** Stop a deletion that has not happened yet. */
  undo(userId: UserId, token: string): PendingDeletion {
    const item = this.scheduled.get(token);
    if (!item || item.userId !== userId) {
      throw new ValidationError(
        'That deletion has already happened or was never scheduled. Nothing was undone.',
      );
    }
    clearTimeout(item.timer);
    this.scheduled.delete(token);
    this.logger.info('event.deletion_undone', { eventId: item.eventId });
    return strip(item);
  }

  /** Deletions still inside their window. */
  pending(userId: UserId): PendingDeletion[] {
    return [...this.scheduled.values()]
      .filter((item) => item.userId === userId)
      .map(strip)
      .sort((a, b) => a.deletesAt - b.deletesAt);
  }

  /** On shutdown, abandon rather than rush: an unfired timer deletes nothing. */
  stop(): void {
    for (const item of this.scheduled.values()) clearTimeout(item.timer);
    this.scheduled.clear();
  }

  private async run(token: string): Promise<void> {
    const item = this.scheduled.get(token);
    if (!item) return;
    this.scheduled.delete(token);
    try {
      await this.calendars.deleteEvent(item.userId, item.eventId, {
        notifyAttendees: item.notifyAttendees,
      });
      this.logger.info('event.deleted', { eventId: item.eventId });
    } catch (error) {
      // Nothing is retried: the window has closed and there is nobody to tell.
      this.logger.error('event.deletion_failed', {
        eventId: item.eventId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const strip = (item: Scheduled): PendingDeletion => ({
  token: item.token,
  eventId: item.eventId,
  title: item.title,
  deletesAt: item.deletesAt,
});

