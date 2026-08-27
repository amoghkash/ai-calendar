import { LLMError } from '@calendar-agent/core';
import type {
  LLMMessage,
  LLMStopReason,
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
  id?: string;
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
        .map((message) => ({ role: message.role, content: toContent(message) })),
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
      // Forcing one tool is the reliable way to get schema-shaped JSON back.
      body.tools = [
        {
          name: request.jsonSchema.name,
          description: request.jsonSchema.description ?? 'Return the structured result.',
          input_schema: request.jsonSchema.schema,
        },
      ];
      body.tool_choice = { type: 'tool', name: request.jsonSchema.name };
    } else if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
      }));
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

    // Every tool_use block, not just the first: a turn may ask for several.
    const toolCalls = request.jsonSchema
      ? []
      : blocks
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({
            id: block.id ?? '',
            name: block.name ?? '',
            input: block.input,
          }));

    return {
      text: textOutput.length > 0 ? textOutput : request.jsonSchema ? JSON.stringify(json ?? {}) : '',
      ...(json === undefined ? {} : { json }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      stopReason: stopReasonOf(parsed.stop_reason),
      model: parsed.model ?? this.model,
      usage: {
        inputTokens: parsed.usage?.input_tokens,
        outputTokens: parsed.usage?.output_tokens,
      },
      raw: parsed,
    };
  }
}

/**
 * One message becomes either a plain string or a list of content blocks.
 *
 * Anthropic wants tool results on a *user* turn and tool calls on the
 * *assistant* turn that made them, each keyed by the same id. Getting that
 * pairing wrong is the usual reason a tool loop silently stops working.
 */
function toContent(message: LLMMessage): unknown {
  if (message.toolResults && message.toolResults.length > 0) {
    const blocks: unknown[] = message.toolResults.map((result) => ({
      type: 'tool_result',
      tool_use_id: result.toolCallId,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    }));
    if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
    return blocks;
  }

  if (message.toolCalls && message.toolCalls.length > 0) {
    const blocks: unknown[] = [];
    if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    return blocks;
  }

  return message.content;
}

function stopReasonOf(reason: string | undefined): LLMStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end';
  if (reason === 'max_tokens') return 'length';
  return 'other';
}
