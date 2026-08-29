import type { Instant } from '../time/instant.js';
import type { DailyWindow, Weekday } from '../time/wall-clock.js';
import type { CategoryId } from './category.js';
import type { CalendarId, ProjectId, TaskId, UserId } from './ids.js';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];

/** Normalised 0..1 weight for each priority level, used by the scoring engine. */
export const PRIORITY_WEIGHT: Record<Priority, number> = {
  low: 0.15,
  normal: 0.4,
  high: 0.75,
  urgent: 1,
};

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

/** How much uninterrupted attention a task needs. Drives deep-work placement. */
export type FocusLevel = 'deep' | 'shallow' | 'any';

export interface Task {
  readonly id: TaskId;
  readonly userId: UserId;
  readonly title: string;
  readonly description?: string;

  /** Total estimated effort in minutes. */
  readonly estimatedMinutes: number;
  /** Effort already completed, in minutes. */
  readonly completedMinutes: number;

  readonly deadline?: Instant;
  readonly earliestStart?: Instant;
  /** The task must have started by this instant (soft constraint on first block). */
  readonly latestStart?: Instant;

  readonly priority: Priority;
  /** 0..100. Long-term significance, independent of the deadline. */
  readonly importance: number;

  readonly minimumBlockMinutes: number;
  readonly maximumBlockMinutes?: number;
  /**
   * Most of *this* task the scheduler may place on any one local day.
   *
   * Distinct from the global `maxDailyTaskMinutes` preference, which caps all
   * task work on a day taken together: this one paces a single task, so eight
   * hours of revision can be spread over a fortnight rather than sat in one
   * sitting. Undefined means no per-task cap.
   */
  readonly maxDailyMinutes?: number;
  readonly allowSplitting: boolean;

  /** Preferred times of day; empty means "any time inside working hours". */
  readonly preferredWindows: readonly DailyWindow[];
  readonly preferredDays: readonly Weekday[];
  readonly focus: FocusLevel;

  readonly tags: readonly string[];
  readonly categoryId?: CategoryId;
  readonly projectId?: ProjectId;
  /** Calendar that scheduled blocks for this task should be written to. */
  readonly calendarId?: CalendarId;
  readonly dependsOn: readonly TaskId[];

  readonly status: TaskStatus;
  /** Pinned tasks keep their existing blocks; the scheduler will not move them. */
  readonly pinned: boolean;

  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly completedAt?: Instant;
}

export type TaskDraft = Omit<
  Task,
  | 'id'
  | 'userId'
  | 'createdAt'
  | 'updatedAt'
  | 'completedMinutes'
  | 'status'
  | 'pinned'
  | 'tags'
  | 'dependsOn'
  | 'preferredWindows'
  | 'preferredDays'
  | 'focus'
  | 'allowSplitting'
  | 'minimumBlockMinutes'
  | 'importance'
  | 'priority'
> &
  Partial<Task>;

export const DEFAULT_MINIMUM_BLOCK_MINUTES = 30;

/** Remaining effort for a task, in minutes. Never negative. */
export const remainingMinutes = (task: Task): number =>
  Math.max(0, task.estimatedMinutes - task.completedMinutes);

export const isActive = (task: Task): boolean =>
  task.status === 'todo' || task.status === 'in_progress' || task.status === 'blocked';

/** A task is schedulable when it is active and still has effort left. */
export const isSchedulable = (task: Task): boolean =>
  isActive(task) && remainingMinutes(task) > 0 && task.status !== 'blocked';

export const isOverdue = (task: Task, now: Instant): boolean =>
  task.deadline !== undefined && task.deadline < now && remainingMinutes(task) > 0;

/**
 * Effective minimum block for a task: the task's own minimum, bounded by the
 * work that is actually left (a 20 minute remainder should still be placeable).
 */
export function effectiveMinimumBlockMinutes(task: Task, globalMinimum: number): number {
  const remaining = remainingMinutes(task);
  const minimum = Math.max(task.minimumBlockMinutes, globalMinimum);
  return Math.min(minimum, remaining);
}

export function effectiveMaximumBlockMinutes(task: Task, globalMaximum: number): number {
  const candidates = [globalMaximum, task.maximumBlockMinutes].filter(
    (value): value is number => typeof value === 'number' && value > 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
}

/**
 * Minutes of `task` still placeable on a day that already holds `usedToday`.
 *
 * Infinite when the task sets no daily cap, which keeps callers free of a
 * special case: the value is only ever used inside a `Math.min`.
 */
export function dailyRemainingMinutes(task: Task, usedToday: number): number {
  if (task.maxDailyMinutes === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, task.maxDailyMinutes - usedToday);
}

/** Tasks whose dependencies are not yet completed cannot be scheduled. */
export function unmetDependencies(task: Task, byId: ReadonlyMap<TaskId, Task>): TaskId[] {
  return task.dependsOn.filter((id) => {
    const dependency = byId.get(id);
    return dependency !== undefined && dependency.status !== 'completed';
  });
}

export function makeTask(input: Partial<Task> & Pick<Task, 'id' | 'userId' | 'title'>): Task {
  const now = input.createdAt ?? 0;
  return {
    description: undefined,
    estimatedMinutes: 60,
    completedMinutes: 0,
    priority: 'normal',
    importance: 50,
    minimumBlockMinutes: DEFAULT_MINIMUM_BLOCK_MINUTES,
    allowSplitting: true,
    preferredWindows: [],
    preferredDays: [],
    focus: 'any',
    tags: [],
    dependsOn: [],
    status: 'todo',
    pinned: false,
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
    ...input,
  };
}
