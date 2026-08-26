import { describe, expect, it } from 'vitest';
import { LLMError } from '@calendar-agent/core';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { NullLLMProvider } from './mock.js';
import { createLLMProvider } from './factory.js';
import { extractJson } from './types.js';

function stubFetch(response: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const body = (init?: RequestInit): Record<string, any> =>
  JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;

describe('AnthropicProvider', () => {
  it('sends the required headers and returns tool output as JSON', async () => {
    const { calls, fetchImpl } = stubFetch({
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', name: 'agent_plan', input: { commands: [] } }],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-opus-5',
      fetch: fetchImpl,
    });
    const result = await provider.generate({
      system: 'be precise',
      messages: [{ role: 'user', content: 'hello' }],
      jsonSchema: { name: 'agent_plan', schema: { type: 'object' } },
    });

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const sent = body(calls[0]!.init);
    expect(sent.system).toBe('be precise');
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'agent_plan' });
    expect(result.json).toEqual({ commands: [] });
    expect(result.usage?.outputTokens).toBe(4);
  });

  it('omits sampling parameters on models that reject them', async () => {
    const { calls, fetchImpl } = stubFetch({ content: [{ type: 'text', text: 'ok' }] });
    await new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-opus-5',
      temperature: 0.5,
      fetch: fetchImpl,
    }).generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(body(calls[0]!.init).temperature).toBeUndefined();

    const older = stubFetch({ content: [{ type: 'text', text: 'ok' }] });
    await new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-3-5-haiku-20241022',
      temperature: 0.5,
      fetch: older.fetchImpl,
    }).generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(body(older.calls[0]!.init).temperature).toBe(0.5);
  });

  it('surfaces API failures as LLM errors', async () => {
    const { fetchImpl } = stubFetch({ error: { message: 'bad' } }, 400);
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-opus-5',
      fetch: fetchImpl,
    });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(LLMError);
  });
});

describe('OpenAICompatibleProvider', () => {
  it('posts a chat completion and requests a JSON schema', async () => {
    const { calls, fetchImpl } = stubFetch({
      model: 'gpt-4.1-mini',
      choices: [{ message: { content: '{"commands":[]}' } }],
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk',
      model: 'gpt-4.1-mini',
      fetch: fetchImpl,
    });
    const result = await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      jsonSchema: { name: 'agent_plan', schema: { type: 'object' } },
    });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body(calls[0]!.init).response_format.type).toBe('json_schema');
    expect(result.json).toEqual({ commands: [] });
  });

  it('routes local models through the same client', async () => {
    const { calls, fetchImpl } = stubFetch({ choices: [{ message: { content: 'hello' } }] });
    await new OpenAICompatibleProvider({
      model: 'llama3.1',
      providerName: 'ollama',
      fetch: fetchImpl,
    }).generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
  });
});

describe('GeminiProvider', () => {
  it('uses generateContent with a response schema', async () => {
    const { calls, fetchImpl } = stubFetch({
      candidates: [{ content: { parts: [{ text: '{"commands":[]}' }] } }],
    });
    const result = await new GeminiProvider({
      apiKey: 'key',
      model: 'gemini-2.5-flash',
      fetch: fetchImpl,
    }).generate({
      messages: [{ role: 'user', content: 'hi' }],
      jsonSchema: { name: 'agent_plan', schema: { type: 'object' } },
    });
    expect(calls[0]!.url).toContain('models/gemini-2.5-flash:generateContent');
    expect(body(calls[0]!.init).generationConfig.responseMimeType).toBe('application/json');
    expect(result.json).toEqual({ commands: [] });
  });
});

describe('factory', () => {
  it('returns a null provider when no LLM is configured', async () => {
    const provider = createLLMProvider({ provider: 'none', model: '' });
    expect(provider).toBeInstanceOf(NullLLMProvider);
    await expect(provider.generate({ messages: [] })).rejects.toThrow(/No LLM provider/);
  });

  it.each([
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['openrouter', 'openrouter'],
    ['ollama', 'ollama'],
    ['gemini', 'gemini'],
  ])('builds the %s provider', (name, expected) => {
    expect(createLLMProvider({ provider: name, model: 'm' }).name).toBe(expected);
  });
});

describe('extractJson', () => {
  it('unwraps fenced JSON and trailing prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":2} - hope that helps')).toEqual({ a: 2 });
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});
