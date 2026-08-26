/**
 * LLM boundary.
 *
 * The intelligence layer is optional: every scheduling decision is made by the
 * deterministic engine. An LLM only translates natural language into typed
 * commands and turns structured explanations into prose. It never mutates the
 * database or a calendar directly.
 */

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  readonly role: LLMRole;
  readonly content: string;
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
  readonly signal?: AbortSignal;
}

export interface LLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface LLMResponse {
  readonly text: string;
  /** Parsed JSON payload when `jsonSchema` was requested. */
  readonly json?: unknown;
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
