import type { LLMProviderName } from '@calendar-agent/core';

/**
 * The catalogue of LLM providers the settings UI offers.
 *
 * Credentials are deliberately absent: an API key is read from the environment
 * (`.env`) and never accepted over HTTP, so a key cannot be leaked through the
 * settings endpoint or stored in the database.
 */
export interface LLMProviderInfo {
  readonly provider: LLMProviderName;
  readonly label: string;
  /** Environment variable that supplies the credential, when one is needed. */
  readonly apiKeyEnvVar?: string;
  readonly defaultModel: string;
  /** Suggestions for the model field. Any model string is accepted. */
  readonly suggestedModels: readonly string[];
  readonly supportsBaseUrl: boolean;
}

export const LLM_PROVIDERS: readonly LLMProviderInfo[] = [
  {
    provider: 'none',
    label: 'None (rule parser)',
    defaultModel: '',
    suggestedModels: [],
    supportsBaseUrl: false,
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5',
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    supportsBaseUrl: true,
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4.1-mini',
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini'],
    supportsBaseUrl: true,
  },
  {
    provider: 'gemini',
    label: 'Google Gemini',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    supportsBaseUrl: true,
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    suggestedModels: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1-mini'],
    supportsBaseUrl: true,
  },
  {
    provider: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'llama3.1',
    suggestedModels: ['llama3.1', 'qwen2.5', 'mistral'],
    supportsBaseUrl: true,
  },
];

export function llmProviderInfo(provider: LLMProviderName): LLMProviderInfo {
  return LLM_PROVIDERS.find((entry) => entry.provider === provider) ?? LLM_PROVIDERS[0]!;
}

export const defaultModelFor = (provider: LLMProviderName): string =>
  llmProviderInfo(provider).defaultModel;

/** The credential for a provider, read from the environment only. */
export function resolveLLMApiKey(
  provider: LLMProviderName,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (provider === 'gemini') return env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  const variable = llmProviderInfo(provider).apiKeyEnvVar;
  const explicit = env.CALENDAR_AGENT_LLM_API_KEY;
  if (explicit) return explicit;
  return variable ? env[variable] : undefined;
}

/** Providers that already have a usable credential in this environment. */
export function providersWithCredentials(
  env: Record<string, string | undefined> = process.env,
): readonly LLMProviderName[] {
  return LLM_PROVIDERS.filter(
    (entry) =>
      entry.provider === 'none' ||
      entry.apiKeyEnvVar === undefined ||
      resolveLLMApiKey(entry.provider, env) !== undefined,
  ).map((entry) => entry.provider);
}
