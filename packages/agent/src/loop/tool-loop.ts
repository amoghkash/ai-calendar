import type { z } from 'zod';
import type { Logger } from '@calendar-agent/core';
import type { LLMMessage, LLMProvider, LLMToolResult, LLMToolSpec } from '../llm/types.js';

/**
 * One thing the agent can do.
 *
 * `schema` is what the model is shown; `input` is what actually validates the
 * arguments at runtime. They are written separately on purpose - the model's
 * schema is a hint it may ignore, and the zod schema is the authority, exactly
 * as the command schema and its JSON mirror already work in this package.
 */
export interface AgentTool<T = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  readonly input: z.ZodType<T>;
  /** True when running it can change something. Logged, and counted. */
  readonly writes?: boolean;
  run(input: T): Promise<unknown>;
}

export interface ToolLoopOptions {
  readonly llm: LLMProvider;
  readonly tools: readonly AgentTool<never>[];
  readonly system: string;
  /**
   * How many model turns before giving up. Each turn may run several tools, so
   * this bounds the conversation, not the work.
   */
  readonly maxIterations?: number;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

export interface ToolInvocation {
  readonly name: string;
  readonly input: unknown;
  readonly ok: boolean;
  readonly summary: string;
}

export interface ToolLoopResult {
  readonly text: string;
  readonly calls: readonly ToolInvocation[];
  readonly iterations: number;
  /** True when the loop hit its cap with the model still asking for tools. */
  readonly exhausted: boolean;
}

const DEFAULT_MAX_ITERATIONS = 12;
/** Long tool output wastes context and rarely helps. */
const MAX_RESULT_CHARS = 8_000;

/**
 * Run the model until it answers.
 *
 * The model chooses which operations to run and in what order; the operations
 * are ordinary service calls that keep their own gates. That is the whole
 * difference from parsing a request into a fixed command list: nothing here
 * needs to anticipate the shape of a request, so "lunch with Sam tomorrow" and
 * "why did nothing fit?" both work without a schema field for either.
 *
 * A tool that throws becomes a result the model can read and react to, not an
 * exception that ends the turn - the same reason a failing shell command does
 * not kill a coding session.
 */
export async function runToolLoop(
  messages: readonly LLMMessage[],
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const specs: LLMToolSpec[] = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
  }));

  const conversation: LLMMessage[] = [...messages];
  const calls: ToolInvocation[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const response = await options.llm.generate({
      system: options.system,
      messages: conversation,
      tools: specs,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const requested = response.toolCalls ?? [];
    if (requested.length === 0) {
      return { text: response.text.trim(), calls, iterations: iteration, exhausted: false };
    }

    conversation.push({
      role: 'assistant',
      content: response.text,
      toolCalls: requested,
    });

    const results: LLMToolResult[] = [];
    for (const call of requested) {
      const tool = byName.get(call.name);
      if (!tool) {
        results.push({
          toolCallId: call.id,
          content: `No tool named "${call.name}".`,
          isError: true,
        });
        calls.push({ name: call.name, input: call.input, ok: false, summary: 'unknown tool' });
        continue;
      }

      const parsed = tool.input.safeParse(call.input);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        results.push({ toolCallId: call.id, content: `Invalid arguments: ${detail}`, isError: true });
        calls.push({ name: call.name, input: call.input, ok: false, summary: detail });
        continue;
      }

      try {
        const output = await (tool as AgentTool<unknown>).run(parsed.data);
        const content = render(output);
        results.push({ toolCallId: call.id, content });
        calls.push({ name: call.name, input: parsed.data, ok: true, summary: content.slice(0, 120) });
        options.logger?.debug?.('agent.tool', { name: tool.name, writes: tool.writes === true });
      } catch (error) {
        // A refusal is information: "that calendar is read-only" is something
        // the model should read and work around, not a dead turn.
        const message = error instanceof Error ? error.message : String(error);
        results.push({ toolCallId: call.id, content: message, isError: true });
        calls.push({ name: call.name, input: parsed.data, ok: false, summary: message });
        options.logger?.info?.('agent.tool_failed', { name: tool.name, message });
      }
    }

    conversation.push({ role: 'user', content: '', toolResults: results });
  }

  return {
    text: 'I could not finish that in a reasonable number of steps. Try narrowing the request.',
    calls,
    iterations: maxIterations,
    exhausted: true,
  };
}

function render(output: unknown): string {
  if (output === undefined || output === null) return 'done';
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n...(truncated)`
    : text;
}
