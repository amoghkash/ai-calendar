import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMProvider, mockText, mockToolCalls } from '../llm/mock.js';
import type { AgentTool } from './tool-loop.js';
import { runToolLoop } from './tool-loop.js';

const echo = (calls: string[]): AgentTool<never> =>
  ({
    name: 'echo',
    description: 'Echo a value back.',
    schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    input: z.object({ value: z.string() }),
    run: (input: { value: string }) => {
      calls.push(input.value);
      return Promise.resolve({ echoed: input.value });
    },
  }) as unknown as AgentTool<never>;

const exploding: AgentTool<never> = {
  name: 'explode',
  description: 'Always fails.',
  schema: { type: 'object', properties: {} },
  input: z.object({}),
  run: () => Promise.reject(new Error('that calendar is read-only')),
} as unknown as AgentTool<never>;

const run = (llm: MockLLMProvider, tools: AgentTool<never>[], maxIterations?: number) =>
  runToolLoop([{ role: 'user', content: 'do it' }], {
    llm,
    tools,
    system: 'be useful',
    ...(maxIterations === undefined ? {} : { maxIterations }),
  });

describe('the tool loop', () => {
  it('answers directly when no tool is needed', async () => {
    const result = await run(new MockLLMProvider([mockText('nothing to do')]), []);
    expect(result).toMatchObject({ text: 'nothing to do', iterations: 1, exhausted: false });
    expect(result.calls).toEqual([]);
  });

  it('runs a tool and feeds the result back', async () => {
    const calls: string[] = [];
    const llm = new MockLLMProvider([
      mockToolCalls([{ name: 'echo', input: { value: 'hello' } }]),
      mockText('done'),
    ]);

    const result = await run(llm, [echo(calls)]);

    expect(calls).toEqual(['hello']);
    expect(result.text).toBe('done');
    expect(result.iterations).toBe(2);
    // The second request must carry the assistant's call and the result.
    const second = llm.requests[1]!;
    expect(second.messages.at(-2)?.toolCalls?.[0]?.name).toBe('echo');
    expect(second.messages.at(-1)?.toolResults?.[0]?.content).toContain('hello');
  });

  it('runs several tools in one turn', async () => {
    const calls: string[] = [];
    const llm = new MockLLMProvider([
      mockToolCalls([
        { name: 'echo', input: { value: 'a' } },
        { name: 'echo', input: { value: 'b' } },
      ]),
      mockText('both'),
    ]);

    await run(llm, [echo(calls)]);

    expect(calls).toEqual(['a', 'b']);
    expect(llm.requests[1]!.messages.at(-1)?.toolResults).toHaveLength(2);
  });

  it('hands a refusal back as a result rather than ending the turn', async () => {
    const llm = new MockLLMProvider([
      mockToolCalls([{ name: 'explode', input: {} }]),
      mockText('I could not do that because the calendar is read-only.'),
    ]);

    const result = await run(llm, [exploding]);

    expect(result.text).toMatch(/read-only/);
    expect(result.calls[0]).toMatchObject({ name: 'explode', ok: false });
    const followUp = llm.requests[1]!.messages.at(-1)?.toolResults?.[0];
    expect(followUp?.isError).toBe(true);
    expect(followUp?.content).toBe('that calendar is read-only');
  });

  it('rejects arguments that do not validate, without running the tool', async () => {
    const calls: string[] = [];
    const llm = new MockLLMProvider([
      mockToolCalls([{ name: 'echo', input: { value: 42 } }]),
      mockText('fixed'),
    ]);

    const result = await run(llm, [echo(calls)]);

    expect(calls).toEqual([]);
    expect(result.calls[0]?.ok).toBe(false);
    expect(llm.requests[1]!.messages.at(-1)?.toolResults?.[0]?.content).toMatch(/Invalid arguments/);
  });

  it('tells the model when it asks for a tool that does not exist', async () => {
    const llm = new MockLLMProvider([
      mockToolCalls([{ name: 'nope', input: {} }]),
      mockText('ok'),
    ]);

    const result = await run(llm, []);

    expect(result.calls[0]).toMatchObject({ name: 'nope', ok: false });
    expect(llm.requests[1]!.messages.at(-1)?.toolResults?.[0]?.content).toMatch(/No tool named/);
  });

  it('stops rather than looping forever', async () => {
    const calls: string[] = [];
    const llm = new MockLLMProvider(
      Array.from({ length: 10 }, () => mockToolCalls([{ name: 'echo', input: { value: 'x' } }])),
    );

    const result = await run(llm, [echo(calls)], 3);

    expect(result.exhausted).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.text).toMatch(/could not finish/);
  });

  it('passes every tool to the model as a spec', async () => {
    const llm = new MockLLMProvider([mockText('hi')]);
    await run(llm, [echo([])]);
    expect(llm.requests[0]!.tools?.map((tool) => tool.name)).toEqual(['echo']);
  });
});
