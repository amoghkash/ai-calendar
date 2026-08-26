import type { Instant } from '../time/instant.js';
import type { NamedInterval } from '../time/interval.js';
import type { DailyWindow, WeeklySchedule } from '../time/wall-clock.js';
import { dailyWindow, weeklySchedule } from '../time/wall-clock.js';
import type { EventClassification } from './calendar.js';
import type { UserId } from './ids.js';

/**
 * Relative weights used when ranking tasks and evaluating placements.
 * Every number is a multiplier on a 0..1 normalised component, so the whole
 * score stays explainable: `contribution = weight * normalisedValue`.
 */
export interface SchedulingWeights {
  /** How close the deadline is, relative to the planning horizon. */
  readonly deadlineUrgency: number;
  /** Declared task priority. */
  readonly priority: number;
  /** Long-term importance, independent of deadlines. */
  readonly importance: number;
  /** How tight remaining work is against remaining capacity. */
  readonly deadlineRisk: number;
  /** Bonus for tasks that have been waiting a long time. */
  readonly ageBonus: number;
  /** Penalty applied when a placement splits work into more, smaller blocks. */
  readonly fragmentationPenalty: number;
  /** Penalty applied when a placement interleaves many tasks in one day. */
  readonly contextSwitchPenalty: number;
  /** Preference for scheduling sooner rather than later. */
  readonly earlyStartPreference: number;
  /** Bonus for keeping already-scheduled blocks where they are. */
  readonly stabilityBonus: number;
  /** Bonus for placing focus work inside deep-work windows. */
  readonly deepWorkAffinity: number;
}

export const DEFAULT_WEIGHTS: SchedulingWeights = {
  deadlineUrgency: 3,
  priority: 2,
  importance: 1,
  deadlineRisk: 2.5,
  ageBonus: 0.5,
  fragmentationPenalty: 1,
  contextSwitchPenalty: 0.5,
  earlyStartPreference: 0.75,
  stabilityBonus: 2,
  deepWorkAffinity: 1,
};

/**
 * Thresholds for the deterministic deadline-risk classifier, expressed as
 * capacity-to-work ratios (available suitable minutes / remaining minutes).
 */
export interface RiskThresholds {
  /** Below this ratio a fully-scheduled task is still CRITICAL. */
  readonly criticalRatio: number;
  /** Below this ratio a task is AT_RISK. */
  readonly atRiskRatio: number;
  /** A task finishing within this many minutes of its deadline is AT_RISK. */
  readonly deadlineBufferMinutes: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  criticalRatio: 1.15,
  atRiskRatio: 1.5,
  deadlineBufferMinutes: 120,
};

export type AutomationMode = 'read_only' | 'suggest' | 'autonomous';

/** What the agent may do with a given class of event. */
export type MovePolicy = 'never' | 'ask' | 'auto';

export interface AutomationSettings {
  readonly mode: AutomationMode;
  /** Per-classification policy for moving existing calendar events. */
  readonly movePolicy: Readonly<Record<EventClassification, MovePolicy>>;
  /** Policy for creating new task blocks on the calendar. */
  readonly createBlocks: MovePolicy;
  /** Policy for deleting task blocks the scheduler no longer wants. */
  readonly deleteBlocks: MovePolicy;
  /** Never touch an event that starts within this many minutes from now. */
  readonly freezeWindowMinutes: number;
  /** Refuse to auto-apply a change set larger than this. */
  readonly maxAutoMutations: number;
}

export const DEFAULT_AUTOMATION: AutomationSettings = {
  // Simulation-first: the system proposes, the user approves.
  mode: 'suggest',
  movePolicy: { MOVABLE: 'auto', PROTECTED: 'never', FIXED: 'never', UNKNOWN: 'ask' },
  createBlocks: 'auto',
  deleteBlocks: 'auto',
  freezeWindowMinutes: 60,
  maxAutoMutations: 25,
};

/** How aggressively the scheduler is allowed to churn an existing schedule. */
export interface StabilitySettings {
  /** Keep an existing block unless moving it improves the score by this much. */
  readonly minimumImprovement: number;
  /** Never move blocks that start within this many minutes from now. */
  readonly freezeWindowMinutes: number;
  /** Upper bound on how many existing blocks a single run may move. */
  readonly maxMovesPerRun: number;
}

