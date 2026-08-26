import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeConfig } from './config.js';
import type { BridgeOverrides } from './bridge.js';
import type { ContactSource } from './contacts.js';
import { BridgeError } from './errors.js';
import { createBridge } from './bridge.js';
import { createBridgeServer } from './server.js';
import { FailingContactSource, FakeContactSource, FakeImsgRunner, ok, testBridgeConfig } from './testing.js';

const CHATS = JSON.stringify([
  {
    id: 7,
    identifier: '+14155559999',
    contact_name: 'Someone Else',
    is_group: false,
    participants: ['+14155559999'],
  },
  {
    id: 99,
    identifier: 'family',
    is_group: true,
    participants: ['+14155551212', '+14155550000'],
  },
  {
    id: 42,
    identifier: '+14155551212',
    contact_name: 'Sarah Chen',
    service: 'iMessage',
    last_message_at: '2026-08-25T18:00:00Z',
    is_group: false,
    participants: ['+14155551212'],
  },
]);

const HISTORY = JSON.stringify([
  { id: 2, chat_id: 42, is_from_me: true, text: 'thursday works', created_at: '2026-08-24T10:00:00Z' },
  { id: 3, chat_id: 42, is_from_me: false, text: 'lunch thursday?', created_at: '2026-08-25T18:00:00Z' },
  { id: 1, chat_id: 42, is_from_me: true, text: 'hey', created_at: '2026-08-20T09:00:00Z' },
]);

const CONTACTS = [
  {
    id: 'AB:1',
    displayName: 'Sarah Chen',
    phones: [{ label: 'mobile', value: '(415) 555-1212' }],
    emails: [{ value: 'Sarah@Example.com' }],
  },
  { id: 'AB:2', displayName: 'Dave Rowe', phones: [{ value: '+14155559999' }], emails: [] },
];

let open: Server | undefined;

interface Harness {
  readonly api: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
}

async function start(
  config: Partial<BridgeConfig> = {},
  overrides: BridgeOverrides = {},
): Promise<Harness> {
  const full = testBridgeConfig(config);
  const bridge = await createBridge(full, {
    runner: new FakeImsgRunner({
      '--version': ok('imsg 0.5.1'),
      chats: ok(CHATS),
      history: ok(HISTORY),
      send: ok('{"status":"sent"}'),
    }),
    contactSource: new FakeContactSource(CONTACTS),
    ...overrides,
  });
  const server = createBridgeServer(bridge).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  open = server;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    api: async (path, init) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${full.token}`,
          ...init?.headers,
        },
      });
      const text = await response.text();
      return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
    },
  };
}

afterEach(async () => {
  if (open) await new Promise((resolve) => open?.close(resolve));
  open = undefined;
});

describe('bridge HTTP surface', () => {
  it('refuses a request without a valid token', async () => {
    const { api } = await start();
    const { status, body } = await api('/health', { headers: { authorization: 'Bearer wrong' } });
    expect(status).toBe(401);
    expect(body.error.code).toBe('AUTH_ERROR');
  });

  it('reports capabilities and the contract version', async () => {
    const { api } = await start();
    const { status, body } = await api('/health');

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.contractVersion).toBe(1);
    expect(body.capabilities.imsg.available).toBe(true);
    expect(body.capabilities.contacts).toMatchObject({ readable: true, count: 2 });
    expect(body.capabilities.send).toMatchObject({ enabled: false, remainingToday: 0 });
  });

  it('degrades rather than failing when imsg is missing', async () => {
    const { api } = await start({}, { runner: new FakeImsgRunner({}) });
    const { status, body } = await api('/health');

    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.capabilities.imsg.available).toBe(false);
    expect(body.capabilities.messages.readable).toBe(false);
  });

  it('reports unreadable contacts without failing health', async () => {
    const { api } = await start(
      {},
      { contactSource: new FailingContactSource(new Error('Contacts access was denied.')) },
    );
    const { status, body } = await api('/health');

    expect(status).toBe(200);
    expect(body.capabilities.contacts.readable).toBe(false);
    expect(body.capabilities.contacts.detail).toMatch(/denied/);
  });

  it('carries the remedy, not just the failure, into health', async () => {
    const { api } = await start(
      {},
      {
        contactSource: new FailingContactSource(
          new BridgeError('UNSUPPORTED', 'Contacts did not respond within 10s.', 'Approve the prompt.'),
        ),
      },
    );
    const { body } = await api('/health');

    // The remedy is the whole point of `detail`; reporting only `message`
    // leaves the operator with nothing to do about it.
    expect(body.capabilities.contacts.detail).toBe(
      'Contacts did not respond within 10s. Approve the prompt.',
    );
  });

  it('answers health without triggering a full address-book dump', async () => {
    let dumps = 0;
    const counting: ContactSource = {
      list: () => {
        dumps += 1;
        return Promise.resolve([]);
      },
      count: () => Promise.resolve(412),
    };
    const { api } = await start({}, { contactSource: counting });
    const { body } = await api('/health');

    expect(body.capabilities.contacts).toMatchObject({ readable: true, count: 412 });
    expect(dumps).toBe(0);
  });

  it('searches contacts and normalises every handle', async () => {
    const { api } = await start();
    const { body } = await api('/contacts?q=sarah');

    expect(body.contacts).toHaveLength(1);
    expect(body.truncated).toBe(false);
    expect(body.contacts[0].handles).toEqual([
      { kind: 'phone', value: '(415) 555-1212', normalized: '+14155551212', label: 'mobile' },
      { kind: 'email', value: 'Sarah@Example.com', normalized: 'sarah@example.com' },
    ]);
  });

  it('rejects a contact search with no query', async () => {
    const { api } = await start();
    const { status, body } = await api('/contacts');
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('derives per-direction timestamps for a thread', async () => {
    const { api } = await start();
    const { body } = await api('/threads?handle=%28415%29%20555-1212');

    expect(body).toMatchObject({
      normalized: '+14155551212',
      chatId: 42,
      contactName: 'Sarah Chen',
      service: 'iMessage',
    });
    expect(body.lastInboundAt).toBe(Date.parse('2026-08-25T18:00:00Z'));
    expect(body.lastOutboundAt).toBe(Date.parse('2026-08-24T10:00:00Z'));
  });

  it('does not match a group chat containing the handle', async () => {
    const { api } = await start();
    const { body } = await api('/threads?handle=%2B14155550000');
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns message bodies only from the explicit endpoint', async () => {
    const { api } = await start();
    const state = await api('/threads?handle=%2B14155551212');
    expect(JSON.stringify(state.body)).not.toContain('lunch thursday');

    const { body } = await api('/threads/messages?handle=%2B14155551212&limit=5');
    expect(body.messages.map((m: any) => m.direction)).toEqual(['outbound', 'outbound', 'inbound']);
    expect(body.messages[2].text).toBe('lunch thursday?');
  });

  it('simulates a send while sending is disabled', async () => {
    const { api } = await start({ sendEnabled: false });
    const { status, body } = await api('/outbox', {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: 'k1', to: '+14155551212', text: 'still on?' }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'simulated', retrySafe: true, to: '+14155551212' });
  });

  it('requires an idempotency key', async () => {
    const { api } = await start();
    const { status, body } = await api('/outbox', {
      method: 'POST',
      body: JSON.stringify({ to: '+14155551212', text: 'still on?' }),
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
