import type { ThreadMessage, ThreadMessagesResponse, ThreadState } from '@calendar-agent/imessage-contract';
import { notFound } from './errors.js';
import type { ImsgChat, ImsgRunner } from './imsg.js';
import { imsgFailure, parseChats, parseMessages, toEpochMs } from './imsg.js';
import { normalizeHandle } from './handles.js';

export interface ThreadServiceOptions {
  readonly region: string;
  readonly chatScanLimit: number;
  readonly historyScanLimit: number;
  /** How long to remember that a handle has no thread. */
  readonly missTtlMs: number;
}

/**
 * Conversation state, derived rather than read.
 *
 * `imsg chats` takes no handle filter and `imsg history` selects only by
 * `--chat-id`, so finding one person's thread means listing chats and matching
 * here, then reading a bounded window of that chat. The chat list alone cannot
 * answer "who spoke last": it carries `last_message_at` but nothing about
 * direction.
 */
export class ThreadService {
  /** handle -> chat. The expensive half of the lookup, and it rarely changes. */
  private readonly chats = new Map<string, ImsgChat>();
  /**
   * Handles known to have no thread, and when that was established.
   *
   * Without this a handle nobody has ever messaged costs a full chat-list scan
   * on every single lookup - the worst case paying the highest price. Kept with
   * a short life because a thread can appear the moment somebody writes.
   */
  private readonly missing = new Map<string, number>();

  constructor(
    private readonly runner: ImsgRunner,
    private readonly options: ThreadServiceOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * @param since when given, and the chat's newest message is no later than it,
   * the per-direction timestamps are skipped along with the history read that
   * derives them. Reading a conversation's messages is by far the expensive
   * call here (measured in seconds), and a poller asking "anything new?" every
   * couple of minutes must not pay it every time to be told no.
   */
  async state(handle: string, since?: number): Promise<ThreadState> {
    const { normalized } = normalizeHandle(handle, this.options.region);
    const chat = await this.resolveChat(normalized);
    const chatLastAt = toEpochMs(chat.last_message_at);
    const contactNameOnly = chat.contact_name ?? chat.display_name;

    if (since !== undefined && chatLastAt !== undefined && chatLastAt <= since) {
      return {
        handle,
        normalized,
        chatId: chat.id,
        ...(chat.service === undefined ? {} : { service: chat.service }),
        ...(contactNameOnly === undefined || contactNameOnly.length === 0
          ? {}
          : { contactName: contactNameOnly }),
        lastMessageAt: chatLastAt,
      };
    }

    const messages = await this.history(chat.id, this.options.historyScanLimit);

    let lastInboundAt: number | undefined;
    let lastOutboundAt: number | undefined;
    let newest: number | undefined;
    // Ordering is not documented, so take maxima rather than trusting position.
    for (const message of messages) {
      const at = toEpochMs(message.created_at);
      if (at === undefined) continue;
      if (newest === undefined || at > newest) newest = at;
      if (message.is_from_me === true) {
        if (lastOutboundAt === undefined || at > lastOutboundAt) lastOutboundAt = at;
      } else if (lastInboundAt === undefined || at > lastInboundAt) {
        lastInboundAt = at;
      }
    }

    const lastMessageAt = toEpochMs(chat.last_message_at) ?? newest;
    const contactName = chat.contact_name ?? chat.display_name;
    return {
      handle,
      normalized,
      chatId: chat.id,
      ...(chat.service === undefined ? {} : { service: chat.service }),
      ...(contactName === undefined || contactName.length === 0 ? {} : { contactName }),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      ...(lastInboundAt === undefined ? {} : { lastInboundAt }),
      ...(lastOutboundAt === undefined ? {} : { lastOutboundAt }),
    };
  }

  async messages(handle: string, limit: number): Promise<ThreadMessagesResponse> {
    const { normalized } = normalizeHandle(handle, this.options.region);
    const chat = await this.resolveChat(normalized);
    const raw = await this.history(chat.id, limit);

    const messages: ThreadMessage[] = [];
    for (const message of raw) {
      const at = toEpochMs(message.created_at);
      if (at === undefined) continue;
      messages.push({
        id: message.id,
        at,
        direction: message.is_from_me === true ? 'outbound' : 'inbound',
        text: message.text ?? '',
        ...(message.sender_name === undefined ? {} : { senderName: message.sender_name }),
      });
    }
    messages.sort((a, b) => a.at - b.at);
    return { handle, normalized, chatId: chat.id, messages };
  }

  private async resolveChat(normalized: string): Promise<ImsgChat> {
    const cached = this.chats.get(normalized);
    if (cached !== undefined) return cached;

    const missedAt = this.missing.get(normalized);
    if (missedAt !== undefined && this.now() - missedAt < this.options.missTtlMs) {
      throw notFound(`No direct message thread found for ${normalized}.`);
    }

    const result = await this.runner.run([
      'chats',
      '--json',
      '--limit',
      String(this.options.chatScanLimit),
    ]);
    if (result.exitCode !== 0) throw imsgFailure('chats', result);

    let match: ImsgChat | undefined;
    for (const chat of parseChats(result.stdout)) {
      // Group threads need an identity model this version does not have.
      if (chat.is_group === true) continue;
      const candidates = [chat.identifier, ...(chat.participants ?? [])];
      const handles = candidates
        .filter((c): c is string => c !== undefined && c.length > 0)
        .map((c) => normalizeHandle(c, this.options.region).normalized);
      if (!handles.includes(normalized)) continue;
      for (const handle of handles) this.chats.set(handle, chat);
      match = chat;
      break;
    }

    if (match === undefined) {
      this.missing.set(normalized, this.now());
      throw notFound(`No direct message thread found for ${normalized}.`);
    }
    this.missing.delete(normalized);
    return match;
  }

  private async history(chatId: number, limit: number) {
    const result = await this.runner.run([
      'history',
      '--chat-id',
      String(chatId),
      '--limit',
      String(limit),
      '--json',
    ]);
    if (result.exitCode !== 0) throw imsgFailure('history', result);
    return parseMessages(result.stdout);
  }
}
