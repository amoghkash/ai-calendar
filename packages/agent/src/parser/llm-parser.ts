import { LLMError } from '@calendar-agent/core';
import { safeParseAgentPlan } from '../commands/schema.js';
import type { LLMProvider } from '../llm/types.js';
import { AGENT_PLAN_JSON_SCHEMA } from '../prompts/command-schema.js';
import { buildPlannerSystemPrompt } from '../prompts/system.js';
import type { CommandParser, ParseRequest, ParseResult } from './types.js';

export interface LLMCommandParserOptions {
  readonly llm: LLMProvider;
  /** Retried once with the validation errors appended. */
  readonly maxAttempts?: number;
}

/**
 * Turns free text into validated commands using an LLM.
 *
 * The model's output is never trusted: it is parsed against the zod schema and
 * a failure is fed back once before giving up. Commands still have to survive
 * application-level validation afterwards.
 */
export class LLMCommandParser implements CommandParser {
  readonly name = 'llm';

  constructor(private readonly options: LLMCommandParserOptions) {}

  async parse(request: ParseRequest): Promise<ParseResult> {
    const system = buildPlannerSystemPrompt(request.context);
    const messages = [
      ...(request.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user' as const, content: request.text },
    ];

    const attempts = this.options.maxAttempts ?? 2;
    const issuesSeen: string[] = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await this.options.llm.generate({
        system:
          attempt === 0
            ? system
            : `${system}\n\nYour previous answer was rejected:\n${issuesSeen.join('\n')}\nReturn corrected JSON.`,
        messages,
        jsonSchema: {
          name: 'agent_plan',
          description: 'The list of commands that satisfy the request.',
          schema: AGENT_PLAN_JSON_SCHEMA,
        },
      });

      const payload = response.json ?? safeJson(response.text);
      const validation = safeParseAgentPlan(payload);
      if (validation.ok) {
        return {
          commands: validation.plan.commands,
          source: 'llm',
          confidence: 0.9,
          ...(validation.plan.intent === undefined ? {} : { intent: validation.plan.intent }),
        };
      }
      issuesSeen.push(...validation.issues);
    }

    throw new LLMError('The model did not return a valid command plan.', {
      details: { issues: issuesSeen },
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
