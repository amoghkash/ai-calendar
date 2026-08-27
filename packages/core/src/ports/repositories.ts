import type {
  Calendar,
  CalendarAccount,
  CalendarEvent,
  CalendarProviderId,
} from '../domain/calendar.js';
import type { Category } from '../domain/category.js';
import type { EventContactLink } from '../domain/contact.js';
import type { Outreach, OutreachState } from '../domain/outreach.js';
import type {
  CalendarAccountId,
  CalendarId,
  EventContactLinkId,
  EventId,
  OutreachId,
  TaskId,
  UserId,
} from '../domain/ids.js';
import type { SchedulingPreferences } from '../domain/preferences.js';
import type { AppSettings } from '../domain/settings.js';
import type { ScheduleBlock } from '../domain/schedule.js';
import type { EventSyncRecord, SyncState } from '../domain/sync.js';
import type { Task } from '../domain/task.js';
import type { User } from '../domain/user.js';
import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import type { StoredTokens } from './calendar-provider.js';

export interface TaskQuery {
  readonly userId: UserId;
  readonly statuses?: readonly Task['status'][];
  readonly tags?: readonly string[];
  readonly deadlineBefore?: Instant;
  readonly search?: string;
}

export interface TaskRepository {
  get(id: TaskId): Promise<Task | undefined>;
  list(query: TaskQuery): Promise<Task[]>;
  save(task: Task): Promise<Task>;
  saveMany(tasks: readonly Task[]): Promise<void>;
  delete(id: TaskId): Promise<void>;
}

export interface EventQuery {
  readonly userId: UserId;
  readonly range: Interval;
  readonly calendarIds?: readonly CalendarId[];
}

export interface CalendarEventRepository {
  get(id: string): Promise<CalendarEvent | undefined>;
  findByExternalId(
    userId: UserId,
    provider: CalendarProviderId,
    calendarId: CalendarId,
    externalId: string,
  ): Promise<CalendarEvent | undefined>;
  list(query: EventQuery): Promise<CalendarEvent[]>;
  save(event: CalendarEvent): Promise<CalendarEvent>;
  saveMany(events: readonly CalendarEvent[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByExternalIds(
    userId: UserId,
    calendarId: CalendarId,
    externalIds: readonly string[],
  ): Promise<void>;
}

export interface BlockQuery {
  readonly userId: UserId;
  readonly range?: Interval;
  readonly taskIds?: readonly TaskId[];
  readonly statuses?: readonly ScheduleBlock['status'][];
}

export interface ScheduleBlockRepository {
  get(id: string): Promise<ScheduleBlock | undefined>;
  list(query: BlockQuery): Promise<ScheduleBlock[]>;
  save(block: ScheduleBlock): Promise<ScheduleBlock>;
  saveMany(blocks: readonly ScheduleBlock[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteMany(ids: readonly string[]): Promise<void>;
}

export interface CalendarRepository {
  get(id: CalendarId): Promise<Calendar | undefined>;
  list(userId: UserId): Promise<Calendar[]>;
  findByExternalId(
    userId: UserId,
    accountId: CalendarAccountId,
    externalId: string,
  ): Promise<Calendar | undefined>;
  save(calendar: Calendar): Promise<Calendar>;
  delete(id: CalendarId): Promise<void>;
}

export interface CalendarAccountRepository {
  get(id: CalendarAccountId): Promise<CalendarAccount | undefined>;
  list(userId: UserId): Promise<CalendarAccount[]>;
  save(account: CalendarAccount): Promise<CalendarAccount>;
  delete(id: CalendarAccountId): Promise<void>;
  readTokens(accountId: CalendarAccountId): Promise<StoredTokens | undefined>;
  writeTokens(accountId: CalendarAccountId, tokens: StoredTokens): Promise<void>;
}

export interface EventContactLinkRepository {
  get(id: EventContactLinkId): Promise<EventContactLink | undefined>;
  list(userId: UserId): Promise<EventContactLink[]>;
  listByEvent(eventId: EventId): Promise<EventContactLink[]>;
  save(link: EventContactLink): Promise<EventContactLink>;
  delete(id: EventContactLinkId): Promise<void>;
  deleteByEvent(eventId: EventId): Promise<void>;
}

export interface OutreachQuery {
  readonly userId: UserId;
  readonly states?: readonly OutreachState[];
}

export interface OutreachRepository {
  get(id: OutreachId): Promise<Outreach | undefined>;
  list(query: OutreachQuery): Promise<Outreach[]>;
  save(outreach: Outreach): Promise<Outreach>;
  delete(id: OutreachId): Promise<void>;
}

export interface CategoryRepository {
  get(id: string): Promise<Category | undefined>;
  list(userId: UserId): Promise<Category[]>;
  save(category: Category): Promise<Category>;
  delete(id: string): Promise<void>;
}

export interface PreferencesRepository {
  get(userId: UserId): Promise<SchedulingPreferences | undefined>;
  save(preferences: SchedulingPreferences): Promise<SchedulingPreferences>;
}

export interface SettingsRepository {
  get(userId: UserId): Promise<AppSettings | undefined>;
  save(settings: AppSettings): Promise<AppSettings>;
}

export interface UserRepository {
  get(id: UserId): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  save(user: User): Promise<User>;
}

export interface SyncStateRepository {
  get(userId: UserId, calendarId: CalendarId): Promise<SyncState | undefined>;
  list(userId: UserId): Promise<SyncState[]>;
  save(state: SyncState): Promise<SyncState>;
  /** Remove a calendar's cursor when the calendar itself is gone. */
  delete(userId: UserId, calendarId: CalendarId): Promise<void>;
  getEventRecord(
    userId: UserId,
    calendarId: CalendarId,
    externalId: string,
  ): Promise<EventSyncRecord | undefined>;
  saveEventRecord(record: EventSyncRecord): Promise<void>;
  deleteEventRecord(userId: UserId, calendarId: CalendarId, externalId: string): Promise<void>;
}

export interface StoredChangeSet {
  readonly id: string;
  readonly userId: UserId;
  readonly createdAt: Instant;
  readonly status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'expired';
  readonly payload: unknown;
  readonly appliedAt?: Instant;
  readonly error?: string;
}

export interface ChangeSetRepository {
  get(id: string): Promise<StoredChangeSet | undefined>;
  list(userId: UserId, limit?: number): Promise<StoredChangeSet[]>;
  save(changeSet: StoredChangeSet): Promise<StoredChangeSet>;
}

export interface StoredConversation {
  readonly id: string;
  readonly userId: UserId;
  readonly title: string;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly createdAt: Instant;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ConversationRepository {
  getConversation(id: string): Promise<StoredConversation | undefined>;
  listConversations(userId: UserId, limit?: number): Promise<StoredConversation[]>;
  saveConversation(conversation: StoredConversation): Promise<StoredConversation>;
  listMessages(conversationId: string, limit?: number): Promise<StoredMessage[]>;
  appendMessage(message: StoredMessage): Promise<StoredMessage>;
}

/** Everything the application needs to persist, in one injectable bundle. */
export interface Database {
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
  migrate(): Promise<void>;
  close(): Promise<void>;
}
