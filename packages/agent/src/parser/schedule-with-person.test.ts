import { describe, expect, it } from 'vitest';
import { HeuristicCommandParser } from './heuristic-parser.js';

const parser = new HeuristicCommandParser();
const parse = async (text: string) =>
  (await parser.parse({ text, now: Date.parse('2026-03-09T08:00:00Z'), timezone: 'UTC', tasks: [] }))
    .commands[0];

describe('arranging something with a person, without a model', () => {
  it('reads the plainest form', async () => {
    expect(await parse('lunch with Sarah')).toEqual({
      type: 'schedule_with_person',
      person: 'Sarah',
      activity: 'lunch',
    });
  });

  it('reads the ways people actually ask', async () => {
    for (const text of [
      'schedule lunch with Sarah',
      'set up lunch with Sarah',
      'can you arrange lunch with Sarah',
      'grab lunch with Sarah',
    ]) {
      expect(await parse(text)).toMatchObject({ type: 'schedule_with_person', person: 'Sarah' });
    }
  });

  it('keeps a full name together but drops a trailing time word', async () => {
    expect(await parse('dinner with Sarah Chen')).toMatchObject({ person: 'Sarah Chen' });
    expect(await parse('dinner with Sarah tomorrow')).toMatchObject({ person: 'Sarah' });
  });

  it('carries a qualifier into the activity', async () => {
    expect(await parse('coffee with Mike this week')).toMatchObject({
      activity: 'coffee this week',
      person: 'Mike',
    });
  });

  it('leaves a settled time to create_event', async () => {
    // The time is agreed, so there is nobody to ask and nothing to draft.
    expect(await parse('lunch with Sarah at 1pm tomorrow')).toMatchObject({
      type: 'create_event',
    });
  });

  it('does not fire without a person', async () => {
    expect(await parse('lunch')).not.toMatchObject({ type: 'schedule_with_person' });
  });

  it('recognises the other activities', async () => {
    for (const [text, activity] of [
      ['drinks with Priya', 'drinks'],
      ['breakfast with Priya', 'breakfast'],
      ['a walk with Priya', 'a walk'],
    ] as const) {
      expect(await parse(text)).toMatchObject({ type: 'schedule_with_person', activity });
    }
  });
});

describe('a day the user named', () => {
  const NOW = Date.parse('2026-03-09T08:00:00Z');
  const parseAt = async (text: string) =>
    (
      await new HeuristicCommandParser().parse({
        text,
        now: NOW,
        timezone: 'UTC',
        tasks: [],
      })
    ).commands[0] as Record<string, unknown>;

  it('carries "tomorrow" through instead of dropping it', async () => {
    const command = await parseAt('I want to get lunch with Viraj tomorrow');

    expect(command).toMatchObject({ type: 'schedule_with_person', person: 'Viraj' });
    // Dropping this is what offered Saturday to someone who asked for Thursday.
    expect(command.rangeStart).toBe('2026-03-10T00:00:00.000Z');
    expect(command.rangeEnd).toBe('2026-03-11T00:00:00.000Z');
  });

  it('carries "today"', async () => {
    const command = await parseAt('coffee with Viraj today');
    expect(command.rangeStart).toBe('2026-03-09T00:00:00.000Z');
  });

  it('leaves the window open when no day is named', async () => {
    const command = await parseAt('lunch with Viraj');
    expect(command.rangeStart).toBeUndefined();
  });
});
