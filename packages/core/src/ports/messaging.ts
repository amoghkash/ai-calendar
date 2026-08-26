import type { DirectoryContact, ThreadSnapshot } from '../domain/messaging.js';

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
  /** Undefined when no conversation with that handle exists. */
  thread(handle: string): Promise<ThreadSnapshot | undefined>;
}
