import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_RISK_THRESHOLDS,
  DEFAULT_STABILITY,
  DEFAULT_WEIGHTS,
  DEFAULT_USER_ID,
  ValidationError,
  assertValidTimezone,
  defaultPreferences,
  parseTimeOfDay,
  instantFromISO,
} from '@calendar-agent/core';
import type {
  DailyWindow,
  EventClassificationRule,
  NamedInterval,
  SchedulingPreferences,
  WeeklySchedule,
  Weekday,
} from '@calendar-agent/core';
import { readDotEnv } from './env.js';
import { defaultModelFor, resolveLLMApiKey } from './llm-providers.js';
import type { RawConfig, RawWeeklySchedule } from './schema.js';
import { configSchema } from './schema.js';
import type { AppConfig, LLMProviderName } from './types.js';

export interface LoadConfigOptions {
  /** Explicit path to a YAML config file. */
  readonly configPath?: string;
  /** Working directory used to resolve relative paths. */
  readonly cwd?: string;
  /** Environment map; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Skip reading `.env` files (used in tests). */
  readonly skipDotEnv?: boolean;
}

const CONFIG_FILE_NAMES = [
  'calendar-agent.yaml',
  'calendar-agent.yml',
  'config/calendar-agent.yaml',
  '.calendar-agent.yaml',
];

