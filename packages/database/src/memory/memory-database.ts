import type {
  BlockQuery,
  Calendar,
  CalendarAccount,
  CalendarAccountRepository,
  CalendarEvent,
  CalendarEventRepository,
  CalendarRepository,
  Category,
  CategoryRepository,
  ChangeSetRepository,
  ConversationRepository,
  Database,
  EventContactLinkRepository,
  EventQuery,
  OutreachRepository,
  EventSyncRecord,
  PreferencesRepository,
  SettingsRepository,
  ScheduleBlock,
  ScheduleBlockRepository,
  SchedulingPreferences,
  StoredChangeSet,
  StoredConversation,
  StoredMessage,
  StoredTokens,
  SyncState,
  SyncStateRepository,
  Task,
  TaskQuery,
  TaskRepository,
  User,
  UserRepository,
} from '@calendar-agent/core';
import { overlaps } from '@calendar-agent/core';
import type { DatabaseSnapshot } from './collections.js';
import { emptySnapshot } from './collections.js';

/**
 * In-memory implementation of every repository port.
 *
 * It is the reference implementation used by tests and by the zero-setup local
 * mode; `JsonFileDatabase` adds durability, `PostgresDatabase` adds SQL.
 */
export class MemoryDatabase implements Database {
  protected snapshot: DatabaseSnapshot = emptySnapshot();

  readonly users: UserRepository;
  readonly tasks: TaskRepository;
  readonly events: CalendarEventRepository;
  readonly blocks: ScheduleBlockRepository;
  readonly calendars: CalendarRepository;
  readonly accounts: CalendarAccountRepository;
  readonly categories: CategoryRepository;
  readonly contactLinks: EventContactLinkRepository;
  readonly outreach: OutreachRepository;
  readonly preferences: PreferencesRepository;
  readonly settings: SettingsRepository;
  readonly syncState: SyncStateRepository;
  readonly changeSets: ChangeSetRepository;
  readonly conversations: ConversationRepository;

