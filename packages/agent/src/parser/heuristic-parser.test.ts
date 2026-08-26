import { describe, expect, it } from 'vitest';
import { instantFromISO, instantToISO } from '@calendar-agent/core';
import type { AgentContext } from '../prompts/system.js';
import { HeuristicCommandParser } from './heuristic-parser.js';

const NOW = instantFromISO('2026-03-09T09:00:00Z');

const context: AgentContext = {
  now: NOW,
  timezone: 'UTC',
  workingHoursSummary: 'Mon-Fri 09:00-17:00',
  automationMode: 'suggest',
  tasks: [
    {
      id: 'task-algo',
      title: 'Algorithms assignment',
      remainingMinutes: 240,
      priority: 'high',
      status: 'todo',
    },
    {
      id: 'task-ml',
      title: 'Machine learning project',
      remainingMinutes: 480,
      priority: 'normal',
      status: 'todo',
    },
  ],
};

const parser = new HeuristicCommandParser();
const parse = (text: string) => parser.parse({ text, now: NOW, timezone: 'UTC', context });

describe('HeuristicCommandParser', () => {
  it('recognises a risk question', async () => {
    const result = await parse('What deadlines are at risk?');
    expect(result.commands).toEqual([{ type: 'list_risks' }]);
  });

  it('recognises an explanation question', async () => {
    const result = await parse('Why is my Friday so full?');
    expect(result.commands[0]!.type).toBe('explain_schedule');
  });

  it('schedules a named task', async () => {
    const result = await parse('Schedule my algorithms assignment for this week');
    expect(result.commands).toEqual([{ type: 'schedule', taskRefs: ['task-algo'] }]);
  });

  it('finds time with a duration and a preferred window', async () => {
    const result = await parse('Give me two hours for research tomorrow morning');
    const command = result.commands[0]!;
    expect(command.type).toBe('find_time');
    if (command.type === 'find_time') {
      expect(command.durationMinutes).toBe(120);
      expect(command.purpose).toBe('research');
      expect(instantToISO(instantFromISO(command.rangeStart!))).toBe('2026-03-10T00:00:00.000Z');
      expect(command.preferredWindow).toEqual({ start: '06:00', end: '12:00' });
    }
  });

  it('turns "leave by" into a bounded reschedule', async () => {
    const result = await parse('Move my work around tomorrow so I can leave by 4pm');
    const command = result.commands[0]!;
    expect(command.type).toBe('reschedule');
    if (command.type === 'reschedule') {
      expect(instantToISO(instantFromISO(command.mustEndBy!))).toBe('2026-03-10T16:00:00.000Z');
    }
  });

  it('blocks out a requested free period', async () => {
    const result = await parse('I need Friday afternoon completely free');
    const command = result.commands[0]!;
    expect(command.type).toBe('block_time');
    if (command.type === 'block_time') {
      expect(instantToISO(instantFromISO(command.start))).toBe('2026-03-13T12:00:00.000Z');
      expect(instantToISO(instantFromISO(command.end))).toBe('2026-03-13T18:00:00.000Z');
    }
  });

  it('creates and schedules a task described in prose', async () => {
    const result = await parse(
      "I need to finish my machine learning report by Thursday, it'll take around 8 hours",
    );
    expect(result.commands.map((c) => c.type)).toEqual(['create_task', 'schedule']);
    const create = result.commands[0]!;
    if (create.type === 'create_task') {
      expect(create.estimatedMinutes).toBe(480);
      expect(instantToISO(instantFromISO(create.deadline!))).toBe('2026-03-12T23:59:00.000Z');
    }
  });

  it('lists the schedule for a day', async () => {
    const result = await parse('what does tomorrow look like');
    const command = result.commands[0]!;
    expect(command.type).toBe('list_schedule');
    if (command.type === 'list_schedule') {
      expect(instantToISO(instantFromISO(command.rangeStart!))).toBe('2026-03-10T00:00:00.000Z');
    }
  });

  it('returns nothing for a request it does not understand', async () => {
    const result = await parse('teleport me to the moon');
    expect(result.commands).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });
});

describe('HeuristicCommandParser: statements vs questions', () => {
  const parse = (text: string) => parser.parse({ text, now: NOW, timezone: 'UTC', context });

  it.each([
    ['I have a meeting tomorrow at 1230pm', 'Meeting', '2026-03-10T12:30:00.000Z'],
    ['I have a meeting tommorow at 1230pm', 'Meeting', '2026-03-10T12:30:00.000Z'],
    ['lunch with Ronit tomorrow at 12', 'Lunch with Ronit', '2026-03-10T12:00:00.000Z'],
    ['coffee with Sam thursday at 9:30am', 'Coffee with Sam', '2026-03-12T09:30:00.000Z'],
    [
      'I have a dentist appointment on friday at 3pm',
      'Dentist appointment',
      '2026-03-13T15:00:00.000Z',
    ],
  ])('reads %s as a calendar event', async (text, title, start) => {
    const result = await parse(text);
    const command = result.commands[0]!;
    expect(command.type).toBe('create_event');
    if (command.type === 'create_event') {
      expect(command.title).toBe(title);
      expect(instantToISO(instantFromISO(command.start))).toBe(start);
    }
  });

  it('does not treat a statement containing a day word as a request to see the schedule', async () => {
    const result = await parse('I have a meeting tomorrow at 1230pm');
    expect(result.commands.map((command) => command.type)).not.toContain('list_schedule');
  });

  it.each(['what does tomorrow look like', 'show me my calendar', 'tomorrow', "what's on today"])(
    'still reads %s as a request to see the schedule',
    async (text) => {
      const result = await parse(text);
      expect(result.commands[0]!.type).toBe('list_schedule');
    },
  );

  it('rolls a time that has already passed to the next day', async () => {
    // NOW is Monday 09:00 UTC, so "standup at 8am" means tomorrow.
    const result = await parse('standup at 8am');
    const command = result.commands[0]!;
    if (command.type === 'create_event') {
      expect(instantToISO(instantFromISO(command.start))).toBe('2026-03-10T08:00:00.000Z');
    }
  });
});
