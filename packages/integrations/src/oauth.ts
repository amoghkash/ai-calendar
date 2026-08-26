import { AuthError } from '@calendar-agent/core';
import type { StoredTokens, TokenStore } from '@calendar-agent/core';
import type { FetchLike } from './http.js';

export interface OAuthClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly extraAuthParams?: Record<string, string>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Minimal OAuth2 authorization-code client. Provider specifics (endpoints,
 * scopes, extra params) are supplied by the integration package.
 */
export class OAuthClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: OAuthClientOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? (() => Date.now());
  }

  buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: this.options.scopes.join(' '),
      state,
      ...this.options.extraAuthParams,
    });
    return `${this.options.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<StoredTokens> {
    return this.post({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<StoredTokens> {
    const tokens = await this.post({ grant_type: 'refresh_token', refresh_token: refreshToken });
    // Providers often omit the refresh token on renewal; keep the existing one.
    return tokens.refreshToken ? tokens : { ...tokens, refreshToken };
  }

  private async post(body: Record<string, string>): Promise<StoredTokens> {
    const response = await this.fetchImpl(this.options.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...body,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AuthError(`OAuth token request failed (${response.status})`, {
        details: { body: text.slice(0, 500) },
      });
    }
    const parsed = JSON.parse(text) as TokenResponse;
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt:
        parsed.expires_in === undefined ? undefined : this.now() + parsed.expires_in * 1000,
      scope: parsed.scope,
      tokenType: parsed.token_type,
    };
  }
}

/** Refreshes and persists access tokens on demand. */
export class TokenManager {
  constructor(
    private readonly accountId: string,
    private readonly store: TokenStore,
    private readonly oauth: OAuthClient,
    private readonly now: () => number = () => Date.now(),
    /** Refresh this many milliseconds before actual expiry. */
    private readonly skewMs = 60_000,
  ) {}

  async accessToken(): Promise<string> {
    const tokens = await this.store.read(this.accountId);
    if (!tokens) {
      throw new AuthError('No stored credentials for this calendar account.', {
        details: { accountId: this.accountId },
      });
    }
    const expired = tokens.expiresAt !== undefined && tokens.expiresAt - this.skewMs <= this.now();
    if (!expired) return tokens.accessToken;
    if (!tokens.refreshToken) {
      throw new AuthError('Access token expired and no refresh token is available.', {
        details: { accountId: this.accountId },
      });
    }
    const refreshed = await this.oauth.refresh(tokens.refreshToken);
    await this.store.write(this.accountId, refreshed);
    return refreshed.accessToken;
  }
}
