import { describe, expect, it } from 'vitest';
import { LLMMessageWriter, acceptable } from './llm-message-writer.js';
import type { LLMProvider } from '../llm/types.js';

const t = (iso: string): number => Date.parse(iso);
const NOW = t('2026-03-09T08:00:00Z');
const slot = (iso: string) => ({ start: t(iso), end: t(iso) + 3_600_000 });
const SLOTS = [slot('2026-03-10T12:00:00Z'), slot('2026-03-10T14:00:00Z')];

const llm = (text: string, fail = false): LLMProvider => ({
  name: 'fake',
  model: 'fake',
  generate: () =>
    fail ? Promise.reject(new Error('down')) : Promise.resolve({ text, model: 'fake' }),
});

const write = (text: string, fail = false) =>
  new LLMMessageWriter({ llm: llm(text, fail) }).write({
    kind: 'propose',
    displayName: 'Sam Rivera',
    activity: 'lunch',
    slots: SLOTS,
    tone: 'casual',
    timezone: 'UTC',
    now: NOW,
    fallback: "Hey Sam, lunch? I'm free tomorrow at 12pm or 2pm. Any of those work?",
  });

describe('letting the model write the message', () => {
  it('accepts a natural rewording that keeps the times', async () => {
    expect(await write('Sam! Free for lunch tomorrow at 12pm or 2pm? Either suits me.')).toBe(
      'Sam! Free for lunch tomorrow at 12pm or 2pm? Either suits me.',
    );
  });

  it('rejects a message that invents a time', async () => {
    // The scheduler never approved 4pm and the user never saw it.
    expect(await write('Sam, lunch tomorrow at 12pm, 2pm, or maybe 4pm?')).toBeUndefined();
  });

  it('rejects a message that drops a time it was given', async () => {
    expect(await write('Sam, lunch tomorrow at 12pm?')).toBeUndefined();
  });

  it('rejects a message that changes a time', async () => {
    expect(await write('Sam, lunch tomorrow at 12pm or 3pm?')).toBeUndefined();
  });

  it('rejects a message that forgets who it is to', async () => {
    expect(await write('Lunch tomorrow at 12pm or 2pm?')).toBeUndefined();
  });

  it('rejects an essay', async () => {
    const long = `Sam, ${'a lovely long preamble '.repeat(20)} 12pm or 2pm?`;
    expect(await write(long)).toBeUndefined();
  });

  it('gives up when the model cannot be reached', async () => {
    expect(await write('', true)).toBeUndefined();
  });

  it('tidies quoting and stray whitespace', async () => {
    expect(await write('  "Sam, lunch tomorrow at 12pm or 2pm?"  ')).toBe(
      'Sam, lunch tomorrow at 12pm or 2pm?',
    );
  });
});

describe('the acceptance check', () => {
  const times = 'tomorrow at 12pm or 2pm';

  it('treats 12:00pm and 12pm as the same time', () => {
    expect(acceptable('Sam, tomorrow 12:00pm or 2pm?', 'Sam', times)).toBe(true);
  });

  it('does not care about spacing around am/pm', () => {
    expect(acceptable('Sam, tomorrow 12 pm or 2 pm?', 'Sam', times)).toBe(true);
  });

  it('accepts two offers that share a clock time on different days', () => {
    // The common case: proposals pick the same hour each day, so the clock
    // tokens collapse and only the day words tell the offers apart.
    const spread = 'tomorrow at 12pm, Sat at 11:30am or Sun at 11:30am';
    expect(
      acceptable('Sam, lunch tomorrow at 12pm, Sat at 11:30am or Sun at 11:30am?', 'Sam', spread),
    ).toBe(true);
  });

  it('rejects a message that quietly drops one of two same-time days', () => {
    const spread = 'tomorrow at 12pm, Sat at 11:30am or Sun at 11:30am';
    expect(acceptable('Sam, lunch tomorrow at 12pm or Sat at 11:30am?', 'Sam', spread)).toBe(false);
  });

  it('rejects a message that moves an offer to a different day', () => {
    const spread = 'tomorrow at 12pm or Sat at 11:30am';
    expect(acceptable('Sam, lunch tomorrow at 12pm or Mon at 11:30am?', 'Sam', spread)).toBe(false);
  });
});
