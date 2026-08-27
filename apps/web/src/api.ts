/**
 * Typed HTTP client for the application API.
 *
 * The UI never talks to the database, a calendar provider or the scheduler
 * directly: everything goes through these endpoints.
 */

export type RiskLevel = 'SAFE' | 'AT_RISK' | 'CRITICAL' | 'IMPOSSIBLE';

export type Weekday =
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface Task {
  id: string;
  title: string;
  description?: string;
  estimatedMinutes: number;
  completedMinutes: number;
  deadline?: number;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  importance: number;
  status: string;
  tags: string[];
  focus: string;
  pinned: boolean;
  /**
   * Times of day the scheduler should place this task in. A hard filter that
   * is relaxed automatically when nothing fits, so it floats rather than fails.
   */
  preferredWindows: DailyWindow[];
  /** Days the task may be placed on. Empty means any day. */
  preferredDays: Weekday[];
}

/**
 * Whether the local messaging bridge is reachable and what it may do.
 *
 * Every field can be false on a working machine - the bridge is optional, its
 * macOS permissions are granted one at a time, and reading commonly works while
 * sending does not - so the UI treats unavailability as ordinary, not as an
 * error state.
 */
export interface MessagingStatus {
  available: boolean;
  canReadMessages: boolean;
  canReadContacts: boolean;
  canSend: boolean;
  detail?: string;
}

export interface PersonHandle {
  kind: 'phone' | 'email';
  /** As stored in Contacts, i.e. how a human typed it. */
  value: string;
  /** The comparable form; this is what gets linked. */
  normalized: string;
  label?: string;
}

export interface DirectoryContact {
  id: string;
  displayName: string;
  handles: PersonHandle[];
}

/** What the message thread says about a plan, derived from timestamps alone. */
export type ThreadPosture = 'unmentioned' | 'awaiting_them' | 'awaiting_me';

export interface EventContactLink {
  id: string;
  eventId: string;
  contactId: string;
  displayName: string;
  handle: string;
  source: 'manual' | 'title_match' | 'attendee';
  createdAt: number;
}

/**
 * A person the event's title appears to name, not yet linked.
 *
 * `unique` is one click; `ambiguous` lists everyone who ties and makes the
 * reader choose, because picking a Sarah at random is worse than asking.
 */
export interface LinkSuggestion {
  candidate: string;
  kind: 'unique' | 'ambiguous';
  contacts: DirectoryContact[];
}

export type OutreachState =
  | 'draft'
  | 'sent'
  | 'needs_you'
  | 'agreed'
  | 'booked'
  | 'declined'
  | 'expired'
  | 'cancelled';

/** A message offering someone times, and where that conversation has got to. */
export interface Outreach {
  id: string;
  contactId: string;
  displayName: string;
  handle: string;
  activity: string;
  durationMinutes: number;
  proposedSlots: { start: number; end: number }[];
  message: string;
  state: OutreachState;
  agreedSlot?: { start: number; end: number };
  eventId?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
  expiresAt?: number;
  lastReplyAt?: number;
  clarifications?: number;
}

export interface TodayPerson {
  name: string;
  handle: string;
  posture: ThreadPosture;
}

export interface TodayEntry {
  id: string;
  kind: 'event' | 'block';
  title: string;
  start: number;
  end: number;
  isAllDay: boolean;
  classification?: string;
  people: TodayPerson[];
  canConfirm: boolean;
  confirmation?: { id: string; state: string };
}

export interface TodayAction {
  id: string;
  kind: 'needs_you' | 'unsent_draft';
  person: string;
  summary: string;
  note?: string;
}

/** The day arranged around what wants an answer, not just what exists. */
export interface TodayView {
  now: number;
  timezone: string;
  dayStart: number;
  dayEnd: number;
  entries: TodayEntry[];
  next?: TodayEntry;
  freeWindows: { start: number; end: number }[];
  actions: TodayAction[];
  risks: TaskRisk[];
  pendingChangeSetId?: string;
}

