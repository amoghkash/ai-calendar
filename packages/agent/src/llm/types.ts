/**
 * LLM boundary.
 *
 * The intelligence layer is optional: every scheduling decision is made by the
 * deterministic engine. A model decides *which* operations to run and in what
 * order; the operations themselves are ordinary service calls with their own
 * gates, so a model never mutates a calendar directly and never places a block.
 */

export type LLMRole = 'system' | 'user' | 'assistant';

/** A tool the model asked to run, with the arguments it chose. */
export interface LLMToolCall {
  /** Provider-assigned id; the matching result must quote it back. */
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface LLMToolResult {
  readonly toolCallId: string;
  /** Rendered for the model. Errors are results too, not exceptions. */
  readonly content: string;
  readonly isError?: boolean;
}

export interface LLMMessage {
  readonly role: LLMRole;
  readonly content: string;
  /** On an assistant turn: what it asked to run. */
  readonly toolCalls?: readonly LLMToolCall[];
  /** On a user turn: what came back from the previous assistant turn's calls. */
  readonly toolResults?: readonly LLMToolResult[];
}

export interface LLMToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly schema: Record<string, unknown>;
}

export interface JsonSchemaSpec {
  readonly name: string;
  readonly description?: string;
  /** A JSON Schema object describing the expected response. */
  readonly schema: Record<string, unknown>;
}

export interface LLMRequest {
  readonly system?: string;
  readonly messages: readonly LLMMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** When present the provider must return JSON matching this schema. */
  readonly jsonSchema?: JsonSchemaSpec;
  /** Tools the model may call. Mutually exclusive with `jsonSchema` in practice. */
  readonly tools?: readonly LLMToolSpec[];
  readonly signal?: AbortSignal;
}

export interface LLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Why the model stopped. `tool_use` means it is waiting for results. */
export type LLMStopReason = 'end' | 'tool_use' | 'length' | 'other';

export interface LLMResponse {
  readonly text: string;
  /** Parsed JSON payload when `jsonSchema` was requested. */
  readonly json?: unknown;
  /** Populated when the model wants tools run before it can answer. */
  readonly toolCalls?: readonly LLMToolCall[];
  readonly stopReason?: LLMStopReason;
  readonly model: string;
  readonly usage?: LLMUsage;
  readonly raw?: unknown;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BaseProviderOptions {
  readonly apiKey?: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly fetch?: FetchLike;
}

/** Extract the first JSON object/array from a model response. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start === -1) throw new SyntaxError('The model response contained no JSON.');
    const opening = candidate[start];
    const closing = opening === '{' ? '}' : ']';
    const end = candidate.lastIndexOf(closing);
    if (end <= start) throw new SyntaxError('The model response contained no complete JSON value.');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}
