import { describe, expect, it } from 'vitest';
import { classifyReply } from './reply-intent.js';

const t = (iso: string): number => Date.parse(iso);
const slot = (iso: string) => ({ start: t(iso), end: t(iso) + 3_600_000 });

// Offered: Tue 12:30pm, Wed 1pm, Thu 12pm.
const SLOTS = [
  slot('2026-03-10T12:30:00Z'),
  slot('2026-03-11T13:00:00Z'),
  slot('2026-03-12T12:00:00Z'),
];
const read = (text: string, slots = SLOTS) => classifyReply(text, slots, 'UTC');

describe('reading a reply', () => {
  it('takes a weekday that matches exactly one offer', () => {
    expect(read('tuesday works')).toEqual({ kind: 'accepts', slotIndex: 0 });
    expect(read('Wed is better for me')).toEqual({ kind: 'accepts', slotIndex: 1 });
  });

  it('takes a time that matches exactly one offer', () => {
    expect(read('12:30 please')).toEqual({ kind: 'accepts', slotIndex: 0 });
    expect(read("1pm works")).toEqual({ kind: 'accepts', slotIndex: 1 });
  });

  it('takes an ordinal', () => {
    expect(read('the second one')).toEqual({ kind: 'accepts', slotIndex: 1 });
    expect(read('first works')).toEqual({ kind: 'accepts', slotIndex: 0 });
  });

  it('accepts a bare yes only when there was nothing to choose', () => {
    expect(read('sounds good', [SLOTS[0]!])).toEqual({ kind: 'accepts', slotIndex: 0 });

    const vague = read('sounds good');
    expect(vague.kind).toBe('unclear');
    expect(vague.kind === 'unclear' && vague.reason).toMatch(/did not say which/);
  });

  it('reads a refusal', () => {
    for (const text of ["can't this week", 'none of those work', 'rain check', 'not free sorry']) {
      expect(read(text)).toEqual({ kind: 'declines' });
    }
  });

  it('refuses to guess when a reply both refuses and names a day', () => {
    // "Tuesday doesn't work but Wednesday does" is the sentence that would make
    // a naive matcher book the wrong day.
    const result = read("tuesday doesn't work but wednesday does");
    expect(result.kind).toBe('unclear');
    expect(result.kind === 'unclear' && result.reason).toMatch(/both refuses and names/);
  });

  it('will not pick between two offers on the same day', () => {
    const sameDay = [slot('2026-03-10T12:00:00Z'), slot('2026-03-10T17:00:00Z')];
    expect(read('tuesday', sameDay).kind).toBe('unclear');
  });

  it('gives up rather than reaching', () => {
    expect(read('what are you up to this weekend?').kind).toBe('unclear');
    expect(read('👍').kind).toBe('unclear');
  });

  it('handles an empty reply and an empty offer', () => {
    expect(read('   ').kind).toBe('unclear');
    expect(read('tuesday', []).kind).toBe('unclear');
  });

  it('reads a counter-proposal as unclear rather than as agreement', () => {
    // Friday was never offered, so nothing here is bookable.
    expect(read('how about friday instead?').kind).toBe('unclear');
  });
});
