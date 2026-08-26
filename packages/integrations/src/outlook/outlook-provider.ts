import type {
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderCapabilities,
  EventRef,
  FetchEventsOptions,
  FetchEventsResult,
  NormalizedEvent,
  ProviderAccount,
  ProviderCalendar,
  TokenStore,
} from '@calendar-agent/core';
import { PROVIDER_MICROSOFT, instantToISO } from '@calendar-agent/core';
import type { FetchLike } from '../http.js';
import { HttpClient } from '../http.js';
import { OAuthClient, TokenManager } from '../oauth.js';
import {
  METADATA_KEYS,
  extendedPropertyId,
  toGraphCreate,
  toGraphPatch,
  toNormalizedEvent,
  toProviderCalendar,
} from './mapper.js';
import type {
  GraphCalendar,
  GraphCollection,
  GraphEvent,
  GraphMailboxSettings,
  GraphUser,
} from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export const MICROSOFT_SCOPES = [
  'offline_access',
  'User.Read',
  'Calendars.ReadWrite',
  'MailboxSettings.Read',
];

export interface MicrosoftOAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly tenantId?: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export function createMicrosoftOAuthClient(options: MicrosoftOAuthOptions): OAuthClient {
  const tenant = options.tenantId ?? 'common';
  return new OAuthClient({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: MICROSOFT_SCOPES,
    extraAuthParams: { response_mode: 'query' },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

export interface OutlookCalendarProviderOptions {
  readonly accountId: string;
  readonly tokens: TokenStore;
  readonly oauth: OAuthClient;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly defaultTimezone?: string;
}

/**
 * Microsoft Outlook / Graph implementation of the same CalendarProvider port.
 *
 * The application cannot tell whether an event came from Google or Outlook:
 * both providers return the same normalised model.
 */
export class OutlookCalendarProvider implements CalendarProvider {
  readonly id = PROVIDER_MICROSOFT;
  readonly capabilities: CalendarProviderCapabilities = {
    incrementalSync: true,
    privateMetadata: true,
    recurringInstanceUpdates: true,
    freeBusy: true,
  };

  private readonly http: HttpClient;
  private readonly tokenManager: TokenManager;
  private readonly defaultTimezone: string;
  private selfEmail: string | undefined;

  constructor(options: OutlookCalendarProviderOptions) {
    this.http = new HttpClient({
      provider: 'microsoft',
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    this.tokenManager = new TokenManager(
      options.accountId,
      options.tokens,
      options.oauth,
      options.now ?? (() => Date.now()),
    );
    this.defaultTimezone = options.defaultTimezone ?? 'UTC';
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokenManager.accessToken()}`,
      // Ask Graph to return every timestamp in UTC so parsing is unambiguous.
      prefer: 'outlook.timezone="UTC"',
      ...extra,
    };
  }

  async authenticate(): Promise<ProviderAccount> {
    const { data } = await this.http.request<GraphUser>({
      url: `${GRAPH_BASE}/me`,
      headers: await this.headers(),
    });
    this.selfEmail = data.mail ?? data.userPrincipalName;
    return {
      externalAccountId: this.selfEmail ?? 'unknown',
      displayName: data.displayName ?? this.selfEmail ?? 'Microsoft account',
      scopes: MICROSOFT_SCOPES,
    };
  }

  /** The mailbox timezone is the closest Graph equivalent of a calendar zone. */
  async getMailboxTimezone(): Promise<string> {
    const { data } = await this.http.request<GraphMailboxSettings>({
      url: `${GRAPH_BASE}/me/mailboxSettings`,
      headers: await this.headers(),
    });
    return data.timeZone ?? this.defaultTimezone;
  }

  async getCalendars(): Promise<readonly ProviderCalendar[]> {
    const { data } = await this.http.request<GraphCollection<GraphCalendar>>({
      url: `${GRAPH_BASE}/me/calendars`,
      headers: await this.headers(),
      query: { $top: 100 },
    });
    return (data.value ?? []).map(toProviderCalendar);
  }

  async getEvents(options: FetchEventsOptions): Promise<FetchEventsResult> {
    const events: NormalizedEvent[] = [];
    const deletedExternalIds: string[] = [];
    const expand = `singleValueExtendedProperties($filter=${METADATA_KEYS.map(
      (key) => `id eq '${extendedPropertyId(key)}'`,
    ).join(' or ')})`;

    let url =
      options.syncToken ??
      `${GRAPH_BASE}/me/calendars/${encodeURIComponent(options.calendarExternalId)}/calendarView/delta`;
    let query: Record<string, string | number | boolean | undefined> | undefined = options.syncToken
      ? undefined
      : {
          startDateTime: instantToISO(options.range.start),
          endDateTime: instantToISO(options.range.end),
          $expand: expand,
          $top: 200,
        };

    let deltaLink: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const { data } = await this.http.request<GraphCollection<GraphEvent>>({
        url,
        headers: await this.headers(),
        ...(query ? { query } : {}),
      });
      for (const raw of data.value ?? []) {
        if (raw['@removed'] || raw.isCancelled) {
          deletedExternalIds.push(raw.id);
          continue;
        }
        events.push(
          toNormalizedEvent(raw, options.calendarExternalId, this.defaultTimezone, this.selfEmail),
        );
      }
      deltaLink = data['@odata.deltaLink'] ?? deltaLink;
      const next = data['@odata.nextLink'];
      if (!next) break;
      url = next;
      query = undefined;
    }

    return {
      events,
      deletedExternalIds,
      ...(deltaLink === undefined ? {} : { nextSyncToken: deltaLink }),
    };
  }

  async createEvent(input: CalendarEventInput): Promise<NormalizedEvent> {
    const { data } = await this.http.request<GraphEvent>({
      method: 'POST',
      url: `${GRAPH_BASE}/me/calendars/${encodeURIComponent(input.calendarExternalId)}/events`,
      headers: await this.headers(),
      body: toGraphCreate(input),
    });
    return toNormalizedEvent(data, input.calendarExternalId, input.timezone, this.selfEmail);
  }

  async updateEvent(ref: EventRef, changes: CalendarEventUpdate): Promise<NormalizedEvent> {
    const etag = ref.etag ?? changes.etag;
    const { data } = await this.http.request<GraphEvent>({
      method: 'PATCH',
      url: `${GRAPH_BASE}/me/events/${encodeURIComponent(ref.externalId)}`,
      headers: await this.headers(etag ? { 'if-match': etag } : {}),
      body: toGraphPatch(changes, changes.timezone ?? this.defaultTimezone),
    });
    return toNormalizedEvent(
      data,
      ref.calendarExternalId,
      changes.timezone ?? this.defaultTimezone,
      this.selfEmail,
    );
  }

  async deleteEvent(ref: EventRef): Promise<void> {
    await this.http.request<unknown>({
      method: 'DELETE',
      url: `${GRAPH_BASE}/me/events/${encodeURIComponent(ref.externalId)}`,
      headers: await this.headers(ref.etag ? { 'if-match': ref.etag } : {}),
    });
  }
}
