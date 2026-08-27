import type { Instant } from '../time/instant.js';

export type HandleKind = 'phone' | 'email';

export interface PersonHandle {
  readonly kind: HandleKind;
  /** As stored by the contact source, i.e. how a human typed it. */
  readonly value: string;
  /** The comparable form. Anything downstream keys on this. */
  readonly normalized: string;
  readonly label?: string;
}

export interface DirectoryContact {
  readonly id: string;
  readonly displayName: string;
  readonly handles: readonly PersonHandle[];
}

/** Conversation state, without conversation content. */
export interface ThreadSnapshot {
  readonly handle: string;
  readonly normalized: string;
  readonly contactName?: string;
  readonly lastMessageAt?: Instant;
  readonly lastInboundAt?: Instant;
  readonly lastOutboundAt?: Instant;
}

export interface ThreadMessage {
  readonly id: number;
  readonly at: Instant;
  readonly direction: 'inbound' | 'outbound';
  readonly text: string;
  readonly senderName?: string;
}

/**
 * What is knowable about whether a plan is confirmed, without reading a word.
 *
 *  unmentioned   - nothing has been said since the plan was made
 *  awaiting_them - I spoke last
 *  awaiting_me   - they spoke last
 */
export type ThreadPosture = 'unmentioned' | 'awaiting_them' | 'awaiting_me';

/**
 * Derive posture from timestamps alone.
 *
 * There is no RSVP for a plan made over text, and inferring `accepted` from
 * message wording is exactly the guess that produces a lunch nobody attends.
 * So this reports only what the clock can prove, and the words in the thread
 * are left to a human - or, explicitly and separately, to a model.
 */
export function threadPosture(
  snapshot: ThreadSnapshot | undefined,
  since: Instant,
): ThreadPosture {
  if (snapshot === undefined) return 'unmentioned';

  const inbound = snapshot.lastInboundAt !== undefined && snapshot.lastInboundAt >= since;
  const outbound = snapshot.lastOutboundAt !== undefined && snapshot.lastOutboundAt >= since;
  if (!inbound && !outbound) return 'unmentioned';
  if (!inbound) return 'awaiting_them';
  if (!outbound) return 'awaiting_me';

  // Both sides have spoken since; whoever spoke last holds the ball.
  return (snapshot.lastOutboundAt ?? 0) > (snapshot.lastInboundAt ?? 0)
    ? 'awaiting_them'
    : 'awaiting_me';
}