/** Look for a configuration file in the cwd, then in `~/.calendar-agent/`. */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  const home = resolve(homedir(), '.calendar-agent', 'config.yaml');
  return existsSync(home) ? home : undefined;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const sources: string[] = [];

  const env: Record<string, string | undefined> = { ...(options.env ?? process.env) };
  if (!options.skipDotEnv) {
    const dotEnvPath = resolve(cwd, '.env');
    if (existsSync(dotEnvPath)) {
      sources.push(dotEnvPath);
      for (const [key, value] of Object.entries(readDotEnv(dotEnvPath))) {
        if (env[key] === undefined) env[key] = value;
        // Also export into the real environment, the way dotenv does. Config
        // resolution uses the local map above, but credentials are looked up
        // from `process.env` later (settings, provider registry), and a key
        // that only existed in the local copy was invisible to them.
        if (options.env === undefined && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  }

  const configPath = options.configPath ?? env.CALENDAR_AGENT_CONFIG ?? findConfigFile(cwd);
  let raw: RawConfig = {};
  if (configPath) {
    const absolute = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
    if (!existsSync(absolute)) {
      throw new ValidationError(`Configuration file not found: ${absolute}`);
    }
    sources.push(absolute);
    const parsed = configSchema.safeParse(parseYaml(readFileSync(absolute, 'utf8')) ?? {});
    if (!parsed.success) {
      throw new ValidationError(`Invalid configuration in ${absolute}`, {
        details: { issues: parsed.error.issues },
      });
    }
    raw = parsed.data;
  }

  return buildConfig(raw, env, cwd, sources);
}

/** Build a config object from an already-parsed structure (used by tests). */
export function buildConfig(
  raw: RawConfig,
  env: Record<string, string | undefined> = {},
  cwd: string = process.cwd(),
  sources: readonly string[] = [],
): AppConfig {
  const timezone = env.CALENDAR_AGENT_TIMEZONE ?? raw.timezone ?? systemTimezone();
  assertValidTimezone(timezone);

  const userId = env.CALENDAR_AGENT_USER_ID ?? raw.user?.id ?? DEFAULT_USER_ID;
  const preferences = buildPreferences(raw, userId, timezone);

  const driver =
    (env.CALENDAR_AGENT_DB_DRIVER as AppConfig['database']['driver'] | undefined) ??
    raw.database?.driver ??
    (env.DATABASE_URL || raw.database?.url ? 'postgres' : 'json');

  const databaseUrl = env.DATABASE_URL ?? raw.database?.url;
  const databasePath = resolve(
    cwd,
    env.CALENDAR_AGENT_DB_PATH ?? raw.database?.path ?? '.data/calendar-agent.json',
  );

  const serverPort = Number(env.PORT ?? env.CALENDAR_AGENT_PORT ?? raw.server?.port ?? 4319);
  const serverHost = env.CALENDAR_AGENT_HOST ?? raw.server?.host ?? '127.0.0.1';
  const publicUrl =
    env.CALENDAR_AGENT_PUBLIC_URL ?? raw.server?.public_url ?? `http://localhost:${serverPort}`;

  const llmProvider = (env.CALENDAR_AGENT_LLM_PROVIDER ??
    raw.llm?.provider ??
    inferLLMProvider(env)) as LLMProviderName;

  return {
    user: {
      id: userId,
      email: env.CALENDAR_AGENT_USER_EMAIL ?? raw.user?.email ?? 'local@localhost',
      name: env.CALENDAR_AGENT_USER_NAME ?? raw.user?.name ?? 'Local User',
    },
    timezone,
    database: {
      driver,
      ...(databaseUrl === undefined ? {} : { url: databaseUrl }),
      path: databasePath,
    },
    preferences,
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? raw.calendars?.google?.client_id,
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? raw.calendars?.google?.client_secret,
      redirectUri:
        env.GOOGLE_REDIRECT_URI ??
        raw.calendars?.google?.redirect_uri ??
        `${publicUrl}/api/oauth/google/callback`,
    },
    microsoft: {
      clientId: env.MICROSOFT_CLIENT_ID ?? raw.calendars?.microsoft?.client_id,
      clientSecret: env.MICROSOFT_CLIENT_SECRET ?? raw.calendars?.microsoft?.client_secret,
      tenantId: env.MICROSOFT_TENANT_ID ?? raw.calendars?.microsoft?.tenant_id ?? 'common',
      redirectUri:
        env.MICROSOFT_REDIRECT_URI ??
        raw.calendars?.microsoft?.redirect_uri ??
        `${publicUrl}/api/oauth/microsoft/callback`,
    },
    llm: {
      provider: llmProvider,
      model: env.CALENDAR_AGENT_LLM_MODEL ?? raw.llm?.model ?? defaultModelFor(llmProvider),
      apiKey:
        env.CALENDAR_AGENT_LLM_API_KEY ?? raw.llm?.api_key ?? resolveLLMApiKey(llmProvider, env),
      baseUrl: env.CALENDAR_AGENT_LLM_BASE_URL ?? raw.llm?.base_url,
      temperature: raw.llm?.temperature ?? 0,
      maxTokens: raw.llm?.max_tokens ?? 2048,
    },
    sync: {
      enabled: envFlag(env.CALENDAR_AGENT_SYNC_ENABLED) ?? raw.sync?.enabled ?? true,
      intervalMinutes: Number(
        env.CALENDAR_AGENT_SYNC_INTERVAL_MINUTES ?? raw.sync?.interval_minutes ?? 15,
      ),
      replanOnChange: envFlag(env.CALENDAR_AGENT_SYNC_REPLAN) ?? raw.sync?.replan_on_change ?? true,
    },
    messaging: {
      // Off unless asked for: the bridge is a separate process the user has to
      // start, and probing for it on every boot would be noise on machines
      // that will never have one.
      enabled: envFlag(env.CALENDAR_AGENT_MESSAGING_ENABLED) ?? false,
      baseUrl: env.CALENDAR_AGENT_MESSAGING_URL ?? 'http://127.0.0.1:4320',
    },
    server: {
      host: serverHost,
      port: serverPort,
      publicUrl,
      corsOrigins: raw.server?.cors_origins ?? ['http://localhost:5173'],
    },
    ui: { weekStart: raw.ui?.week_start ?? 'rolling' },
    logLevel:
      (env.CALENDAR_AGENT_LOG_LEVEL as AppConfig['logLevel'] | undefined) ??
      raw.logging?.level ??
      'info',
    sources,
  };
}

export function buildPreferences(
  raw: RawConfig,
  userId: string,
  timezone: string,
): SchedulingPreferences {
  const base = defaultPreferences(userId, timezone);
  const deepWorkSchedule =
    raw.deep_work?.schedule !== undefined
      ? toWeeklySchedule(raw.deep_work.schedule)
      : raw.deep_work?.preferred_start && raw.deep_work?.preferred_end
        ? everyWorkday({
            start: parseTimeOfDay(raw.deep_work.preferred_start),
            end: parseTimeOfDay(raw.deep_work.preferred_end),
            label: 'deep work',
          })
        : base.deepWork.schedule;

  return {
    ...base,
    workingHours:
      raw.working_hours !== undefined ? toWeeklySchedule(raw.working_hours) : base.workingHours,
    sleepHours: raw.sleep_hours !== undefined ? toWeeklySchedule(raw.sleep_hours) : base.sleepHours,
    recurringBlocks:
      raw.recurring_blocks !== undefined
        ? toWeeklySchedule(raw.recurring_blocks)
        : base.recurringBlocks,
    blockedPeriods: (raw.blocked_periods ?? []).map(toNamedInterval),
    deepWork: {
      enabled: raw.deep_work?.enabled ?? base.deepWork.enabled,
      schedule: deepWorkSchedule,
      allowMeetings: raw.deep_work?.allow_meetings ?? base.deepWork.allowMeetings,
      reserveForFocusTasks:
        raw.deep_work?.reserve_for_focus_tasks ?? base.deepWork.reserveForFocusTasks,
    },
    minimumBlockMinutes: raw.scheduling?.minimum_block_minutes ?? base.minimumBlockMinutes,
    maximumBlockMinutes: raw.scheduling?.maximum_block_minutes ?? base.maximumBlockMinutes,
    allowTaskSplitting: raw.scheduling?.allow_task_splitting ?? base.allowTaskSplitting,
    bufferBetweenBlocksMinutes:
      raw.scheduling?.buffer_between_blocks_minutes ?? base.bufferBetweenBlocksMinutes,
    ...(raw.scheduling?.max_daily_task_minutes === undefined
      ? {}
      : { maxDailyTaskMinutes: raw.scheduling.max_daily_task_minutes }),
    protectExistingEvents: raw.scheduling?.protect_existing_events ?? base.protectExistingEvents,
    allDayEventsBlockTime: raw.scheduling?.all_day_events_block_time ?? base.allDayEventsBlockTime,
    granularityMinutes: raw.scheduling?.granularity_minutes ?? base.granularityMinutes,
    planningHorizonDays: raw.scheduling?.planning_horizon_days ?? base.planningHorizonDays,
    placementStrategy: raw.scheduling?.placement_strategy ?? base.placementStrategy,
    weights: {
      deadlineUrgency: raw.weights?.deadline_urgency ?? DEFAULT_WEIGHTS.deadlineUrgency,
      priority: raw.weights?.priority ?? DEFAULT_WEIGHTS.priority,
      importance: raw.weights?.importance ?? DEFAULT_WEIGHTS.importance,
      deadlineRisk: raw.weights?.deadline_risk ?? DEFAULT_WEIGHTS.deadlineRisk,
      ageBonus: raw.weights?.age_bonus ?? DEFAULT_WEIGHTS.ageBonus,
      fragmentationPenalty:
        raw.weights?.fragmentation_penalty ?? DEFAULT_WEIGHTS.fragmentationPenalty,
      contextSwitchPenalty:
        raw.weights?.context_switch_penalty ?? DEFAULT_WEIGHTS.contextSwitchPenalty,
      earlyStartPreference:
        raw.weights?.early_start_preference ?? DEFAULT_WEIGHTS.earlyStartPreference,
      stabilityBonus: raw.weights?.stability_bonus ?? DEFAULT_WEIGHTS.stabilityBonus,
      deepWorkAffinity: raw.weights?.deep_work_affinity ?? DEFAULT_WEIGHTS.deepWorkAffinity,
    },
    riskThresholds: {
      criticalRatio: raw.risk?.critical_ratio ?? DEFAULT_RISK_THRESHOLDS.criticalRatio,
      atRiskRatio: raw.risk?.at_risk_ratio ?? DEFAULT_RISK_THRESHOLDS.atRiskRatio,
      deadlineBufferMinutes:
        raw.risk?.deadline_buffer_minutes ?? DEFAULT_RISK_THRESHOLDS.deadlineBufferMinutes,
    },
    automation: {
      mode: raw.automation?.mode ?? DEFAULT_AUTOMATION.mode,
      movePolicy: {
        MOVABLE: raw.automation?.move_policy?.MOVABLE ?? DEFAULT_AUTOMATION.movePolicy.MOVABLE,
        PROTECTED:
          raw.automation?.move_policy?.PROTECTED ?? DEFAULT_AUTOMATION.movePolicy.PROTECTED,
        FIXED: raw.automation?.move_policy?.FIXED ?? DEFAULT_AUTOMATION.movePolicy.FIXED,
        UNKNOWN: raw.automation?.move_policy?.UNKNOWN ?? DEFAULT_AUTOMATION.movePolicy.UNKNOWN,
      },
      createBlocks: raw.automation?.create_blocks ?? DEFAULT_AUTOMATION.createBlocks,
      deleteBlocks: raw.automation?.delete_blocks ?? DEFAULT_AUTOMATION.deleteBlocks,
      freezeWindowMinutes:
        raw.automation?.freeze_window_minutes ?? DEFAULT_AUTOMATION.freezeWindowMinutes,
      maxAutoMutations: raw.automation?.max_auto_mutations ?? DEFAULT_AUTOMATION.maxAutoMutations,
    },
    stability: {
      minimumImprovement:
        raw.stability?.minimum_improvement ?? DEFAULT_STABILITY.minimumImprovement,
      freezeWindowMinutes:
        raw.stability?.freeze_window_minutes ?? DEFAULT_STABILITY.freezeWindowMinutes,
      maxMovesPerRun: raw.stability?.max_moves_per_run ?? DEFAULT_STABILITY.maxMovesPerRun,
    },
    classificationRules: (raw.classification_rules ?? []).map(toClassificationRule),
  };
}

const WEEKDAY_KEYS: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export function toWeeklySchedule(raw: RawWeeklySchedule): WeeklySchedule {
  const result: Record<string, DailyWindow[]> = {};
  for (const day of WEEKDAY_KEYS) {
    const value = raw[day];
    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    const windows = list.map(toDailyWindow);
    if (windows.length > 0) result[day] = windows;
  }
  return result as WeeklySchedule;
}

function toDailyWindow(
  value: string | { start: string; end: string; label?: string },
): DailyWindow {
  if (typeof value === 'string') {
    const [start, end] = value.split('-').map((part) => part.trim());
    if (!start || !end) {
      throw new ValidationError(`Invalid time range "${value}" (expected "HH:MM-HH:MM")`);
    }
    return { start: parseTimeOfDay(start), end: parseTimeOfDay(end) };
  }
  return {
    start: parseTimeOfDay(value.start),
    end: parseTimeOfDay(value.end),
    ...(value.label === undefined ? {} : { label: value.label }),
  };
}

function everyWorkday(window: DailyWindow): WeeklySchedule {
  return {
    monday: [window],
    tuesday: [window],
    wednesday: [window],
    thursday: [window],
    friday: [window],
  };
}

function toNamedInterval(raw: { start: string; end: string; label?: string }): NamedInterval {
  return {
    start: instantFromISO(raw.start),
    end: instantFromISO(raw.end),
    ...(raw.label === undefined ? {} : { label: raw.label }),
  };
}

function toClassificationRule(raw: {
  id: string;
  classification: EventClassificationRule['classification'];
  title_pattern?: string;
  calendar_id?: string;
  has_other_attendees?: boolean;
  is_all_day?: boolean;
  created_by_agent?: boolean;
}): EventClassificationRule {
  return {
    id: raw.id,
    classification: raw.classification,
    ...(raw.title_pattern === undefined ? {} : { titlePattern: raw.title_pattern }),
    ...(raw.calendar_id === undefined ? {} : { calendarId: raw.calendar_id }),
    ...(raw.has_other_attendees === undefined
      ? {}
      : { hasOtherAttendees: raw.has_other_attendees }),
    ...(raw.is_all_day === undefined ? {} : { isAllDay: raw.is_all_day }),
    ...(raw.created_by_agent === undefined ? {} : { createdByAgent: raw.created_by_agent }),
  };
}

/** `"1"`, `"true"`, `"yes"` -> true; `"0"`, `"false"`, `"no"` -> false. */
function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
  return undefined;
}

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function inferLLMProvider(env: Record<string, string | undefined>): LLMProviderName {
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'gemini';
  return 'none';
}
