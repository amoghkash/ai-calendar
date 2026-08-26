import { LLMError } from '@calendar-agent/core';
import type { LLMProvider } from '../llm/types.js';
import { LLMCommandParser } from './llm-parser.js';
import type { CommandParser, ParseRequest, ParseResult } from './types.js';

/**
 * Routes each request to exactly one parser, chosen per message so that
 * turning the model on or off in settings takes effect immediately.
 *
 * The rule is deliberately absolute: when a model is configured it interprets
 * every request, and the deterministic rule parser is used only when no model
 * is set. Mixing the two silently made identical phrasings behave differently
 * depending on which one happened to answer, which is impossible to reason
 * about. If the model is configured but unreachable, that is reported rather
 * than papered over with a guess.
 */
export class AdaptiveCommandParser implements CommandParser {
  readonly name = 'adaptive';
  private readonly llmParser: CommandParser;

  constructor(
    private readonly llm: LLMProvider,
    private readonly heuristic: CommandParser,
    private readonly onFailure?: (error: unknown) => void,
  ) {
    this.llmParser = new LLMCommandParser({ llm });
  }

  /** Which parser will answer right now. Surfaced in the UI. */
  get active(): 'llm' | 'heuristic' {
    return this.llm.name === 'none' ? 'heuristic' : 'llm';
  }

  async parse(request: ParseRequest): Promise<ParseResult> {
    if (this.active === 'heuristic') return this.heuristic.parse(request);

    try {
      return await this.llmParser.parse(request);
    } catch (error) {
      this.onFailure?.(error);
      const reason = error instanceof Error ? error.message : String(error);
      throw new LLMError(
        `${this.llm.name} (${this.llm.model}) could not interpret that request: ${reason}. ` +
          'While a model is configured it handles every request, so nothing was guessed. ' +
          'Retry, or set the provider to "none" in Settings to use the built-in rule parser.',
        { details: { provider: this.llm.name, model: this.llm.model }, cause: error },
      );
    }
  }
}
