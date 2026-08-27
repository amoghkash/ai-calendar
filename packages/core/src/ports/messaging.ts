import type { DirectoryContact, ThreadMessage, ThreadSnapshot } from '../domain/messaging.js';

/**
 * What the messaging integration can currently do.
 *
 * Every field can be false on a correctly configured machine: the integration
 * is optional, its permissions are granted one at a time, and reading commonly
 * works while sending does not. Callers must treat unavailability as ordinary.
 */
export interface MessagingCapabilities {
  /** The integration is reachable at all. */
  readonly available: boolean;
  readonly canReadMessages: boolean;
  readonly canReadContacts: boolean;
  readonly canSend: boolean;
  /** Operator-facing remedy when something is off. */
  readonly detail?: string;
}

export type MessageSendStatus =
  | 'sent'
  | 'unconfirmed'
  | 'failed'
  | 'blocked'
  | 'simulated'
  | 'duplicate';

export interface MessageSendRequest {
  readonly handle: string;
  readonly text: string;
  /** Stable per logical message, so a retry cannot send it twice. */
  readonly idempotencyKey: string;
}

export interface MessageSendResult {
  readonly status: MessageSendStatus;
  /** False whenever the message may already have gone out. Never retry then. */
  readonly retrySafe: boolean;
  readonly reason?: string;
}

/**
 * The only way to reach another person, kept off `MessagingProvider` on
 * purpose.
 *
 * Reading conversations and sending into them are different privileges, and
 * the scheduler can reach the reading one. Keeping them apart means no amount
 * of refactoring upstream can quietly acquire the ability to text somebody.
 */
export interface MessageSender {
  send(request: MessageSendRequest): Promise<MessageSendResult>;
}

/** Look up people by name. Read-only, and never picks on the caller's behalf. */
export interface ContactDirectory {
  search(query: string, limit?: number): Promise<readonly DirectoryContact[]>;
}

/**
 * Conversation state for one person.
 *
 * Sending is deliberately absent from this port. Outbound messages are a
 * separate decision with a separate approval path, and keeping them out of the
 * interface the scheduler can reach means no amount of refactoring upstream can
 * accidentally acquire the ability to text somebody.
 */
export interface MessagingProvider {
  readonly id: string;
  capabilities(): Promise<MessagingCapabilities>;
  /**
   * Undefined when no conversation with that handle exists.
   *
   * `since` lets the implementation skip deriving per-direction timestamps when
   * nothing newer exists, which is the difference between a cheap poll and an
   * expensive one.
   */
  thread(handle: string, since?: number): Promise<ThreadSnapshot | undefined>;
  /**
   * Recent messages in one conversation, newest last.
   *
   * The only place message text enters the application, and separate from
   * `thread` so that reading somebody's words is always a deliberate call
   * rather than a side effect of asking when they last wrote.
   */
  recentMessages(handle: string, limit?: number): Promise<readonly ThreadMessage[]>;
}
