import type { Clock, Database, Instant, Logger, UserId } from '@calendar-agent/core';
import { ValidationError, days, isLiveBlock } from '@calendar-agent/core';

export type DataScope =
  | 'events'
  | 'blocks'
  | 'tasks'
  | 'categories'
  | 'calendars'
  | 'accounts'
  | 'conversations'
  | 'changeSets'
  | 'preferences'
  | 'settings';

export const DATA_SCOPES: readonly DataScope[] = [
  'events',
  'blocks',
  'tasks',
  'categories',
  'calendars',
  'accounts',
  'conversations',
  'changeSets',
  'preferences',
  'settings',
];

export interface DataStats {
  readonly counts: Readonly<Record<string, number>>;
  readonly oldestEvent?: Instant;
  readonly newestEvent?: Instant;
  readonly staleBlocks: number;
  readonly orphanedEvents: number;
  readonly orphanedSyncRecords: number;
  readonly detachedBlocks: number;
}

export interface PruneOptions {
  readonly userId: UserId;
  /** Delete history older than this. Defaults to 90 days ago. */
  readonly before?: Instant;
  /** Report what would go without deleting anything. Defaults to true. */
  readonly dryRun?: boolean;
  readonly includeConversations?: boolean;
}

export interface PruneReport {
  readonly dryRun: boolean;
  readonly before: Instant;
  readonly events: number;
  readonly blocks: number;
  readonly changeSets: number;
  readonly conversations: number;
  readonly orphanedEvents: number;
  readonly orphanedSyncRecords: number;
}

export interface ResetOptions {
  readonly userId: UserId;
  readonly scopes: readonly DataScope[];
  /** Must be true to delete anything. */
  readonly confirm: boolean;
  readonly dryRun?: boolean;
}

export interface ResetReport {
  readonly dryRun: boolean;
  readonly scopes: readonly DataScope[];
  readonly deleted: Readonly<Record<string, number>>;
}

/**
 * Housekeeping for the data the system accumulates: old events, blocks whose
 * task is gone, change-set history, and the leftovers a disconnected account
 * used to leave behind.
 *
 * Everything destructive is dry-run by default and needs an explicit
 * confirmation, because the honest answer to "can I get that back" is no.
 */
export class MaintenanceService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async stats(userId: UserId): Promise<DataStats> {
    const everything = { start: 0, end: Number.MAX_SAFE_INTEGER };
    const [
      events,
      blocks,
      tasks,
      categories,
      calendars,
      accounts,
      changeSets,
      conversations,
      syncStates,
    ] = await Promise.all([
      this.db.events.list({ userId, range: everything }),
      this.db.blocks.list({ userId }),
      this.db.tasks.list({ userId }),
      this.db.categories.list(userId),
      this.db.calendars.list(userId),
      this.db.accounts.list(userId),
      this.db.changeSets.list(userId, 10_000),
      this.db.conversations.listConversations(userId, 10_000),
      this.db.syncState.list(userId),
    ]);

    const taskIds = new Set(tasks.map((task) => task.id));
    const calendarIds = new Set(calendars.map((calendar) => calendar.id));

