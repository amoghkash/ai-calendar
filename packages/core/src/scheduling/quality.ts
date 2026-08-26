import type { TaskId } from '../domain/ids.js';
import type { ScheduleBlock } from '../domain/schedule.js';
import { isLiveBlock } from '../domain/schedule.js';
import type { Task } from '../domain/task.js';
import { PRIORITY_WEIGHT, remainingMinutes } from '../domain/task.js';
import { clamp01, round } from '../time/format.js';
import { expandWindowOnDay, localDayKey, weekdayOf } from '../time/wall-clock.js';
import type {
  PlannedBlock,
  QualityMetric,
  ScheduleQuality,
  TaskScore,
  UnscheduledTask,
} from './types.js';

/** Relative importance of each quality metric in the overall score. */
export interface QualityWeights {
  readonly deadlineSatisfaction: number;
  readonly priorityAlignment: number;
  readonly stability: number;
  readonly deepWorkPreservation: number;
  readonly fragmentation: number;
  readonly contextSwitching: number;
  readonly preferenceSatisfaction: number;
}

export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  deadlineSatisfaction: 3,
  priorityAlignment: 1.5,
  stability: 1.5,
  deepWorkPreservation: 1,
  fragmentation: 1,
  contextSwitching: 0.75,
  preferenceSatisfaction: 1,
};

export interface QualityInput {
  readonly blocks: readonly PlannedBlock[];
  readonly tasks: readonly Task[];
  readonly previousBlocks: readonly ScheduleBlock[];
  readonly scores: readonly TaskScore[];
  readonly unscheduled: readonly UnscheduledTask[];
  readonly timezone: string;
  readonly weights?: QualityWeights;
}

/**
 * Measurable schedule quality. Every metric is 0..1 (higher is better) and
 * carries the sentence that explains its value, so two plans can be compared
 * and the difference described.
 */
export function evaluateQuality(input: QualityInput): ScheduleQuality {
  const weights = input.weights ?? DEFAULT_QUALITY_WEIGHTS;
  const metrics: QualityMetric[] = [
    deadlineSatisfaction(input, weights.deadlineSatisfaction),
    priorityAlignment(input, weights.priorityAlignment),
    stability(input, weights.stability),
    deepWorkPreservation(input, weights.deepWorkPreservation),
    fragmentation(input, weights.fragmentation),
    contextSwitching(input, weights.contextSwitching),
    preferenceSatisfaction(input, weights.preferenceSatisfaction),
  ];

  const weightSum = metrics.reduce((sum, m) => sum + m.weight, 0);
  const overall =
    weightSum === 0 ? 0 : metrics.reduce((sum, m) => sum + m.value * m.weight, 0) / weightSum;

  return { overall: round(overall, 4), metrics };
}

function minutesByTask(blocks: readonly PlannedBlock[]): Map<TaskId, number> {
  const result = new Map<TaskId, number>();
  for (const block of blocks) {
    result.set(block.taskId, (result.get(block.taskId) ?? 0) + block.minutes);
  }
  return result;
}

function deadlineSatisfaction(input: QualityInput, weight: number): QualityMetric {
  const scheduled = minutesByTask(input.blocks);
  const relevant = input.tasks.filter((t) => remainingMinutes(t) > 0);
  if (relevant.length === 0) {
    return metric('deadlineSatisfaction', 'Deadline satisfaction', 1, weight, 'No open work.');
  }
  let weighted = 0;
  let total = 0;
  let fullyCovered = 0;
  for (const task of relevant) {
    const remaining = remainingMinutes(task);
    const done = Math.min(remaining, scheduled.get(task.id) ?? 0);
    const w = PRIORITY_WEIGHT[task.priority];
    weighted += (done / remaining) * w;
    total += w;
    if (done >= remaining) fullyCovered += 1;
  }
  const value = total === 0 ? 1 : clamp01(weighted / total);
  return metric(
    'deadlineSatisfaction',
    'Deadline satisfaction',
    value,
    weight,
    `${fullyCovered} of ${relevant.length} open tasks are fully scheduled (priority-weighted coverage ${round(value * 100)}%).`,
  );
}

