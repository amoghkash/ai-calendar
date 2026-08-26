import { LLMError } from '@calendar-agent/core';
import type {
  BaseProviderOptions,
  FetchLike,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from './types.js';
import { extractJson } from './types.js';

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAICompatibleOptions extends BaseProviderOptions {
  /** Display name; also used for provider-specific headers. */
  readonly providerName?: 'openai' | 'openrouter' | 'ollama';
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};

/**
 * Client for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Covers OpenAI, OpenRouter and local runtimes such as Ollama or llama.cpp,
 * which all speak the same wire format; only the base url and key differ.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = options.providerName ?? 'openai';
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[this.name] ?? DEFAULT_BASE_URLS.openai!;
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.options.apiKey && this.name !== 'ollama') {
      throw new LLMError(`${this.name} API key is not configured.`);
    }

    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? this.options.maxTokens ?? 2048,
      temperature: request.temperature ?? this.options.temperature ?? 0,
    };

    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          schema: request.jsonSchema.schema,
          strict: false,
        },
      };
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new LLMError(`${this.name} request failed (${response.status})`, {
        details: { body: text.slice(0, 500) },
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const parsed = JSON.parse(text) as ChatCompletionResponse;
    const content = parsed.choices?.[0]?.message?.content ?? '';
    return {
      text: content,
      ...(request.jsonSchema ? { json: extractJson(content) } : {}),
      model: parsed.model ?? this.model,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens,
        outputTokens: parsed.usage?.completion_tokens,
      },
      raw: parsed,
    };
  }
}
