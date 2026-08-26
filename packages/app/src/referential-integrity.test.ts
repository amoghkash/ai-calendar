import { describe, expect, it } from 'vitest';
import type { Database } from '@calendar-agent/core';
import { ConflictError, PROVIDER_MOCK } from '@calendar-agent/core';
import { MemoryDatabase } from '@calendar-agent/database';
import { createTestApp } from './testing.js';

/**
 * The in-memory and JSON backends have no foreign keys, so an operation that
 * writes a child row before its parent passes there and fails on PostgreSQL.
 * This wrapper enforces the constraints the SQL schema declares, so that class
 * of bug is caught by the normal test run rather than in production.
 */
function withForeignKeys(db: Database): Database {
  const accounts = db.accounts;
  return {
    // Spread so a newly added repository is carried through automatically;
    // migrate/close live on the prototype and have to be re-bound by hand.
    ...db,
    accounts: {
      ...accounts,
      async writeTokens(accountId, tokens) {
        // calendar_account_tokens.account_id REFERENCES calendar_accounts(id)
        if (!(await accounts.get(accountId))) {
          throw new ConflictError(
            'insert or update on table "calendar_account_tokens" violates foreign key constraint "calendar_account_tokens_account_id_fkey"',
          );
        }
        return accounts.writeTokens(accountId, tokens);
      },
    },
    migrate: () => db.migrate(),
    close: () => db.close(),
  };
}

describe('referential integrity', () => {
  it('creates the account row before writing its credentials', async () => {
    const harness = await createTestApp({
      withoutCalendar: true,
      db: withForeignKeys(new MemoryDatabase()),
    });

    const { account, calendars } = await harness.app.calendars.connectAccount({
      userId: harness.userId,
      provider: PROVIDER_MOCK,
      tokens: { accessToken: 'token', refreshToken: 'refresh' },
    });

    expect(account.status).toBe('connected');
    expect(calendars.length).toBeGreaterThan(0);
    expect((await harness.app.db.accounts.readTokens(account.id))?.accessToken).toBe('token');
  });

  it('leaves nothing behind when authorisation fails half way', async () => {
    const failing = {
      async create() {
        return {
          id: PROVIDER_MOCK,
          capabilities: {
            incrementalSync: false,
            privateMetadata: false,
            recurringInstanceUpdates: false,
            freeBusy: false,
          },
          authenticate: async () => {
            throw new ConflictError('provider rejected the token');
          },
        } as never;
      },
      oauth: () => undefined,
      available: () => [PROVIDER_MOCK],
    };

    const db = withForeignKeys(new MemoryDatabase());
    const harness = await createTestApp({ withoutCalendar: true, db });
    // Swap in a provider registry whose authenticate() fails.
    const service = new (await import('./services/calendar-service.js')).CalendarService(
      db,
      failing,
      harness.app.clock,
      harness.app.ids,
    );

    await expect(
      service.connectAccount({
        userId: harness.userId,
        provider: PROVIDER_MOCK,
        tokens: { accessToken: 'token' },
      }),
    ).rejects.toThrow(/provider rejected/);

    // No half-connected account is left for the user to trip over.
    expect(await db.accounts.list(harness.userId)).toHaveLength(0);
  });
});