  constructor() {
    const persist = () => this.persist();
    const data = () => this.snapshot;

    this.users = {
      async get(id) {
        return data().users.find((u) => u.id === id);
      },
      async findByEmail(email) {
        return data().users.find((u) => u.email === email);
      },
      async save(user) {
        upsert(data().users, user, (u) => u.id === user.id);
        await persist();
        return user;
      },
    };

    this.tasks = {
      async get(id) {
        return data().tasks.find((t) => t.id === id);
      },
      async list(query: TaskQuery) {
        return data()
          .tasks.filter((t) => t.userId === query.userId)
          .filter((t) => !query.statuses || query.statuses.includes(t.status))
          .filter((t) => !query.tags || query.tags.some((tag) => t.tags.includes(tag)))
          .filter(
            (t) =>
              query.deadlineBefore === undefined ||
              (t.deadline !== undefined && t.deadline <= query.deadlineBefore),
          )
          .filter((t) =>
            query.search === undefined
              ? true
              : `${t.title} ${t.description ?? ''}`
                  .toLowerCase()
                  .includes(query.search.toLowerCase()),
          )
          .sort(
            (a, b) =>
              (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.createdAt - b.createdAt,
          );
      },
      async save(task) {
        upsert(data().tasks, task, (t) => t.id === task.id);
        await persist();
        return task;
      },
      async saveMany(tasks) {
        for (const task of tasks) upsert(data().tasks, task, (t) => t.id === task.id);
        await persist();
      },
      async delete(id) {
        remove(data().tasks, (t) => t.id === id);
        await persist();
      },
    };

    this.events = {
      async get(id) {
        return data().events.find((e) => e.id === id);
      },
      async findByExternalId(userId, provider, calendarId, externalId) {
        return data().events.find(
          (e) =>
            e.userId === userId &&
            e.provider === provider &&
            e.calendarId === calendarId &&
            e.externalId === externalId,
        );
      },
      async list(query: EventQuery) {
        return data()
          .events.filter((e) => e.userId === query.userId)
          .filter((e) => !query.calendarIds || query.calendarIds.includes(e.calendarId))
          .filter((e) => overlaps({ start: e.start, end: e.end }, query.range))
          .sort((a, b) => a.start - b.start);
      },
      async save(event) {
        upsert(data().events, event, (e) => e.id === event.id);
        await persist();
        return event;
      },
      async saveMany(events) {
        for (const event of events) upsert(data().events, event, (e) => e.id === event.id);
        await persist();
      },
      async delete(id) {
        remove(data().events, (e) => e.id === id);
        await persist();
      },
      async deleteByExternalIds(userId, calendarId, externalIds) {
        const ids = new Set(externalIds);
        removeAll(
          data().events,
          (e) => e.userId === userId && e.calendarId === calendarId && ids.has(e.externalId),
        );
        await persist();
      },
    };

    this.blocks = {
      async get(id) {
        return data().blocks.find((b) => b.id === id);
      },
      async list(query: BlockQuery) {
        return data()
          .blocks.filter((b) => b.userId === query.userId)
          .filter((b) => !query.taskIds || query.taskIds.includes(b.taskId))
          .filter((b) => !query.statuses || query.statuses.includes(b.status))
          .filter((b) => !query.range || overlaps({ start: b.start, end: b.end }, query.range))
          .sort((a, b) => a.start - b.start);
      },
      async save(block) {
        upsert(data().blocks, block, (b) => b.id === block.id);
        await persist();
        return block;
      },
      async saveMany(blocks) {
        for (const block of blocks) upsert(data().blocks, block, (b) => b.id === block.id);
        await persist();
      },
      async delete(id) {
        remove(data().blocks, (b) => b.id === id);
        await persist();
      },
      async deleteMany(ids) {
        const set = new Set(ids);
        removeAll(data().blocks, (b) => set.has(b.id));
        await persist();
      },
    };

    this.calendars = {
      async get(id) {
        return data().calendars.find((c) => c.id === id);
      },
      async list(userId) {
        return data()
          .calendars.filter((c) => c.userId === userId)
          .sort(
            (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name),
          );
      },
      async findByExternalId(userId, accountId, externalId) {
        return data().calendars.find(
          (c) => c.userId === userId && c.accountId === accountId && c.externalId === externalId,
        );
      },
      async save(calendar) {
        upsert(data().calendars, calendar, (c) => c.id === calendar.id);
        await persist();
        return calendar;
      },
      async delete(id) {
        remove(data().calendars, (c) => c.id === id);
        await persist();
      },
    };

    this.accounts = {
      async get(id) {
        return data().accounts.find((a) => a.id === id);
      },
      async list(userId) {
        return data().accounts.filter((a) => a.userId === userId);
      },
      async save(account) {
        upsert(data().accounts, account, (a) => a.id === account.id);
        await persist();
        return account;
      },
      async delete(id) {
        remove(data().accounts, (a) => a.id === id);
        delete data().tokens[id];
        await persist();
      },
      async readTokens(accountId) {
        return data().tokens[accountId];
      },
      async writeTokens(accountId, tokens) {
        data().tokens[accountId] = tokens;
        await persist();
      },
    };

    this.categories = {
      async get(id) {
        return data().categories.find((c) => c.id === id);
      },
      async list(userId) {
        return data()
          .categories.filter((c) => c.userId === userId)
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      },
      async save(category) {
        upsert(data().categories, category, (c) => c.id === category.id);
        await persist();
        return category;
      },
      async delete(id) {
        remove(data().categories, (c) => c.id === id);
        await persist();
      },
    };

    this.contactLinks = {
      async get(id) {
        return data().contactLinks.find((l) => l.id === id);
      },
      async list(userId) {
        return data()
          .contactLinks.filter((l) => l.userId === userId)
          .sort((a, b) => a.createdAt - b.createdAt);
      },
      async listByEvent(eventId) {
        return data()
          .contactLinks.filter((l) => l.eventId === eventId)
          .sort((a, b) => a.createdAt - b.createdAt);
      },
      async save(link) {
        upsert(data().contactLinks, link, (l) => l.id === link.id);
        await persist();
        return link;
      },
      async delete(id) {
        remove(data().contactLinks, (l) => l.id === id);
        await persist();
      },
      async deleteByEvent(eventId) {
        remove(data().contactLinks, (l) => l.eventId === eventId);
        await persist();
      },
    };

    this.outreach = {
      async get(id) {
        return data().outreach.find((o) => o.id === id);
      },
      async list(query) {
        return data()
          .outreach.filter(
            (o) =>
              o.userId === query.userId &&
              (query.states === undefined || query.states.includes(o.state)),
          )
          .sort((a, b) => b.createdAt - a.createdAt);
      },
      async save(outreach) {
        upsert(data().outreach, outreach, (o) => o.id === outreach.id);
        await persist();
        return outreach;
      },
      async delete(id) {
        remove(data().outreach, (o) => o.id === id);
        await persist();
      },
    };

    this.preferences = {
      async get(userId) {
        return data().preferences.find((p) => p.userId === userId);
      },
      async save(preferences) {
        upsert(data().preferences, preferences, (p) => p.userId === preferences.userId);
        await persist();
        return preferences;
      },
    };

    this.settings = {
      async get(userId) {
        return data().settings.find((s) => s.userId === userId);
      },
      async save(settings) {
        upsert(data().settings, settings, (s) => s.userId === settings.userId);
        await persist();
        return settings;
      },
    };

    this.syncState = {
      async get(userId, calendarId) {
        return data().syncStates.find((s) => s.userId === userId && s.calendarId === calendarId);
      },
      async list(userId) {
        return data().syncStates.filter((s) => s.userId === userId);
      },
      async save(state) {
        upsert(
          data().syncStates,
          state,
          (s) => s.userId === state.userId && s.calendarId === state.calendarId,
        );
        await persist();
        return state;
      },
      async delete(userId, calendarId) {
        remove(data().syncStates, (s) => s.userId === userId && s.calendarId === calendarId);
        await persist();
      },
      async getEventRecord(userId, calendarId, externalId) {
        return data().eventSyncRecords.find(
          (r) => r.userId === userId && r.calendarId === calendarId && r.externalId === externalId,
        );
      },
      async saveEventRecord(record) {
        upsert(
          data().eventSyncRecords,
          record,
          (r) =>
            r.userId === record.userId &&
            r.calendarId === record.calendarId &&
            r.externalId === record.externalId,
        );
        await persist();
      },
      async deleteEventRecord(userId, calendarId, externalId) {
        remove(
          data().eventSyncRecords,
          (r) => r.userId === userId && r.calendarId === calendarId && r.externalId === externalId,
        );
        await persist();
      },
    };

    this.changeSets = {
      async get(id) {
        return data().changeSets.find((c) => c.id === id);
      },
      async list(userId, limit = 20) {
        return data()
          .changeSets.filter((c) => c.userId === userId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit);
      },
      async save(changeSet) {
        upsert(data().changeSets, changeSet, (c) => c.id === changeSet.id);
        await persist();
        return changeSet;
      },
    };

    this.conversations = {
      async getConversation(id) {
        return data().conversations.find((c) => c.id === id);
      },
      async listConversations(userId, limit = 20) {
        return data()
          .conversations.filter((c) => c.userId === userId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit);
      },
      async saveConversation(conversation) {
        upsert(data().conversations, conversation, (c) => c.id === conversation.id);
        await persist();
        return conversation;
      },
      async listMessages(conversationId, limit = 100) {
        return data()
          .messages.filter((m) => m.conversationId === conversationId)
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(-limit);
      },
      async appendMessage(message) {
        data().messages.push(message);
        await persist();
        return message;
      },
    };
  }

  async migrate(): Promise<void> {
    // Nothing to do: the in-memory shape is the schema.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  /** Hook for subclasses that persist the snapshot. */
  protected async persist(): Promise<void> {
    // no-op
  }

  /** Direct access, used by tests and by the JSON file backend. */
  export(): DatabaseSnapshot {
    return this.snapshot;
  }

  import(snapshot: DatabaseSnapshot): void {
    this.snapshot = snapshot;
  }
}

function upsert<T>(list: T[], value: T, match: (item: T) => boolean): void {
  const index = list.findIndex(match);
  if (index >= 0) list[index] = value;
  else list.push(value);
}

function remove<T>(list: T[], match: (item: T) => boolean): void {
  const index = list.findIndex(match);
  if (index >= 0) list.splice(index, 1);
}

function removeAll<T>(list: T[], match: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (match(list[i]!)) list.splice(i, 1);
  }
}

export type {
  Calendar,
  Category,
  CalendarAccount,
  CalendarEvent,
  EventSyncRecord,
  ScheduleBlock,
  SchedulingPreferences,
  StoredChangeSet,
  StoredConversation,
  StoredMessage,
  StoredTokens,
  SyncState,
  Task,
  User,
};
