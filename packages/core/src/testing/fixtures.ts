import type { CalendarEvent } from '../domain/calendar.js';
import type { SchedulingPreferences } from '../domain/preferences.js';
import { defaultPreferences } from '../domain/preferences.js';
import type { ScheduleBlock } from '../domain/schedule.js';
import type { Task } from '../domain/task.js';
import { makeTask } from '../domain/task.js';
import { instantFromISO } from '../time/instant.js';

/** Test helpers shared by the core tests and the integration suite. */

export const at = (iso: string): number => instantFromISO(iso);

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}_${counter}`;
};

export function taskFixture(partial: Partial<Task> = {}): Task {
  return makeTask({
    id: partial.id ?? nextId('task'),
    userId: 'user',
    title: 'Task',
    ...partial,
  });
}

export function eventFixture(partial: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = partial.start ?? at('2026-03-09T10:00:00Z');
  return {
    id: partial.id ?? nextId('event'),
    userId: 'user',
    provider: 'mock',
    calendarId: 'cal-1',
    externalId: partial.externalId ?? nextId('ext'),
    title: 'Meeting',
    start,
    end: partial.end ?? start + 3_600_000,
    timezone: 'UTC',
    isAllDay: false,
    isRecurring: false,
    recurrenceKind: 'single',
    status: 'confirmed',
    transparency: 'opaque',
    attendees: [],
    isOrganizer: true,
    classification: 'FIXED',
    isMovable: false,
    isProtected: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

export function blockFixture(partial: Partial<ScheduleBlock> = {}): ScheduleBlock {
  const start = partial.start ?? at('2026-03-09T09:00:00Z');
  return {
    id: partial.id ?? nextId('block'),
    userId: 'user',
    taskId: partial.taskId ?? 'task_1',
    kind: 'task',
    start,
    end: partial.end ?? start + 3_600_000,
    timezone: 'UTC',
    sequence: 0,
    status: 'confirmed',
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

export function preferencesFixture(
  partial: Partial<SchedulingPreferences> = {},
): SchedulingPreferences {
  return { ...defaultPreferences('user', partial.timezone ?? 'UTC'), ...partial };
}
