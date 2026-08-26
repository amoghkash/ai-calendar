import { describe, expect, it } from 'vitest';
import { ImessageBridgeClient } from './bridge-client.js';
import type { FetchLike } from '../http.js';

const HEALTHY = {
  status: 'ok',
  contractVersion: 1,
  capabilities: {
    imsg: { available: true, version: '0.14.1' },
    messages: { readable: true, sendable: false, detail: 'Sending is disabled.' },
    contacts: { readable: true, count: 783 },
    send: { enabled: false, remainingToday: 0 },
  },
};

const routed = (routes: Record<string, { status?: number; body: unknown }>): FetchLike => {
  return (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const hit = key === undefined ? undefined : routes[key];
    if (hit === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }), { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 }),
    );
  };
};

const client = (fetchImpl: FetchLike): ImessageBridgeClient =>
  new ImessageBridgeClient({ token: 't', fetch: fetchImpl });

describe('iMessage bridge client', () => {
  it('maps a healthy bridge onto messaging capabilities', async () => {
    const result = await client(routed({ '/health': { body: HEALTHY } })).capabilities();

    expect(result).toMatchObject({
      available: true,
      canReadMessages: true,
      canReadContacts: true,
      canSend: false,
    });
  });

  it('reports an unreachable bridge instead of throwing', async () => {
    const result = await client(() => Promise.reject(new Error('ECONNREFUSED'))).capabilities();

    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/npm run bridge/);
  });

  it('refuses to guess across a contract change', async () => {
    const body = { ...HEALTHY, contractVersion: 99 };
    const result = await client(routed({ '/health': { body } })).capabilities();

    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/contract v99/);
  });

  it('requires both a sendable channel and sending switched on', async () => {
    const body = {
      ...HEALTHY,
      capabilities: {
        ...HEALTHY.capabilities,
        messages: { readable: true, sendable: true },
        send: { enabled: false, remainingToday: 0 },
      },
    };
    expect((await client(routed({ '/health': { body } })).capabilities()).canSend).toBe(false);
  });

  it('treats no conversation as an answer, not a failure', async () => {
    const fetchImpl = routed({
      '/threads': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'none' } } },
    });
    await expect(client(fetchImpl).thread('+14155551212')).resolves.toBeUndefined();
  });

  it('carries thread timestamps through unchanged', async () => {
    const body = {
      handle: '(415) 555-1212',
      normalized: '+14155551212',
      chatId: 42,
      contactName: 'Sarah Chen',
      lastInboundAt: 1_756_200_000_000,
      lastOutboundAt: 1_756_100_000_000,
    };
    const result = await client(routed({ '/threads': { body } })).thread('(415) 555-1212');

    expect(result).toEqual({
      handle: '(415) 555-1212',
      normalized: '+14155551212',
      contactName: 'Sarah Chen',
      lastInboundAt: 1_756_200_000_000,
      lastOutboundAt: 1_756_100_000_000,
    });
  });

  it('returns contact candidates for a search', async () => {
    const body = {
      contacts: [
        {
          id: 'AB:1',
          displayName: 'Sarah Chen',
          handles: [{ kind: 'phone', value: '(415) 555-1212', normalized: '+14155551212' }],
        },
      ],
      truncated: false,
    };
    const result = await client(routed({ '/contacts': { body } })).search('sarah');

    expect(result).toHaveLength(1);
    expect(result[0]?.handles[0]?.normalized).toBe('+14155551212');
  });

  it('explains a rejected token rather than surfacing a bare 401', async () => {
    const fetchImpl = routed({
      '/contacts': { status: 401, body: { error: { code: 'AUTH_ERROR', message: 'nope' } } },
    });
    await expect(client(fetchImpl).search('sarah')).rejects.toThrow(/same token file/);
  });

  it('preserves the remedy the bridge sends with a 503', async () => {
    const message = 'Contacts access was denied. Enable it under System Settings.';
    const fetchImpl = routed({
      '/contacts': { status: 503, body: { error: { code: 'UNSUPPORTED', message } } },
    });
    await expect(client(fetchImpl).search('sarah')).rejects.toThrow(/System Settings/);
  });
});
