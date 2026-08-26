import type { Instant } from '@calendar-agent/core';
import type { AgentCommand } from '../commands/schema.js';
import type { AgentContext } from '../prompts/system.js';

export interface ParseRequest {
  readonly text: string;
  readonly now: Instant;
  readonly timezone: string;
  readonly context: AgentContext;
  /** Prior turns, oldest first, for follow-up questions. */
  readonly history?: readonly { role: 'user' | 'assistant'; content: string }[];
}

export interface ParseResult {
  readonly commands: readonly AgentCommand[];
  readonly source: 'llm' | 'heuristic';
  /** 0..1. Heuristic matches report how specific the matched rule was. */
  readonly confidence: number;
  readonly intent?: string;
  readonly notes?: readonly string[];
}

export interface CommandParser {
  readonly name: string;
  parse(request: ParseRequest): Promise<ParseResult>;
}
