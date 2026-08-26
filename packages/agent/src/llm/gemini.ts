import { LLMError } from '@calendar-agent/core';
import type {
  BaseProviderOptions,
  FetchLike,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from './types.js';
import { extractJson } from './types.js';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Google Gemini `generateContent` client. */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: BaseProviderOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.options.apiKey) throw new LLMError('Gemini API key is not configured.');

    const body: Record<string, unknown> = {
      contents: request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig: {
        temperature: request.temperature ?? this.options.temperature ?? 0,
        maxOutputTokens: request.maxTokens ?? this.options.maxTokens ?? 2048,
        ...(request.jsonSchema
          ? { responseMimeType: 'application/json', responseSchema: request.jsonSchema.schema }
          : {}),
      },
    };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };

    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}/models/${this.model}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new LLMError(`Gemini request failed (${response.status})`, {
        details: { body: text.slice(0, 500) },
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const parsed = JSON.parse(text) as GeminiResponse;
    const content =
      parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    return {
      text: content,
      ...(request.jsonSchema ? { json: extractJson(content) } : {}),
      model: this.model,
      usage: {
        inputTokens: parsed.usageMetadata?.promptTokenCount,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount,
      },
      raw: parsed,
    };
  }
}