function priorityAlignment(input: QualityInput, weight: number): QualityMetric {
  const firstStart = new Map<TaskId, number>();
  for (const block of [...input.blocks].sort((a, b) => a.start - b.start)) {
    if (!firstStart.has(block.taskId)) firstStart.set(block.taskId, block.start);
  }
  const ranked = input.scores.filter((s) => firstStart.has(s.taskId));
  if (ranked.length < 2) {
    return metric(
      'priorityAlignment',
      'Priority alignment',
      1,
      weight,
      'Fewer than two scheduled tasks; ordering is trivially correct.',
    );
  }
  let concordant = 0;
  let pairs = 0;
  for (let i = 0; i < ranked.length; i += 1) {
    for (let j = i + 1; j < ranked.length; j += 1) {
      const a = ranked[i]!;
      const b = ranked[j]!;
      if (a.total === b.total) continue;
      pairs += 1;
      const higher = a.total > b.total ? a : b;
      const lower = a.total > b.total ? b : a;
      if ((firstStart.get(higher.taskId) ?? 0) <= (firstStart.get(lower.taskId) ?? 0)) {
        concordant += 1;
      }
    }
  }
  const value = pairs === 0 ? 1 : clamp01(concordant / pairs);
  return metric(
    'priorityAlignment',
    'Priority alignment',
    value,
    weight,
    `${concordant} of ${pairs} task pairs are scheduled in score order.`,
  );
}

function stability(input: QualityInput, weight: number): QualityMetric {
  const previous = input.previousBlocks.filter(isLiveBlock);
  if (previous.length === 0) {
    return metric('stability', 'Schedule stability', 1, weight, 'No previous schedule to disturb.');
  }
  const plannedById = new Map(input.blocks.map((b) => [b.id, b]));
  let untouched = 0;
  for (const block of previous) {
    const planned = plannedById.get(block.id);
    if (planned && planned.start === block.start && planned.end === block.end) untouched += 1;
  }
  const value = clamp01(untouched / previous.length);
  return metric(
    'stability',
    'Schedule stability',
    value,
    weight,
    `${untouched} of ${previous.length} existing blocks keep their original time.`,
  );
}

function deepWorkPreservation(input: QualityInput, weight: number): QualityMetric {
  const focusTasks = new Set(input.tasks.filter((t) => t.focus === 'deep').map((t) => t.id));
  const focusBlocks = input.blocks.filter((b) => focusTasks.has(b.taskId));
  if (focusBlocks.length === 0) {
    return metric(
      'deepWorkPreservation',
      'Deep work preservation',
      1,
      weight,
      'No focus-heavy tasks to place.',
    );
  }
  const focusMinutes = focusBlocks.reduce((sum, b) => sum + b.minutes, 0);
  const inDeepWindows = focusBlocks
    .filter((b) => b.deepWork)
    .reduce((sum, b) => sum + b.minutes, 0);
  const value = focusMinutes === 0 ? 1 : clamp01(inDeepWindows / focusMinutes);
  return metric(
    'deepWorkPreservation',
    'Deep work preservation',
    value,
    weight,
    `${round(value * 100)}% of focus work sits inside deep-work windows.`,
  );
}

function fragmentation(input: QualityInput, weight: number): QualityMetric {
  if (input.blocks.length === 0) {
    return metric('fragmentation', 'Low fragmentation', 1, weight, 'Nothing scheduled.');
  }
  const byTask = new Map<TaskId, number>();
  for (const block of input.blocks) byTask.set(block.taskId, (byTask.get(block.taskId) ?? 0) + 1);
  const taskCount = byTask.size;
  const blockCount = input.blocks.length;
  // 1 block per task is ideal; every extra block costs proportionally.
  const value = clamp01(taskCount / blockCount);
  return metric(
    'fragmentation',
    'Low fragmentation',
    value,
    weight,
    `${blockCount} blocks across ${taskCount} tasks (${round(blockCount / taskCount, 2)} blocks per task).`,
  );
}