/** An event on its way out, still inside the window where it can be kept. */
export interface PendingDeletion {
  token: string;
  eventId: string;
  title: string;
  deletesAt: number;
}

export interface OutreachStatus {
  poller: { enabled: boolean; intervalMinutes: number; running: boolean };
  waiting: number;
  /** False when the bridge cannot send; the panel falls back to copy-and-paste. */
  canSend: boolean;
}

export interface LinkedPerson {
  link: EventContactLink;
  posture: ThreadPosture;
  lastInboundAt?: number;
  lastOutboundAt?: number;
}

export type AttendeeResponse = 'accepted' | 'declined' | 'tentative' | 'needsAction';

export interface Attendee {
  email: string;
  name?: string;
  optional?: boolean;
  response?: AttendeeResponse;
  self?: boolean;
  organizer?: boolean;
}

/** `opaque` consumes time; `transparent` is shown as free. */
export type Transparency = 'opaque' | 'transparent';

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  location?: string;
  start: number;
  end: number;
  timezone: string;
  isAllDay: boolean;
  classification: string;
  calendarId: string;
  taskId?: string;
  blockId?: string;
  isRecurring: boolean;
  recurrenceKind: 'single' | 'series_master' | 'instance';
  status: 'confirmed' | 'tentative' | 'cancelled';
  transparency: Transparency;
  attendees: Attendee[];
  organizer?: Attendee;
  isOrganizer: boolean;
  /** Provider conferencing payload; read through `meetingUrl` in `event.ts`. */
  conferenceData?: unknown;
  updatedAt: number;
}

export interface ScheduleBlock {
  id: string;
  taskId: string;
  title: string;
  start: number;
  end: number;
  status: string;
  pinned: boolean;
}

export interface TaskRisk {
  taskId: string;
  title: string;
  level: RiskLevel;
  explanation: string;
  deadline?: number;
  remainingMinutes: number;
  availableMinutesBeforeDeadline: number;
}

export interface DiffEntry {
  kind: string;
  blockId: string;
  taskId: string;
  taskTitle: string;
  before?: { start: number; end: number };
  after?: { start: number; end: number };
  reason: { code: string; message: string };
}

export interface SchedulingPlan {
  runId: string;
  timezone: string;
  blocks: {
    id: string;
    taskId: string;
    start: number;
    end: number;
    minutes: number;
    origin: string;
    reason: { message: string };
  }[];
  unscheduled: {
    taskId: string;
    title: string;
    missingMinutes: number;
    reason: { message: string };
  }[];
  risks: TaskRisk[];
  quality: {
    overall: number;
    metrics: { key: string; label: string; value: number; explanation: string }[];
  };
  diff: {
    added: DiffEntry[];
    moved: DiffEntry[];
    removed: DiffEntry[];
    unchanged: DiffEntry[];
    summary: {
      addedCount: number;
      movedCount: number;
      removedCount: number;
      unchangedCount: number;
    };
  };
  trace: {
    steps: { step: string; message: string }[];
    scores: {
      taskId: string;
      title: string;
      total: number;
      components: { key: string; contribution: number; explanation: string }[];
    }[];
  };
}

export interface ChangeSet {
  id: string;
  mode: string;
  summary: string;
  autoApply: { id: string; kind: string; label: string }[];
  pending: { id: string; kind: string; label: string }[];
  blocked: { mutation: { id: string; label: string }; reason: { message: string } }[];
}

export interface PlanResult {
  changeSetId: string;
  plan: SchedulingPlan;
  changeSet: ChangeSet;
  tasks: Task[];
}

export interface DailyWindow {
  start: { hour: number; minute: number };
  end: { hour: number; minute: number };
}

export type WeeklySchedule = Record<string, DailyWindow[] | undefined>;

export type MovePolicy = 'never' | 'ask' | 'auto';
export type EventClassification = 'MOVABLE' | 'PROTECTED' | 'FIXED' | 'UNKNOWN';

