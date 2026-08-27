import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type {
  ContactDirectory,
  DirectoryContact,
  MessagingCapabilities,
  MessageSendRequest,
  MessageSendResult,
  MessageSender,
  MessagingProvider,
  ThreadMessage,
  ThreadSnapshot,
} from '@calendar-agent/core';
import { ProviderError, UnsupportedError } from '@calendar-agent/core';
import {
  CONTRACT_VERSION,
  contactSearchResponseSchema,
  errorResponseSchema,
  healthResponseSchema,
  sendResultSchema,
  threadMessagesResponseSchema,
  threadStateSchema,
} from '@calendar-agent/imessage-contract';
import type { FetchLike } from '../http.js';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4320';

export const defaultBridgeTokenPath = (): string =>
  resolve(homedir(), '.calendar-agent', 'imessage-bridge', 'token');

/**
 * Read the bridge token the way the bridge itself writes it.
 *
 * Both processes run as the same user on the same machine, so the token never
 * needs to be pasted anywhere - which matters because it is a credential, and
 * credentials in this system are read from the environment or disk, never
 * carried across the HTTP API or stored in a settings row.
 */
export function readBridgeToken(
  env: NodeJS.ProcessEnv = process.env,
  path: string = defaultBridgeTokenPath(),
): string | undefined {
  const explicit = env.IMESSAGE_BRIDGE_TOKEN?.trim();
  if (explicit) return explicit;

  const file = env.IMESSAGE_BRIDGE_TOKEN_FILE?.trim() || path;
  try {
    if (!existsSync(file)) return undefined;
    const contents = readFileSync(file, 'utf8').trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

export interface BridgeClientOptions {
  readonly baseUrl?: string;
  readonly token: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Speaks to the local iMessage bridge over loopback.
 *
 * The bridge is a separate process with its own lifecycle and its own macOS
 * permission grants, so every call here has to treat "not running", "not
 * permitted" and "older than I expect" as ordinary conditions rather than
 * faults. `capabilities()` in particular never throws: the calendar app has to
 * be able to render "messaging unavailable" without an error path.
 */
export class ImessageBridgeClient implements MessagingProvider, ContactDirectory, MessageSender {
  readonly id = 'imessage';
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: BridgeClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async capabilities(): Promise<MessagingCapabilities> {
    const unavailable = (detail: string): MessagingCapabilities => ({
      available: false,
      canReadMessages: false,
      canReadContacts: false,
      canSend: false,
      detail,
    });

    let payload: unknown;
    try {
      payload = await this.get('/health');
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }

    const parsed = healthResponseSchema.safeParse(payload);
    if (!parsed.success) return unavailable('The bridge returned an unrecognised health response.');

    // Refuse to guess across a contract change rather than mis-parse later calls.
    if (parsed.data.contractVersion !== CONTRACT_VERSION) {
      return unavailable(
        `The bridge speaks contract v${parsed.data.contractVersion}; this app expects v${CONTRACT_VERSION}. Rebuild and restart the bridge.`,
      );
    }

    const { capabilities } = parsed.data;
    const detail = [capabilities.messages.detail, capabilities.contacts.detail]
      .filter((line): line is string => typeof line === 'string' && line.length > 0)
      .join(' ');
    return {
      available: true,
      canReadMessages: capabilities.messages.readable,
      canReadContacts: capabilities.contacts.readable,
      canSend: capabilities.messages.sendable && capabilities.send.enabled,
      ...(detail.length === 0 ? {} : { detail }),
    };
  }

  async search(query: string, limit = 10): Promise<readonly DirectoryContact[]> {
    const payload = await this.get(
      `/contacts?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`,
    );
    const parsed = contactSearchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError('The bridge returned an unrecognised contact response.');
    }
    return parsed.data.contacts;
  }

  async thread(handle: string, since?: number): Promise<ThreadSnapshot | undefined> {
    let payload: unknown;
    try {
      payload = await this.get(
        `/threads?handle=${encodeURIComponent(handle)}` +
          (since === undefined ? '' : `&since=${encodeURIComponent(String(since))}`),
      );
    } catch (error) {
      // No conversation with this person is a normal answer, not a failure.
      if (error instanceof NotFoundFromBridge) return undefined;
      throw error;
    }
    const parsed = threadStateSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError('The bridge returned an unrecognised thread response.');
    }
    const { handle: echoed, normalized, contactName, lastMessageAt, lastInboundAt, lastOutboundAt } =
      parsed.data;
    return {
      handle: echoed,
      normalized,
      ...(contactName === undefined ? {} : { contactName }),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      ...(lastInboundAt === undefined ? {} : { lastInboundAt }),
      ...(lastOutboundAt === undefined ? {} : { lastOutboundAt }),
    };
  }

  async recentMessages(handle: string, limit = 20): Promise<readonly ThreadMessage[]> {
    let payload: unknown;
    try {
      payload = await this.get(
        `/threads/messages?handle=${encodeURIComponent(handle)}&limit=${encodeURIComponent(String(limit))}`,
      );
    } catch (error) {
      // No conversation is an answer, not a failure - the same as `thread`.
      if (error instanceof NotFoundFromBridge) return [];
      throw error;
    }
    const parsed = threadMessagesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError('The bridge returned an unrecognised message list.');
    }
    return parsed.data.messages.map((message) => ({
      id: message.id,
      at: message.at,
      direction: message.direction,
      text: message.text,
      ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
    }));
  }

  async send(request: MessageSendRequest): Promise<MessageSendResult> {
    const payload = await this.post('/outbox', {
      idempotencyKey: request.idempotencyKey,
      to: request.handle,
      text: request.text,
    });
    const parsed = sendResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError('The bridge returned an unrecognised send result.');
    }
    return {
      status: parsed.data.status,
      retrySafe: parsed.data.retrySafe,
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    };
  }

  private get(path: string): Promise<unknown> {
    return this.request(path);
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, body);
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new UnsupportedError(
        `The iMessage bridge is not reachable at ${this.baseUrl}. Start it with: npm run bridge`,
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    if (response.ok) return payload;

    const parsed = errorResponseSchema.safeParse(payload);
    const message = parsed.success ? parsed.data.error.message : `bridge returned ${response.status}`;
    if (response.status === 404) throw new NotFoundFromBridge(message);
    if (response.status === 401) {
      throw new UnsupportedError(
        'The iMessage bridge rejected the token. Check that both processes read the same token file.',
      );
    }
    // 503 carries the remedy for an ungranted macOS permission; keep it intact.
    if (response.status === 503) throw new UnsupportedError(message);
    throw new ProviderError(message);
  }
}

/** Internal: distinguishes "no such thread" from a real failure. */
class NotFoundFromBridge extends Error {}
