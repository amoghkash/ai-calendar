import type { RiskThresholds } from '../domain/preferences.js';
import type { Task } from '../domain/task.js';
import { remainingMinutes } from '../domain/task.js';
import type { Instant } from '../time/instant.js';
import { toMinutes } from '../time/instant.js';
import { formatMinutes, round } from '../time/format.js';
import { describeInstant } from '../time/wall-clock.js';
import type { RiskLevel, TaskRisk } from './types.js';
import { reason } from './types.js';

export interface RiskAssessmentInput {
  readonly task: Task;
  readonly now: Instant;
  readonly timezone: string;
  /** Minutes the plan managed to schedule for this task. */
  readonly scheduledMinutes: number;
  /** Suitable capacity before the deadline, ignoring competing tasks. */
  readonly availableMinutesBeforeDeadline: number;
  readonly lastBlockEnd?: Instant;
  readonly thresholds: RiskThresholds;
}

/**
 * Deterministic deadline-risk classification. No LLM, no randomness: the same
 * inputs always yield the same level and the same explanation.
 */
export function assessRisk(input: RiskAssessmentInput): TaskRisk {
  const { task, now, thresholds, scheduledMinutes, availableMinutesBeforeDeadline } = input;
  const remaining = remainingMinutes(task);
  const unscheduled = Math.max(0, remaining - scheduledMinutes);
  const capacityRatio =
    task.deadline === undefined
      ? null
      : remaining <= 0
        ? Number.POSITIVE_INFINITY
        : round(availableMinutesBeforeDeadline / remaining, 3);

  const base = {
    taskId: task.id,
    title: task.title,
    remainingMinutes: remaining,
    scheduledMinutes,
    unscheduledMinutes: unscheduled,
    availableMinutesBeforeDeadline: round(availableMinutesBeforeDeadline),
    capacityRatio,
    ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
    ...(input.lastBlockEnd === undefined ? {} : { lastBlockEnd: input.lastBlockEnd }),
  };

  const finish = (level: RiskLevel, code: string, explanation: string): TaskRisk => ({
    ...base,
    level,
    explanation,
    reason: reason(code, explanation, {
      remainingMinutes: remaining,
      scheduledMinutes,
      availableMinutesBeforeDeadline: round(availableMinutesBeforeDeadline),
      capacityRatio,
      deadline: task.deadline ?? null,
    }),
  });

  if (remaining <= 0) {
    return finish('SAFE', 'risk.no_work_remaining', `"${task.title}" has no remaining work.`);
  }

  if (task.deadline === undefined) {
    if (unscheduled > 0) {
      return finish(
        'AT_RISK',
        'risk.unscheduled_no_deadline',
        `"${task.title}" has ${formatMinutes(unscheduled)} of unscheduled work and no deadline to plan against.`,
      );
    }
    return finish(
      'SAFE',
      'risk.scheduled_no_deadline',
      `"${task.title}" is fully scheduled (${formatMinutes(scheduledMinutes)}) and has no deadline.`,
    );
  }

  const deadlineLabel = describeInstant(task.deadline, input.timezone);

  if (task.deadline <= now) {
    return finish(
      'IMPOSSIBLE',
      'risk.overdue',
      `"${task.title}" is overdue: the deadline was ${deadlineLabel} and ${formatMinutes(remaining)} of work is still outstanding.`,
    );
  }

  if (availableMinutesBeforeDeadline < remaining) {
    return finish(
      'IMPOSSIBLE',
      'risk.insufficient_capacity',
      `"${task.title}" cannot be completed: ${formatMinutes(remaining)} of work remains but only ${formatMinutes(availableMinutesBeforeDeadline)} of suitable availability exists before ${deadlineLabel}.`,
    );
  }

  if (unscheduled > 0) {
    return finish(
      'CRITICAL',
      'risk.contended_capacity',
      `"${task.title}" is at critical risk: ${formatMinutes(unscheduled)} of work could not be scheduled before ${deadlineLabel} because higher-priority work is using the available time.`,
    );
  }

  const ratio = availableMinutesBeforeDeadline / remaining;
  if (ratio < thresholds.criticalRatio) {
    return finish(
      'CRITICAL',
      'risk.tight_capacity',
      `"${task.title}" is at critical risk: ${formatMinutes(remaining)} of work against only ${formatMinutes(availableMinutesBeforeDeadline)} of availability before ${deadlineLabel} (${round(ratio, 2)}x cover).`,
    );
  }

  if (ratio < thresholds.atRiskRatio) {
    return finish(
      'AT_RISK',
      'risk.low_slack',
      `"${task.title}" is at risk: ${formatMinutes(remaining)} of work against ${formatMinutes(availableMinutesBeforeDeadline)} of availability before ${deadlineLabel} (${round(ratio, 2)}x cover) leaves little room for disruption.`,
    );
  }

  if (input.lastBlockEnd !== undefined) {
    const slackMinutes = toMinutes(task.deadline - input.lastBlockEnd);
    if (slackMinutes < thresholds.deadlineBufferMinutes) {
      return finish(
        'AT_RISK',
        'risk.finishes_near_deadline',
        `"${task.title}" is scheduled to finish only ${formatMinutes(slackMinutes)} before its ${deadlineLabel} deadline.`,
      );
    }
  }

  return finish(
    'SAFE',
    'risk.safe',
    `"${task.title}" is on track: ${formatMinutes(scheduledMinutes)} scheduled before ${deadlineLabel} with ${round(ratio, 2)}x capacity cover.`,
  );
}
