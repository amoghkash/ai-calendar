import { describe, expect, it } from 'vitest';
import { AuthError } from '@calendar-agent/core';
import { OAuthClient, TokenManager } from './oauth.js';
import { FetchRecorder, MemoryTokenStore } from './testing.js';

function client(recorder: FetchRecorder, now = () => 1_000_000): OAuthClient {
  return new OAuthClient({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://localhost/cb',
    authorizeUrl: 'https://auth/authorize',
    tokenUrl: 'https://auth/token',
    scopes: ['calendar'],
    fetch: recorder.fetch,
    now,
  });
}

describe('OAuthClient', () => {
  it('exchanges a code for tokens and computes the expiry', async () => {
    const recorder = new FetchRecorder().on('token', {
      body: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 },
    });
    const tokens = await client(recorder).exchangeCode('code-1');
    expect(tokens).toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: 1_000_000 + 3_600_000,
      scope: undefined,
      tokenType: undefined,
    });
  });

  it('keeps the old refresh token when the provider omits it', async () => {
    const recorder = new FetchRecorder().on('token', {
      body: { access_token: 'a2', expires_in: 60 },
    });
    const tokens = await client(recorder).refresh('r-original');
    expect(tokens.refreshToken).toBe('r-original');
  });

  it('reports failures as auth errors', async () => {
    const recorder = new FetchRecorder().on('token', {
      status: 400,
      body: { error: 'invalid_grant' },
    });
    await expect(client(recorder).exchangeCode('bad')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('TokenManager', () => {
  it('returns a valid token without calling the provider', async () => {
    const recorder = new FetchRecorder();
    const store = new MemoryTokenStore({ acc: { accessToken: 'good', expiresAt: 2_000_000 } });
    const manager = new TokenManager('acc', store, client(recorder), () => 1_000_000);
    expect(await manager.accessToken()).toBe('good');
    expect(recorder.requests).toHaveLength(0);
  });

  it('refreshes and persists an expired token', async () => {
    const recorder = new FetchRecorder().on('token', {
      body: { access_token: 'fresh', expires_in: 3600 },
    });
    const store = new MemoryTokenStore({
      acc: { accessToken: 'stale', refreshToken: 'r1', expiresAt: 999_000 },
    });
    const manager = new TokenManager('acc', store, client(recorder), () => 1_000_000);
    expect(await manager.accessToken()).toBe('fresh');
    expect((await store.read('acc'))?.accessToken).toBe('fresh');
  });

  it('fails clearly when there is nothing to refresh with', async () => {
    const store = new MemoryTokenStore({ acc: { accessToken: 'stale', expiresAt: 1 } });
    const manager = new TokenManager('acc', store, client(new FetchRecorder()), () => 1_000_000);
    await expect(manager.accessToken()).rejects.toBeInstanceOf(AuthError);
  });
});
