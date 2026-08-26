/**
 * PostgreSQL schema.
 *
 * Timestamps are stored as `bigint` epoch milliseconds so they round-trip with
 * the domain's `Instant` type without any timezone reinterpretation. Nested
 * value objects that are always read as a whole (attendees, preferences,
 * change-set payloads) are stored as `jsonb`.
 */
export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

CREATE TABLE IF NOT EXISTS calendar_accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  status              TEXT NOT NULL,
  scopes              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_account_tokens (
  account_id    TEXT PRIMARY KEY REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    BIGINT,
  scope         TEXT,
  token_type    TEXT
);

CREATE TABLE IF NOT EXISTS calendars (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id              TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL,
  external_id             TEXT NOT NULL,
  name                    TEXT NOT NULL,
  description             TEXT,
  timezone                TEXT NOT NULL,
  is_primary              BOOLEAN NOT NULL DEFAULT FALSE,
  is_writable             BOOLEAN NOT NULL DEFAULT TRUE,
  include_in_availability BOOLEAN NOT NULL DEFAULT TRUE,
  is_task_target          BOOLEAN NOT NULL DEFAULT FALSE,
  color                   TEXT,
  selected                BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (user_id, account_id, external_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description           TEXT,
  estimated_minutes     INTEGER NOT NULL,
  completed_minutes     INTEGER NOT NULL DEFAULT 0,
  deadline              BIGINT,
  earliest_start        BIGINT,
  latest_start          BIGINT,
  priority              TEXT NOT NULL,
  importance            INTEGER NOT NULL,
  minimum_block_minutes INTEGER NOT NULL,
  maximum_block_minutes INTEGER,
  allow_splitting       BOOLEAN NOT NULL DEFAULT TRUE,
  preferred_windows     JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_days        JSONB NOT NULL DEFAULT '[]'::jsonb,
  focus                 TEXT NOT NULL DEFAULT 'any',
  tags                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_id            TEXT,
  calendar_id           TEXT,
  depends_on            JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                TEXT NOT NULL,
  pinned                BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL,
  completed_at          BIGINT
);
CREATE INDEX IF NOT EXISTS tasks_user_status_idx ON tasks (user_id, status);
CREATE INDEX IF NOT EXISTS tasks_deadline_idx ON tasks (user_id, deadline);

CREATE TABLE IF NOT EXISTS calendar_events (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  calendar_id        TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  location           TEXT,
  start_ms           BIGINT NOT NULL,
  end_ms             BIGINT NOT NULL,
  timezone           TEXT NOT NULL,
  is_all_day         BOOLEAN NOT NULL DEFAULT FALSE,
  is_recurring       BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_kind    TEXT NOT NULL DEFAULT 'single',
  series_external_id TEXT,
  recurrence_rules   JSONB,
  status             TEXT NOT NULL,
  transparency       TEXT NOT NULL,
  attendees          JSONB NOT NULL DEFAULT '[]'::jsonb,
  organizer          JSONB,
  is_organizer       BOOLEAN NOT NULL DEFAULT FALSE,
  classification     TEXT NOT NULL,
  is_movable         BOOLEAN NOT NULL DEFAULT FALSE,
  is_protected       BOOLEAN NOT NULL DEFAULT FALSE,
  task_id            TEXT,
  block_id           TEXT,
  etag               TEXT,
  conference_data    JSONB,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  UNIQUE (user_id, calendar_id, external_id)
);
CREATE INDEX IF NOT EXISTS calendar_events_range_idx ON calendar_events (user_id, start_ms, end_ms);

CREATE TABLE IF NOT EXISTS schedule_blocks (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'task',
  start_ms          BIGINT NOT NULL,
  end_ms            BIGINT NOT NULL,
  timezone          TEXT NOT NULL,
  sequence          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  pinned            BOOLEAN NOT NULL DEFAULT FALSE,
  calendar_id       TEXT,
  provider          TEXT,
  external_event_id TEXT,
  reason_code       TEXT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_blocks_range_idx ON schedule_blocks (user_id, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS schedule_blocks_task_idx ON schedule_blocks (task_id);

CREATE TABLE IF NOT EXISTS scheduling_preferences (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_states (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  provider        TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  sync_token      TEXT,
  delta_link      TEXT,
  last_synced_at  BIGINT,
  last_success_at BIGINT,
  last_error      TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  window_start    BIGINT,
  window_end      BIGINT,
  UNIQUE (user_id, calendar_id)
);

CREATE TABLE IF NOT EXISTS event_sync_records (
  user_id            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  calendar_id        TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  local_event_id     TEXT,
  last_known_start   BIGINT NOT NULL,
  last_known_end     BIGINT NOT NULL,
  last_known_etag    TEXT,
  last_local_write_at BIGINT,
  last_written_etag  TEXT,
  last_seen_at       BIGINT NOT NULL,
  PRIMARY KEY (user_id, calendar_id, external_id)
);

CREATE TABLE IF NOT EXISTS change_sets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  status     TEXT NOT NULL,
  payload    JSONB NOT NULL,
  applied_at BIGINT,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS change_sets_user_idx ON change_sets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  metadata        JSONB
);
CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx ON agent_messages (conversation_id, created_at);
`,
  },
  {
    id: '0002_app_settings',
    sql: `
CREATE TABLE IF NOT EXISTS app_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
`,
  },
  {
    id: '0003_categories',
    sql: `
CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,
  description   TEXT,
  match_pattern TEXT,
  calendar_id   TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS categories_user_idx ON categories (user_id, position);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS category_id TEXT;
`,
  },
  {
    id: '0004_event_contact_links',
    sql: `
CREATE TABLE IF NOT EXISTS event_contact_links (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  contact_id   TEXT NOT NULL,
  display_name TEXT NOT NULL,
  handle       TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (event_id, handle)
);
CREATE INDEX IF NOT EXISTS event_contact_links_user_idx ON event_contact_links (user_id);
CREATE INDEX IF NOT EXISTS event_contact_links_event_idx ON event_contact_links (event_id);
`,
  },
];
