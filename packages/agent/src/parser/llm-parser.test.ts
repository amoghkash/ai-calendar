import { describe, expect, it } from 'vitest';
import { LLMError, instantFromISO } from '@calendar-agent/core';
import { MockLLMProvider } from '../llm/mock.js';
import type { AgentContext } from '../prompts/system.js';
import { LLMCommandParser } from './llm-parser.js';

const NOW = instantFromISO('2026-03-09T09:00:00Z');
const context: AgentContext = {
  now: NOW,
  timezone: 'UTC',
  workingHoursSummary: 'Mon-Fri 09:00-17:00',
  automationMode: 'suggest',
  tasks: [
    {
      id: 'task-1',
      title: 'Database assignment',
      remainingMinutes: 180,
      priority: 'high',
      status: 'todo',
    },
  ],
};

const request = (text: string) => ({ text, now: NOW, timezone: 'UTC', context });

describe('LLMCommandParser', () => {
  it('maps a natural-language request onto validated commands', async () => {
    const llm = new MockLLMProvider([
      {
        intent: 'Create the ML project and schedule it',
        commands: [
          {
            type: 'create_task',
            title: 'Machine learning project',
            estimatedMinutes: 480,
            deadline: '2026-03-12T23:59:00Z',
          },
          { type: 'schedule' },
        ],
      },
    ]);
    const parser = new LLMCommandParser({ llm });
    const result = await parser.parse(
      request(
        "I need to finish my machine learning project by Thursday. It'll take about 8 hours.",
      ),
    );
    expect(result.source).toBe('llm');
    expect(result.commands.map((c) => c.type)).toEqual(['create_task', 'schedule']);
    // The task context is handed to the model so it can reference real ids.
    expect(llm.requests[0]!.system).toContain('task-1');
    expect(llm.requests[0]!.jsonSchema?.name).toBe('agent_plan');
  });

  it('retries once when the model returns something invalid', async () => {
    const llm = new MockLLMProvider([
      { commands: [{ type: 'launch_missiles' }] },
      { commands: [{ type: 'list_risks' }] },
    ]);
    const parser = new LLMCommandParser({ llm });
    const result = await parser.parse(request('what is at risk'));
    expect(result.commands).toEqual([{ type: 'list_risks' }]);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.system).toContain('previous answer was rejected');
  });

  it('gives up after the retry budget', async () => {
    const llm = new MockLLMProvider([
      { commands: [{ type: 'nope' }] },
      { commands: [{ type: 'nope' }] },
    ]);
    const parser = new LLMCommandParser({ llm });
    await expect(parser.parse(request('do something'))).rejects.toBeInstanceOf(LLMError);
  });

  it('sends every request to the model, even ones the rule parser could answer', async () => {
    const llm = new MockLLMProvider([{ commands: [{ type: 'list_risks' }] }]);
    const parser = new LLMCommandParser({ llm });
    const result = await parser.parse(request('What deadlines are at risk?'));
    // The rule parser handles this phrasing with high confidence, but a
    // configured model is the single interpreter of every request.
    expect(result.source).toBe('llm');
    expect(llm.requests).toHaveLength(1);
  });
});
