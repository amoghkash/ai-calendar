import type { Clock, Logger, MessagingProvider, Outreach, UserId } from '@calendar-agent/core';
import type { OutreachService } from './outreach-service.js';

export interface OutreachPollerOptions {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  /** How many recent messages to read when a reply is known to exist. */
  readonly readLimit: number;
}

export interface OutreachPollerRun {
  readonly startedAt: number;
  readonly checked: number;
  readonly replies: number;
  readonly expired: number;
  readonly error?: string;
}

export interface OutreachPollerStatus {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly running: boolean;
  readonly lastRun?: OutreachPollerRun;
}

/**
 * Watches for answers to messages that have gone out.
 *
 * It needs no watch registry and no event feed on the bridge: an outreach in
 * `sent` already names the handle and the moment it was sent, and the bridge
 * already answers "when did this person last write" cheaply. So the loop asks
 * that question, and only reaches for message text when the answer says there
 * is something new - which keeps other people's words out of this process on
 * every pass where nobody replied.
 *
 * Owned by the server process, like `BackgroundSync`. A one-shot CLI must never
 * start a loop.
 */
export class OutreachPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private lastRun: OutreachPollerRun | undefined;

  constructor(
    private readonly userId: UserId,
    private readonly outreach: OutreachService,
    private readonly messaging: MessagingProvider | undefined,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: OutreachPollerOptions,
  ) {}

  status(): OutreachPollerStatus {
    return {
      enabled: this.options.enabled,
      intervalMinutes: this.options.intervalMinutes,
      running: this.timer !== undefined,
      ...(this.lastRun === undefined ? {} : { lastRun: this.lastRun }),
    };
  }

  start(): void {
    if (!this.options.enabled || this.messaging === undefined || this.timer) return;
    const period = Math.max(1, this.options.intervalMinutes) * 60_000;
    this.timer = setInterval(() => void this.runOnce(), period);
    this.timer.unref?.();
    this.logger.info('outreach.poller_started', {
      intervalMinutes: this.options.intervalMinutes,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Exposed so a test - or an operator - can drive it directly. */
  async runOnce(): Promise<OutreachPollerRun> {
    if (this.inFlight) return this.lastRun ?? { startedAt: this.clock.now(), checked: 0, replies: 0, expired: 0 };
    this.inFlight = true;
    const startedAt = this.clock.now();
    let checked = 0;
    let replies = 0;
    let expired = 0;

    try {
      const waiting = await this.outreach.list(this.userId, ['sent', 'needs_you']);
      for (const outreach of waiting) {
        checked += 1;
        try {
          if (await this.expireIfStale(outreach, startedAt)) {
            expired += 1;
            continue;
          }
          if (await this.checkOne(outreach)) replies += 1;
        } catch (error) {
          // One unreachable conversation must not stop the others.
          this.logger.warn?.('outreach.poll_failed', {
            id: outreach.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.lastRun = { startedAt, checked, replies, expired };
      // A heartbeat at debug level: a quiet pass otherwise logs nothing at all,
      // which is indistinguishable from a loop that never ran.
      this.logger.debug?.('outreach.polled', { checked, replies, expired });
    } catch (error) {
      this.lastRun = {
        startedAt,
        checked,
        replies,
        expired,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.inFlight = false;
    }
    return this.lastRun;
  }

  private async expireIfStale(outreach: Outreach, now: number): Promise<boolean> {
    if (outreach.expiresAt === undefined || outreach.expiresAt > now) return false;
    await this.outreach.expire(this.userId, outreach.id);
    this.logger.info('outreach.expired', { id: outreach.id });
    return true;
  }

  private async checkOne(outreach: Outreach): Promise<boolean> {
    if (this.messaging === undefined) return false;
    // Anything at or before this has already been acted on.
    const floor = outreach.lastReplyAt ?? outreach.sentAt ?? outreach.createdAt;

    // Passing the floor lets the bridge answer "nothing new" without reading
    // the conversation at all.
    const thread = await this.messaging.thread(outreach.handle, floor);
    if (thread === undefined) return false;
    // With `since` in play a quiet thread reports only `lastMessageAt`, so check
    // that first: no message at all since the floor means nothing to read.
    if (thread.lastMessageAt !== undefined && thread.lastMessageAt <= floor) return false;
    if (thread.lastInboundAt === undefined || thread.lastInboundAt <= floor) return false;

    // Only now is it worth reading anybody's words.
    const messages = await this.messaging.recentMessages(outreach.handle, this.options.readLimit);
    const fresh = messages
      .filter((message) => message.direction === 'inbound' && message.at > floor)
      .sort((a, b) => a.at - b.at);
    const latest = fresh[fresh.length - 1];
    if (latest === undefined || latest.text.trim().length === 0) return false;

    await this.outreach.recordReply(this.userId, outreach.id, latest.text, latest.at);
    return true;
  }
}
