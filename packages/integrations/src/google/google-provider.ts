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
import { PROVIDER_GOOGLE, ProviderError, instantToISO } from '@calendar-agent/core';
import type { FetchLike } from '../http.js';
import { HttpClient } from '../http.js';
import { OAuthClient, TokenManager } from '../oauth.js';
import { toGoogleInsert, toGooglePatch, toNormalizedEvent, toProviderCalendar } from './mapper.js';
import type {
  GoogleCalendarListResponse,
  GoogleEvent,
  GoogleEventsResponse,
  GoogleUserInfo,
} from './types.js';

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'openid',
  'email',
  'profile',
];

export interface GoogleOAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

/** OAuth2 client preconfigured for Google's endpoints. */
export function createGoogleOAuthClient(options: GoogleOAuthOptions): OAuthClient {
  return new OAuthClient({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: GOOGLE_SCOPES,
    // offline + consent are required to receive a refresh token.
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

export interface GoogleCalendarProviderOptions {
  readonly accountId: string;
  readonly tokens: TokenStore;
  readonly oauth: OAuthClient;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Timezone used when an event carries a naive all-day date. */
  readonly defaultTimezone?: string;
}

/**
 * Google Calendar implementation of the CalendarProvider port.
 *
 * Implemented directly against the REST API (no SDK) to keep the dependency
 * surface small and the request/response mapping explicit and testable.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = PROVIDER_GOOGLE;
  readonly capabilities: CalendarProviderCapabilities = {
    incrementalSync: true,
    privateMetadata: true,
    recurringInstanceUpdates: true,
    freeBusy: true,
  };

  private readonly http: HttpClient;
  private readonly tokenManager: TokenManager;
  private readonly calendarTimezones = new Map<string, string>();
  private readonly defaultTimezone: string;

  constructor(private readonly options: GoogleCalendarProviderOptions) {
    this.http = new HttpClient({
      provider: 'google',
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

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.tokenManager.accessToken()}`, ...extra };
  }

  async authenticate(): Promise<ProviderAccount> {
    const { data } = await this.http.request<GoogleUserInfo>({
      url: USERINFO_URL,
      headers: await this.authHeaders(),
    });
    return {
      externalAccountId: data.email ?? this.options.accountId,
      displayName: data.name ?? data.email ?? 'Google account',
      scopes: GOOGLE_SCOPES,
    };
  }

  async getCalendars(): Promise<readonly ProviderCalendar[]> {
    const calendars: ProviderCalendar[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.http.request<GoogleCalendarListResponse>({
        url: `${API_BASE}/users/me/calendarList`,
        headers: await this.authHeaders(),
        query: { maxResults: 250, pageToken, showDeleted: false },
      });
      for (const entry of data.items ?? []) {
        if (entry.deleted) continue;
        const calendar = toProviderCalendar(entry);
        this.calendarTimezones.set(calendar.externalId, calendar.timezone);
        calendars.push(calendar);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return calendars;
  }

  async getEvents(options: FetchEventsOptions): Promise<FetchEventsResult> {
    const timezone = this.calendarTimezones.get(options.calendarExternalId) ?? this.defaultTimezone;
    const events: NormalizedEvent[] = [];
    const deletedExternalIds: string[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    do {
      // With a sync token Google rejects timeMin/timeMax, so they are mutually
      // exclusive: an incremental fetch always covers the original window.
      const query: Record<string, string | number | boolean | undefined> = options.syncToken
        ? { syncToken: options.syncToken, showDeleted: true, maxResults: 2500, pageToken }
        : {
            timeMin: instantToISO(options.range.start),
            timeMax: instantToISO(options.range.end),
            singleEvents: options.expandRecurrence ?? true,
            showDeleted: true,
            maxResults: 2500,
            orderBy: (options.expandRecurrence ?? true) ? 'startTime' : undefined,
            pageToken,
          };

      let data: GoogleEventsResponse;
      try {
        ({ data } = await this.http.request<GoogleEventsResponse>({
          url: `${API_BASE}/calendars/${encodeURIComponent(options.calendarExternalId)}/events`,
          headers: await this.authHeaders(),
          query,
        }));
      } catch (error) {
        if (options.syncToken && error instanceof ProviderError && /410/.test(error.message)) {
          // The cursor expired: tell the caller to run a full resync.
          return { events: [], deletedExternalIds: [], resyncRequired: true };
        }
        throw error;
      }

      for (const raw of data.items ?? []) {
        if (raw.status === 'cancelled') {
          deletedExternalIds.push(raw.id);
          continue;
        }
        events.push(toNormalizedEvent(raw, options.calendarExternalId, timezone));
      }
      pageToken = data.nextPageToken;
      nextSyncToken = data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);

    return { events, deletedExternalIds, nextSyncToken };
  }

  async createEvent(input: CalendarEventInput): Promise<NormalizedEvent> {
    const timezone =
      this.calendarTimezones.get(input.calendarExternalId) ??
      input.timezone ??
      this.defaultTimezone;
    const { data } = await this.http.request<GoogleEvent>({
      method: 'POST',
      url: `${API_BASE}/calendars/${encodeURIComponent(input.calendarExternalId)}/events`,
      headers: await this.authHeaders(),
      query: { sendUpdates: input.notifyAttendees ? 'all' : 'none' },
      body: toGoogleInsert(input),
    });
    return toNormalizedEvent(data, input.calendarExternalId, timezone);
  }

  async updateEvent(ref: EventRef, changes: CalendarEventUpdate): Promise<NormalizedEvent> {
    const timezone =
      this.calendarTimezones.get(ref.calendarExternalId) ??
      changes.timezone ??
      this.defaultTimezone;
    // PATCH, never PUT: unspecified fields keep their remote values.
    const { data } = await this.http.request<GoogleEvent>({
      method: 'PATCH',
      url: `${API_BASE}/calendars/${encodeURIComponent(ref.calendarExternalId)}/events/${encodeURIComponent(ref.externalId)}`,
      headers: await this.authHeaders(
        (ref.etag ?? changes.etag) ? { 'if-match': (ref.etag ?? changes.etag)! } : {},
      ),
      query: { sendUpdates: changes.notifyAttendees ? 'all' : 'none' },
      body: toGooglePatch(changes, timezone),
    });
    return toNormalizedEvent(data, ref.calendarExternalId, timezone);
  }

  async deleteEvent(ref: EventRef): Promise<void> {
    await this.http.request<unknown>({
      method: 'DELETE',
      url: `${API_BASE}/calendars/${encodeURIComponent(ref.calendarExternalId)}/events/${encodeURIComponent(ref.externalId)}`,
      headers: await this.authHeaders(ref.etag ? { 'if-match': ref.etag } : {}),
      query: { sendUpdates: ref.notifyAttendees ? 'all' : 'none' },
    });
  }
}
