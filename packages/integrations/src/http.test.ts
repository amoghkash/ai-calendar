import { describe, expect, it } from 'vitest';
import { AuthError, ProviderError } from '@calendar-agent/core';
import { HttpClient } from './http.js';
import { FetchRecorder } from './testing.js';

const noSleep = async (): Promise<void> => {};

describe('HttpClient', () => {
  it('maps 401 to an auth error', async () => {
    const recorder = new FetchRecorder().on('x', { status: 401, body: { error: 'nope' } });
    const client = new HttpClient({ provider: 'test', fetch: recorder.fetch, sleep: noSleep });
    await expect(client.request({ url: 'https://api/x' })).rejects.toBeInstanceOf(AuthError);
  });

  it('retries transient failures and then succeeds', async () => {
    let calls = 0;
    const recorder = new FetchRecorder().on('x', () => {
      calls += 1;
      return calls < 3 ? { status: 503, body: { error: 'busy' } } : { body: { ok: true } };
    });
    const client = new HttpClient({ provider: 'test', fetch: recorder.fetch, sleep: noSleep });
    const result = await client.request<{ ok: boolean }>({ url: 'https://api/x' });
    expect(result.data.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    const recorder = new FetchRecorder().on('x', { status: 500, body: {} });
    const client = new HttpClient({
      provider: 'test',
      fetch: recorder.fetch,
      sleep: noSleep,
      maxRetries: 1,
    });
    await expect(client.request({ url: 'https://api/x' })).rejects.toBeInstanceOf(ProviderError);
    expect(recorder.requests).toHaveLength(2);
  });

  it('does not retry a plain client error', async () => {
    const recorder = new FetchRecorder().on('x', { status: 400, body: {} });
    const client = new HttpClient({ provider: 'test', fetch: recorder.fetch, sleep: noSleep });
    await expect(client.request({ url: 'https://api/x' })).rejects.toThrow(/400/);
    expect(recorder.requests).toHaveLength(1);
  });

  it('serialises query parameters and skips undefined ones', async () => {
    const recorder = new FetchRecorder().on('x', { body: {} });
    const client = new HttpClient({ provider: 'test', fetch: recorder.fetch, sleep: noSleep });
    await client.request({ url: 'https://api/x', query: { a: 1, b: undefined, c: 'two words' } });
    expect(recorder.requests[0]!.url).toBe('https://api/x?a=1&c=two+words');
  });
});
