import type { TaskId } from '../domain/ids.js';
import type { SchedulingWeights } from '../domain/preferences.js';
import type { Task } from '../domain/task.js';
import { PRIORITY_WEIGHT, remainingMinutes } from '../domain/task.js';
import type { Instant } from '../time/instant.js';
import { DAY_MS, toMinutes } from '../time/instant.js';
import { clamp01, formatMinutes, round } from '../time/format.js';
import type { ScoreComponent, TaskScore } from './types.js';

export interface ScoringContext {
  readonly now: Instant;
  /** Length of the planning horizon; deadline urgency is relative to it. */
  readonly horizonMs: number;
  readonly weights: SchedulingWeights;
  /**
   * Suitable capacity available to each task before its deadline, ignoring
   * competition from other tasks. Drives the `deadlineRisk` component.
   */
  readonly capacityByTask: ReadonlyMap<TaskId, number>;
}

const AGE_REFERENCE_MS = 30 * DAY_MS;

/**
 * Score a single task. The result is an explainable breakdown: no opaque
 * constant is applied outside of the configured weights.
 */
export function scoreTask(task: Task, ctx: ScoringContext): TaskScore {
  const remaining = remainingMinutes(task);
  const components: ScoreComponent[] = [];
  const w = ctx.weights;

  // --- deadline urgency -----------------------------------------------------
  if (task.deadline === undefined) {
    components.push({
      key: 'deadlineUrgency',
      weight: w.deadlineUrgency,
      raw: Number.POSITIVE_INFINITY,
      normalized: 0,
      contribution: 0,
      explanation: 'No deadline, so deadline urgency does not apply.',
    });
  } else {
    const msUntil = task.deadline - ctx.now;
    const normalized = msUntil <= 0 ? 1 : clamp01(1 - msUntil / Math.max(ctx.horizonMs, 1));
    components.push({
      key: 'deadlineUrgency',
      weight: w.deadlineUrgency,
      raw: round(toMinutes(msUntil)),
      normalized: round(normalized, 4),
      contribution: round(normalized * w.deadlineUrgency, 4),
      explanation:
        msUntil <= 0
          ? 'Deadline has already passed.'
          : `Deadline is in ${formatMinutes(toMinutes(msUntil))}, ${round(normalized * 100)}% of the way through the planning horizon.`,
    });
  }

  // --- declared priority ----------------------------------------------------
  const priorityValue = PRIORITY_WEIGHT[task.priority];
  components.push({
    key: 'priority',
    weight: w.priority,
    raw: priorityValue,
    normalized: priorityValue,
    contribution: round(priorityValue * w.priority, 4),
    explanation: `Priority is ${task.priority}.`,
  });

  // --- importance -----------------------------------------------------------
  const importance = clamp01(task.importance / 100);
  components.push({
    key: 'importance',
    weight: w.importance,
    raw: task.importance,
    normalized: importance,
    contribution: round(importance * w.importance, 4),
    explanation: `Importance is ${task.importance}/100.`,
  });

  // --- deadline risk (how tight the remaining capacity is) ------------------
  const capacity = ctx.capacityByTask.get(task.id);
  if (task.deadline === undefined || capacity === undefined) {
    components.push({
      key: 'deadlineRisk',
      weight: w.deadlineRisk,
      raw: 0,
      normalized: 0,
      contribution: 0,
      explanation: 'No deadline, so there is no capacity pressure.',
    });
  } else {
    const tightness = capacity <= 0 ? 1 : clamp01(remaining / capacity);
    components.push({
      key: 'deadlineRisk',
      weight: w.deadlineRisk,
      raw: round(capacity),
      normalized: round(tightness, 4),
      contribution: round(tightness * w.deadlineRisk, 4),
      explanation: `${formatMinutes(remaining)} of work left against ${formatMinutes(capacity)} of capacity before the deadline.`,
    });
  }

  // --- age ------------------------------------------------------------------
  const ageMs = Math.max(0, ctx.now - task.createdAt);
  const ageNormalized = clamp01(ageMs / AGE_REFERENCE_MS);
  components.push({
    key: 'ageBonus',
    weight: w.ageBonus,
    raw: round(ageMs / DAY_MS, 2),
    normalized: round(ageNormalized, 4),
    contribution: round(ageNormalized * w.ageBonus, 4),
    explanation: `Created ${round(ageMs / DAY_MS, 1)} days ago.`,
  });

  const total = round(
    components.reduce((sum, c) => sum + c.contribution, 0),
    4,
  );
  return { taskId: task.id, title: task.title, total, components };
}

/**
 * Rank tasks highest-score-first. Ties break on deadline, then priority, then
 * id, so the ordering is stable across runs.
 */
export function rankTasks(tasks: readonly Task[], ctx: ScoringContext): TaskScore[] {
  const scores = tasks.map((task) => scoreTask(task, ctx));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return scores.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    const ta = byId.get(a.taskId);
    const tb = byId.get(b.taskId);
    const da = ta?.deadline ?? Number.POSITIVE_INFINITY;
    const db = tb?.deadline ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const pa = ta ? PRIORITY_WEIGHT[ta.priority] : 0;
    const pb = tb ? PRIORITY_WEIGHT[tb.priority] : 0;
    if (pa !== pb) return pb - pa;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
}

/**
 * Order tasks so that dependencies always come before their dependents while
 * otherwise preserving the score ordering. Cycles are broken deterministically.
 */
export function orderByDependencies(
  ranked: readonly TaskScore[],
  tasks: readonly Task[],
): TaskScore[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const position = new Map(ranked.map((s, index) => [s.taskId, index]));
  const visited = new Set<TaskId>();
  const result: TaskScore[] = [];

  const visit = (score: TaskScore, stack: Set<TaskId>): void => {
    if (visited.has(score.taskId) || stack.has(score.taskId)) return;
    stack.add(score.taskId);
    const task = byId.get(score.taskId);
    for (const dependencyId of task?.dependsOn ?? []) {
      const index = position.get(dependencyId);
      const dependencyScore = index === undefined ? undefined : ranked[index];
      if (dependencyScore) visit(dependencyScore, stack);
    }
    stack.delete(score.taskId);
    if (!visited.has(score.taskId)) {
      visited.add(score.taskId);
      result.push(score);
    }
  };

  for (const score of ranked) visit(score, new Set());
  return result;
}
