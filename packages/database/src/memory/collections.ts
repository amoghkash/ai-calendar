import type {
  AppSettings,
  Calendar,
  CalendarAccount,
  CalendarEvent,
  Category,
  EventContactLink,
  EventSyncRecord,
  SchedulingPreferences,
  ScheduleBlock,
  StoredChangeSet,
  StoredConversation,
  StoredMessage,
  StoredTokens,
  SyncState,
  Task,
  User,
} from '@calendar-agent/core';

/** Everything the in-memory database holds. Also the JSON persistence shape. */
export interface DatabaseSnapshot {
  version: number;
  users: User[];
  tasks: Task[];
  events: CalendarEvent[];
  blocks: ScheduleBlock[];
  calendars: Calendar[];
  accounts: CalendarAccount[];
  tokens: Record<string, StoredTokens>;
  categories: Category[];
  contactLinks: EventContactLink[];
  preferences: SchedulingPreferences[];
  settings: AppSettings[];
  syncStates: SyncState[];
  eventSyncRecords: EventSyncRecord[];
  changeSets: StoredChangeSet[];
  conversations: StoredConversation[];
  messages: StoredMessage[];
}

export const emptySnapshot = (): DatabaseSnapshot => ({
  version: 1,
  users: [],
  tasks: [],
  events: [],
  blocks: [],
  calendars: [],
  accounts: [],
  tokens: {},
  categories: [],
  contactLinks: [],
  preferences: [],
  settings: [],
  syncStates: [],
  eventSyncRecords: [],
  changeSets: [],
  conversations: [],
  messages: [],
});