function contextSwitching(input: QualityInput, weight: number): QualityMetric {
  if (input.blocks.length < 2) {
    return metric(
      'contextSwitching',
      'Few context switches',
      1,
      weight,
      'Fewer than two blocks scheduled.',
    );
  }
  const byDay = new Map<string, PlannedBlock[]>();
  for (const block of input.blocks) {
    const key = localDayKey(block.start, input.timezone);
    const list = byDay.get(key);
    if (list) list.push(block);
    else byDay.set(key, [block]);
  }
  let switches = 0;
  let transitions = 0;
  for (const blocks of byDay.values()) {
    const ordered = [...blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i += 1) {
      transitions += 1;
      if (ordered[i]!.taskId !== ordered[i - 1]!.taskId) switches += 1;
    }
  }
  const value = transitions === 0 ? 1 : clamp01(1 - switches / transitions);
  return metric(
    'contextSwitching',
    'Few context switches',
    value,
    weight,
    `${switches} task switches across ${transitions} same-day transitions.`,
  );
}

function preferenceSatisfaction(input: QualityInput, weight: number): QualityMetric {
  const tasksById = new Map(input.tasks.map((t) => [t.id, t]));
  let satisfied = 0;
  let total = 0;
  for (const block of input.blocks) {
    const task = tasksById.get(block.taskId);
    if (!task) continue;
    const hasPreference = task.preferredWindows.length > 0 || task.preferredDays.length > 0;
    total += block.minutes;
    if (!hasPreference) {
      satisfied += block.minutes;
      continue;
    }
    const dayKey = localDayKey(block.start, input.timezone);
    const weekday = weekdayOf(block.start, input.timezone);
    const dayOk = task.preferredDays.length === 0 || task.preferredDays.includes(weekday);
    const windowOk =
      task.preferredWindows.length === 0 ||
      task.preferredWindows.some((w) => {
        const expanded = expandWindowOnDay(dayKey, w, input.timezone);
        return expanded !== null && block.start >= expanded.start && block.end <= expanded.end;
      });
    if (dayOk && windowOk) satisfied += block.minutes;
  }
  const value = total === 0 ? 1 : clamp01(satisfied / total);
  return metric(
    'preferenceSatisfaction',
    'Preference satisfaction',
    value,
    weight,
    `${round(value * 100)}% of scheduled minutes fall inside the requested days and times.`,
  );
}

function metric(
  key: string,
  label: string,
  value: number,
  weight: number,
  explanation: string,
): QualityMetric {
  return { key, label, value: round(clamp01(value), 4), weight, explanation };
}

export interface QualityComparison {
  readonly better: 'a' | 'b' | 'equal';
  readonly overallDelta: number;
  readonly deltas: readonly {
    readonly key: string;
    readonly label: string;
    readonly delta: number;
    readonly explanation: string;
  }[];
  readonly summary: string;
}

/** Answer "why is this schedule better than the previous one?". */
export function compareQuality(a: ScheduleQuality, b: ScheduleQuality): QualityComparison {
  const byKey = new Map(b.metrics.map((m) => [m.key, m]));
  const deltas = a.metrics
    .map((metricA) => {
      const metricB = byKey.get(metricA.key);
      const delta = round(metricA.value - (metricB?.value ?? 0), 4);
      return {
        key: metricA.key,
        label: metricA.label,
        delta,
        explanation:
          delta === 0
            ? `${metricA.label} is unchanged (${round(metricA.value * 100)}%).`
            : `${metricA.label} ${delta > 0 ? 'improves' : 'regresses'} from ${round((metricB?.value ?? 0) * 100)}% to ${round(metricA.value * 100)}%.`,
      };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const overallDelta = round(a.overall - b.overall, 4);
  const better = overallDelta > 0 ? 'a' : overallDelta < 0 ? 'b' : 'equal';
  const leading = deltas.filter((d) => d.delta !== 0).slice(0, 3);
  const summary =
    overallDelta === 0
      ? 'Both schedules score the same overall.'
      : `Overall quality ${overallDelta > 0 ? 'improves' : 'regresses'} by ${round(Math.abs(overallDelta) * 100, 1)} points. ${leading.map((d) => d.explanation).join(' ')}`;

  return { better, overallDelta, deltas, summary };
}
