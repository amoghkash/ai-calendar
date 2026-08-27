import type { OutreachTone } from './outreach.js';
import type { LogLevel } from '../logging/logger.js';
import type { Instant } from '../time/instant.js';
import type { UserId } from './ids.js';

/**
 * Runtime settings that are not part of the scheduling policy.
 *
 * `SchedulingPreferences` covers everything the scheduler reads. This covers
 * the rest of the configuration file - which model answers questions, and how
 * loudly the process logs - so that both are editable without a restart.
 */

/** Providers the agent can talk to. `none` disables the LLM entirely. */
export type LLMProviderName = 'none' | 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama';

export const LLM_PROVIDER_NAMES: readonly LLMProviderName[] = [
  'none',
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'ollama',
];

export const isLLMProviderName = (value: unknown): value is LLMProviderName =>
  typeof value === 'string' && (LLM_PROVIDER_NAMES as readonly string[]).includes(value);

export interface LLMSettings {
  readonly provider: LLMProviderName;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  /** Endpoint override for self-hosted or proxied providers. */
  readonly baseUrl?: string;
}

export const DEFAULT_LLM_SETTINGS: LLMSettings = {
  provider: 'none',
  model: '',
  temperature: 0,
  maxTokens: 2048,
};

/**
 * How the week view lays its columns out.
 *
 * `rolling` keeps today in the leftmost column, which answers "what is coming
 * up". `sunday` pins the grid to a calendar week, which answers "what does this
 * week look like". Neither affects scheduling.
 */
export type WeekStart = 'rolling' | 'sunday';

export const WEEK_STARTS: readonly WeekStart[] = ['rolling', 'sunday'];

export const isWeekStart = (value: unknown): value is WeekStart =>
  typeof value === 'string' && (WEEK_STARTS as readonly string[]).includes(value);

export interface AppSettings {
  readonly userId: UserId;
  readonly llm: LLMSettings;
  readonly logLevel: LogLevel;
  readonly weekStart: WeekStart;
  /** Default voice for messages sent to other people. */
  readonly outreachTone: OutreachTone;
  readonly updatedAt: Instant;
}

export function defaultAppSettings(userId: UserId, updatedAt: Instant = 0): AppSettings {
  return {
    userId,
    llm: DEFAULT_LLM_SETTINGS,
    logLevel: 'info',
    weekStart: 'rolling',
    outreachTone: 'casual',
    updatedAt,
  };
}
