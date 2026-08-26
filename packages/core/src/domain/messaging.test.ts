import { describe, expect, it } from 'vitest';
import { threadPosture } from './messaging.js';

const PLANNED = 1_000;
const base = { handle: '+14155551212', normalized: '+14155551212' };

describe('threadPosture', () => {
  it('is unmentioned when there is no thread at all', () => {
    expect(threadPosture(undefined, PLANNED)).toBe('unmentioned');
  });

  it('is unmentioned when the only messages predate the plan', () => {
    expect(
      threadPosture({ ...base, lastInboundAt: 500, lastOutboundAt: 400 }, PLANNED),
    ).toBe('unmentioned');
  });

  it('awaits them when only I have spoken since', () => {
    expect(threadPosture({ ...base, lastOutboundAt: 2_000 }, PLANNED)).toBe('awaiting_them');
  });

  it('awaits me when only they have spoken since', () => {
    expect(threadPosture({ ...base, lastInboundAt: 2_000 }, PLANNED)).toBe('awaiting_me');
  });

  it('gives the ball to whoever spoke last when both have', () => {
    expect(
      threadPosture({ ...base, lastOutboundAt: 3_000, lastInboundAt: 2_000 }, PLANNED),
    ).toBe('awaiting_them');
    expect(
      threadPosture({ ...base, lastOutboundAt: 2_000, lastInboundAt: 3_000 }, PLANNED),
    ).toBe('awaiting_me');
  });

  it('counts a message exactly at the planning instant', () => {
    expect(threadPosture({ ...base, lastInboundAt: PLANNED }, PLANNED)).toBe('awaiting_me');
  });

  it('ignores an old reply when I have spoken since', () => {
    // The stale inbound is before the plan existed, so it cannot be a response
    // to it - treating it as one would silently mark the plan acknowledged.
    expect(
      threadPosture({ ...base, lastInboundAt: 100, lastOutboundAt: 2_000 }, PLANNED),
    ).toBe('awaiting_them');
  });
});
