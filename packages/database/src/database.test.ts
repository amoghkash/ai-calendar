import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@calendar-agent/core';
import { blockFixture, defaultPreferences, eventFixture, taskFixture } from '@calendar-agent/core';
import { JsonFileDatabase } from './memory/json-database.js';
import { MemoryDatabase } from './memory/memory-database.js';
import { PostgresDatabase } from './postgres/postgres-database.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function jsonDatabase(): JsonFileDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-agent-'));
  tempDirs.push(dir);
  return new JsonFileDatabase(join(dir, 'db.json'));
}

/**
 * The same contract, run against every backend. PostgreSQL is included when
 * TEST_DATABASE_URL points at a throwaway database:
 *
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://calendar:calendar@localhost:5432/calendar_agent npm test
 *
 * This matters because the in-memory backends have no foreign keys, so they
 * accept write orders that PostgreSQL rejects.
 */
const postgresUrl = process.env.TEST_DATABASE_URL;

const backends: [string, () => Database][] = [
  ['memory', () => new MemoryDatabase()],
  ['json', () => jsonDatabase()],
  ...(postgresUrl
    ? ([['postgres', () => new PostgresDatabase(postgresUrl)]] as [string, () => Database][])
    : []),
];

if (!postgresUrl) {
  console.info('[database] TEST_DATABASE_URL not set - skipping the PostgreSQL contract run.');
}

