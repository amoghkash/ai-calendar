import type { CalendarEvent } from '../domain/calendar.js';
import type { BlockId, TaskId } from '../domain/ids.js';
import type { SchedulingPreferences } from '../domain/preferences.js';
import type { ScheduleBlock } from '../domain/schedule.js';
import type { Task } from '../domain/task.js';
import type { Instant } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import type { FreeWindow } from './availability.js';

/**
 * Structured explanation attached to every scheduling decision. `code` is
 * stable and machine-readable; `message` is a deterministic English rendering;
 * `details` carries the numbers the message was built from.
 */
export interface DecisionReason {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const reason = (
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): DecisionReason => (details === undefined ? { code, message } : { code, message, details });

export type BlockOrigin = 'retained' | 'new' | 'moved';

export interface PlannedBlock {
  readonly id: BlockId;
  readonly taskId: TaskId;
  readonly sequence: number;
  readonly start: Instant;
  readonly end: Instant;
  readonly timezone: string;
  readonly minutes: number;
  readonly origin: BlockOrigin;
  readonly deepWork: boolean;
  /** Where the block used to be, when it was moved. */
  readonly previous?: Interval;
  readonly reason: DecisionReason;
}

export interface UnscheduledTask {
  readonly taskId: TaskId;
  readonly title: string;
  readonly remainingMinutes: number;
  readonly scheduledMinutes: number;
  readonly missingMinutes: number;
  readonly reason: DecisionReason;
}

export type RiskLevel = 'SAFE' | 'AT_RISK' | 'CRITICAL' | 'IMPOSSIBLE';

export const RISK_ORDER: Record<RiskLevel, number> = {
  SAFE: 0,
  AT_RISK: 1,
  CRITICAL: 2,
  IMPOSSIBLE: 3,
};

export interface TaskRisk {
  readonly taskId: TaskId;
  readonly title: string;
  readonly level: RiskLevel;
  readonly deadline?: Instant;
  readonly remainingMinutes: number;
  readonly scheduledMinutes: number;
  readonly unscheduledMinutes: number;
  /** Suitable capacity between now and the deadline, ignoring other tasks. */
  readonly availableMinutesBeforeDeadline: number;
  /** availableMinutesBeforeDeadline / remainingMinutes; null without deadline. */
  readonly capacityRatio: number | null;
  readonly lastBlockEnd?: Instant;
  readonly explanation: string;
  readonly reason: DecisionReason;
}

export interface ScoreComponent {
  readonly key: string;
  readonly weight: number;
  /** Raw measured value, in whatever unit the component is expressed in. */
  readonly raw: number;
  /** Raw value mapped onto 0..1. */
  readonly normalized: number;
  /** weight * normalized. */
  readonly contribution: number;
  readonly explanation: string;
}

export interface TaskScore {
  readonly taskId: TaskId;
  readonly title: string;
  readonly total: number;
  readonly components: readonly ScoreComponent[];
}

export interface QualityMetric {
  readonly key: string;
  readonly label: string;
  /** 0..1, higher is better. */
  readonly value: number;
  readonly weight: number;
  readonly explanation: string;
}

export interface ScheduleQuality {
  /** Weighted mean of the metrics, 0..1. */
  readonly overall: number;
  readonly metrics: readonly QualityMetric[];
}

export type DiffChangeKind = 'added' | 'moved' | 'removed' | 'unchanged';

export interface DiffEntry {
  readonly kind: DiffChangeKind;
  readonly blockId: BlockId;
  readonly taskId: TaskId;
  readonly taskTitle: string;
  readonly before?: Interval;
  readonly after?: Interval;
  readonly reason: DecisionReason;
}

export interface ScheduleDiff {
  readonly added: readonly DiffEntry[];
  readonly moved: readonly DiffEntry[];
  readonly removed: readonly DiffEntry[];
  readonly unchanged: readonly DiffEntry[];
  readonly summary: {
    readonly addedCount: number;
    readonly movedCount: number;
    readonly removedCount: number;
    readonly unchangedCount: number;
    readonly netMinutesChanged: number;
  };
}

export interface TraceStep {
  readonly step: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Replayable record of everything the scheduler considered and decided. */
export interface SchedulingTrace {
  readonly runId: string;
  readonly generatedAt: Instant;
  readonly input: {
    readonly now: Instant;
    readonly horizon: Interval;
    readonly timezone: string;
    readonly taskCount: number;
    readonly eventCount: number;
    readonly existingBlockCount: number;
    readonly availableMinutes: number;
  };
  readonly scores: readonly TaskScore[];
  readonly steps: readonly TraceStep[];
}

export interface SchedulingInput {
  readonly runId?: string;
  readonly now: Instant;
  readonly horizon: Interval;
  readonly timezone?: string;
  readonly tasks: readonly Task[];
  readonly events: readonly CalendarEvent[];
  readonly existingBlocks: readonly ScheduleBlock[];
  readonly preferences: SchedulingPreferences;
  /** When set, only these tasks are (re)placed; other blocks are retained. */
  readonly taskIds?: readonly TaskId[];
  /** Ignore stability and rebuild the schedule from scratch. */
  readonly rebuild?: boolean;
}

export interface SchedulingPlan {
  readonly runId: string;
  readonly generatedAt: Instant;
  readonly horizon: Interval;
  readonly timezone: string;
  readonly blocks: readonly PlannedBlock[];
  readonly unscheduled: readonly UnscheduledTask[];
  readonly risks: readonly TaskRisk[];
  readonly quality: ScheduleQuality;
  readonly diff: ScheduleDiff;
  readonly trace: SchedulingTrace;
  /** Windows left free after planning; useful for "find me a meeting slot". */
  readonly remainingWindows: readonly FreeWindow[];
}

/**
 * The scheduling engine contract. Implementations must be deterministic and
 * free of I/O: given identical input they must return an identical plan.
 */
export interface Scheduler {
  readonly name: string;
  plan(input: SchedulingInput): SchedulingPlan;
}
