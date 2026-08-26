import type {
  AutomationSettings,
  DailyWindow,
  EventClassification,
  EventClassificationRule,
  MovePolicy,
  PlacementStrategy,
  SchedulingPreferences,
  Weekday,
  WeeklySchedule,
} from '@calendar-agent/core';
import {
  WEEKDAYS,
  ValidationError,
  assertValidTimezone,
  parseTimeOfDay,
  timeOfDayMinutes,
} from '@calendar-agent/core';

/**
 * Validation for the scheduling policy coming from the settings panel.
 *
 * `PUT /preferences` writes straight into the object the scheduler reads on
 * every run, so an unchecked payload would persist values that break planning
 * later, far from the request that caused them. Everything is validated here
 * and anything unrecognised is dropped rather than merged.
 */

const AUTOMATION_MODES = ['read_only', 'suggest', 'autonomous'] as const;
const MOVE_POLICIES = ['never', 'ask', 'auto'] as const;
const PLACEMENT_STRATEGIES = ['earliest_fit', 'best_fit'] as const;
const CLASSIFICATIONS = ['MOVABLE', 'PROTECTED', 'FIXED', 'UNKNOWN'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface NumberBounds {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

function number(value: unknown, field: string, bounds: NumberBounds = {}): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ValidationError(`"${field}" must be a number.`);
  }
  if (bounds.integer && !Number.isInteger(parsed)) {
    throw new ValidationError(`"${field}" must be a whole number.`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new ValidationError(`"${field}" must be at least ${bounds.min}.`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new ValidationError(`"${field}" must be at most ${bounds.max}.`);
  }
  return parsed;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`"${field}" must be true or false.`);
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`"${field}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** Accepts `"09:00"` and `{ hour, minute }`, which is what `GET` returns. */
function timeOfDay(value: unknown, field: string): { hour: number; minute: number } {
  if (typeof value === 'string') {
    try {
      return parseTimeOfDay(value);
    } catch {
      throw new ValidationError(`"${field}" must look like "09:00".`);
    }
  }
  if (isRecord(value)) {
    const hour = number(value.hour, `${field}.hour`, { min: 0, max: 24, integer: true });
    const minute = number(value.minute, `${field}.minute`, { min: 0, max: 59, integer: true });
    if (hour === 24 && minute !== 0) throw new ValidationError(`"${field}" is not a valid time.`);
    return { hour, minute };
  }
  throw new ValidationError(`"${field}" must be a time of day.`);
}

function dailyWindow(value: unknown, field: string): DailyWindow {
  if (!isRecord(value)) throw new ValidationError(`"${field}" must be a window object.`);
  const start = timeOfDay(value.start, `${field}.start`);
  const end = timeOfDay(value.end, `${field}.end`);
  const label =
    typeof value.label === 'string' && value.label.trim() ? value.label.trim() : undefined;
  return { start, end, ...(label === undefined ? {} : { label }) };
}

/**
 * A task's preferred times of day. Unlike a `WeeklySchedule` this is one flat
 * list that applies to every day the task is allowed on, so a window that ran
 * backwards could never match and would be silently relaxed away - it is
 * rejected instead.
 */
export function dailyWindowList(value: unknown, field: string): DailyWindow[] {
  if (!Array.isArray(value)) throw new ValidationError(`"${field}" must be a list of windows.`);
  return value.map((window, index) => {
    const parsed = dailyWindow(window, `${field}[${index}]`);
    if (timeOfDayMinutes(parsed.end) <= timeOfDayMinutes(parsed.start)) {
      throw new ValidationError(`"${field}[${index}]" must end after it starts.`);
    }
    return parsed;
  });
}

export function weekdayList(value: unknown, field: string): Weekday[] {
  if (!Array.isArray(value)) throw new ValidationError(`"${field}" must be a list of weekdays.`);
  const days = value.map((day, index) => {
    if (typeof day !== 'string' || !(WEEKDAYS as readonly string[]).includes(day)) {
      throw new ValidationError(`"${field}[${index}]" must be a weekday such as "monday".`);
    }
    return day as Weekday;
  });
  return [...new Set(days)];
}

export function weeklySchedule(value: unknown, field: string): WeeklySchedule {
  if (!isRecord(value)) throw new ValidationError(`"${field}" must be an object keyed by weekday.`);
  const result: Partial<Record<Weekday, DailyWindow[]>> = {};
  for (const [key, windows] of Object.entries(value)) {
    if (!(WEEKDAYS as readonly string[]).includes(key)) {
      throw new ValidationError(`"${field}" has an unknown day "${key}".`);
    }
    if (windows === undefined || windows === null) continue;
    if (!Array.isArray(windows)) throw new ValidationError(`"${field}.${key}" must be a list.`);
    const parsed = windows.map((window, index) => dailyWindow(window, `${field}.${key}[${index}]`));
    if (parsed.length > 0) result[key as Weekday] = parsed;
  }
  return result as WeeklySchedule;
}

function classificationRule(value: unknown, field: string): EventClassificationRule {
  if (!isRecord(value)) throw new ValidationError(`"${field}" must be a rule object.`);
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) throw new ValidationError(`"${field}.id" is required.`);
  const classification = oneOf(
    value.classification,
    `${field}.classification`,
    CLASSIFICATIONS,
  ) as EventClassification;

  const pattern =
    typeof value.titlePattern === 'string' && value.titlePattern.trim()
      ? value.titlePattern.trim()
      : undefined;
  if (pattern !== undefined) {
    try {
      new RegExp(pattern);
    } catch {
      throw new ValidationError(`"${field}.titlePattern" is not a valid regular expression.`);
    }
  }
  const calendarId =
    typeof value.calendarId === 'string' && value.calendarId.trim()
      ? value.calendarId.trim()
      : undefined;

  return {
    id,
    classification,
    ...(pattern === undefined ? {} : { titlePattern: pattern }),
    ...(calendarId === undefined ? {} : { calendarId }),
    ...(typeof value.hasOtherAttendees === 'boolean'
      ? { hasOtherAttendees: value.hasOtherAttendees }
      : {}),
    ...(typeof value.isAllDay === 'boolean' ? { isAllDay: value.isAllDay } : {}),
    ...(typeof value.createdByAgent === 'boolean' ? { createdByAgent: value.createdByAgent } : {}),
  };
}

function automation(value: unknown, current: AutomationSettings): AutomationSettings {
  if (!isRecord(value)) throw new ValidationError('"automation" must be an object.');
  const policies = isRecord(value.movePolicy) ? value.movePolicy : {};
  const movePolicy = { ...current.movePolicy } as Record<EventClassification, MovePolicy>;
  for (const [key, policy] of Object.entries(policies)) {
    const classification = oneOf(key, 'automation.movePolicy', CLASSIFICATIONS);
    movePolicy[classification as EventClassification] = oneOf(
      policy,
      `automation.movePolicy.${key}`,
      MOVE_POLICIES,
    );
  }

  return {
    mode:
      value.mode === undefined
        ? current.mode
        : oneOf(value.mode, 'automation.mode', AUTOMATION_MODES),
    movePolicy,
    createBlocks:
      value.createBlocks === undefined
        ? current.createBlocks
        : oneOf(value.createBlocks, 'automation.createBlocks', MOVE_POLICIES),
    deleteBlocks:
      value.deleteBlocks === undefined
        ? current.deleteBlocks
        : oneOf(value.deleteBlocks, 'automation.deleteBlocks', MOVE_POLICIES),
    freezeWindowMinutes:
      value.freezeWindowMinutes === undefined
        ? current.freezeWindowMinutes
        : number(value.freezeWindowMinutes, 'automation.freezeWindowMinutes', {
            min: 0,
            max: 1440,
            integer: true,
          }),
    maxAutoMutations:
      value.maxAutoMutations === undefined
        ? current.maxAutoMutations
        : number(value.maxAutoMutations, 'automation.maxAutoMutations', {
            min: 0,
            max: 1000,
            integer: true,
          }),
  };
}

/**
 * Validate a partial update against the stored preferences. Only the fields the
 * settings panel owns are accepted; unknown keys are ignored.
 */
export function parsePreferencesPatch(
  raw: unknown,
  current: SchedulingPreferences,
): Partial<SchedulingPreferences> {
  if (!isRecord(raw)) throw new ValidationError('The request body must be an object.');
  const patch: Record<string, unknown> = {};

  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== 'string') throw new ValidationError('"timezone" must be a string.');
    try {
      assertValidTimezone(raw.timezone);
    } catch {
      throw new ValidationError(`"${raw.timezone}" is not a known IANA timezone.`);
    }
    patch.timezone = raw.timezone;
  }

  if (raw.workingHours !== undefined) {
    patch.workingHours = weeklySchedule(raw.workingHours, 'workingHours');
  }
  if (raw.sleepHours !== undefined) patch.sleepHours = weeklySchedule(raw.sleepHours, 'sleepHours');
  if (raw.recurringBlocks !== undefined) {
    patch.recurringBlocks = weeklySchedule(raw.recurringBlocks, 'recurringBlocks');
  }

  if (raw.deepWork !== undefined) {
    if (!isRecord(raw.deepWork)) throw new ValidationError('"deepWork" must be an object.');
    patch.deepWork = {
      enabled:
        raw.deepWork.enabled === undefined
          ? current.deepWork.enabled
          : boolean(raw.deepWork.enabled, 'deepWork.enabled'),
      schedule:
        raw.deepWork.schedule === undefined
          ? current.deepWork.schedule
          : weeklySchedule(raw.deepWork.schedule, 'deepWork.schedule'),
      allowMeetings:
        raw.deepWork.allowMeetings === undefined
          ? current.deepWork.allowMeetings
          : boolean(raw.deepWork.allowMeetings, 'deepWork.allowMeetings'),
      reserveForFocusTasks:
        raw.deepWork.reserveForFocusTasks === undefined
          ? current.deepWork.reserveForFocusTasks
          : boolean(raw.deepWork.reserveForFocusTasks, 'deepWork.reserveForFocusTasks'),
    };
  }

  if (raw.minimumBlockMinutes !== undefined) {
    patch.minimumBlockMinutes = number(raw.minimumBlockMinutes, 'minimumBlockMinutes', {
      min: 5,
      max: 24 * 60,
      integer: true,
    });
  }
  if (raw.maximumBlockMinutes !== undefined) {
    patch.maximumBlockMinutes = number(raw.maximumBlockMinutes, 'maximumBlockMinutes', {
      min: 5,
      max: 24 * 60,
      integer: true,
    });
  }
  if (raw.allowTaskSplitting !== undefined) {
    patch.allowTaskSplitting = boolean(raw.allowTaskSplitting, 'allowTaskSplitting');
  }
  if (raw.bufferBetweenBlocksMinutes !== undefined) {
    patch.bufferBetweenBlocksMinutes = number(
      raw.bufferBetweenBlocksMinutes,
      'bufferBetweenBlocksMinutes',
      { min: 0, max: 240, integer: true },
    );
  }
  if (raw.maxDailyTaskMinutes !== undefined) {
    patch.maxDailyTaskMinutes =
      raw.maxDailyTaskMinutes === null || raw.maxDailyTaskMinutes === ''
        ? undefined
        : number(raw.maxDailyTaskMinutes, 'maxDailyTaskMinutes', {
            min: 15,
            max: 24 * 60,
            integer: true,
          });
  }
  if (raw.protectExistingEvents !== undefined) {
    patch.protectExistingEvents = boolean(raw.protectExistingEvents, 'protectExistingEvents');
  }
  if (raw.allDayEventsBlockTime !== undefined) {
    patch.allDayEventsBlockTime = boolean(raw.allDayEventsBlockTime, 'allDayEventsBlockTime');
  }
  if (raw.granularityMinutes !== undefined) {
    patch.granularityMinutes = number(raw.granularityMinutes, 'granularityMinutes', {
      min: 1,
      max: 120,
      integer: true,
    });
  }
  if (raw.planningHorizonDays !== undefined) {
    patch.planningHorizonDays = number(raw.planningHorizonDays, 'planningHorizonDays', {
      min: 1,
      max: 365,
      integer: true,
    });
  }
  if (raw.placementStrategy !== undefined) {
    patch.placementStrategy = oneOf(
      raw.placementStrategy,
      'placementStrategy',
      PLACEMENT_STRATEGIES,
    ) as PlacementStrategy;
  }

  if (raw.automation !== undefined)
    patch.automation = automation(raw.automation, current.automation);

  if (raw.classificationRules !== undefined) {
    if (!Array.isArray(raw.classificationRules)) {
      throw new ValidationError('"classificationRules" must be a list.');
    }
    const rules = raw.classificationRules.map((rule, index) =>
      classificationRule(rule, `classificationRules[${index}]`),
    );
    const ids = new Set<string>();
    for (const rule of rules) {
      if (ids.has(rule.id)) {
        throw new ValidationError(`Two classification rules share the id "${rule.id}".`);
      }
      ids.add(rule.id);
    }
    patch.classificationRules = rules;
  }

  const merged = { ...current, ...patch } as SchedulingPreferences;
  if (merged.minimumBlockMinutes > merged.maximumBlockMinutes) {
    throw new ValidationError(
      'The minimum block length cannot be longer than the maximum block length.',
    );
  }
  return patch as Partial<SchedulingPreferences>;
}
