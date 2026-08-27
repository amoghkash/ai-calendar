import { describe, expect, it } from 'vitest';
import { LLMReplyReader } from './llm-reply-reader.js';
import type { LLMProvider } from '../llm/types.js';

const t = (iso: string): number => Date.parse(iso);
const slot = (iso: string) => ({ start: t(iso), end: t(iso) + 3_600_000 });
const SLOTS = [
  slot('2026-03-10T12:30:00Z'),
  slot('2026-03-11T13:00:00Z'),
  slot('2026-03-12T12:00:00Z'),
];

const llm = (json: unknown, fail = false): LLMProvider => ({
  name: 'fake',
  model: 'fake',
  generate: () =>
    fail
      ? Promise.reject(new Error('unreachable'))
      : Promise.resolve({ text: JSON.stringify(json), json }),
});

const read = (json: unknown, fail = false) =>
  new LLMReplyReader({ llm: llm(json, fail) }).read({
    text: 'whatever they said',
    slots: SLOTS,
    timezone: 'UTC',
    now: t('2026-03-09T08:00:00Z'),
    personName: 'Priya',
    activity: 'lunch',
  });

describe('reading a reply with a model', () => {
  it('takes a confident choice among the offered times', async () => {
    expect(await read({ kind: 'accepts', slotIndex: 1, confident: true })).toEqual({
      kind: 'accepts',
      slotIndex: 1,
    });
  });

  it('takes a confident refusal', async () => {
    expect(await read({ kind: 'declines', confident: true })).toEqual({ kind: 'declines' });
  });

  it('refuses to act on an unconfident answer', async () => {
    const result = await read({ kind: 'accepts', slotIndex: 0, confident: false });
    expect(result?.kind).toBe('unclear');
  });

  it('rejects a slot that was never offered', async () => {
    // The model must choose from the list, not invent an index.
    const result = await read({ kind: 'accepts', slotIndex: 7, confident: true });
    expect(result).toEqual({
      kind: 'unclear',
      reason: 'The reply pointed at a time that was not offered.',
    });
  });

  it('passes an explicit unclear through with its reason', async () => {
    expect(await read({ kind: 'unclear', reason: 'They suggested Friday instead.' })).toEqual({
      kind: 'unclear',
      reason: 'They suggested Friday instead.',
    });
  });

  it('gives up rather than guessing when the answer does not validate', async () => {
    expect(await read({ kind: 'maybe', slotIndex: 'first' })).toBeUndefined();
    expect(await read({ kind: 'accepts' })).toBeUndefined();
  });

  it('gives up when the model cannot be reached', async () => {
    // Deterministic behaviour must survive an unreachable model.
    expect(await read({}, true)).toBeUndefined();
  });

  it('does not call the model when nothing was offered', async () => {
    let called = false;
    const reader = new LLMReplyReader({
      llm: {
        name: 'fake',
        model: 'fake',
        generate: () => {
          called = true;
          return Promise.resolve({ text: '{}' });
        },
      },
    });
    const result = await reader.read({
      text: 'sure',
      slots: [],
      timezone: 'UTC',
      now: t('2026-03-09T08:00:00Z'),
      personName: 'Priya',
      activity: 'lunch',
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });
});
