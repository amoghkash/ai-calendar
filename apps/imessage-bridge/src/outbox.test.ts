import { describe, expect, it } from 'vitest';
import type { SendRequest } from '@calendar-agent/imessage-contract';
import { Outbox, classify } from './outbox.js';
import { FakeImsgRunner, ok, testBridgeConfig } from './testing.js';

const request = (over: Partial<SendRequest> = {}): SendRequest => ({
  idempotencyKey: 'follow-up:evt_1:1',
  to: '(415) 555-1212',
  text: 'still on for Thursday?',
  ...over,
});

const sendOk = new FakeImsgRunner({ send: ok('{"status":"sent"}') });

describe('outbox', () => {
  it('simulates without touching imsg while sending is disabled', async () => {
    const runner = new FakeImsgRunner({ send: ok('{"status":"sent"}') });
    const outbox = new Outbox(runner, testBridgeConfig({ sendEnabled: false }));
    await outbox.load();

    const result = await outbox.send(request());

    expect(result.status).toBe('simulated');
    expect(result.retrySafe).toBe(true);
    expect(runner.calls).toHaveLength(0);
  });

  it('normalises the recipient before dispatching', async () => {
    const runner = new FakeImsgRunner({ send: ok('{"status":"sent"}') });
    const outbox = new Outbox(runner, testBridgeConfig({ sendEnabled: true }));
    await outbox.load();

    const result = await outbox.send(request());

    expect(result.status).toBe('sent');
    expect(result.to).toBe('+14155551212');
    expect(runner.calls[0]).toContain('+14155551212');
  });

  it('returns the original result for a repeated idempotency key', async () => {
    const outbox = new Outbox(sendOk, testBridgeConfig({ sendEnabled: true }));
    await outbox.load();

    const first = await outbox.send(request());
    const second = await outbox.send(request());

    expect(second.status).toBe('duplicate');
    expect(second.id).toBe(first.id);
  });

  it('blocks a recipient over their daily limit', async () => {
    const outbox = new Outbox(sendOk, testBridgeConfig({ sendEnabled: true, perRecipientDailyLimit: 1 }));
    await outbox.load();

    await outbox.send(request({ idempotencyKey: 'a' }));
    const blocked = await outbox.send(request({ idempotencyKey: 'b' }));

    expect(blocked.status).toBe('blocked');
    expect(blocked.retrySafe).toBe(true);
    expect(blocked.reason).toMatch(/this recipient/);
  });

  it('blocks everything over the global daily limit', async () => {
    const outbox = new Outbox(sendOk, testBridgeConfig({ sendEnabled: true, globalDailyLimit: 1 }));
    await outbox.load();

    await outbox.send(request({ idempotencyKey: 'a', to: '+14155551212' }));
    const blocked = await outbox.send(request({ idempotencyKey: 'b', to: '+14155559999' }));

    expect(blocked.status).toBe('blocked');
    expect(blocked.reason).toMatch(/Daily send limit/);
  });

  it('keeps idempotency and caps across a restart', async () => {
    const config = testBridgeConfig({ sendEnabled: true, perRecipientDailyLimit: 1 });
    const first = new Outbox(sendOk, config);
    await first.load();
    const original = await first.send(request());

    const restarted = new Outbox(sendOk, config);
    await restarted.load();

    expect((await restarted.send(request())).id).toBe(original.id);
    expect((await restarted.send(request({ idempotencyKey: 'other' }))).status).toBe('blocked');
  });

  it('does not spend the daily budget on simulated sends', async () => {
    const outbox = new Outbox(sendOk, testBridgeConfig({ sendEnabled: true, globalDailyLimit: 2 }));
    await outbox.load();

    await outbox.send(request({ idempotencyKey: 'a', dryRun: true }));

    expect(outbox.remainingToday()).toBe(2);
  });
});

describe('send disposition', () => {
  it('treats not_started as a safe retry', () => {
    expect(classify(1, '', 'disposition: not_started')).toMatchObject({
      status: 'failed',
      retrySafe: true,
    });
  });

  it('never marks an ambiguous disposition retry-safe', () => {
    for (const disposition of ['may_have_completed', 'still_in_flight']) {
      expect(classify(1, `{"disposition":"${disposition}"}`, '')).toMatchObject({
        status: 'unconfirmed',
        retrySafe: false,
      });
    }
  });

  it('assumes a message may have gone out when imsg says nothing useful', () => {
    expect(classify(1, '', 'something went wrong')).toMatchObject({
      status: 'unconfirmed',
      retrySafe: false,
    });
  });

  it('reports a clean exit as sent', () => {
    expect(classify(0, '{"status":"sent"}', '')).toMatchObject({ status: 'sent', retrySafe: false });
  });
});
