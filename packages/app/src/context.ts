import type {
  CalendarProvider,
  Clock,
  ContactDirectory,
  MessagingProvider,
  Database,
  IdGenerator,
  Logger,
  MessageSender,
  MessageWriter,
  ReplyReader,
  Scheduler,
  User,
} from '@calendar-agent/core';
import {
  GreedyScheduler,
  RandomIdGenerator,
  StructuredLogger,
  SystemClock,
} from '@calendar-agent/core';
import type { AppConfig } from '@calendar-agent/config';
import { loadConfig } from '@calendar-agent/config';
import { createDatabase } from '@calendar-agent/database';
import type { CommandParser, LLMProvider } from '@calendar-agent/agent';
import { ImessageBridgeClient, readBridgeToken } from '@calendar-agent/integrations';
import {
  AdaptiveCommandParser,
  LLMMessageWriter,
  LLMReplyReader,
  HeuristicCommandParser,
  ReconfigurableLLMProvider,
} from '@calendar-agent/agent';
import type { ProviderRegistry } from './provider-registry.js';
import { DefaultProviderRegistry } from './provider-registry.js';
import { buildAgentTools } from './agent/tools.js';
import { AgentService } from './services/agent-service.js';
import { CalendarService } from './services/calendar-service.js';
import { CategoryService } from './services/category-service.js';
import { MaintenanceService } from './services/maintenance-service.js';
import { DoctorService } from './services/doctor-service.js';
import { ContactLinkService } from './services/contact-link-service.js';
import { OutreachService } from './services/outreach-service.js';
import { TodayService } from './services/today-service.js';
import { DeferredDeletionService } from './services/deferred-deletion-service.js';
import { PreferencesService } from './services/preferences-service.js';
import { SettingsService } from './services/settings-service.js';
import { SchedulingService } from './services/scheduling-service.js';
import { SyncService } from './services/sync-service.js';
import { TaskService } from './services/task-service.js';

export interface AppOverrides {
  readonly db?: Database;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  readonly scheduler?: Scheduler;
  readonly llm?: LLMProvider;
  readonly parser?: CommandParser;
  /** Second opinion on replies the deterministic rules cannot read. */
  readonly replyReader?: ReplyReader;
  /** Writes outbound message text; without it the deterministic template is used. */
  readonly messageWriter?: MessageWriter;
  readonly registry?: ProviderRegistry;
  /** Messaging integration; tests inject a fake, most runs have none. */
  readonly messaging?: MessagingIntegration;
  /** Pre-built calendar providers keyed by account id (tests, demo mode). */
  readonly providers?: Record<string, CalendarProvider>;
}

/**
 * Everything the UI and CLI need, wired once.
 *
 * Dependencies flow one way: services depend on ports, never on transports.
 * Anything that varies (database, clock, providers, LLM) is injectable.
 */
export interface AppContext {
  readonly config: AppConfig;
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly scheduler: Scheduler;
  readonly llm: LLMProvider;
  readonly registry: ProviderRegistry;
  readonly user: User;
  readonly tasks: TaskService;
  readonly calendars: CalendarService;
  readonly categories: CategoryService;
  readonly maintenance: MaintenanceService;
  readonly scheduling: SchedulingService;
  readonly sync: SyncService;
  readonly agent: AgentService;
  readonly preferences: PreferencesService;
  readonly settings: SettingsService;
  readonly doctor: DoctorService;
  readonly contactLinks: ContactLinkService;
  readonly outreach: OutreachService;
  readonly today: TodayService;
  readonly deletions: DeferredDeletionService;
  /** Present only when the messaging bridge is configured and reachable. */
  readonly messaging?: MessagingProvider;
  shutdown(): Promise<void>;
}

