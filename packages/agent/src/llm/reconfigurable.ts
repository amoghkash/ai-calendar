import type { LLMFactoryOptions } from './factory.js';
import { createLLMProvider } from './factory.js';
import type { LLMProvider, LLMRequest, LLMResponse } from './types.js';

/**
 * A provider whose identity is stable but whose implementation can be swapped.
 *
 * Services capture the LLM once at construction, so changing the model in the
 * settings panel has to replace the delegate rather than the reference. `name`
 * and `model` are getters, which keeps `name === 'none'` an honest test of
 * whether an LLM is currently enabled.
 */
export class ReconfigurableLLMProvider implements LLMProvider {
  private delegate: LLMProvider;
  private options: LLMFactoryOptions;

  constructor(options: LLMFactoryOptions) {
    this.options = options;
    this.delegate = createLLMProvider(options);
  }

  get name(): string {
    return this.delegate.name;
  }

  get model(): string {
    return this.delegate.model;
  }

  /** The options the current delegate was built from. */
  get configuration(): LLMFactoryOptions {
    return this.options;
  }

  configure(options: LLMFactoryOptions): void {
    this.options = options;
    this.delegate = createLLMProvider(options);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    return this.delegate.generate(request);
  }
}
