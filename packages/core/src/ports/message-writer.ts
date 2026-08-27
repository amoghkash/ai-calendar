import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import type { OutreachKind, OutreachTone } from '../domain/outreach.js';

export interface MessageWriteRequest {
  readonly kind: OutreachKind;
  readonly displayName: string;
  readonly activity: string;
  readonly slots: readonly Interval[];
  readonly tone: OutreachTone;
  readonly timezone: string;
  readonly now: Instant;
  /** The deterministic version, as an example of length and register. */
  readonly fallback: string;
}

/**
 * Writes the text that goes to another person.
 *
 * Allowed to return `undefined` - no model, a failed request, an answer that
 * did not survive checking - and the caller then uses the template it already
 * had. A model improves the wording; it is never the reason a message exists
 * or does not.
 */
export interface MessageWriter {
  write(request: MessageWriteRequest): Promise<string | undefined>;
}