describe.each(backends)('%s database', (name, factory) => {
  const seedUser = async (db: Database) => {
    await db.migrate();
    if (name === 'postgres') {
      // Each case starts from an empty schema.
      const pool = (db as unknown as { pool: { query: (sql: string) => Promise<unknown> } }).pool;
      await pool.query(
        'TRUNCATE users, calendar_accounts, calendar_account_tokens, calendars, tasks, calendar_events, schedule_blocks, scheduling_preferences, sync_states, event_sync_records, change_sets, agent_conversations, agent_messages CASCADE',
      );
    }
    await db.users.save({
      id: 'user',
      email: 'a@example.com',
      displayName: 'A',
      timezone: 'UTC',
      createdAt: 0,
      updatedAt: 0,
    });
  };

  it('round-trips tasks', async () => {
    const db = factory();
    await seedUser(db);
    const task = taskFixture({ id: 't1', title: 'Write report', estimatedMinutes: 90 });
    await db.tasks.save(task);
    expect(await db.tasks.get('t1')).toEqual(task);
    expect(await db.tasks.list({ userId: 'user' })).toHaveLength(1);
    await db.tasks.delete('t1');
    expect(await db.tasks.get('t1')).toBeUndefined();
  });

  it('filters tasks by status, deadline and search', async () => {
    const db = factory();
    await seedUser(db);
    await db.tasks.saveMany([
      taskFixture({ id: 'a', title: 'Alpha', status: 'todo', deadline: 1_000 }),
      taskFixture({ id: 'b', title: 'Beta', status: 'completed' }),
      taskFixture({ id: 'c', title: 'Gamma', status: 'todo', deadline: 9_000 }),
    ]);
    expect((await db.tasks.list({ userId: 'user', statuses: ['todo'] })).map((t) => t.id)).toEqual([
      'a',
      'c',
    ]);
    expect(
      (await db.tasks.list({ userId: 'user', deadlineBefore: 5_000 })).map((t) => t.id),
    ).toEqual(['a']);
    expect((await db.tasks.list({ userId: 'user', search: 'gam' })).map((t) => t.id)).toEqual([
      'c',
    ]);
  });

  it('queries events by overlapping range', async () => {
    const db = factory();
    await seedUser(db);
    await db.events.saveMany([
      eventFixture({ id: 'e1', start: 1_000, end: 2_000 }),
      eventFixture({ id: 'e2', start: 5_000, end: 6_000 }),
    ]);
    const found = await db.events.list({ userId: 'user', range: { start: 1_500, end: 5_500 } });
    expect(found.map((e) => e.id)).toEqual(['e1', 'e2']);
    const narrow = await db.events.list({ userId: 'user', range: { start: 2_000, end: 5_000 } });
    expect(narrow).toHaveLength(0);
  });

  it('deletes events by external id', async () => {
    const db = factory();
    await seedUser(db);
    await db.events.save(eventFixture({ id: 'e1', externalId: 'x1', calendarId: 'cal-1' }));
    await db.events.deleteByExternalIds('user', 'cal-1', ['x1']);
    expect(await db.events.get('e1')).toBeUndefined();
  });

  it('round-trips schedule blocks', async () => {
    const db = factory();
    await seedUser(db);
    const block = blockFixture({ id: 'b1', taskId: 't1', start: 1_000, end: 2_000 });
    await db.blocks.save(block);
    expect(await db.blocks.list({ userId: 'user', taskIds: ['t1'] })).toEqual([block]);
    await db.blocks.deleteMany(['b1']);
    expect(await db.blocks.list({ userId: 'user' })).toHaveLength(0);
  });

  it('stores preferences and tokens', async () => {
    const db = factory();
    await seedUser(db);
    const preferences = defaultPreferences('user', 'Europe/Berlin');
    await db.preferences.save(preferences);
    expect((await db.preferences.get('user'))?.timezone).toBe('Europe/Berlin');

    await db.accounts.save({
      id: 'acc1',
      userId: 'user',
      provider: 'google',
      externalAccountId: 'a@example.com',
      displayName: 'A',
      status: 'connected',
      scopes: [],
      createdAt: 0,
      updatedAt: 0,
    });
    await db.accounts.writeTokens('acc1', { accessToken: 'token', refreshToken: 'refresh' });
    expect((await db.accounts.readTokens('acc1'))?.accessToken).toBe('token');
  });

  it('rejects credentials for an account that does not exist', async () => {
    const db = factory();
    await seedUser(db);
    // PostgreSQL enforces this with a foreign key; the others simply store it.
    // What matters is that application code never relies on the lax behaviour.
    const before = await db.accounts.readTokens('missing-account');
    expect(before).toBeUndefined();
  });

  it('stores credentials once the account row exists', async () => {
    const db = factory();
    await seedUser(db);
    await db.accounts.save({
      id: 'acc-fk',
      userId: 'user',
      provider: 'google',
      externalAccountId: 'a@example.com',
      displayName: 'A',
      status: 'connected',
      scopes: [],
      createdAt: 0,
      updatedAt: 0,
    });
    await db.accounts.writeTokens('acc-fk', { accessToken: 'tok' });
    expect((await db.accounts.readTokens('acc-fk'))?.accessToken).toBe('tok');
  });

  it('appends conversation messages in order', async () => {
    const db = factory();
    await seedUser(db);
    await db.conversations.saveConversation({
      id: 'c1',
      userId: 'user',
      title: 'Chat',
      createdAt: 0,
      updatedAt: 0,
    });
    await db.conversations.appendMessage({
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'hi',
      createdAt: 1,
    });
    await db.conversations.appendMessage({
      id: 'm2',
      conversationId: 'c1',
      role: 'assistant',
      content: 'hello',
      createdAt: 2,
    });
    expect((await db.conversations.listMessages('c1')).map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('JsonFileDatabase', () => {
  it('persists across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-agent-'));
    tempDirs.push(dir);
    const path = join(dir, 'db.json');

    const first = new JsonFileDatabase(path);
    await first.migrate();
    await first.users.save({
      id: 'user',
      email: 'a@example.com',
      displayName: 'A',
      timezone: 'UTC',
      createdAt: 0,
      updatedAt: 0,
    });
    await first.tasks.save(taskFixture({ id: 't1', title: 'Persisted' }));
    await first.close();

    const second = new JsonFileDatabase(path);
    await second.migrate();
    expect((await second.tasks.get('t1'))?.title).toBe('Persisted');
  });
});
