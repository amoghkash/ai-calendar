import { LLMError } from '@calendar-agent/core';
import type { LLMProvider, LLMRequest, LLMResponse } from './types.js';

export type MockResponder = (request: LLMRequest) => LLMResponse | Promise<LLMResponse>;

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
