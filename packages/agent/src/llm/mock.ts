import { LLMError } from '@calendar-agent/core';
import type { LLMProvider, LLMRequest, LLMResponse } from './types.js';

export type MockResponder = (request: LLMRequest) => LLMResponse | Promise<LLMResponse>;

/** Script one turn that asks for tools; the loop feeds results back and asks again. */
export const mockToolCalls = (
  calls: readonly { name: string; input: unknown; id?: string }[],
  text = '',
): LLMResponse => ({
  text,
  model: 'mock-model',
  stopReason: 'tool_use',
  toolCalls: calls.map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.name,
    input: call.input,
  })),
});

/** Script the turn that ends the loop. */
export const mockText = (text: string): LLMResponse => ({
  text,
  model: 'mock-model',
  stopReason: 'end',
});

/** Scripted provider. Tests must never depend on a real model response. */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';
  readonly requests: LLMRequest[] = [];
  private readonly queue: (LLMResponse | MockResponder)[];

  constructor(responses: (LLMResponse | MockResponder | unknown)[] = []) {
    this.queue = responses.map((response) =>
      typeof response === 'function' || isResponse(response)
        ? (response as LLMResponse | MockResponder)
        : ({ text: JSON.stringify(response), json: response, model: 'mock-model' } as LLMResponse),
    );
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined) throw new LLMError('MockLLMProvider ran out of scripted responses.');
    return typeof next === 'function' ? next(request) : next;
  }
}

function isResponse(value: unknown): value is LLMResponse {
  return typeof value === 'object' && value !== null && 'text' in value && 'model' in value;
}

/** Placeholder used when no LLM is configured. Core features never need it. */
export class NullLLMProvider implements LLMProvider {
  readonly name = 'none';
  readonly model = 'none';
  async generate(): Promise<LLMResponse> {
    throw new LLMError(
      'No LLM provider is configured. Set llm.provider (or an API key) to enable natural-language features; scheduling works without it.',
    );
  }
}
