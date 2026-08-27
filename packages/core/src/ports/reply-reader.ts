import type { ReplyIntent } from '../domain/reply-intent.js';
import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';

export interface ReplyReaderRequest {
  readonly text: string;
  /** The times that were offered, in the order they were offered. */
  readonly slots: readonly Interval[];
  readonly timezone: string;
  readonly now: Instant;
  readonly personName: string;
  readonly activity: string;
}

/**
 * A second opinion on a reply the deterministic rules could not read.
 *
 * Deliberately allowed to return `undefined`: no model configured, a request
 * that failed, an answer that did not validate. The caller keeps its own
 * `unclear` in that case, so a model being unreachable costs a nudge to the
 * human and nothing else.
 *
 * It may only ever choose among the times already offered. It cannot propose
 * one, because the thing on the other side of this decision is a real event in
 * a real calendar and a person expecting you somewhere.
 */
export interface ReplyReader {
  read(request: ReplyReaderRequest): Promise<ReplyIntent | undefined>;
}
