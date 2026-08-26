import type { LLMProvider } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatibleProvider } from './openai.js';
import { NullLLMProvider } from './mock.js';

export interface LLMFactoryOptions {
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Build the configured provider. Unknown or `none` yields a null provider. */
export function createLLMProvider(options: LLMFactoryOptions): LLMProvider {
  const base = {
    model: options.model,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };

  switch (options.provider) {
    case 'anthropic':
      return new AnthropicProvider(base);
    case 'openai':
      return new OpenAICompatibleProvider({ ...base, providerName: 'openai' });
    case 'openrouter':
      return new OpenAICompatibleProvider({ ...base, providerName: 'openrouter' });
    case 'ollama':
      return new OpenAICompatibleProvider({ ...base, providerName: 'ollama' });
    case 'gemini':
      return new GeminiProvider(base);
    default:
      return new NullLLMProvider();
  }
}

export const isLLMEnabled = (provider: LLMProvider): boolean => provider.name !== 'none';
