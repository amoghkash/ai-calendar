import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instantFromISO } from '@calendar-agent/core';
import { mockEvent } from '@calendar-agent/integrations';
import { BackgroundSync } from './services/background-sync.js';
import type { TestApp } from './testing.js';
import { createTestApp } from './testing.js';

const at = instantFromISO;

const build = (
  harness: TestApp,
  options: Partial<ConstructorParameters<typeof BackgroundSync>[6]> = {},
) =>
  new BackgroundSync(
    harness.userId,
    harness.app.sync,
    harness.app.scheduling,
    harness.app.preferences,
    harness.app.clock,
    harness.app.logger,
    { enabled: true, intervalMinutes: 15, replanOnChange: true, ...options },
  );

describe('BackgroundSync', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('syncs on a timer', async () => {
    const sync = build(harness);
    const spy = vi.spyOn(harness.app.sync, 'sync');
    vi.useFakeTimers();

    sync.start();
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(spy).toHaveBeenCalledTimes(2);

    sync.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not start when disabled', () => {
    const sync = build(harness, { enabled: false });
    sync.start();
    expect(sync.status().running).toBe(false);
  });

  it('proposes a new plan when something changed externally', async () => {
    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Algorithms',
      estimatedMinutes: 120,
      earliestStart: at('2026-03-10T00:00:00Z'),
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });
    const blockStart = proposal.plan.blocks[0]!.start;

    // A meeting lands on top of the scheduled block.
    harness.provider.seed(
      mockEvent({
        externalId: 'clash',
        title: 'Product review',
        start: blockStart,
        end: blockStart + 90 * 60_000,
        attendees: [{ email: 'me@example.com', self: true }, { email: 'boss@example.com' }],
      }),
    );

    const run = await build(harness).runOnce();
    expect(run.report?.needsReplan).toBe(true);
    expect(run.changeSetId).toBeDefined();

    // Suggest mode: the proposal waits, nothing was written.
    expect(run.appliedMutations).toBe(0);
    const stored = await harness.app.db.changeSets.get(run.changeSetId!);
    expect(stored?.status).toBe('pending');
  });

  it('applies allowed changes only in autonomous mode', async () => {
    const preferences = await harness.app.preferences.get(harness.userId);
    await harness.app.preferences.update(harness.userId, {
      automation: { ...preferences.automation, mode: 'autonomous' },
    });

    await harness.app.tasks.create({
      userId: harness.userId,
      title: 'Algorithms',
      estimatedMinutes: 120,
      earliestStart: at('2026-03-10T00:00:00Z'),
    });
    const proposal = await harness.app.scheduling.plan({ userId: harness.userId });
    await harness.app.scheduling.approve(proposal.changeSetId, { userId: harness.userId });
    const blockStart = proposal.plan.blocks[0]!.start;

    harness.provider.seed(
      mockEvent({
        externalId: 'clash',
        title: 'Product review',
        start: blockStart,
        end: blockStart + 90 * 60_000,
        attendees: [{ email: 'me@example.com', self: true }, { email: 'boss@example.com' }],
      }),
    );

    const run = await build(harness).runOnce();
    expect(run.appliedMutations).toBeGreaterThan(0);
  });

  it('leaves the schedule alone when nothing changed', async () => {
    const run = await build(harness).runOnce();
    expect(run.report?.needsReplan).toBe(false);
    expect(run.changeSetId).toBeUndefined();
  });

  it('skips a run while the previous one is still going', async () => {
    const sync = build(harness);
    let release: () => void = () => {};
    vi.spyOn(harness.app.sync, 'sync').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              startedAt: 0,
              finishedAt: 0,
              calendars: [],
              externalChanges: [],
              errors: [],
              needsReplan: false,
            });
        }),
    );

    const first = sync.runOnce();
    const second = await sync.runOnce();
    expect(second.report).toBeUndefined();
    release();
    await first;
  });

  it('survives a failing provider and keeps running', async () => {
    const sync = build(harness);
    vi.spyOn(harness.app.sync, 'sync').mockRejectedValueOnce(new Error('provider exploded'));

    const failed = await sync.runOnce();
    expect(failed.error).toMatch(/provider exploded/);

    // The loop is still usable afterwards.
    const recovered = await sync.runOnce();
    expect(recovered.error).toBeUndefined();
    expect(recovered.report).toBeDefined();
  });
});
