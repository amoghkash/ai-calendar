import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  EventClassification,
} from '../domain/calendar.js';
import { METADATA_BLOCK_ID, METADATA_MANAGED, METADATA_TASK_ID } from '../domain/calendar.js';
import type { BlockId, TaskId } from '../domain/ids.js';
import type { AutomationSettings, MovePolicy } from '../domain/preferences.js';
import type { ScheduleBlock } from '../domain/schedule.js';
import type { Instant } from '../time/instant.js';
import { minutes as msFromMinutes } from '../time/instant.js';
import type { Interval } from '../time/interval.js';
import { describeInterval } from '../time/wall-clock.js';
import type { DecisionReason, ScheduleDiff, SchedulingPlan } from '../scheduling/types.js';
import { reason } from '../scheduling/types.js';

export type MutationKind = 'create_event' | 'update_event' | 'delete_event';

interface MutationBase {
  readonly id: string;
  readonly kind: MutationKind;
  readonly reason: DecisionReason;
  readonly taskId?: TaskId;
  readonly blockId?: BlockId;
  readonly calendarId: string;
  readonly calendarExternalId: string;
  readonly label: string;
}

export interface CreateEventMutation extends MutationBase {
  readonly kind: 'create_event';
  readonly input: CalendarEventInput;
  readonly after: Interval;
}

export interface UpdateEventMutation extends MutationBase {
  readonly kind: 'update_event';
  readonly externalId: string;
  readonly etag?: string;
  /** Only the fields that actually change; everything else is preserved. */
  readonly changes: CalendarEventUpdate;
  readonly before: Interval;
  readonly after: Interval;
}

export interface DeleteEventMutation extends MutationBase {
  readonly kind: 'delete_event';
  readonly externalId: string;
  readonly etag?: string;
  readonly before: Interval;
}

export type CalendarMutation = CreateEventMutation | UpdateEventMutation | DeleteEventMutation;

export interface BlockedMutation {
  readonly mutation: CalendarMutation;
  readonly policy: MovePolicy;
  readonly reason: DecisionReason;
}

export type ChangeSetStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';

/**
 * The unit of calendar modification. Nothing is written to a provider except
 * through a change set, which always records what will change and why.
 */
export interface ChangeSet {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Instant;
  readonly mode: AutomationSettings['mode'];
  /** Mutations the current automation mode allows to run without asking. */
  readonly autoApply: readonly CalendarMutation[];
  /** Mutations that need explicit user approval. */
  readonly pending: readonly CalendarMutation[];
  /** Mutations policy forbids entirely. */
  readonly blocked: readonly BlockedMutation[];
  readonly diff: ScheduleDiff;
  readonly summary: string;
  readonly planRunId: string;
}

export interface CalendarTarget {
  readonly calendarId: string;
  readonly calendarExternalId: string;
  readonly timezone: string;
}

export interface BuildChangeSetInput {
  readonly id: string;
  readonly userId: string;
  readonly now: Instant;
  readonly plan: SchedulingPlan;
  readonly previousBlocks: readonly ScheduleBlock[];
  readonly taskTitles: ReadonlyMap<TaskId, string>;
  /** Resolves the calendar a task's blocks should be written to. */
  readonly resolveTarget: (taskId: TaskId) => CalendarTarget | undefined;
  readonly automation: AutomationSettings;
  readonly timezone: string;
  /** Description added to created events. */
  readonly describeTask?: (taskId: TaskId) => string | undefined;
}

/**
 * Translate a scheduling plan into concrete calendar mutations, gated by the
 * automation mode and the per-classification move policy.
 */
