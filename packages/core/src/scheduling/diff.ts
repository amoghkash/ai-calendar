import type { BlockId, TaskId } from '../domain/ids.js';
import type { ScheduleBlock } from '../domain/schedule.js';
import { isLiveBlock } from '../domain/schedule.js';
import { durationMinutes } from '../time/interval.js';
import { describeInterval } from '../time/wall-clock.js';
import type { DiffEntry, PlannedBlock, ScheduleDiff } from './types.js';
import { reason } from './types.js';

export interface DiffInput {
  readonly previous: readonly ScheduleBlock[];
  readonly planned: readonly PlannedBlock[];
  readonly titles: ReadonlyMap<TaskId, string>;
  readonly timezone: string;
}

/**
 * Structured before/after comparison between the schedule that exists today
 * and the schedule the planner produced. Consumers (UI, CLI, approval flow)
 * render this; they never diff text.
 */
export function buildScheduleDiff(input: DiffInput): ScheduleDiff {
  const previousById = new Map<BlockId, ScheduleBlock>();
  for (const block of input.previous) {
    if (isLiveBlock(block)) previousById.set(block.id, block);
  }

  const added: DiffEntry[] = [];
  const moved: DiffEntry[] = [];
  const unchanged: DiffEntry[] = [];
  const seen = new Set<BlockId>();

  for (const block of input.planned) {
    const title = input.titles.get(block.taskId) ?? block.taskId;
    const before = previousById.get(block.id);
    if (before) seen.add(block.id);

    if (!before) {
      added.push({
        kind: 'added',
        blockId: block.id,
        taskId: block.taskId,
        taskTitle: title,
        after: { start: block.start, end: block.end },
        reason: block.reason,
      });
      continue;
    }

    if (before.start === block.start && before.end === block.end) {
      unchanged.push({
        kind: 'unchanged',
        blockId: block.id,
        taskId: block.taskId,
        taskTitle: title,
        before: { start: before.start, end: before.end },
        after: { start: block.start, end: block.end },
        reason: reason(
          'diff.unchanged',
          `"${title}" stays at ${describeInterval(block, input.timezone)}.`,
        ),
      });
      continue;
    }

    moved.push({
      kind: 'moved',
      blockId: block.id,
      taskId: block.taskId,
      taskTitle: title,
      before: { start: before.start, end: before.end },
      after: { start: block.start, end: block.end },
      reason: block.reason,
    });
  }

  const removed: DiffEntry[] = [];
  for (const [id, block] of previousById) {
    if (seen.has(id)) continue;
    const title = input.titles.get(block.taskId) ?? block.taskId;
    removed.push({
      kind: 'removed',
      blockId: id,
      taskId: block.taskId,
      taskTitle: title,
      before: { start: block.start, end: block.end },
      reason: reason(
        'diff.removed',
        `"${title}" block at ${describeInterval(block, input.timezone)} is no longer needed.`,
        { blockId: id },
      ),
    });
  }

  const netMinutesChanged =
    added.reduce((sum, e) => sum + (e.after ? durationMinutes(e.after) : 0), 0) -
    removed.reduce((sum, e) => sum + (e.before ? durationMinutes(e.before) : 0), 0);

  const byStart = (a: DiffEntry, b: DiffEntry): number =>
    (a.after?.start ?? a.before?.start ?? 0) - (b.after?.start ?? b.before?.start ?? 0);

  return {
    added: added.sort(byStart),
    moved: moved.sort(byStart),
    removed: removed.sort(byStart),
    unchanged: unchanged.sort(byStart),
    summary: {
      addedCount: added.length,
      movedCount: moved.length,
      removedCount: removed.length,
      unchangedCount: unchanged.length,
      netMinutesChanged: Math.round(netMinutesChanged),
    },
  };
}

export const diffIsEmpty = (diff: ScheduleDiff): boolean =>
  diff.added.length === 0 && diff.moved.length === 0 && diff.removed.length === 0;