export interface AutomationSettings {
  mode: 'read_only' | 'suggest' | 'autonomous';
  movePolicy: Record<EventClassification, MovePolicy>;
  createBlocks: MovePolicy;
  deleteBlocks: MovePolicy;
  freezeWindowMinutes: number;
  maxAutoMutations: number;
}

export interface DeepWorkSettings {
  enabled: boolean;
  schedule: WeeklySchedule;
  allowMeetings: boolean;
  reserveForFocusTasks: boolean;
}

export interface ClassificationRule {
  id: string;
  classification: EventClassification;
  titlePattern?: string;
  calendarId?: string;
  /** Undefined means the rule does not care either way. */
  hasOtherAttendees?: boolean;
  isAllDay?: boolean;
  createdByAgent?: boolean;
}

/** The scheduling policy. Mirrors `SchedulingPreferences` on the server. */
export interface Preferences {
  timezone: string;
  workingHours: WeeklySchedule;
  sleepHours: WeeklySchedule;
  recurringBlocks: WeeklySchedule;
  deepWork: DeepWorkSettings;
  automation: AutomationSettings;
  minimumBlockMinutes: number;
  maximumBlockMinutes: number;
  allowTaskSplitting: boolean;
  bufferBetweenBlocksMinutes: number;
  maxDailyTaskMinutes?: number;
  protectExistingEvents: boolean;
  allDayEventsBlockTime: boolean;
  granularityMinutes: number;
  planningHorizonDays: number;
  placementStrategy: 'earliest_fit' | 'best_fit';
  classificationRules: ClassificationRule[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** `rolling` keeps today leftmost; `sunday` pins the grid to a calendar week. */
export type WeekStart = 'rolling' | 'sunday';

export interface LLMSettings {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  baseUrl?: string;
}

export interface AppSettings {
  llm: LLMSettings;
  logLevel: LogLevel;
  weekStart: WeekStart;
  updatedAt: number;
}

export interface LLMProviderStatus {
  provider: string;
  label: string;
  defaultModel: string;
  suggestedModels: string[];
  supportsBaseUrl: boolean;
  requiresApiKey: boolean;
  /** Whether the server environment supplies a credential. Never the key itself. */
  hasApiKey: boolean;
  apiKeyEnvVar?: string;
}

export interface SettingsView {
  settings: AppSettings;
  providers: LLMProviderStatus[];
  active: { provider: string; model: string };
  sources: string[];
  readOnlyRuntime: boolean;
}

export interface Calendar {
  id: string;
  name: string;
  provider: string;
  color?: string;
  isPrimary: boolean;
  isWritable: boolean;
  isTaskTarget: boolean;
  includeInAvailability: boolean;
  selected: boolean;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  description?: string;
  matchPattern?: string;
  calendarId?: string;
  isDefault: boolean;
  position: number;
}

export interface CategoryUsage {
  category: Category;
  taskCount: number;
  eventCount: number;
}

export interface DataStats {
  counts: Record<string, number>;
  staleBlocks: number;
  detachedBlocks: number;
  orphanedEvents: number;
  orphanedSyncRecords: number;
}

export interface AppState {
  user: { id: string; displayName: string };
  now: number;
  timezone: string;
  automationMode: string;
  llm: { provider: string; model: string };
  weekStart: WeekStart;
  tasks: Task[];
  events: CalendarEvent[];
  blocks: ScheduleBlock[];
  preferences: Preferences;
  calendars: Calendar[];
  risks: TaskRisk[];
  categories: Category[];
  categoryByTask: Record<string, string>;
  categoryByEvent: Record<string, string>;
  categoryByBlock: Record<string, string>;
}

export interface AgentReply {
  reply: string;
  intent?: string;
  source: string;
  commands: { type: string }[];
  plan?: SchedulingPlan;
  changeSet?: ChangeSet;
  changeSetId?: string;
  needsConfirmation: boolean;
  conversationId: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      error.message ?? response.statusText,
      error.code ?? 'ERROR',
      response.status,
    );
  }
  return payload as T;
}

