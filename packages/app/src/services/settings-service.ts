import type { ReconfigurableLLMProvider } from '@calendar-agent/agent';
import type { AppConfig, LLMProviderInfo } from '@calendar-agent/config';
import { LLM_PROVIDERS, llmProviderInfo, resolveLLMApiKey } from '@calendar-agent/config';
import type {
  AppSettings,
  Clock,
  Database,
  LLMProviderName,
  LLMSettings,
  LogLevel,
  Logger,
  UserId,
  WeekStart,
} from '@calendar-agent/core';
import { ValidationError, isLLMProviderName, isWeekStart } from '@calendar-agent/core';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** A provider as the settings UI sees it: no key, only whether one exists. */
export interface LLMProviderStatus extends Omit<LLMProviderInfo, 'apiKeyEnvVar'> {
  readonly apiKeyEnvVar?: string;
  readonly requiresApiKey: boolean;
  /** Whether the environment currently supplies a usable credential. */
  readonly hasApiKey: boolean;
}

export interface SettingsView {
  readonly settings: AppSettings;
  readonly providers: readonly LLMProviderStatus[];
  /** What the process is actually running right now. */
  readonly active: { readonly provider: string; readonly model: string };
  /** Files the start-up configuration came from, for the "where from" note. */
  readonly sources: readonly string[];
  /** True when settings changes cannot be applied without a restart. */
  readonly readOnlyRuntime: boolean;
}

/**
 * Runtime settings: which model answers questions, and how loudly the process
 * logs. The scheduling policy lives in `PreferencesService`; this covers the
 * rest of the configuration file.
 *
 * The configuration file seeds the first run and the database is the source of
 * truth afterwards, matching how scheduling preferences already behave. API
 * keys are never part of this surface - they are read from the environment so
 * that a credential can neither be submitted to nor read back from the API.
 */
