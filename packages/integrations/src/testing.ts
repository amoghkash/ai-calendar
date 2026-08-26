import type { StoredTokens, TokenStore } from '@calendar-agent/core';
import type { FetchLike } from './http.js';

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface StubResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** Scriptable `fetch` double for provider tests. */
export class FetchRecorder {
  readonly requests: RecordedRequest[] = [];
  private readonly handlers: ((request: RecordedRequest) => StubResponse | undefined)[] = [];

  on(
    match: string | RegExp,
    response: StubResponse | ((r: RecordedRequest) => StubResponse),
  ): this {
    this.handlers.push((request) => {
      const matches =
        typeof match === 'string' ? request.url.includes(match) : match.test(request.url);
      if (!matches) return undefined;
      return typeof response === 'function' ? response(request) : response;
    });
    return this;
  }

  get fetch(): FetchLike {
    return async (url, init) => {
      const request: RecordedRequest = {
        url,
        method: init?.method ?? 'GET',
        headers: normaliseHeaders(init?.headers),
        body: typeof init?.body === 'string' ? safeParse(init.body) : undefined,
      };
      this.requests.push(request);
      for (const handler of this.handlers) {
        const stub = handler(request);
        if (stub) {
          const status = stub.status ?? 200;
          // 204/205/304 responses must not carry a body.
          const bodyless = status === 204 || status === 205 || status === 304;
          return new Response(
            bodyless || stub.body === undefined ? null : JSON.stringify(stub.body),
            {
              status,
              headers: { 'content-type': 'application/json', ...stub.headers },
            },
          );
        }
      }
      return new Response(JSON.stringify({ error: 'no stub', url }), { status: 404 });
    };
  }

  find(fragment: string): RecordedRequest | undefined {
    return this.requests.find((r) => r.url.includes(fragment));
  }
}

function normaliseHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** In-memory token store for tests. */
export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, StoredTokens>();
  constructor(seed: Record<string, StoredTokens> = {}) {
    for (const [id, value] of Object.entries(seed)) this.tokens.set(id, value);
  }
  async read(accountId: string): Promise<StoredTokens | undefined> {
    return this.tokens.get(accountId);
  }
  async write(accountId: string, tokens: StoredTokens): Promise<void> {
    this.tokens.set(accountId, tokens);
  }
}
