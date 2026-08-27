import type { CalendarAccount, CalendarProvider } from '@calendar-agent/core';
import {
  FixedClock,
  PROVIDER_MOCK,
  SequentialIdGenerator,
  instantFromISO,
} from '@calendar-agent/core';
import type { RawConfig } from '@calendar-agent/config';
import { buildConfig } from '@calendar-agent/config';
import { MemoryDatabase } from '@calendar-agent/database';
import { MockCalendarProvider } from '@calendar-agent/integrations';
import type { Database, MessageWriter, ReplyReader } from '@calendar-agent/core';
import type { CommandParser, LLMProvider } from '@calendar-agent/agent';
import type { AppContext, MessagingIntegration } from './context.js';
import { createApp } from './context.js';
import type { ProviderRegistry } from './provider-registry.js';

export interface TestApp {
  readonly app: AppContext;
  readonly provider: MockCalendarProvider;
  readonly clock: FixedClock;
  readonly userId: string;
  readonly account: CalendarAccount;
}

export interface TestAppOptions {
  /** ISO instant used as "now". Defaults to Monday 2026-03-09 08:00 UTC. */
  readonly now?: string;
  readonly config?: RawConfig;
  readonly llm?: LLMProvider;
  readonly parser?: CommandParser;
  /** Skip connecting the mock calendar (local-only mode). */
  readonly withoutCalendar?: boolean;
  /** Override the database, e.g. to enforce constraints a real one would. */
  readonly db?: Database;
  /** Fake messaging integration; without it the app runs with none, as usual. */
  readonly messaging?: MessagingIntegration;
  /** Second opinion on replies the deterministic rules cannot read. */
  readonly replyReader?: ReplyReader;
  /** Writes outbound message text; without it the template is used. */
  readonly messageWriter?: MessageWriter;
}

/**
 * Builds a fully wired application against in-memory infrastructure: a memory
 * database, a fixed clock and the mock calendar provider. Used by the app
 * tests and the end-to-end suite so both exercise the real services.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const clock = new FixedClock(instantFromISO(options.now ?? '2026-03-09T08:00:00Z'));
  const provider = new MockCalendarProvider({ now: () => clock.now() });
  const config = buildConfig(
    {
      timezone: 'UTC',
      working_hours: {
        monday: '09:00-17:00',
        tuesday: '09:00-17:00',
        wednesday: '09:00-17:00',
        thursday: '09:00-17:00',
        friday: '09:00-17:00',
      },
      deep_work: { enabled: false },
      ...options.config,
    },
    {},
  );

  const registry: ProviderRegistry = {
    async create(): Promise<CalendarProvider> {
      return provider;
    },
    oauth: () => undefined,
    available: () => [PROVIDER_MOCK],
  };

  const app = await createApp(config, {
    db: options.db ?? new MemoryDatabase(),
    clock,
    ids: new SequentialIdGenerator('t'),
    registry,
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.parser ? { parser: options.parser } : {}),
    ...(options.replyReader ? { replyReader: options.replyReader } : {}),
    ...(options.messageWriter ? { messageWriter: options.messageWriter } : {}),
    ...(options.messaging ? { messaging: options.messaging } : {}),
  });

  let account: CalendarAccount = {
    id: 'none',
    userId: app.user.id,
    provider: PROVIDER_MOCK,
    externalAccountId: 'mock@example.com',
    displayName: 'Mock',
    status: 'connected',
    scopes: [],
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };

  if (!options.withoutCalendar) {
    const connected = await app.calendars.connectAccount({
      userId: app.user.id,
      provider: PROVIDER_MOCK,
      tokens: { accessToken: 'test-token' },
    });
    account = connected.account;
  }

  return { app, provider, clock, userId: app.user.id, account };
}