export const DEFAULT_STABILITY: StabilitySettings = {
  minimumImprovement: 0.05,
  freezeWindowMinutes: 120,
  maxMovesPerRun: 20,
};

export interface DeepWorkSettings {
  readonly enabled: boolean;
  readonly schedule: WeeklySchedule;
  /** Whether meetings may be booked inside deep-work windows. */
  readonly allowMeetings: boolean;
  /** Reserve deep-work windows for tasks whose focus level is `deep`. */
  readonly reserveForFocusTasks: boolean;
}

/**
 * A rule that assigns a classification to matching events. Rules are evaluated
 * in order; the first match wins. Anything unmatched falls back to heuristics.
 */
export interface EventClassificationRule {
  readonly id: string;
  readonly classification: EventClassification;
  readonly titlePattern?: string;
  readonly calendarId?: string;
  readonly hasOtherAttendees?: boolean;
  readonly isAllDay?: boolean;
  readonly createdByAgent?: boolean;
}

export type PlacementStrategy = 'earliest_fit' | 'best_fit';

/** The complete, user-configurable scheduling policy. */
export interface SchedulingPreferences {
  readonly userId: UserId;
  readonly timezone: string;

  readonly workingHours: WeeklySchedule;
  /** Time that is never available, e.g. sleep. Subtracted from working hours. */
  readonly sleepHours: WeeklySchedule;
  /** Recurring unavailable periods (lunch, gym, commute...). */
  readonly recurringBlocks: WeeklySchedule;
  /** One-off unavailable periods. */
  readonly blockedPeriods: readonly NamedInterval[];

  readonly deepWork: DeepWorkSettings;

  readonly minimumBlockMinutes: number;
  readonly maximumBlockMinutes: number;
  readonly allowTaskSplitting: boolean;
  /** Gap inserted between two consecutive task blocks. */
  readonly bufferBetweenBlocksMinutes: number;
  /** Upper bound on scheduled task time per local day. */
  readonly maxDailyTaskMinutes?: number;
  /** Whether existing calendar events remove time from availability. */
  readonly protectExistingEvents: boolean;
  /** Whether all-day events consume the whole day. */
  readonly allDayEventsBlockTime: boolean;
  /** Snap block boundaries to this granularity. */
  readonly granularityMinutes: number;
  readonly planningHorizonDays: number;
  readonly placementStrategy: PlacementStrategy;

  readonly weights: SchedulingWeights;
  readonly riskThresholds: RiskThresholds;
  readonly automation: AutomationSettings;
  readonly stability: StabilitySettings;
  readonly classificationRules: readonly EventClassificationRule[];

  readonly updatedAt: Instant;
}

const WORKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;

export const DEFAULT_WORKING_HOURS: WeeklySchedule = weeklySchedule(WORKDAYS, [
  dailyWindow('09:00', '17:00', 'working hours'),
]);

export const DEFAULT_DEEP_WORK_SCHEDULE: WeeklySchedule = weeklySchedule(WORKDAYS, [
  dailyWindow('09:00', '12:00', 'deep work'),
]);

export function defaultPreferences(
  userId: UserId,
  timezone = 'UTC',
  updatedAt: Instant = 0,
): SchedulingPreferences {
  return {
    userId,
    timezone,
    workingHours: DEFAULT_WORKING_HOURS,
    sleepHours: {},
    recurringBlocks: {},
    blockedPeriods: [],
    deepWork: {
      enabled: true,
      schedule: DEFAULT_DEEP_WORK_SCHEDULE,
      allowMeetings: false,
      reserveForFocusTasks: false,
    },
    minimumBlockMinutes: 30,
    maximumBlockMinutes: 180,
    allowTaskSplitting: true,
    bufferBetweenBlocksMinutes: 0,
    protectExistingEvents: true,
    allDayEventsBlockTime: false,
    granularityMinutes: 15,
    planningHorizonDays: 14,
    placementStrategy: 'earliest_fit',
    weights: DEFAULT_WEIGHTS,
    riskThresholds: DEFAULT_RISK_THRESHOLDS,
    automation: DEFAULT_AUTOMATION,
    stability: DEFAULT_STABILITY,
    classificationRules: [],
    updatedAt,
  };
}

export type { DailyWindow, WeeklySchedule };
