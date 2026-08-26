import type { Pool, PoolClient, QueryResultRow } from 'pg';
import pg from 'pg';
import type {
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
  EventContactLink,
  EventContactLinkRepository,
  EventSyncRecord,
  PreferencesRepository,
  SettingsRepository,
  ScheduleBlock,
  ScheduleBlockRepository,
  AppSettings,
  SchedulingPreferences,
  StoredChangeSet,
  StoredConversation,
  StoredMessage,
  StoredTokens,
  SyncState,
  SyncStateRepository,
  Task,
  TaskRepository,
  User,
  UserRepository,
} from '@calendar-agent/core';
import { MIGRATIONS } from './schema.sql.js';

const num = (value: unknown): number => Number(value);
const optNum = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);
const opt = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : (value ?? undefined);

/**
 * PostgreSQL-backed implementation of every repository port.
 *
 * The SQL lives in `schema.sql.ts`; this file only maps rows to and from the
 * domain model. Nothing here leaks above the repository interfaces.
 */
export class PostgresDatabase implements Database {
  private readonly pool: Pool;

  readonly users: UserRepository;
  readonly tasks: TaskRepository;
  readonly events: CalendarEventRepository;
  readonly blocks: ScheduleBlockRepository;
  readonly calendars: CalendarRepository;
  readonly accounts: CalendarAccountRepository;
  readonly categories: CategoryRepository;
  readonly contactLinks: EventContactLinkRepository;
  readonly preferences: PreferencesRepository;
  readonly settings: SettingsRepository;
  readonly syncState: SyncStateRepository;
  readonly changeSets: ChangeSetRepository;
  readonly conversations: ConversationRepository;