export function buildChangeSet(input: BuildChangeSetInput): ChangeSet {
  const { plan, automation } = input;
  const blocksById = new Map(input.previousBlocks.map((b) => [b.id, b]));
  const mutations: CalendarMutation[] = [];
  const blocked: BlockedMutation[] = [];
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `${input.id}_m${counter}`;
  };

  const freezeUntil = input.now + msFromMinutes(automation.freezeWindowMinutes);

  for (const entry of plan.diff.added) {
    const target = input.resolveTarget(entry.taskId);
    const after = entry.after;
    if (!target || !after) continue;
    const description = input.describeTask?.(entry.taskId);
    const mutation: CreateEventMutation = {
      id: nextId(),
      kind: 'create_event',
      calendarId: target.calendarId,
      calendarExternalId: target.calendarExternalId,
      taskId: entry.taskId,
      blockId: entry.blockId,
      label: `+ ${describeInterval(after, input.timezone)}  ${entry.taskTitle}`,
      reason: entry.reason,
      after,
      input: {
        calendarExternalId: target.calendarExternalId,
        title: entry.taskTitle,
        ...(description === undefined ? {} : { description }),
        start: after.start,
        end: after.end,
        timezone: target.timezone,
        transparency: 'opaque',
        metadata: {
          [METADATA_MANAGED]: 'true',
          [METADATA_TASK_ID]: entry.taskId,
          [METADATA_BLOCK_ID]: entry.blockId,
        },
      },
    };
    push(mutation, automation.createBlocks);
  }

  for (const entry of plan.diff.moved) {
    const target = input.resolveTarget(entry.taskId);
    const block = blocksById.get(entry.blockId);
    const before = entry.before;
    const after = entry.after;
    if (!target || !before || !after) continue;
    if (!block?.externalEventId) {
      // Never synced: treat as a plain creation instead of an update.
      const description = input.describeTask?.(entry.taskId);
      push(
        {
          id: nextId(),
          kind: 'create_event',
          calendarId: target.calendarId,
          calendarExternalId: target.calendarExternalId,
          taskId: entry.taskId,
          blockId: entry.blockId,
          label: `+ ${describeInterval(after, input.timezone)}  ${entry.taskTitle}`,
          reason: entry.reason,
          after,
          input: {
            calendarExternalId: target.calendarExternalId,
            title: entry.taskTitle,
            ...(description === undefined ? {} : { description }),
            start: after.start,
            end: after.end,
            timezone: target.timezone,
            transparency: 'opaque',
            metadata: {
              [METADATA_MANAGED]: 'true',
              [METADATA_TASK_ID]: entry.taskId,
              [METADATA_BLOCK_ID]: entry.blockId,
            },
          },
        },
        automation.createBlocks,
      );
      continue;
    }
    const mutation: UpdateEventMutation = {
      id: nextId(),
      kind: 'update_event',
      calendarId: target.calendarId,
      calendarExternalId: target.calendarExternalId,
      taskId: entry.taskId,
      blockId: entry.blockId,
      externalId: block.externalEventId,
      label: `~ ${describeInterval(before, input.timezone)} -> ${describeInterval(after, input.timezone)}  ${entry.taskTitle}`,
      reason: entry.reason,
      before,
      after,
      // Only the timing changes: title, description, attendees, recurrence and
      // conferencing data are deliberately left untouched.
      changes: { start: after.start, end: after.end, timezone: target.timezone },
    };
    if (before.start < freezeUntil) {
      blocked.push({
        mutation,
        policy: 'never',
        reason: reason(
          'policy.freeze_window',
          `"${entry.taskTitle}" starts within the ${automation.freezeWindowMinutes} minute freeze window and will not be moved automatically.`,
        ),
      });
      continue;
    }
    push(mutation, automation.movePolicy.MOVABLE);
  }

  for (const entry of plan.diff.removed) {
    const block = blocksById.get(entry.blockId);
    const target = input.resolveTarget(entry.taskId);
    const before = entry.before;
    if (!block?.externalEventId || !target || !before) continue;
    push(
      {
        id: nextId(),
        kind: 'delete_event',
        calendarId: target.calendarId,
        calendarExternalId: target.calendarExternalId,
        taskId: entry.taskId,
        blockId: entry.blockId,
        externalId: block.externalEventId,
        ...(block.externalEventId === undefined ? {} : {}),
        label: `- ${describeInterval(before, input.timezone)}  ${entry.taskTitle}`,
        reason: entry.reason,
        before,
      },
      automation.deleteBlocks,
    );
  }

  function push(mutation: CalendarMutation, policy: MovePolicy): void {
    if (automation.mode === 'read_only') {
      blocked.push({
        mutation,
        policy: 'never',
        reason: reason(
          'policy.read_only',
          'The system is running in read-only mode, so no calendar changes are made.',
        ),
      });
      return;
    }
    if (policy === 'never') {
      blocked.push({
        mutation,
        policy,
        reason: reason(
          'policy.never',
          `Policy forbids this ${mutation.kind.replace('_', ' ')} operation.`,
        ),
      });
      return;
    }
    mutations.push(mutation);
  }

  const requiresApproval = (mutation: CalendarMutation): boolean => {
    if (automation.mode === 'suggest') return true;
    const policy =
      mutation.kind === 'create_event'
        ? automation.createBlocks
        : mutation.kind === 'delete_event'
          ? automation.deleteBlocks
          : automation.movePolicy.MOVABLE;
    return policy !== 'auto';
  };

  let autoApply = mutations.filter((m) => !requiresApproval(m));
  let pending = mutations.filter(requiresApproval);

  if (autoApply.length > automation.maxAutoMutations) {
    pending = [...pending, ...autoApply];
    autoApply = [];
  }

  return {
    id: input.id,
    userId: input.userId,
    createdAt: input.now,
    mode: automation.mode,
    autoApply,
    pending: pending.sort((a, b) => a.id.localeCompare(b.id)),
    blocked,
    diff: plan.diff,
    planRunId: plan.runId,
    summary: summarise(plan.diff, autoApply.length, pending.length, blocked.length),
  };
}