export async function createApp(
  config?: AppConfig,
  overrides: AppOverrides = {},
): Promise<AppContext> {
  const resolvedConfig = config ?? loadConfig();
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new RandomIdGenerator();
  const logger =
    overrides.logger ??
    new StructuredLogger({ level: resolvedConfig.logLevel, base: { app: 'calendar-agent' } });

  const db =
    overrides.db ??
    createDatabase({
      driver: resolvedConfig.database.driver,
      ...(resolvedConfig.database.url === undefined ? {} : { url: resolvedConfig.database.url }),
      path: resolvedConfig.database.path,
    });
  await db.migrate();

  const user = await ensureUser(db, resolvedConfig, clock);

  const preferences = new PreferencesService(db, resolvedConfig.preferences, clock);
  if (!(await db.preferences.get(user.id))) {
    await preferences.save(preferences.seed(user.id, resolvedConfig.timezone));
  }

  await new CategoryService(db, clock, ids).seedDefaults(user.id);

  const registry =
    overrides.registry ??
    new DefaultProviderRegistry({
      config: resolvedConfig,
      db,
      ...(overrides.providers ? { overrides: overrides.providers } : {}),
    });

  const scheduler = overrides.scheduler ?? new GreedyScheduler();

  // Wrapped rather than built directly so that changing the model in settings
  // takes effect without a restart. An injected provider (tests) is left alone.
  const reconfigurable = overrides.llm
    ? undefined
    : new ReconfigurableLLMProvider({
        provider: resolvedConfig.llm.provider,
        model: resolvedConfig.llm.model,
        ...(resolvedConfig.llm.apiKey === undefined ? {} : { apiKey: resolvedConfig.llm.apiKey }),
        ...(resolvedConfig.llm.baseUrl === undefined
          ? {}
          : { baseUrl: resolvedConfig.llm.baseUrl }),
        temperature: resolvedConfig.llm.temperature,
        maxTokens: resolvedConfig.llm.maxTokens,
      });
  const llm = overrides.llm ?? reconfigurable!;

  const settings = new SettingsService(db, resolvedConfig, clock, logger, reconfigurable);
  settings.apply(await settings.get(user.id));

  const heuristic = new HeuristicCommandParser();
  const parser =
    overrides.parser ??
    new AdaptiveCommandParser(llm, heuristic, (error) =>
      logger.error('agent.llm_unavailable', {
        provider: llm.name,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  const tasks = new TaskService(db, clock, ids);
  const categories = new CategoryService(db, clock, ids);
  const maintenance = new MaintenanceService(db, clock, logger);
  // Optional by construction: no bridge, no token, or messaging switched off
  // all land in the same place - a service that reports unavailable and a
  // calendar that works exactly as before.
  const messaging = overrides.messaging ?? buildMessaging(resolvedConfig, logger);
  const contactLinks = new ContactLinkService(
    db,
    preferences,
    ids,
    clock,
    logger,
    messaging?.directory,
    messaging?.provider,
  );
  const calendars = new CalendarService(
    db,
    registry,
    clock,
    ids,
    preferences,
    logger,
    contactLinks,
  );
  const scheduling = new SchedulingService(
    db,
    scheduler,
    calendars,
    preferences,
    clock,
    ids,
    logger,
  );
  const sync = new SyncService(db, calendars, preferences, clock, ids, logger);
  const outreach = new OutreachService(
    db,
    scheduling,
    contactLinks,
    calendars,
    preferences,
    settings,
    clock,
    ids,
    logger,
    // Only useful with a model behind it; `none` reads nothing and the
    // deterministic rules stand on their own.
    overrides.replyReader ?? (llm.name === 'none' ? undefined : new LLMReplyReader({ llm })),
    messaging?.sender,
    overrides.messageWriter ??
      (llm.name === 'none' ? undefined : new LLMMessageWriter({ llm })),
  );
  const agent = new AgentService(
    db,
    parser,
    tasks,
    scheduling,
    calendars,
    preferences,
    clock,
    ids,
    logger,
    llm,
    outreach,
    // Late-bound: the tools need the finished context, which includes this
    // very service. The closure only runs on a turn, by which time it exists.
    (uid) => buildAgentTools(context, uid),
  );
  const today = new TodayService(db, scheduling, contactLinks, outreach, preferences, clock);

  const deletions = new DeferredDeletionService(calendars, clock, logger);

  const doctor = new DoctorService(resolvedConfig, db, registry, preferences, clock, logger, llm);

  const context: AppContext = {
    config: resolvedConfig,
    db,
    clock,
    ids,
    logger,
    scheduler,
    llm,
    registry,
    user,
    tasks,
    calendars,
    categories,
    maintenance,
    scheduling,
    sync,
    agent,
    preferences,
    settings,
    doctor,
    contactLinks,
    outreach,
    today,
    deletions,
    ...(messaging === undefined ? {} : { messaging: messaging.provider }),
    async shutdown() {
      // An unfired timer deletes nothing; abandoning is the safe direction.
      deletions.stop();
      await db.close();
    },
  };
  return context;
}

async function ensureUser(db: Database, config: AppConfig, clock: Clock): Promise<User> {
  const existing = await db.users.get(config.user.id);
  if (existing) return existing;
  const now = clock.now();
  return db.users.save({
    id: config.user.id,
    email: config.user.email,
    displayName: config.user.name,
    timezone: config.timezone,
    createdAt: now,
    updatedAt: now,
  });
}

/** A messaging integration is a directory and a provider from one source. */
export interface MessagingIntegration {
  readonly directory: ContactDirectory;
  readonly provider: MessagingProvider;
  /** Optional: a test harness can supply reading without sending. */
  readonly sender?: MessageSender;
}

function buildMessaging(
  config: AppConfig,
  logger: Logger,
): MessagingIntegration | undefined {
  if (!config.messaging.enabled) return undefined;

  const token = readBridgeToken();
  if (token === undefined) {
    // Not an error: the bridge writes this file on its first run, so the usual
    // cause is simply that it has never been started.
    logger.info('messaging.no_token', { baseUrl: config.messaging.baseUrl });
    return undefined;
  }
  const client = new ImessageBridgeClient({ baseUrl: config.messaging.baseUrl, token });
  // One client, three roles. The ports stay separate so nothing upstream can
  // acquire sending by holding the reading one.
  return { directory: client, provider: client, sender: client };
}