  constructor(connectionString: string, poolOverride?: Pool) {
    this.pool = poolOverride ?? new pg.Pool({ connectionString });
    const query = <T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> =>
      this.pool.query<T>(sql, params).then((result) => result.rows);

    this.users = {
      async get(id) {
        const rows = await query('SELECT * FROM users WHERE id = $1', [id]);
        return rows[0] ? toUser(rows[0]) : undefined;
      },
      async findByEmail(email) {
        const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
        return rows[0] ? toUser(rows[0]) : undefined;
      },
      async save(user) {
        await query(
          `INSERT INTO users (id, email, display_name, timezone, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET
             email = EXCLUDED.email, display_name = EXCLUDED.display_name,
             timezone = EXCLUDED.timezone, updated_at = EXCLUDED.updated_at`,
          [user.id, user.email, user.displayName, user.timezone, user.createdAt, user.updatedAt],
        );
        return user;
      },
    };

    const saveTask = async (task: Task): Promise<void> => {
      await query(
        `INSERT INTO tasks (
           id, user_id, title, description, estimated_minutes, completed_minutes, deadline,
           earliest_start, latest_start, priority, importance, minimum_block_minutes,
           maximum_block_minutes, allow_splitting, preferred_windows, preferred_days, focus,
           tags, project_id, calendar_id, depends_on, status, pinned, created_at, updated_at,
           completed_at, category_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,$25,$26,$27)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description,
           estimated_minutes = EXCLUDED.estimated_minutes,
           completed_minutes = EXCLUDED.completed_minutes, deadline = EXCLUDED.deadline,
           earliest_start = EXCLUDED.earliest_start, latest_start = EXCLUDED.latest_start,
           priority = EXCLUDED.priority, importance = EXCLUDED.importance,
           minimum_block_minutes = EXCLUDED.minimum_block_minutes,
           maximum_block_minutes = EXCLUDED.maximum_block_minutes,
           allow_splitting = EXCLUDED.allow_splitting,
           preferred_windows = EXCLUDED.preferred_windows,
           preferred_days = EXCLUDED.preferred_days, focus = EXCLUDED.focus, tags = EXCLUDED.tags,
           project_id = EXCLUDED.project_id, calendar_id = EXCLUDED.calendar_id,
           depends_on = EXCLUDED.depends_on, status = EXCLUDED.status, pinned = EXCLUDED.pinned,
           updated_at = EXCLUDED.updated_at, completed_at = EXCLUDED.completed_at,
           category_id = EXCLUDED.category_id`,
        [
          task.id,
          task.userId,
          task.title,
          task.description ?? null,
          task.estimatedMinutes,
          task.completedMinutes,
          task.deadline ?? null,
          task.earliestStart ?? null,
          task.latestStart ?? null,
          task.priority,
          task.importance,
          task.minimumBlockMinutes,
          task.maximumBlockMinutes ?? null,
          task.allowSplitting,
          JSON.stringify(task.preferredWindows),
          JSON.stringify(task.preferredDays),
          task.focus,
          JSON.stringify(task.tags),
          task.projectId ?? null,
          task.calendarId ?? null,
          JSON.stringify(task.dependsOn),
          task.status,
          task.pinned,
          task.createdAt,
          task.updatedAt,
          task.completedAt ?? null,
          task.categoryId ?? null,
        ],
      );
    };

    this.tasks = {
      async get(id) {
        const rows = await query('SELECT * FROM tasks WHERE id = $1', [id]);
        return rows[0] ? toTask(rows[0]) : undefined;
      },
      async list(q) {
        const conditions = ['user_id = $1'];
        const params: unknown[] = [q.userId];
        if (q.statuses?.length) {
          params.push(q.statuses);
          conditions.push(`status = ANY($${params.length})`);
        }
        if (q.deadlineBefore !== undefined) {
          params.push(q.deadlineBefore);
          conditions.push(`deadline IS NOT NULL AND deadline <= $${params.length}`);
        }
        if (q.search) {
          params.push(`%${q.search}%`);
          conditions.push(
            `(title ILIKE $${params.length} OR COALESCE(description, '') ILIKE $${params.length})`,
          );
        }
        if (q.tags?.length) {
          params.push(JSON.stringify(q.tags));
          conditions.push(
            `tags @> ANY(ARRAY(SELECT jsonb_array_elements($${params.length}::jsonb)))`,
          );
        }
        const rows = await query(
          `SELECT * FROM tasks WHERE ${conditions.join(' AND ')}
           ORDER BY deadline NULLS LAST, created_at`,
          params,
        );
        return rows.map(toTask);
      },
      async save(task) {
        await saveTask(task);
        return task;
      },
      async saveMany(tasks) {
        for (const task of tasks) await saveTask(task);
      },
      async delete(id) {
        await query('DELETE FROM tasks WHERE id = $1', [id]);
      },
    };

    const saveEvent = async (event: CalendarEvent): Promise<void> => {
      await query(
        `INSERT INTO calendar_events (
           id, user_id, provider, calendar_id, external_id, title, description, location,
           start_ms, end_ms, timezone, is_all_day, is_recurring, recurrence_kind,
           series_external_id, recurrence_rules, status, transparency, attendees, organizer,
           is_organizer, classification, is_movable, is_protected, task_id, block_id, etag,
           conference_data, created_at, updated_at, category_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,$25,$26,$27,$28,$29,$30,$31)
         ON CONFLICT (user_id, calendar_id, external_id) DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description,
           location = EXCLUDED.location, start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms,
           timezone = EXCLUDED.timezone, is_all_day = EXCLUDED.is_all_day,
           is_recurring = EXCLUDED.is_recurring, recurrence_kind = EXCLUDED.recurrence_kind,
           series_external_id = EXCLUDED.series_external_id,
           recurrence_rules = EXCLUDED.recurrence_rules, status = EXCLUDED.status,
           transparency = EXCLUDED.transparency, attendees = EXCLUDED.attendees,
           organizer = EXCLUDED.organizer, is_organizer = EXCLUDED.is_organizer,
           classification = EXCLUDED.classification, is_movable = EXCLUDED.is_movable,
           is_protected = EXCLUDED.is_protected, task_id = EXCLUDED.task_id,
           block_id = EXCLUDED.block_id, etag = EXCLUDED.etag,
           conference_data = EXCLUDED.conference_data, updated_at = EXCLUDED.updated_at,
           category_id = EXCLUDED.category_id`,
        [
          event.id,
          event.userId,
          event.provider,
          event.calendarId,
          event.externalId,
          event.title,
          event.description ?? null,
          event.location ?? null,
          event.start,
          event.end,
          event.timezone,
          event.isAllDay,
          event.isRecurring,
          event.recurrenceKind,
          event.seriesExternalId ?? null,
          event.recurrenceRules ? JSON.stringify(event.recurrenceRules) : null,
          event.status,
          event.transparency,
          JSON.stringify(event.attendees),
          event.organizer ? JSON.stringify(event.organizer) : null,
          event.isOrganizer,
          event.classification,
          event.isMovable,
          event.isProtected,
          event.taskId ?? null,
          event.blockId ?? null,
          event.etag ?? null,
          event.conferenceData ? JSON.stringify(event.conferenceData) : null,
          event.createdAt,
          event.updatedAt,
          event.categoryId ?? null,
        ],
      );
    };

    this.events = {
      async get(id) {
        const rows = await query('SELECT * FROM calendar_events WHERE id = $1', [id]);
        return rows[0] ? toEvent(rows[0]) : undefined;
      },
      async findByExternalId(userId, provider, calendarId, externalId) {
        const rows = await query(
          `SELECT * FROM calendar_events
           WHERE user_id = $1 AND provider = $2 AND calendar_id = $3 AND external_id = $4`,
          [userId, provider, calendarId, externalId],
        );
        return rows[0] ? toEvent(rows[0]) : undefined;
      },
      async list(q) {
        const params: unknown[] = [q.userId, q.range.start, q.range.end];
        let sql = `SELECT * FROM calendar_events
                   WHERE user_id = $1 AND start_ms < $3 AND end_ms > $2`;
        if (q.calendarIds?.length) {
          params.push(q.calendarIds);
          sql += ` AND calendar_id = ANY($${params.length})`;
        }
        const rows = await query(`${sql} ORDER BY start_ms`, params);
        return rows.map(toEvent);
      },
      async save(event) {
        await saveEvent(event);
        return event;
      },
      async saveMany(events) {
        for (const event of events) await saveEvent(event);
      },
      async delete(id) {
        await query('DELETE FROM calendar_events WHERE id = $1', [id]);
      },
      async deleteByExternalIds(userId, calendarId, externalIds) {
        if (externalIds.length === 0) return;
        await query(
          `DELETE FROM calendar_events
           WHERE user_id = $1 AND calendar_id = $2 AND external_id = ANY($3)`,
          [userId, calendarId, externalIds],
        );
      },
    };

    const saveBlock = async (block: ScheduleBlock): Promise<void> => {
      await query(
        `INSERT INTO schedule_blocks (
           id, user_id, task_id, kind, start_ms, end_ms, timezone, sequence, status, pinned,
           calendar_id, provider, external_event_id, reason_code, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           task_id = EXCLUDED.task_id, kind = EXCLUDED.kind, start_ms = EXCLUDED.start_ms,
           end_ms = EXCLUDED.end_ms, timezone = EXCLUDED.timezone, sequence = EXCLUDED.sequence,
           status = EXCLUDED.status, pinned = EXCLUDED.pinned, calendar_id = EXCLUDED.calendar_id,
           provider = EXCLUDED.provider, external_event_id = EXCLUDED.external_event_id,
           reason_code = EXCLUDED.reason_code, updated_at = EXCLUDED.updated_at`,
        [
          block.id,
          block.userId,
          block.taskId,
          block.kind,
          block.start,
          block.end,
          block.timezone,
          block.sequence,
          block.status,
          block.pinned,
          block.calendarId ?? null,
          block.provider ?? null,
          block.externalEventId ?? null,
          block.reasonCode ?? null,
          block.createdAt,
          block.updatedAt,
        ],
      );
    };

    this.blocks = {
      async get(id) {
        const rows = await query('SELECT * FROM schedule_blocks WHERE id = $1', [id]);
        return rows[0] ? toBlock(rows[0]) : undefined;
      },
      async list(q) {
        const conditions = ['user_id = $1'];
        const params: unknown[] = [q.userId];
        if (q.range) {
          params.push(q.range.start, q.range.end);
          conditions.push(`start_ms < $${params.length} AND end_ms > $${params.length - 1}`);
        }
        if (q.taskIds?.length) {
          params.push(q.taskIds);
          conditions.push(`task_id = ANY($${params.length})`);
        }
        if (q.statuses?.length) {
          params.push(q.statuses);
          conditions.push(`status = ANY($${params.length})`);
        }
        const rows = await query(
          `SELECT * FROM schedule_blocks WHERE ${conditions.join(' AND ')} ORDER BY start_ms`,
          params,
        );
        return rows.map(toBlock);
      },
      async save(block) {
        await saveBlock(block);
        return block;
      },
      async saveMany(blocks) {
        for (const block of blocks) await saveBlock(block);
      },
      async delete(id) {
        await query('DELETE FROM schedule_blocks WHERE id = $1', [id]);
      },
      async deleteMany(ids) {
        if (ids.length === 0) return;
        await query('DELETE FROM schedule_blocks WHERE id = ANY($1)', [ids]);
      },
    };

    this.calendars = {
      async get(id) {
        const rows = await query('SELECT * FROM calendars WHERE id = $1', [id]);
        return rows[0] ? toCalendar(rows[0]) : undefined;
      },
      async list(userId) {
        const rows = await query(
          'SELECT * FROM calendars WHERE user_id = $1 ORDER BY is_primary DESC, name',
          [userId],
        );
        return rows.map(toCalendar);
      },
      async findByExternalId(userId, accountId, externalId) {
        const rows = await query(
          'SELECT * FROM calendars WHERE user_id = $1 AND account_id = $2 AND external_id = $3',
          [userId, accountId, externalId],
        );
        return rows[0] ? toCalendar(rows[0]) : undefined;
      },
      async save(calendar) {
        await query(
          `INSERT INTO calendars (
             id, user_id, account_id, provider, external_id, name, description, timezone,
             is_primary, is_writable, include_in_availability, is_task_target, color, selected)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, description = EXCLUDED.description,
             timezone = EXCLUDED.timezone, is_primary = EXCLUDED.is_primary,
             is_writable = EXCLUDED.is_writable,
             include_in_availability = EXCLUDED.include_in_availability,
             is_task_target = EXCLUDED.is_task_target, color = EXCLUDED.color,
             selected = EXCLUDED.selected`,
          [
            calendar.id,
            calendar.userId,
            calendar.accountId,
            calendar.provider,
            calendar.externalId,
            calendar.name,
            calendar.description ?? null,
            calendar.timezone,
            calendar.isPrimary,
            calendar.isWritable,
            calendar.includeInAvailability,
            calendar.isTaskTarget,
            calendar.color ?? null,
            calendar.selected,
          ],
        );
        return calendar;
      },
      async delete(id) {
        await query('DELETE FROM calendars WHERE id = $1', [id]);
      },
    };

    this.accounts = {
      async get(id) {
        const rows = await query('SELECT * FROM calendar_accounts WHERE id = $1', [id]);
        return rows[0] ? toAccount(rows[0]) : undefined;
      },
      async list(userId) {
        const rows = await query('SELECT * FROM calendar_accounts WHERE user_id = $1', [userId]);
        return rows.map(toAccount);
      },
      async save(account) {
        await query(
          `INSERT INTO calendar_accounts (
             id, user_id, provider, external_account_id, display_name, status, scopes,
             created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET
             display_name = EXCLUDED.display_name, status = EXCLUDED.status,
             scopes = EXCLUDED.scopes, updated_at = EXCLUDED.updated_at`,
          [
            account.id,
            account.userId,
            account.provider,
            account.externalAccountId,
            account.displayName,
            account.status,
            JSON.stringify(account.scopes),
            account.createdAt,
            account.updatedAt,
          ],
        );
        return account;
      },
      async delete(id) {
        await query('DELETE FROM calendar_accounts WHERE id = $1', [id]);
      },
      async readTokens(accountId) {
        const rows = await query('SELECT * FROM calendar_account_tokens WHERE account_id = $1', [
          accountId,
        ]);
        const row = rows[0];
        if (!row) return undefined;
        return {
          accessToken: String(row.access_token),
          refreshToken: opt(row.refresh_token) as string | undefined,
          expiresAt: optNum(row.expires_at),
          scope: opt(row.scope) as string | undefined,
          tokenType: opt(row.token_type) as string | undefined,
        };
      },
      async writeTokens(accountId, tokens: StoredTokens) {
        await query(
          `INSERT INTO calendar_account_tokens (
             account_id, access_token, refresh_token, expires_at, scope, token_type)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (account_id) DO UPDATE SET
             access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
             expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope,
             token_type = EXCLUDED.token_type`,
          [
            accountId,
            tokens.accessToken,
            tokens.refreshToken ?? null,
            tokens.expiresAt ?? null,
            tokens.scope ?? null,
            tokens.tokenType ?? null,
          ],
        );
      },
    };

    this.categories = {
      async get(id) {
        const rows = await query('SELECT * FROM categories WHERE id = $1', [id]);
        return rows[0] ? toCategory(rows[0]) : undefined;
      },
      async list(userId) {
        const rows = await query(
          'SELECT * FROM categories WHERE user_id = $1 ORDER BY position, name',
          [userId],
        );
        return rows.map(toCategory);
      },
      async save(category) {
        await query(
          `INSERT INTO categories (
             id, user_id, name, color, description, match_pattern, calendar_id, is_default,
             position, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, color = EXCLUDED.color,
             description = EXCLUDED.description, match_pattern = EXCLUDED.match_pattern,
             calendar_id = EXCLUDED.calendar_id, is_default = EXCLUDED.is_default,
             position = EXCLUDED.position, updated_at = EXCLUDED.updated_at`,
          [
            category.id,
            category.userId,
            category.name,
            category.color,
            category.description ?? null,
            category.matchPattern ?? null,
            category.calendarId ?? null,
            category.isDefault,
            category.position,
            category.createdAt,
            category.updatedAt,
          ],
        );
        return category;
      },
      async delete(id) {
        await query('DELETE FROM categories WHERE id = $1', [id]);
      },
    };

    this.contactLinks = {
      async get(id) {
        const rows = await query('SELECT * FROM event_contact_links WHERE id = $1', [id]);
        return rows[0] ? toContactLink(rows[0]) : undefined;
      },
      async list(userId) {
        const rows = await query(
          'SELECT * FROM event_contact_links WHERE user_id = $1 ORDER BY created_at',
          [userId],
        );
        return rows.map(toContactLink);
      },
      async listByEvent(eventId) {
        const rows = await query(
          'SELECT * FROM event_contact_links WHERE event_id = $1 ORDER BY created_at',
          [eventId],
        );
        return rows.map(toContactLink);
      },
      async save(link) {
        await query(
          `INSERT INTO event_contact_links (
             id, user_id, event_id, contact_id, display_name, handle, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             contact_id = EXCLUDED.contact_id, display_name = EXCLUDED.display_name,
             handle = EXCLUDED.handle, source = EXCLUDED.source`,
          [
            link.id,
            link.userId,
            link.eventId,
            link.contactId,
            link.displayName,
            link.handle,
            link.source,
            link.createdAt,
          ],
        );
        return link;
      },
      async delete(id) {
        await query('DELETE FROM event_contact_links WHERE id = $1', [id]);
      },
      async deleteByEvent(eventId) {
        await query('DELETE FROM event_contact_links WHERE event_id = $1', [eventId]);
      },
    };

    this.preferences = {
      async get(userId) {
        const rows = await query('SELECT * FROM scheduling_preferences WHERE user_id = $1', [
          userId,
        ]);
        return rows[0] ? (rows[0].data as SchedulingPreferences) : undefined;
      },
      async save(preferences) {
        await query(
          `INSERT INTO scheduling_preferences (user_id, data, updated_at)
           VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [preferences.userId, JSON.stringify(preferences), preferences.updatedAt],
        );
        return preferences;
      },
    };

    this.settings = {
      async get(userId) {
        const rows = await query('SELECT * FROM app_settings WHERE user_id = $1', [userId]);
        return rows[0] ? (rows[0].data as AppSettings) : undefined;
      },
      async save(settings) {
        await query(
          `INSERT INTO app_settings (user_id, data, updated_at)
           VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [settings.userId, JSON.stringify(settings), settings.updatedAt],
        );
        return settings;
      },
    };

    this.syncState = {
      async get(userId, calendarId) {
        const rows = await query(
          'SELECT * FROM sync_states WHERE user_id = $1 AND calendar_id = $2',
          [userId, calendarId],
        );
        return rows[0] ? toSyncState(rows[0]) : undefined;
      },
      async list(userId) {
        const rows = await query('SELECT * FROM sync_states WHERE user_id = $1', [userId]);
        return rows.map(toSyncState);
      },
      async save(state) {
        await query(
          `INSERT INTO sync_states (
             id, user_id, provider, calendar_id, sync_token, delta_link, last_synced_at,
             last_success_at, last_error, failure_count, window_start, window_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (user_id, calendar_id) DO UPDATE SET
             sync_token = EXCLUDED.sync_token, delta_link = EXCLUDED.delta_link,
             last_synced_at = EXCLUDED.last_synced_at, last_success_at = EXCLUDED.last_success_at,
             last_error = EXCLUDED.last_error, failure_count = EXCLUDED.failure_count,
             window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end`,
          [
            state.id,
            state.userId,
            state.provider,
            state.calendarId,
            state.syncToken ?? null,
            state.deltaLink ?? null,
            state.lastSyncedAt ?? null,
            state.lastSuccessAt ?? null,
            state.lastError ?? null,
            state.failureCount,
            state.windowStart ?? null,
            state.windowEnd ?? null,
          ],
        );
        return state;
      },
      async delete(userId, calendarId) {
        await query('DELETE FROM sync_states WHERE user_id = $1 AND calendar_id = $2', [
          userId,
          calendarId,
        ]);
        await query('DELETE FROM event_sync_records WHERE user_id = $1 AND calendar_id = $2', [
          userId,
          calendarId,
        ]);
      },
      async getEventRecord(userId, calendarId, externalId) {
        const rows = await query(
          `SELECT * FROM event_sync_records
           WHERE user_id = $1 AND calendar_id = $2 AND external_id = $3`,
          [userId, calendarId, externalId],
        );
        return rows[0] ? toEventSyncRecord(rows[0]) : undefined;
      },
      async saveEventRecord(record) {
        await query(
          `INSERT INTO event_sync_records (
             user_id, provider, calendar_id, external_id, local_event_id, last_known_start,
             last_known_end, last_known_etag, last_local_write_at, last_written_etag, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (user_id, calendar_id, external_id) DO UPDATE SET
             local_event_id = EXCLUDED.local_event_id,
             last_known_start = EXCLUDED.last_known_start,
             last_known_end = EXCLUDED.last_known_end,
             last_known_etag = EXCLUDED.last_known_etag,
             last_local_write_at = EXCLUDED.last_local_write_at,
             last_written_etag = EXCLUDED.last_written_etag,
             last_seen_at = EXCLUDED.last_seen_at`,
          [
            record.userId,
            record.provider,
            record.calendarId,
            record.externalId,
            record.localEventId ?? null,
            record.lastKnownStart,
            record.lastKnownEnd,
            record.lastKnownEtag ?? null,
            record.lastLocalWriteAt ?? null,
            record.lastWrittenEtag ?? null,
            record.lastSeenAt,
          ],
        );
      },
      async deleteEventRecord(userId, calendarId, externalId) {
        await query(
          `DELETE FROM event_sync_records
           WHERE user_id = $1 AND calendar_id = $2 AND external_id = $3`,
          [userId, calendarId, externalId],
        );
      },
    };

    this.changeSets = {
      async get(id) {
        const rows = await query('SELECT * FROM change_sets WHERE id = $1', [id]);
        return rows[0] ? toChangeSet(rows[0]) : undefined;
      },
      async list(userId, limit = 20) {
        const rows = await query(
          'SELECT * FROM change_sets WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
          [userId, limit],
        );
        return rows.map(toChangeSet);
      },
      async save(changeSet) {
        await query(
          `INSERT INTO change_sets (id, user_id, created_at, status, payload, applied_at, error)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, payload = EXCLUDED.payload,
             applied_at = EXCLUDED.applied_at, error = EXCLUDED.error`,
          [
            changeSet.id,
            changeSet.userId,
            changeSet.createdAt,
            changeSet.status,
            JSON.stringify(changeSet.payload),
            changeSet.appliedAt ?? null,
            changeSet.error ?? null,
          ],
        );
        return changeSet;
      },
    };

    this.conversations = {
      async getConversation(id) {
        const rows = await query('SELECT * FROM agent_conversations WHERE id = $1', [id]);
        return rows[0] ? toConversation(rows[0]) : undefined;
      },
      async listConversations(userId, limit = 20) {
        const rows = await query(
          'SELECT * FROM agent_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
          [userId, limit],
        );
        return rows.map(toConversation);
      },
      async saveConversation(conversation) {
        await query(
          `INSERT INTO agent_conversations (id, user_id, title, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_at = EXCLUDED.updated_at`,
          [
            conversation.id,
            conversation.userId,
            conversation.title,
            conversation.createdAt,
            conversation.updatedAt,
          ],
        );
        return conversation;
      },
      async listMessages(conversationId, limit = 100) {
        const rows = await query(
          `SELECT * FROM agent_messages WHERE conversation_id = $1
           ORDER BY created_at DESC LIMIT $2`,
          [conversationId, limit],
        );
        return rows.map(toMessage).reverse();
      },
      async appendMessage(message) {
        await query(
          `INSERT INTO agent_messages (id, conversation_id, role, content, created_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            message.id,
            message.conversationId,
            message.role,
            message.content,
            message.createdAt,
            message.metadata ? JSON.stringify(message.metadata) : null,
          ],
        );
        return message;
      },
    };
  }

  async migrate(): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)',
      );
      const applied = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
      const done = new Set(applied.rows.map((row) => row.id));
      for (const migration of MIGRATIONS) {
        if (done.has(migration.id)) continue;
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [
          migration.id,
          Date.now(),
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toUser(row: QueryResultRow): User {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    timezone: String(row.timezone),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toTask(row: QueryResultRow): Task {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    description: opt(row.description) as string | undefined,
    estimatedMinutes: num(row.estimated_minutes),
    completedMinutes: num(row.completed_minutes),
    deadline: optNum(row.deadline),
    earliestStart: optNum(row.earliest_start),
    latestStart: optNum(row.latest_start),
    priority: row.priority as Task['priority'],
    importance: num(row.importance),
    minimumBlockMinutes: num(row.minimum_block_minutes),
    maximumBlockMinutes: optNum(row.maximum_block_minutes),
    allowSplitting: Boolean(row.allow_splitting),
    preferredWindows: (row.preferred_windows ?? []) as Task['preferredWindows'],
    preferredDays: (row.preferred_days ?? []) as Task['preferredDays'],
    focus: row.focus as Task['focus'],
    tags: (row.tags ?? []) as string[],
    projectId: opt(row.project_id) as string | undefined,
    calendarId: opt(row.calendar_id) as string | undefined,
    dependsOn: (row.depends_on ?? []) as string[],
    status: row.status as Task['status'],
    pinned: Boolean(row.pinned),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    completedAt: optNum(row.completed_at),
    categoryId: opt(row.category_id) as string | undefined,
  };
}

function toEvent(row: QueryResultRow): CalendarEvent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider),
    calendarId: String(row.calendar_id),
    externalId: String(row.external_id),
    title: String(row.title),
    description: opt(row.description) as string | undefined,
    location: opt(row.location) as string | undefined,
    start: num(row.start_ms),
    end: num(row.end_ms),
    timezone: String(row.timezone),
    isAllDay: Boolean(row.is_all_day),
    isRecurring: Boolean(row.is_recurring),
    recurrenceKind: row.recurrence_kind as CalendarEvent['recurrenceKind'],
    seriesExternalId: opt(row.series_external_id) as string | undefined,
    recurrenceRules: (opt(row.recurrence_rules) ?? undefined) as string[] | undefined,
    status: row.status as CalendarEvent['status'],
    transparency: row.transparency as CalendarEvent['transparency'],
    attendees: (row.attendees ?? []) as CalendarEvent['attendees'],
    organizer: (opt(row.organizer) ?? undefined) as CalendarEvent['organizer'],
    isOrganizer: Boolean(row.is_organizer),
    classification: row.classification as CalendarEvent['classification'],
    isMovable: Boolean(row.is_movable),
    isProtected: Boolean(row.is_protected),
    taskId: opt(row.task_id) as string | undefined,
    blockId: opt(row.block_id) as string | undefined,
    etag: opt(row.etag) as string | undefined,
    conferenceData: opt(row.conference_data),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    categoryId: opt(row.category_id) as string | undefined,
  };
}

function toCategory(row: QueryResultRow): Category {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    color: String(row.color),
    description: opt(row.description) as string | undefined,
    matchPattern: opt(row.match_pattern) as string | undefined,
    calendarId: opt(row.calendar_id) as string | undefined,
    isDefault: Boolean(row.is_default),
    position: num(row.position),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toContactLink(row: QueryResultRow): EventContactLink {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    eventId: String(row.event_id),
    contactId: String(row.contact_id),
    displayName: String(row.display_name),
    handle: String(row.handle),
    source: String(row.source) as EventContactLink['source'],
    createdAt: num(row.created_at),
  };
}

function toBlock(row: QueryResultRow): ScheduleBlock {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    taskId: String(row.task_id),
    kind: row.kind as ScheduleBlock['kind'],
    start: num(row.start_ms),
    end: num(row.end_ms),
    timezone: String(row.timezone),
    sequence: num(row.sequence),
    status: row.status as ScheduleBlock['status'],
    pinned: Boolean(row.pinned),
    calendarId: opt(row.calendar_id) as string | undefined,
    provider: opt(row.provider) as string | undefined,
    externalEventId: opt(row.external_event_id) as string | undefined,
    reasonCode: opt(row.reason_code) as string | undefined,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toCalendar(row: QueryResultRow): Calendar {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    accountId: String(row.account_id),
    provider: String(row.provider),
    externalId: String(row.external_id),
    name: String(row.name),
    description: opt(row.description) as string | undefined,
    timezone: String(row.timezone),
    isPrimary: Boolean(row.is_primary),
    isWritable: Boolean(row.is_writable),
    includeInAvailability: Boolean(row.include_in_availability),
    isTaskTarget: Boolean(row.is_task_target),
    color: opt(row.color) as string | undefined,
    selected: Boolean(row.selected),
  };
}

function toAccount(row: QueryResultRow): CalendarAccount {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider),
    externalAccountId: String(row.external_account_id),
    displayName: String(row.display_name),
    status: row.status as CalendarAccount['status'],
    scopes: (row.scopes ?? []) as string[],
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toSyncState(row: QueryResultRow): SyncState {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider),
    calendarId: String(row.calendar_id),
    syncToken: opt(row.sync_token) as string | undefined,
    deltaLink: opt(row.delta_link) as string | undefined,
    lastSyncedAt: optNum(row.last_synced_at),
    lastSuccessAt: optNum(row.last_success_at),
    lastError: opt(row.last_error) as string | undefined,
    failureCount: num(row.failure_count),
    windowStart: optNum(row.window_start),
    windowEnd: optNum(row.window_end),
  };
}

function toEventSyncRecord(row: QueryResultRow): EventSyncRecord {
  return {
    userId: String(row.user_id),
    provider: String(row.provider),
    calendarId: String(row.calendar_id),
    externalId: String(row.external_id),
    localEventId: opt(row.local_event_id) as string | undefined,
    lastKnownStart: num(row.last_known_start),
    lastKnownEnd: num(row.last_known_end),
    lastKnownEtag: opt(row.last_known_etag) as string | undefined,
    lastLocalWriteAt: optNum(row.last_local_write_at),
    lastWrittenEtag: opt(row.last_written_etag) as string | undefined,
    lastSeenAt: num(row.last_seen_at),
  };
}

function toChangeSet(row: QueryResultRow): StoredChangeSet {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    createdAt: num(row.created_at),
    status: row.status as StoredChangeSet['status'],
    payload: row.payload,
    appliedAt: optNum(row.applied_at),
    error: opt(row.error) as string | undefined,
  };
}

function toConversation(row: QueryResultRow): StoredConversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toMessage(row: QueryResultRow): StoredMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as StoredMessage['role'],
    content: String(row.content),
    createdAt: num(row.created_at),
    metadata: (opt(row.metadata) ?? undefined) as Record<string, unknown> | undefined,
  };
}
