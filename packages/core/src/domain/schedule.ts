import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import type { BlockId, CalendarId, EventId, TaskId, UserId } from './ids.js';
import type { CalendarProviderId } from './calendar.js';

export type BlockStatus =
  'proposed' | 'confirmed' | 'synced' | 'completed' | 'cancelled' | 'detached';

export type BlockKind = 'task' | 'buffer' | 'manual_block';

/**
 * A concrete chunk of time allocated to a task. Blocks are the unit that gets
 * written to (and read back from) an external calendar.
 */
export interface ScheduleBlock {
  readonly id: BlockId;
  readonly userId: UserId;
  readonly taskId: TaskId;
  readonly kind: BlockKind;

  readonly start: Instant;
  readonly end: Instant;
  readonly timezone: string;

  /** 0-based index of this block within the task's schedule. */
  readonly sequence: number;
  readonly status: BlockStatus;
  /** Pinned blocks are never moved by the scheduler. */
  readonly pinned: boolean;

  readonly calendarId?: CalendarId;
  readonly provider?: CalendarProviderId;
  readonly externalEventId?: EventId;

  /** Structured reason recorded when the block was planned. */
  readonly reasonCode?: string;

  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export const blockInterval = (block: ScheduleBlock): Interval => ({
  start: block.start,
  end: block.end,
});

export const blockMinutes = (block: ScheduleBlock): number =>
  Math.max(0, (block.end - block.start) / 60_000);

export const isLiveBlock = (block: ScheduleBlock): boolean =>
  block.status !== 'cancelled' && block.status !== 'detached';

/** Aggregate view of everything scheduled for one task. */
export interface TaskSchedule {
  readonly taskId: TaskId;
  readonly blocks: readonly ScheduleBlock[];
  readonly scheduledMinutes: number;
  readonly firstStart?: Instant;
  readonly lastEnd?: Instant;
}

export function buildTaskSchedule(taskId: TaskId, blocks: readonly ScheduleBlock[]): TaskSchedule {
  const own = blocks
    .filter((b) => b.taskId === taskId && isLiveBlock(b))
    .sort((a, b) => a.start - b.start);
  const scheduledMinutes = own.reduce((sum, b) => sum + blockMinutes(b), 0);
  const first = own[0];
  const last = own[own.length - 1];
  return {
    taskId,
    blocks: own,
    scheduledMinutes,
    ...(first ? { firstStart: first.start } : {}),
    ...(last ? { lastEnd: last.end } : {}),
  };
}
