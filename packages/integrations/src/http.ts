import { AuthError, ProviderError, DomainError } from '@calendar-agent/core';

/** Injectable `fetch`, so provider tests never touch the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined>;
}

export interface HttpClientOptions {
  readonly fetch?: FetchLike;
  readonly provider: string;
  readonly maxRetries?: number;
  /** Injected so retry backoff is instant in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Thin JSON HTTP client with provider-agnostic error mapping and retry on
 * transient failures. Keeps the provider code focused on the API semantics.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T>(request: HttpRequest): Promise<{ data: T; headers: Headers; status: number }> {
    const url = withQuery(request.url, request.query);
    const init: RequestInit = {
      method: request.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    };

    let lastError: DomainError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (cause) {
        lastError = new ProviderError(`${this.options.provider}: network request failed`, {
          cause,
          retryable: true,
          details: { url },
        });
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        const text = await response.text();
        const data = text.length === 0 ? ({} as T) : (JSON.parse(text) as T);
        return { data, headers: response.headers, status: response.status };
      }

      const errorText = await response.text().catch(() => '');
      const error = mapError(this.options.provider, response.status, errorText, url);
      if (error.retryable && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 0);
        await this.sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        lastError = error;
        continue;
      }
      throw error;
    }
    throw lastError ?? new ProviderError(`${this.options.provider}: request failed`);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2_000, 200 * 2 ** attempt);
}

function withQuery(
  url: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const queryString = params.toString();
  if (queryString.length === 0) return url;
  return url.includes('?') ? `${url}&${queryString}` : `${url}?${queryString}`;
}

function mapError(provider: string, status: number, body: string, url: string): DomainError {
  const details = { status, url, body: body.slice(0, 500) };
  if (status === 401) {
    return new AuthError(`${provider}: authentication failed (401)`, { details });
  }
  if (status === 403) {
    // Google returns 403 for quota problems as well as permission problems.
    const retryable = /rateLimitExceeded|userRateLimitExceeded|quota/i.test(body);
    return new ProviderError(`${provider}: request forbidden (403)`, { details, retryable });
  }
  if (status === 404) {
    return new ProviderError(`${provider}: resource not found (404)`, { details });
  }
  if (status === 410) {
    // Sync token expired: callers fall back to a full resync.
    return new ProviderError(`${provider}: sync token expired (410)`, { details });
  }
  if (status === 412) {
    return new ProviderError(`${provider}: precondition failed - the event changed remotely`, {
      details,
    });
  }
  if (status === 429 || status >= 500) {
    return new ProviderError(`${provider}: transient failure (${status})`, {
      details,
      retryable: true,
    });
  }
  return new ProviderError(`${provider}: request failed (${status})`, { details });
}

export const isSyncTokenExpired = (error: unknown): boolean =>
  error instanceof DomainError && /410/.test(error.message);