function summarise(
  diff: ScheduleDiff,
  autoCount: number,
  pendingCount: number,
  blockedCount: number,
): string {
  const plural = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (diff.summary.addedCount) parts.push(plural(diff.summary.addedCount, 'new block'));
  if (diff.summary.movedCount) parts.push(plural(diff.summary.movedCount, 'move'));
  if (diff.summary.removedCount) parts.push(plural(diff.summary.removedCount, 'removal'));
  if (parts.length === 0) return 'No calendar changes are required.';
  if (autoCount + pendingCount + blockedCount === 0) {
    // The plan changed, but no calendar can receive it: blocks stay local.
    return `${parts.join(', ')}: tracked locally (no writable calendar is connected).`;
  }
  return `${parts.join(', ')}: ${autoCount} to apply automatically, ${pendingCount} awaiting approval, ${blockedCount} blocked by policy.`;
}

export const changeSetIsEmpty = (changeSet: ChangeSet): boolean =>
  changeSet.autoApply.length === 0 &&
  changeSet.pending.length === 0 &&
  changeSet.blocked.length === 0;

export const allMutations = (changeSet: ChangeSet): CalendarMutation[] => [
  ...changeSet.autoApply,
  ...changeSet.pending,
];

/**
 * Decide whether an existing (non task-block) calendar event may be moved.
 * Used by agent commands such as "move my 3pm so I can leave early".
 */
export function evaluateEventMove(
  event: Pick<CalendarEvent, 'classification' | 'title' | 'isProtected'>,
  automation: AutomationSettings,
): { readonly policy: MovePolicy; readonly reason: DecisionReason } {
  if (automation.mode === 'read_only') {
    return {
      policy: 'never',
      reason: reason('policy.read_only', 'Read-only mode: calendar events are never modified.'),
    };
  }
  if (event.isProtected) {
    return {
      policy: 'never',
      reason: reason(
        'policy.protected_event',
        `"${event.title}" is protected and can only be moved by you.`,
      ),
    };
  }
  const policy = automation.movePolicy[event.classification as EventClassification] ?? 'ask';
  return {
    policy,
    reason: reason(
      `policy.${policy}`,
      policy === 'never'
        ? `Policy never moves ${event.classification} events such as "${event.title}".`
        : policy === 'ask'
          ? `Moving "${event.title}" (${event.classification}) needs your confirmation.`
          : `"${event.title}" is ${event.classification} and may be moved automatically.`,
    ),
  };
}