    return {
      counts: {
        events: events.length,
        blocks: blocks.length,
        tasks: tasks.length,
        categories: categories.length,
        calendars: calendars.length,
        accounts: accounts.length,
        changeSets: changeSets.length,
        conversations: conversations.length,
        syncStates: syncStates.length,
      },
      ...(events.length > 0
        ? {
            oldestEvent: Math.min(...events.map((event) => event.start)),
            newestEvent: Math.max(...events.map((event) => event.end)),
          }
        : {}),
      // A block whose task no longer exists can never be re-planned.
      staleBlocks: blocks.filter((block) => !taskIds.has(block.taskId)).length,
      detachedBlocks: blocks.filter((block) => !isLiveBlock(block)).length,
      // Events belonging to a calendar that is gone: the usual residue of a
      // disconnected account.
      orphanedEvents: events.filter((event) => !calendarIds.has(event.calendarId)).length,
      orphanedSyncRecords: syncStates.filter((state) => !calendarIds.has(state.calendarId)).length,
    };
  }

  /** Remove history and leftovers. Dry-run unless told otherwise. */
  async prune(options: PruneOptions): Promise<PruneReport> {
    const dryRun = options.dryRun !== false;
    const before = options.before ?? this.clock.now() - days(90);
    const userId = options.userId;

    const [allEvents, blocks, tasks, calendars, changeSets] = await Promise.all([
      this.db.events.list({ userId, range: { start: 0, end: Number.MAX_SAFE_INTEGER } }),
      this.db.blocks.list({ userId }),
      this.db.tasks.list({ userId }),
      this.db.calendars.list(userId),
      this.db.changeSets.list(userId, 10_000),
    ]);

    const taskIds = new Set(tasks.map((task) => task.id));
    const calendarIds = new Set(calendars.map((calendar) => calendar.id));

    const oldEvents = allEvents.filter((event) => event.end < before);
    const orphanedEvents = allEvents.filter((event) => !calendarIds.has(event.calendarId));
    const eventsToDelete = dedupeById([...oldEvents, ...orphanedEvents]);

    const blocksToDelete = blocks.filter(
      (block) => block.end < before || !taskIds.has(block.taskId),
    );
    const changeSetsToDelete = changeSets.filter((changeSet) => changeSet.createdAt < before);

    const conversations = options.includeConversations
      ? (await this.db.conversations.listConversations(userId, 10_000)).filter(
          (conversation) => conversation.updatedAt < before,
        )
      : [];

    const syncStates = (await this.db.syncState.list(userId)).filter(
      (state) => !calendarIds.has(state.calendarId),
    );

    if (!dryRun) {
      for (const event of eventsToDelete) await this.db.events.delete(event.id);
      if (blocksToDelete.length > 0) {
        await this.db.blocks.deleteMany(blocksToDelete.map((block) => block.id));
      }
      for (const changeSet of changeSetsToDelete) {
        await this.db.changeSets.save({ ...changeSet, status: 'expired' });
      }
      for (const state of syncStates) {
        await this.db.syncState.delete(userId, state.calendarId);
      }
      this.logger.info('maintenance.pruned', {
        events: eventsToDelete.length,
        blocks: blocksToDelete.length,
        before,
      });
    }

    return {
      dryRun,
      before,
      events: eventsToDelete.length,
      blocks: blocksToDelete.length,
      changeSets: changeSetsToDelete.length,
      conversations: conversations.length,
      orphanedEvents: orphanedEvents.length,
      orphanedSyncRecords: syncStates.length,
    };
  }

  /**
   * Delete whole categories of data for one user.
   *
   * Scopes are applied in dependency order so nothing is left pointing at
   * something that no longer exists.
   */
  async reset(options: ResetOptions): Promise<ResetReport> {
    const dryRun = options.dryRun !== false;
    if (!dryRun && !options.confirm) {
      throw new ValidationError(
        'Refusing to delete data without an explicit confirmation. Pass confirm: true (or --yes).',
      );
    }
    for (const scope of options.scopes) {
      if (!DATA_SCOPES.includes(scope)) {
        throw new ValidationError(
          `Unknown scope "${scope}". Valid scopes: ${DATA_SCOPES.join(', ')}.`,
        );
      }
    }

    const userId = options.userId;
    const wanted = new Set(options.scopes);
    const deleted: Record<string, number> = {};
    const everything = { start: 0, end: Number.MAX_SAFE_INTEGER };

    // Blocks reference tasks and calendars, so they go first.
    if (wanted.has('blocks') || wanted.has('tasks') || wanted.has('calendars')) {
      const blocks = await this.db.blocks.list({ userId });
      deleted.blocks = blocks.length;
      if (!dryRun && blocks.length > 0) {
        await this.db.blocks.deleteMany(blocks.map((block) => block.id));
      }
    }

    if (wanted.has('events') || wanted.has('calendars') || wanted.has('accounts')) {
      const events = await this.db.events.list({ userId, range: everything });
      deleted.events = events.length;
      if (!dryRun) for (const event of events) await this.db.events.delete(event.id);

      const syncStates = await this.db.syncState.list(userId);
      deleted.syncStates = syncStates.length;
      if (!dryRun) {
        for (const state of syncStates) {
          await this.db.syncState.save({ ...state, syncToken: undefined, failureCount: 0 });
        }
      }
    }

    if (wanted.has('tasks')) {
      const tasks = await this.db.tasks.list({ userId });
      deleted.tasks = tasks.length;
      if (!dryRun) for (const task of tasks) await this.db.tasks.delete(task.id);
    }

    if (wanted.has('categories')) {
      const categories = await this.db.categories.list(userId);
      deleted.categories = categories.length;
      if (!dryRun) for (const category of categories) await this.db.categories.delete(category.id);
    }

    if (wanted.has('calendars') || wanted.has('accounts')) {
      const calendars = await this.db.calendars.list(userId);
      deleted.calendars = calendars.length;
      if (!dryRun) for (const calendar of calendars) await this.db.calendars.delete(calendar.id);
    }

    if (wanted.has('accounts')) {
      const accounts = await this.db.accounts.list(userId);
      deleted.accounts = accounts.length;
      if (!dryRun) for (const account of accounts) await this.db.accounts.delete(account.id);
    }

    if (wanted.has('conversations')) {
      const conversations = await this.db.conversations.listConversations(userId, 10_000);
      deleted.conversations = conversations.length;
      if (!dryRun) {
        for (const conversation of conversations) {
          await this.db.conversations.saveConversation({ ...conversation, title: '(deleted)' });
        }
      }
    }

    if (wanted.has('changeSets')) {
      const changeSets = await this.db.changeSets.list(userId, 10_000);
      deleted.changeSets = changeSets.length;
      if (!dryRun) {
        for (const changeSet of changeSets) {
          await this.db.changeSets.save({ ...changeSet, status: 'expired' });
        }
      }
    }

    if (!dryRun) {
      this.logger.warn('maintenance.reset', { scopes: [...wanted], deleted });
    }
    return { dryRun, scopes: options.scopes, deleted };
  }

  /** Every scope at once: the "start over" button. */
  async resetAll(userId: UserId, confirm: boolean, dryRun = true): Promise<ResetReport> {
    return this.reset({ userId, scopes: DATA_SCOPES, confirm, dryRun });
  }
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(item.id, item);
  return [...seen.values()];
}