export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** Absent when an LLM was injected directly (tests), which cannot be swapped. */
    private readonly llm?: ReconfigurableLLMProvider,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** Settings from the configuration file, used until something is stored. */
  fallback(userId: UserId): AppSettings {
    return {
      userId,
      llm: {
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        temperature: this.config.llm.temperature,
        maxTokens: this.config.llm.maxTokens,
        ...(this.config.llm.baseUrl === undefined ? {} : { baseUrl: this.config.llm.baseUrl }),
      },
      logLevel: this.config.logLevel,
      weekStart: this.config.ui.weekStart,
      updatedAt: 0,
    };
  }

  async get(userId: UserId): Promise<AppSettings> {
    const stored = await this.db.settings.get(userId);
    if (!stored) return this.fallback(userId);
    const base = this.fallback(userId);
    return { ...base, ...stored, llm: { ...base.llm, ...stored.llm }, userId };
  }

  /** Everything the settings panel needs in one round-trip. */
  async view(userId: UserId): Promise<SettingsView> {
    const settings = await this.get(userId);
    return {
      settings,
      providers: this.providers(),
      active: { provider: this.llm?.name ?? 'unknown', model: this.llm?.model ?? '' },
      sources: this.config.sources,
      readOnlyRuntime: this.llm === undefined,
    };
  }

  providers(): readonly LLMProviderStatus[] {
    return LLM_PROVIDERS.map((info) => ({
      ...info,
      requiresApiKey: info.apiKeyEnvVar !== undefined,
      hasApiKey:
        info.apiKeyEnvVar === undefined || resolveLLMApiKey(info.provider, this.env) !== undefined,
    }));
  }

  async update(userId: UserId, raw: unknown): Promise<AppSettings> {
    const current = await this.get(userId);
    const next: AppSettings = {
      ...current,
      ...parseSettingsPatch(raw, current),
      userId,
      updatedAt: this.clock.now(),
    };
    const saved = await this.db.settings.save(next);
    this.apply(saved);
    this.logger.info('settings.updated', {
      provider: saved.llm.provider,
      model: saved.llm.model,
      logLevel: saved.logLevel,
    });
    return saved;
  }

  /** Point the running process at the stored settings. */
  apply(settings: AppSettings): void {
    this.logger.setLevel?.(settings.logLevel);

    if (!this.llm) return;
    const apiKey = resolveLLMApiKey(settings.llm.provider, this.env);
    this.llm.configure({
      provider: settings.llm.provider,
      model: settings.llm.model || llmProviderInfo(settings.llm.provider).defaultModel,
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.maxTokens,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(settings.llm.baseUrl === undefined ? {} : { baseUrl: settings.llm.baseUrl }),
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseSettingsPatch(raw: unknown, current: AppSettings): Partial<AppSettings> {
  if (!isRecord(raw)) throw new ValidationError('The request body must be an object.');
  const patch: { llm?: LLMSettings; logLevel?: LogLevel; weekStart?: WeekStart } = {};

  if (raw.weekStart !== undefined) {
    if (!isWeekStart(raw.weekStart)) {
      throw new ValidationError('"weekStart" must be either "rolling" or "sunday".');
    }
    patch.weekStart = raw.weekStart;
  }

  if (raw.logLevel !== undefined) {
    if (typeof raw.logLevel !== 'string' || !LOG_LEVELS.includes(raw.logLevel as LogLevel)) {
      throw new ValidationError(`"logLevel" must be one of: ${LOG_LEVELS.join(', ')}.`);
    }
    patch.logLevel = raw.logLevel as LogLevel;
  }

  if (raw.llm !== undefined) {
    if (!isRecord(raw.llm)) throw new ValidationError('"llm" must be an object.');
    if (raw.llm.apiKey !== undefined) {
      throw new ValidationError(
        'API keys are read from the environment. Set the provider key in your .env file instead.',
      );
    }

    const provider: LLMProviderName =
      raw.llm.provider === undefined ? current.llm.provider : requireProvider(raw.llm.provider);

    const model =
      raw.llm.model === undefined
        ? provider === current.llm.provider
          ? current.llm.model
          : llmProviderInfo(provider).defaultModel
        : requireString(raw.llm.model, 'llm.model');

    if (provider !== 'none' && model.trim().length === 0) {
      throw new ValidationError('Choose a model, or set the provider to "none".');
    }

    const temperature =
      raw.llm.temperature === undefined
        ? current.llm.temperature
        : requireNumber(raw.llm.temperature, 'llm.temperature', 0, 2);

    const maxTokens =
      raw.llm.maxTokens === undefined
        ? current.llm.maxTokens
        : Math.round(requireNumber(raw.llm.maxTokens, 'llm.maxTokens', 1, 200_000));

    const rawBaseUrl = raw.llm.baseUrl;
    const baseUrl =
      rawBaseUrl === undefined
        ? current.llm.baseUrl
        : rawBaseUrl === null || rawBaseUrl === ''
          ? undefined
          : requireUrl(rawBaseUrl, 'llm.baseUrl');

    patch.llm = {
      provider,
      model: model.trim(),
      temperature,
      maxTokens,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    };
  }

  return patch;
}

function requireProvider(value: unknown): LLMProviderName {
  if (!isLLMProviderName(value)) {
    throw new ValidationError(
      `"llm.provider" must be one of: ${LLM_PROVIDERS.map((p) => p.provider).join(', ')}.`,
    );
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`"${field}" must be a string.`);
  return value;
}

function requireNumber(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ValidationError(`"${field}" must be a number.`);
  }
  if (parsed < min || parsed > max) {
    throw new ValidationError(`"${field}" must be between ${min} and ${max}.`);
  }
  return parsed;
}

function requireUrl(value: unknown, field: string): string {
  const text = requireString(value, field).trim();
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new ValidationError(`"${field}" must be an http(s) URL.`);
  }
  return text;
}
