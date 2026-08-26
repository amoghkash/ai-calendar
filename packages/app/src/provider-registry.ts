import type {
  CalendarAccount,
  CalendarProvider,
  Database,
  StoredTokens,
  TokenStore,
} from '@calendar-agent/core';
import {
  PROVIDER_GOOGLE,
  PROVIDER_MICROSOFT,
  PROVIDER_MOCK,
  UnsupportedError,
} from '@calendar-agent/core';
import type { AppConfig } from '@calendar-agent/config';
import {
  GoogleCalendarProvider,
  MockCalendarProvider,
  OutlookCalendarProvider,
  createGoogleOAuthClient,
  createMicrosoftOAuthClient,
} from '@calendar-agent/integrations';
import type { OAuthClient } from '@calendar-agent/integrations';

/** Token store backed by the account repository. */
export class DatabaseTokenStore implements TokenStore {
  constructor(private readonly db: Database) {}
  async read(accountId: string): Promise<StoredTokens | undefined> {
    return this.db.accounts.readTokens(accountId);
  }
  async write(accountId: string, tokens: StoredTokens): Promise<void> {
    await this.db.accounts.writeTokens(accountId, tokens);
  }
}

export interface ProviderRegistry {
  /** Build a provider client for a stored account. */
  create(account: CalendarAccount): Promise<CalendarProvider>;
  /** OAuth client for a provider id, when credentials are configured. */
  oauth(providerId: string): OAuthClient | undefined;
  available(): readonly string[];
}

export interface ProviderRegistryOptions {
  readonly config: AppConfig;
  readonly db: Database;
  /** Pre-built providers keyed by account id; used by tests and demo mode. */
  readonly overrides?: Record<string, CalendarProvider>;
}

/**
 * Chooses the integration for an account. Adding a provider means registering
 * it here; nothing above this class knows which service an event came from.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  private readonly tokens: TokenStore;

  constructor(private readonly options: ProviderRegistryOptions) {
    this.tokens = new DatabaseTokenStore(options.db);
  }

  available(): readonly string[] {
    const ids: string[] = [PROVIDER_MOCK];
    if (this.options.config.google.clientId) ids.push(PROVIDER_GOOGLE);
    if (this.options.config.microsoft.clientId) ids.push(PROVIDER_MICROSOFT);
    return ids;
  }

  oauth(providerId: string): OAuthClient | undefined {
    const { google, microsoft } = this.options.config;
    if (providerId === PROVIDER_GOOGLE && google.clientId && google.clientSecret) {
      return createGoogleOAuthClient({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        redirectUri: google.redirectUri,
      });
    }
    if (providerId === PROVIDER_MICROSOFT && microsoft.clientId && microsoft.clientSecret) {
      return createMicrosoftOAuthClient({
        clientId: microsoft.clientId,
        clientSecret: microsoft.clientSecret,
        redirectUri: microsoft.redirectUri,
        ...(microsoft.tenantId ? { tenantId: microsoft.tenantId } : {}),
      });
    }
    return undefined;
  }

  async create(account: CalendarAccount): Promise<CalendarProvider> {
    const override = this.options.overrides?.[account.id];
    if (override) return override;

    if (account.provider === PROVIDER_MOCK) return new MockCalendarProvider();

    const oauth = this.oauth(account.provider);
    if (!oauth) {
      throw new UnsupportedError(
        `No credentials configured for provider "${account.provider}". Set its client id and secret.`,
        { details: { provider: account.provider } },
      );
    }

    const shared = {
      accountId: account.id,
      tokens: this.tokens,
      oauth,
      defaultTimezone: this.options.config.timezone,
    };
    if (account.provider === PROVIDER_GOOGLE) return new GoogleCalendarProvider(shared);
    if (account.provider === PROVIDER_MICROSOFT) return new OutlookCalendarProvider(shared);
    throw new UnsupportedError(`Unknown calendar provider: ${account.provider}`);
  }
}
