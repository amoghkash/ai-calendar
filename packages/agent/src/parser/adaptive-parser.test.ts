import { describe, expect, it, vi } from 'vitest';
import { LLMError, instantFromISO } from '@calendar-agent/core';
import { MockLLMProvider, NullLLMProvider } from '../llm/mock.js';
import type { AgentContext } from '../prompts/system.js';
import { AdaptiveCommandParser } from './adaptive-parser.js';
import { HeuristicCommandParser } from './heuristic-parser.js';

const NOW = instantFromISO('2026-03-09T09:00:00Z');
const context: AgentContext = {
  now: NOW,
  timezone: 'UTC',
  workingHoursSummary: 'Mon-Fri 09:00-17:00',
  automationMode: 'suggest',
  tasks: [],
};
const request = (text: string) => ({ text, now: NOW, timezone: 'UTC', context });

describe('AdaptiveCommandParser', () => {
  it('uses the rule parser only when no model is configured', async () => {
    const parser = new AdaptiveCommandParser(new NullLLMProvider(), new HeuristicCommandParser());
    expect(parser.active).toBe('heuristic');
    const result = await parser.parse(request('what deadlines are at risk?'));
    expect(result.source).toBe('heuristic');
    expect(result.commands).toEqual([{ type: 'list_risks' }]);
  });

  it('routes every request to the model when one is configured', async () => {
    const llm = new MockLLMProvider([
      { commands: [{ type: 'list_risks' }] },
      { commands: [{ type: 'list_schedule' }] },
    ]);
    const parser = new AdaptiveCommandParser(llm, new HeuristicCommandParser());
    expect(parser.active).toBe('llm');

    // Both of these are phrasings the rule parser answers confidently.
    expect((await parser.parse(request('what deadlines are at risk?'))).source).toBe('llm');
    expect((await parser.parse(request('tomorrow'))).source).toBe('llm');
    expect(llm.requests).toHaveLength(2);
  });

  it('reports a model failure instead of silently guessing', async () => {
    const llm = new MockLLMProvider([]); // runs out of scripted responses
    const onFailure = vi.fn();
    const parser = new AdaptiveCommandParser(llm, new HeuristicCommandParser(), onFailure);

    // "at risk" is a phrasing the rule parser could answer - it must not.
    await expect(parser.parse(request('what deadlines are at risk?'))).rejects.toBeInstanceOf(
      LLMError,
    );
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('explains how to fall back to the rule parser when the model fails', async () => {
    const parser = new AdaptiveCommandParser(new MockLLMProvider([]), new HeuristicCommandParser());
    await expect(parser.parse(request('anything'))).rejects.toThrow(
      /set the provider to "none" in Settings/,
    );
  });

  it('follows the model being turned off at runtime', async () => {
    const llm = new MockLLMProvider([{ commands: [{ type: 'list_risks' }] }]);
    const parser = new AdaptiveCommandParser(llm, new HeuristicCommandParser());
    expect((await parser.parse(request('what is at risk?'))).source).toBe('llm');

    const off = new AdaptiveCommandParser(new NullLLMProvider(), new HeuristicCommandParser());
    expect((await off.parse(request('what is at risk?'))).source).toBe('heuristic');
  });
});
