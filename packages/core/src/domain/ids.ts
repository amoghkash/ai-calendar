export type UserId = string;
export type TaskId = string;
export type BlockId = string;
export type CalendarId = string;
export type CalendarAccountId = string;
export type EventId = string;
export type ProjectId = string;
export type ConversationId = string;
export type ChangeSetId = string;
export type EventContactLinkId = string;
export type OutreachId = string;

/** Port for id generation so domain services stay deterministic in tests. */
export interface IdGenerator {
  next(prefix?: string): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix = ''): string {
    const uuid = globalThis.crypto.randomUUID();
    return prefix ? `${prefix}_${uuid}` : uuid;
  }
}

/** Deterministic generator for tests and reproducible planning runs. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;
  constructor(private readonly seed = 'id') {}
  next(prefix = ''): string {
    this.counter += 1;
    const base = `${this.seed}${this.counter}`;
    return prefix ? `${prefix}_${base}` : base;
  }
}
