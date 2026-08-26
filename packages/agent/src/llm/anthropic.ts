import { LLMError } from '@calendar-agent/core';
import type {
  BaseProviderOptions,
  FetchLike,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from './types.js';
import { extractJson } from './types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Current Claude models reject sampling parameters such as `temperature`;
 * older ones still accept them, so the parameter is sent only when the model
 * id looks like a pre-4.6 release.
 */
const MODELS_WITHOUT_SAMPLING = /^claude-(opus|sonnet|fable|mythos)-(5|4-[678])/;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Anthropic Messages API client.
 *
 * Structured output is requested through a single-tool call with
 * `tool_choice`, which is the reliable way to get schema-shaped JSON back.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: BaseProviderOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.options.apiKey) throw new LLMError('Anthropic API key is not configured.');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.options.maxTokens ?? 2048,
      messages: request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content })),
    };
    const system = [
      request.system,
      ...request.messages.filter((m) => m.role === 'system').map((m) => m.content),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (system.length > 0) body.system = system;

    const temperature = request.temperature ?? this.options.temperature;
    if (temperature !== undefined && !MODELS_WITHOUT_SAMPLING.test(this.model)) {
      body.temperature = temperature;
    }

    if (request.jsonSchema) {
      body.tools = [
        {
          name: request.jsonSchema.name,
          description: request.jsonSchema.description ?? 'Return the structured result.',
          input_schema: request.jsonSchema.schema,
        },
      ];
      body.tool_choice = { type: 'tool', name: request.jsonSchema.name };
    }

    const response = await this.fetchImpl(
      `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const text = await response.text();
    if (!response.ok) {
      throw new LLMError(`Anthropic request failed (${response.status})`, {
        details: { body: text.slice(0, 500) },
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const parsed = JSON.parse(text) as AnthropicResponse;
    const blocks = parsed.content ?? [];
    const toolBlock = blocks.find((block) => block.type === 'tool_use');
    const textOutput = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();

    const json = request.jsonSchema
      ? (toolBlock?.input ?? (textOutput ? extractJson(textOutput) : undefined))
      : undefined;

    return {
      text: textOutput.length > 0 ? textOutput : JSON.stringify(json ?? {}),
      ...(json === undefined ? {} : { json }),
      model: parsed.model ?? this.model,
      usage: {
        inputTokens: parsed.usage?.input_tokens,
        outputTokens: parsed.usage?.output_tokens,
      },
      raw: parsed,
    };
  }
}