export const api = {
  state: () => request<AppState>('/state'),
  createTask: (task: Partial<Task> & { title: string; estimatedMinutes: number }) =>
    request<Task>('/tasks', { method: 'POST', body: JSON.stringify(task) }),
  updateTask: (id: string, changes: Partial<Task>) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  completeTask: (id: string) => request<Task>(`/tasks/${id}/complete`, { method: 'POST' }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  plan: (body: { taskIds?: string[]; days?: number; rebuild?: boolean } = {}) =>
    request<PlanResult>('/schedule/plan', { method: 'POST', body: JSON.stringify(body) }),
  apply: (changeSetId: string, mutationIds?: string[]) =>
    request<{ appliedMutations: number; failures: { id: string; error: string }[] }>(
      '/schedule/apply',
      { method: 'POST', body: JSON.stringify({ changeSetId, mutationIds }) },
    ),
  reject: (changeSetId: string) =>
    request<void>('/schedule/reject', { method: 'POST', body: JSON.stringify({ changeSetId }) }),
  risks: () => request<TaskRisk[]>('/risks'),
  sync: (full = false) =>
    request<{ needsReplan: boolean; errors: { message: string }[] }>('/sync', {
      method: 'POST',
      body: JSON.stringify({ full }),
    }),
  message: (text: string, conversationId?: string) =>
    request<AgentReply>('/agent/message', {
      method: 'POST',
      body: JSON.stringify({ text, conversationId }),
    }),
  calendars: () =>
    request<{
      accounts: { id: string; displayName: string; provider: string }[];
      calendars: Calendar[];
      providers: string[];
    }>('/calendars'),
  updateCalendar: (id: string, changes: Partial<Calendar>) =>
    request<Calendar>(`/calendars/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),

  // --- settings -------------------------------------------------------------
  preferences: () => request<Preferences>('/preferences'),
  updatePreferences: (patch: Partial<Preferences>) =>
    request<Preferences>('/preferences', { method: 'PUT', body: JSON.stringify(patch) }),
  settings: () => request<SettingsView>('/settings'),
  updateSettings: (patch: {
    llm?: Partial<LLMSettings>;
    logLevel?: LogLevel;
    weekStart?: WeekStart;
  }) => request<SettingsView>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  // --- direct editing -------------------------------------------------------
  moveBlock: (id: string, start: number, end: number, pin = true) =>
    request<ScheduleBlock>(`/blocks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        pin,
      }),
    }),
  pinBlock: (id: string, pinned: boolean) =>
    request<ScheduleBlock>(`/blocks/${id}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    }),
  deleteBlock: (id: string) => request<void>(`/blocks/${id}`, { method: 'DELETE' }),

  createEvent: (input: {
    calendarId: string;
    title: string;
    start: number;
    end: number;
    description?: string;
    location?: string;
    attendees?: Attendee[];
    transparency?: Transparency;
    notifyAttendees?: boolean;
  }) =>
    request<CalendarEvent>('/events', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        start: new Date(input.start).toISOString(),
        end: new Date(input.end).toISOString(),
      }),
    }),
  updateEvent: (
    id: string,
    changes: {
      start?: number;
      end?: number;
      title?: string;
      description?: string;
      location?: string;
      /** The complete guest list; omit it to leave the guests alone. */
      attendees?: Attendee[];
      transparency?: Transparency;
      notifyAttendees?: boolean;
    },
  ) =>
    request<CalendarEvent>(`/events/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...changes,
        ...(changes.start === undefined ? {} : { start: new Date(changes.start).toISOString() }),
        ...(changes.end === undefined ? {} : { end: new Date(changes.end).toISOString() }),
      }),
    }),
  deleteEvent: (id: string, notify = false) =>
    request<void>(`/events/${id}?notify=${notify}`, { method: 'DELETE' }),

  // --- categories -----------------------------------------------------------
  categories: () => request<CategoryUsage[]>('/categories'),
  createCategory: (input: { name: string; color?: string; matchPattern?: string }) =>
    request<Category>('/categories', { method: 'POST', body: JSON.stringify(input) }),
  updateCategory: (id: string, changes: Partial<Category>) =>
    request<Category>(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  deleteCategory: (id: string) => request<unknown>(`/categories/${id}`, { method: 'DELETE' }),

  // --- data management ------------------------------------------------------
  dataStats: () => request<DataStats>('/maintenance/stats'),
  prune: (options: { days?: number; dryRun: boolean }) =>
    request<Record<string, number> & { dryRun: boolean }>('/maintenance/prune', {
      method: 'POST',
      body: JSON.stringify({
        dryRun: options.dryRun,
        ...(options.days === undefined
          ? {}
          : { before: new Date(Date.now() - options.days * 86_400_000).toISOString() }),
      }),
    }),
  reset: (scopes: string[], confirm: boolean, dryRun: boolean) =>
    request<{ dryRun: boolean; deleted: Record<string, number> }>('/maintenance/reset', {
      method: 'POST',
      body: JSON.stringify({ scopes, confirm, dryRun }),
    }),
  deleteCalendar: (id: string) =>
    request<{ events: number; blocksDetached: number }>(`/calendars/${id}`, { method: 'DELETE' }),

  // --- people ---------------------------------------------------------------
  // Linking is a local annotation. Nothing here sends a message or an invite:
  // the bridge's outbox is not reachable from this API at all.
  messagingStatus: () => request<MessagingStatus>('/messaging/status'),

  // --- outreach -------------------------------------------------------------
  // Nothing here sends a message. `sent` records that a human did.
  today: () => request<TodayView>('/today'),
  // Undo is a human action: the agent can delete but has no tool to reverse it.
  deletions: () => request<{ pending: PendingDeletion[] }>('/deletions'),
  /** Schedules the deletion and returns the window; nothing is removed yet. */
  deleteEventSoon: (id: string, notifyAttendees: boolean) =>
    request<PendingDeletion>(`/events/${id}/delete`, {
      method: 'POST',
      body: JSON.stringify({ notifyAttendees }),
    }),
  undoDeletion: (token: string) =>
    request<PendingDeletion>(`/deletions/${token}/undo`, { method: 'POST' }),
  outreach: () => request<{ outreach: Outreach[] }>('/outreach'),
  outreachStatus: () => request<OutreachStatus>('/outreach/status'),
  sendOutreach: (id: string) => request<Outreach>(`/outreach/${id}/send`, { method: 'POST' }),
  markOutreachSent: (id: string) => request<Outreach>(`/outreach/${id}/sent`, { method: 'POST' }),
  cancelOutreach: (id: string) => request<Outreach>(`/outreach/${id}`, { method: 'DELETE' }),
  recordOutreachReply: (id: string, text: string) =>
    request<Outreach>(`/outreach/${id}/reply`, { method: 'POST', body: JSON.stringify({ text }) }),
  searchContacts: (query: string, limit = 8) =>
    request<{ contacts: DirectoryContact[] }>(
      `/contacts?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  /** Events and blocks for an arbitrary window, so the grid can look backwards. */
  agenda: (start: number, end: number) =>
    request<{ events: CalendarEvent[]; blocks: ScheduleBlock[] }>(
      `/agenda?start=${encodeURIComponent(new Date(start).toISOString())}` +
        `&end=${encodeURIComponent(new Date(end).toISOString())}`,
    ),
  eventPeople: (eventId: string) =>
    request<{ people: LinkedPerson[] }>(`/events/${eventId}/people`),
  confirmMeeting: (eventId: string) =>
    request<{ kind: string; outreach?: Outreach }>(`/events/${eventId}/confirm`, {
      method: 'POST',
    }),
  eventPeopleSuggestions: (eventId: string) =>
    request<{ suggestions: LinkSuggestion[] }>(`/events/${eventId}/people/suggestions`),
  linkPerson: (
    eventId: string,
    input: { handle: string; displayName: string; contactId: string },
  ) =>
    request<EventContactLink>(`/events/${eventId}/people`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  unlinkPerson: (linkId: string) => request<void>(`/people/${linkId}`, { method: 'DELETE' }),
};
