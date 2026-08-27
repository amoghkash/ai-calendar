import type { LLMProviderName, SchedulingPreferences, WeekStart } from '@calendar-agent/core';

export type DatabaseDriver = 'memory' | 'json' | 'postgres';

export interface DatabaseConfig {
  readonly driver: DatabaseDriver;
  readonly url?: string;
  /** File location for the `json` driver. */
  readonly path: string;
}

export interface OAuthClientConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly tenantId?: string;
}

export type { LLMProviderName };

export interface LLMConfig {
  readonly provider: LLMProviderName;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly temperature: number;
  readonly maxTokens: number;
}

export interface SyncConfig {
  /** Whether the server syncs calendars on a timer. */
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  /**
   * Whether a detected external change immediately produces a fresh plan.
   * The plan is only ever a proposal unless automation mode allows more.
   */
  readonly replanOnChange: boolean;
}

export interface UIConfig {
  readonly weekStart: WeekStart;
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly corsOrigins: readonly string[];
}

export interface UserConfig {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** Fully resolved application configuration. */
/**
 * The local iMessage bridge. Optional by construction: it only exists on macOS,
 * it holds its own permission grants, and everything above it has to work when
 * it is absent.
 */
export interface MessagingConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  /** How often to look for answers to messages that have gone out. */
  readonly pollIntervalMinutes: number;
}

export interface AppConfig {
  readonly user: UserConfig;
  readonly timezone: string;
  readonly database: DatabaseConfig;
  readonly preferences: SchedulingPreferences;
  readonly google: OAuthClientConfig;
  readonly microsoft: OAuthClientConfig;
  readonly llm: LLMConfig;
  readonly sync: SyncConfig;
  readonly messaging: MessagingConfig;
  readonly server: ServerConfig;
  readonly ui: UIConfig;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Where the configuration was loaded from, for `doctor` output. */
  readonly sources: readonly string[];
}
