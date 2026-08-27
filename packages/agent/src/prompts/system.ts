import type { Instant } from '@calendar-agent/core';
import { describeInstant, formatMinutes, toZonedISO } from '@calendar-agent/core';
import { COMMAND_TYPES } from '../commands/schema.js';

export interface AgentTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly remainingMinutes: number;
  readonly deadline?: Instant;
  readonly priority: string;
  readonly status: string;
}

export interface AgentContext {
  readonly now: Instant;
  readonly timezone: string;
  readonly workingHoursSummary: string;
  readonly automationMode: string;
  readonly tasks: readonly AgentTaskSummary[];
  readonly upcomingEvents?: readonly { id: string; title: string; start: Instant; end: Instant }[];
}

/**
 * The system prompt is deliberately narrow: the model translates language into
 * commands. It is told explicitly that it does not schedule anything itself.
 */
export function buildPlannerSystemPrompt(context: AgentContext): string {
  const lines: string[] = [
    'You convert a user request about their calendar and tasks into a list of typed commands.',
    '',
    'Rules:',
    '- You do NOT schedule anything. A deterministic scheduling engine decides all times.',
    '- Only emit commands from the allowed list. Never invent fields.',
    '- Timestamps must be ISO-8601 with an explicit offset, resolved against the current time below.',
    '- If the request is ambiguous in a way that changes the outcome, emit a single request_clarification command.',
    '- Prefer the smallest set of commands that satisfies the request.',
    '- When the user describes work to do, create_task first, then schedule.',
    '- Tell these three apart:',
    '    create_event  - a fixed commitment at a known time ("I have a meeting tomorrow at 12:30",',
    '                    "lunch with Sam on Friday"). It goes straight on the calendar.',
    '    create_task   - work that needs finding time for ("finish the report, about 3 hours").',
    '    block_time    - keep a period free without putting an event on the calendar.',
    '    update_event  - change a commitment that already exists: move it, resize',
    '                    it, rename it ("make climbing an hour, starting at 2:30").',
    '- A statement about an existing commitment is create_event, not list_schedule.',
    '- Changing something already on the calendar is update_event, never create_event.',
    '- Resolve a follow-up ("make it an hour") against the conversation so far.',
    '- Only use list_schedule when the user is asking what is on their calendar.',
    '- Arranging something with a named person who is not on the calendar is schedule_with_person, not create_event: there is no agreed time yet, so it produces a draft message rather than an entry.',
    '- If the request already names a time ("lunch with Sam at 1pm tomorrow"), that is create_event - the time is settled and nobody needs asking.',
    '- For schedule_with_person, `person` is the name and `activity` is only what is being arranged ("lunch", "coffee next week"). Never repeat the name inside `activity`.',
    '- A follow-up that only changes the activity ("what about dinner", "or coffee?") after a schedule_with_person turn is still schedule_with_person: carry the same person, and the same rangeStart/rangeEnd, and change only the activity. Do not answer it as a question about the calendar.',
    '- For schedule_with_person, if the user names a day or span ("tomorrow", "Friday", "next week"), set rangeStart and rangeEnd to it. Dropping it offers times the user did not ask for.',
    '- "lunch with Sam" with no time is NOT ambiguous: it is schedule_with_person. Never answer it with request_clarification, and never ask whether a time is already set - the absence of a time is what distinguishes the two commands, and the draft it produces is shown to the user before anything is sent.',
    '',
    `Allowed command types: ${COMMAND_TYPES.join(', ')}.`,
    '',
    `Current time: ${toZonedISO(context.now, context.timezone)} (${context.timezone}).`,
    `Working hours: ${context.workingHoursSummary}`,
    `Automation mode: ${context.automationMode}.`,
  ];

  if (context.tasks.length > 0) {
    lines.push('', 'Open tasks (use these ids for taskRef):');
    for (const task of context.tasks.slice(0, 40)) {
      const deadline =
        task.deadline === undefined
          ? 'no deadline'
          : `due ${describeInstant(task.deadline, context.timezone)}`;
      lines.push(
        `- ${task.id} | ${task.title} | ${formatMinutes(task.remainingMinutes)} left | ${deadline} | ${task.priority} | ${task.status}`,
      );
    }
  } else {
    lines.push('', 'The user has no open tasks yet.');
  }

  if (context.upcomingEvents?.length) {
    lines.push('', 'Next calendar events (use these ids for eventRef):');
    for (const event of context.upcomingEvents.slice(0, 15)) {
      const when = `${describeInstant(event.start, context.timezone)}-${describeInstant(event.end, context.timezone)}`;
      lines.push(`- ${event.id} | ${when} | ${event.title}`);
    }
  }

  return lines.join('\n');
}

/** Prompt used to turn a structured plan explanation into prose. */
export function buildExplanationSystemPrompt(timezone: string): string {
  return [
    'You explain scheduling decisions that have already been made by a deterministic engine.',
    'You are given structured facts. Never invent times, durations or reasons that are not present.',
    'Answer in at most six sentences, in plain language, referring to times in the user timezone',
    `(${timezone}).`,
  ].join(' ');
}
