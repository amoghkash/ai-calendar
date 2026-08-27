import { describe, expect, it } from 'vitest';
import type {
  ContactDirectory,
  MessagingProvider,
  ThreadMessage,
  ThreadSnapshot,
} from '@calendar-agent/core';
import { OutreachPoller } from './services/outreach-poller.js';
import { createTestApp } from './testing.js';

const PRIYA = {
  id: 'AB:3',
  displayName: 'Priya Raman',
  handles: [{ kind: 'phone' as const, value: '(415) 555-7777', normalized: '+14155557777' }],
};

const directory: ContactDirectory = {
  search: (query) =>
    Promise.resolve([PRIYA].filter((c) => c.displayName.toLowerCase().includes(query.toLowerCase()))),
};

/** Records what was asked, so a test can assert nobody's words were read. */
class FakeMessaging implements MessagingProvider {
  readonly id = 'fake';
  messages: ThreadMessage[] = [];
  threadCalls = 0;
  readCalls = 0;
  failThread = false;

  capabilities() {
    return Promise.resolve({
      available: true,
      canReadMessages: true,
      canReadContacts: true,
      canSend: false,
    });
  }

  thread(_handle: string, since?: number): Promise<ThreadSnapshot | undefined> {
    this.threadCalls += 1;
    if (this.failThread) return Promise.reject(new Error('bridge down'));
    const newest = this.messages[this.messages.length - 1];
    const base = {
      handle: '+14155557777',
      normalized: '+14155557777',
      ...(newest === undefined ? {} : { lastMessageAt: newest.at }),
    };
    // Mirrors the bridge: with nothing newer, the per-direction timestamps are
    // not derived at all.
    if (since !== undefined && newest !== undefined && newest.at <= since) {
      return Promise.resolve(base);
    }
    const inbound = this.messages.filter((m) => m.direction === 'inbound');
    const last = inbound[inbound.length - 1];
    return Promise.resolve({
      ...base,
      ...(last === undefined ? {} : { lastInboundAt: last.at }),
    });
  }

  recentMessages(): Promise<readonly ThreadMessage[]> {
    this.readCalls += 1;
    return Promise.resolve([...this.messages]);
  }
}

async function scenario() {
  const messaging = new FakeMessaging();
  const harness = await createTestApp({ messaging: { directory, provider: messaging } });
  const app = harness.app;
  const outcome = await app.outreach.draft({
    userId: app.user.id,
    person: 'Priya',
    activity: 'lunch',
  });
  if (outcome.kind !== 'drafted') throw new Error('expected a draft');
  const sent = await app.outreach.markSent(app.user.id, outcome.outreach.id);

  const poller = new OutreachPoller(app.user.id, app.outreach, messaging, app.clock, app.logger, {
    enabled: true,
    intervalMinutes: 2,
    readLimit: 20,
  });
  return { app, messaging, outreach: sent, poller };
}

const reply = (text: string, at: number): ThreadMessage => ({
  id: 1,
  at,
  direction: 'inbound',
  text,
});

describe('watching for answers', () => {
  it('books the time an answer picked', async () => {
    const { app, messaging, outreach, poller } = await scenario();
    messaging.messages = [reply('the second one works', outreach.sentAt! + 60_000)];

    const run = await poller.runOnce();

    expect(run).toMatchObject({ checked: 1, replies: 1 });
    const after = await app.outreach.get(app.user.id, outreach.id);
    expect(after.state).toBe('booked');
    expect(after.eventId).toBeDefined();
  });

  it('does not read anybody’s words when nobody has replied', async () => {
    const { messaging, poller } = await scenario();

    await poller.runOnce();

    expect(messaging.threadCalls).toBe(1);
    // The cheap question was asked; the expensive one was not.
    expect(messaging.readCalls).toBe(0);
  });

  it('ignores a reply that predates the message going out', async () => {
    const { app, messaging, outreach, poller } = await scenario();
    messaging.messages = [reply('yes', outreach.sentAt! - 60_000)];

    await poller.runOnce();

    expect((await app.outreach.get(app.user.id, outreach.id)).state).toBe('sent');
  });

  it('does not act on the same message twice', async () => {
    const { app, messaging, outreach, poller } = await scenario();
    messaging.messages = [reply('sounds good', outreach.sentAt! + 60_000)];

    const first = await poller.runOnce();
    const second = await poller.runOnce();

    expect(first.replies).toBe(1);
    // It escalated once; a second pass must not re-read and re-escalate.
    expect(second.replies).toBe(0);
    expect((await app.outreach.get(app.user.id, outreach.id)).state).toBe('needs_you');
  });

  it('picks up a later message that resolves an escalation', async () => {
    const { app, messaging, outreach, poller } = await scenario();
    messaging.messages = [reply('sounds good', outreach.sentAt! + 60_000)];
    await poller.runOnce();

    messaging.messages.push(reply('tuesday', outreach.sentAt! + 120_000));
    const run = await poller.runOnce();

    expect(run.replies).toBe(1);
    expect(['booked', 'needs_you']).toContain(
      (await app.outreach.get(app.user.id, outreach.id)).state,
    );
  });

  it('stops waiting once the last time offered has passed', async () => {
    const { app, outreach, poller } = await scenario();
    // Move the clock past the final slot.
    (app.clock as { advance?: (ms: number) => void }).advance?.(
      outreach.expiresAt! - app.clock.now() + 1,
    );

    const run = await poller.runOnce();

    expect(run.expired).toBe(1);
    expect((await app.outreach.get(app.user.id, outreach.id)).state).toBe('expired');
  });

  it('survives an unreachable bridge', async () => {
    const { app, messaging, outreach, poller } = await scenario();
    messaging.failThread = true;

    const run = await poller.runOnce();

    expect(run.error).toBeUndefined();
    expect(run.checked).toBe(1);
    expect((await app.outreach.get(app.user.id, outreach.id)).state).toBe('sent');
  });

  it('does nothing at all without a messaging integration', async () => {
    const { app, outreach } = await scenario();
    const blind = new OutreachPoller(
      app.user.id,
      app.outreach,
      undefined,
      app.clock,
      app.logger,
      { enabled: true, intervalMinutes: 2, readLimit: 20 },
    );

    const run = await blind.runOnce();

    expect(run.replies).toBe(0);
    expect((await app.outreach.get(app.user.id, outreach.id)).state).toBe('sent');
  });
});
