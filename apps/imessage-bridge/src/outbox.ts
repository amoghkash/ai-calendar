import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { SendRequest, SendResult, SendStatus } from '@calendar-agent/imessage-contract';
import { BridgeError } from './errors.js';
import { normalizeHandle } from './handles.js';
import type { ImsgRunner } from './imsg.js';
import { imsgFailure } from './imsg.js';

const auditEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  idempotencyKey: z.string(),
  to: z.string(),
  status: z.string(),
  retrySafe: z.boolean(),
  bytes: z.number(),
  reason: z.string().optional(),
});

export interface OutboxOptions {
  readonly sendEnabled: boolean;
  readonly perRecipientDailyLimit: number;
  readonly globalDailyLimit: number;
  readonly auditLogPath: string;
  readonly auditIncludesText: boolean;
  readonly region: string;
}

interface AuditEntry {
  readonly id: string;
  readonly at: number;
  readonly idempotencyKey: string;
  readonly to: string;
  readonly status: SendStatus;
  readonly retrySafe: boolean;
  readonly bytes: number;
  readonly reason?: string;
  readonly text?: string;
}

/**
 * Sends that actually reached Messages.app.
 *
 * The single source of truth for both questions that matter: what counts
 * against the daily caps, and what blocks a retry. They must agree - if
 * dedup counted attempts the caps ignored, a simulated send would silently
 * prevent the real one.
 */
const DISPATCHED: readonly SendStatus[] = ['sent', 'unconfirmed'];

const dayKey = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/**
 * The last mile, and the only thing in this system that can text a human.
 *
 * It is deliberately dumb about intent: it does not decide who to message or
 * what to say, and it has no autonomous mode. Its whole job is to bound the
 * damage a caller can do - including a buggy one on the other side of the
 * socket - so every guard here is about blast radius rather than correctness of
 * the message itself.
 */
export class Outbox {
  private readonly results = new Map<string, SendResult>();
  private readonly entries: AuditEntry[] = [];

  constructor(
    private readonly runner: ImsgRunner,
    private readonly options: OutboxOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Replays the audit log so idempotency and caps survive a restart. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.options.auditLogPath, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = auditEntrySchema.safeParse(parsed);
      if (!entry.success) continue;
      const record: AuditEntry = {
        ...entry.data,
        status: entry.data.status as SendStatus,
      };
      this.entries.push(record);
      this.results.set(record.idempotencyKey, this.toResult(record));
    }
  }

  remainingToday(): number {
    return Math.max(0, this.options.globalDailyLimit - this.countToday());
  }

  async send(request: SendRequest): Promise<SendResult> {
    const existing = this.results.get(request.idempotencyKey);
    // Only a message that actually went out may block a retry. A dry run or a
    // capped attempt reached nobody, so refusing the real send afterwards would
    // mean the safety switch permanently poisons the very message it protected.
    if (existing && DISPATCHED.includes(existing.status)) {
      return { ...existing, status: 'duplicate' };
    }

    const { normalized } = normalizeHandle(request.to, this.options.region);
    const simulated = request.dryRun === true || !this.options.sendEnabled;

    if (!simulated) {
      const cap = this.capBreach(normalized);
      if (cap !== undefined) {
        // Recorded, so a caller stuck in a loop shows up in the audit log.
        return this.record(request, normalized, 'blocked', true, cap);
      }
    }

    if (simulated) {
      const reason = request.dryRun === true ? 'dryRun requested' : 'sending is disabled';
      return this.record(request, normalized, 'simulated', true, reason);
    }

    const result = await this.runner.run([
      'send',
      '--to',
      normalized,
      '--text',
      request.text,
      '--service',
      'auto',
      '--region',
      this.options.region,
      '--json',
    ]);

    // A missing binary or a denied permission means nothing was dispatched, so
    // it is a capability problem and raises rather than becoming a send status.
    if (result.exitCode === 127) throw imsgFailure('send', result);
    const failure = result.exitCode === 0 ? undefined : imsgFailure('send', result);
    if (failure?.code === 'UNSUPPORTED') throw failure;

    const { status, retrySafe, reason } = classify(result.exitCode, result.stdout, result.stderr);
    return this.record(request, normalized, status, retrySafe, reason);
  }

  private capBreach(normalized: string): string | undefined {
    if (this.countToday() >= this.options.globalDailyLimit) {
      return `Daily send limit of ${this.options.globalDailyLimit} reached.`;
    }
    if (this.countToday(normalized) >= this.options.perRecipientDailyLimit) {
      return `Daily limit of ${this.options.perRecipientDailyLimit} messages to this recipient reached.`;
    }
    return undefined;
  }

  private countToday(recipient?: string): number {
    const today = dayKey(this.now());
    return this.entries.filter(
      (entry) =>
        DISPATCHED.includes(entry.status) &&
        dayKey(entry.at) === today &&
        (recipient === undefined || entry.to === recipient),
    ).length;
  }

  private toResult(entry: AuditEntry): SendResult {
    return {
      id: entry.id,
      status: entry.status,
      retrySafe: entry.retrySafe,
      at: entry.at,
      to: entry.to,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
  }

  private async record(
    request: SendRequest,
    normalized: string,
    status: SendStatus,
    retrySafe: boolean,
    reason?: string,
  ): Promise<SendResult> {
    const entry: AuditEntry = {
      id: `snd_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      at: this.now(),
      idempotencyKey: request.idempotencyKey,
      to: normalized,
      status,
      retrySafe,
      bytes: Buffer.byteLength(request.text, 'utf8'),
      ...(reason === undefined ? {} : { reason }),
      ...(this.options.auditIncludesText ? { text: request.text } : {}),
    };
    this.entries.push(entry);
    const result = this.toResult(entry);
    this.results.set(request.idempotencyKey, result);
    await this.append(entry);
    return result;
  }

  private async append(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(dirname(this.options.auditLogPath), { recursive: true });
      await appendFile(this.options.auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      // An unwritable audit log must not silently become an unaudited send.
      throw new BridgeError(
        'INTERNAL_ERROR',
        'The send was recorded in memory but the audit log could not be written.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * `imsg` reports three dispositions and only one of them is safe to retry.
 * Anything it does not say is treated as possibly-delivered: sending a friend
 * the same question twice is worse than reporting an outcome we are unsure of.
 */
export function classify(
  exitCode: number,
  stdout: string,
  stderr: string,
): { status: SendStatus; retrySafe: boolean; reason?: string } {
  const haystack = `${stdout} ${stderr}`.toLowerCase();
  if (haystack.includes('not_started')) {
    return { status: 'failed', retrySafe: true, reason: stderr.trim().slice(0, 200) || 'imsg reported not_started' };
  }
  if (haystack.includes('may_have_completed') || haystack.includes('still_in_flight')) {
    return {
      status: 'unconfirmed',
      retrySafe: false,
      reason: 'imsg could not confirm delivery; do not retry',
    };
  }
  if (exitCode === 0 && haystack.includes('"status"') && haystack.includes('sent')) {
    return { status: 'sent', retrySafe: false };
  }
  if (exitCode === 0) return { status: 'sent', retrySafe: false };
  return {
    status: 'unconfirmed',
    retrySafe: false,
    reason: stderr.trim().slice(0, 200) || 'imsg exited non-zero without a disposition',
  };
}
