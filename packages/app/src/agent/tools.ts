import { z } from 'zod';
import type { AgentTool } from '@calendar-agent/agent';
import type { Interval, UserId } from '@calendar-agent/core';
import { days, instantFromISO, instantToISO } from '@calendar-agent/core';
import type { AppContext } from '../context.js';

/**
 * What the agent can actually do.
 *
 * Every tool is a thin call onto a service that already exists, so each one
 * keeps whatever gate that service has: a change set stays pending, a
 * read-only calendar still refuses, an outreach is still only a draft. The
 * model chooses *which* to run and in what order; it never gets a shortcut
 * past a rule.
 *
 * Two operations are deliberately absent. Sending an outreach is one press in
 * the outbox, because that is where the person gets chosen. Applying a change
 * set is an approval, and an approval the agent can grant itself is not one.
 */
export function buildAgentTools(app: AppContext, userId: UserId): AgentTool<never>[] {
  const iso = { type: 'string', description: 'ISO-8601 timestamp' };
  const now = (): number => app.clock.now();
  const window = (start?: string, end?: string): Interval => ({
    start: start ? instantFromISO(start) : now(),
    end: end ? instantFromISO(end) : now() + days(7),
  });

  const tools: AgentTool<never>[] = [
    tool({
      name: 'get_preferences',
      description:
        'The scheduling rules in force: timezone, working hours, sleep, the buffer kept around meetings, and the automation mode. Read this before explaining why something did or did not fit - the buffer in particular is invisible on a calendar and is often the reason.',
      schema: { type: 'object', properties: {} },
      input: z.object({}),
      run: async () => {
        const preferences = await app.preferences.get(userId);
        return {
          timezone: preferences.timezone,
          workingHours: preferences.workingHours,
          sleepHours: preferences.sleepHours,
          bufferBetweenBlocksMinutes: preferences.bufferBetweenBlocksMinutes,
          automationMode: preferences.automation.mode,
          planningHorizonDays: preferences.planningHorizonDays,
        };
      },
    }),

    tool({
      name: 'list_events',
      description: 'Calendar events in a window. Defaults to the next seven days.',
      schema: { type: 'object', properties: { start: iso, end: iso } },
      input: z.object({ start: z.string().optional(), end: z.string().optional() }),
      run: async ({ start, end }) => {
        const events = await app.calendars.listEvents(userId, window(start, end));
        // A deferred deletion has not happened yet, so the event is still here.
        // Without saying so, a follow-up "undo that" looks like nothing to undo.
        const deleting = new Map(
          app.deletions.pending(userId).map((item) => [item.eventId, item.token]),
        );
        return events.map((event) => ({
          id: event.id,
          title: event.title,
          start: instantToISO(event.start),
          end: instantToISO(event.end),
          isAllDay: event.isAllDay,
          classification: event.classification,
          guests: event.attendees.length,
          ...(deleting.has(event.id)
            ? {
                deletionPending: true,
                undoToken: deleting.get(event.id),
                note: 'Being deleted shortly. Still listed because it has not happened yet; undo_delete stops it.',
              }
            : {}),
        }));
      },
    }),

    tool({
      name: 'list_tasks',
      description: 'Open tasks, with their estimates and deadlines.',
      schema: {
        type: 'object',
        properties: { includeCompleted: { type: 'boolean' } },
      },
      input: z.object({ includeCompleted: z.boolean().optional() }),
      run: async ({ includeCompleted }) => {
        const tasks = await app.tasks.list(userId, { includeCompleted: includeCompleted ?? false });
        return tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          estimatedMinutes: task.estimatedMinutes,
          remainingMinutes: app.tasks.remaining(task),
          deadline: task.deadline ? instantToISO(task.deadline) : undefined,
          priority: task.priority,
        }));
      },
    }),

    tool({
      name: 'find_free_time',
      description:
        'Free windows of at least the given length. Use basis "waking_hours" for anything that is not work - evenings and weekends are outside working hours and would otherwise look fully booked.',
      schema: {
        type: 'object',
        properties: {
          durationMinutes: { type: 'integer', minimum: 1 },
          start: iso,
          end: iso,
          basis: { type: 'string', enum: ['working_hours', 'waking_hours'] },
        },
        required: ['durationMinutes'],
      },
      input: z.object({
        durationMinutes: z.number().int().positive(),
        start: z.string().optional(),
        end: z.string().optional(),
        basis: z.enum(['working_hours', 'waking_hours']).optional(),
      }),
      run: async ({ durationMinutes, start, end, basis }) => {
        const slots = await app.scheduling.findSlots({
          userId,
          durationMinutes,
          range: window(start, end),
          limit: 40,
          ...(basis === undefined ? {} : { basis }),
        });
        return slots.map((slot) => ({
          start: instantToISO(slot.start),
          end: instantToISO(slot.end),
          minutes: Math.round((slot.end - slot.start) / 60_000),
        }));
      },
    }),

    tool({
      name: 'list_risks',
      description: 'Tasks whose deadlines are at risk, with the reason.',
      schema: { type: 'object', properties: {} },
      input: z.object({}),
      run: async () => {
        const risks = await app.scheduling.risks(userId);
        return risks
          .filter((risk) => risk.level !== 'SAFE')
          .map((risk) => ({ taskId: risk.taskId, level: risk.level, reason: risk.explanation }));
      },
    }),

    tool({
      name: 'create_task',
      description: 'Add a task. Scheduling it is a separate step.',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          estimatedMinutes: { type: 'integer', minimum: 1 },
          deadline: iso,
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        },
        required: ['title', 'estimatedMinutes'],
      },
      input: z.object({
        title: z.string().min(1),
        estimatedMinutes: z.number().int().positive(),
        deadline: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      }),
      run: async ({ title, estimatedMinutes, deadline, priority }) => {
        const task = await app.tasks.create({
          userId,
          title,
          estimatedMinutes,
          ...(deadline === undefined ? {} : { deadline: instantFromISO(deadline) }),
          ...(priority === undefined ? {} : { priority }),
        });
        return { id: task.id, title: task.title };
      },
    }),

    tool({
      name: 'complete_task',
      description: 'Mark a task done. Accepts an id or an exact title.',
      schema: {
        type: 'object',
        properties: { taskRef: { type: 'string' } },
        required: ['taskRef'],
      },
      input: z.object({ taskRef: z.string().min(1) }),
      run: async ({ taskRef }) => {
        const task = await app.tasks.resolve(userId, taskRef);
        const done = await app.tasks.complete(task.id);
        return { id: done.id, status: done.status };
      },
    }),

    tool({
      name: 'plan_schedule',
      description:
        'Find time for open tasks. Produces a proposal that waits for approval; it never writes to a calendar by itself.',
      schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1 } } },
      input: z.object({ days: z.number().int().positive().optional() }),
      run: async ({ days: horizon }) => {
        const result = await app.scheduling.plan({
          userId,
          ...(horizon === undefined ? {} : { range: { start: now(), end: now() + days(horizon) } }),
        });
        return {
          changeSetId: result.changeSetId,
          summary: result.changeSet.summary,
          added: result.changeSet.diff.added.length,
          moved: result.changeSet.diff.moved.length,
          removed: result.changeSet.diff.removed.length,
          pendingApproval: result.changeSet.pending.length,
          unscheduled: result.plan.unscheduled.length,
          note: 'Nothing is written until the user approves it.',
        };
      },
    }),

    tool({
      name: 'create_event',
      description: 'Put something on the calendar at a known time. Nobody is invited.',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, start: iso, end: iso },
        required: ['title', 'start', 'end'],
      },
      input: z.object({ title: z.string().min(1), start: z.string(), end: z.string() }),
      run: async ({ title, start, end }) => {
        const target = await app.calendars.taskTarget(userId);
        if (!target) throw new Error('There is no writable calendar.');
        const event = await app.calendars.createEvent({
          userId,
          calendarId: target.calendarId,
          title,
          start: instantFromISO(start),
          end: instantFromISO(end),
        });
        return { id: event.id, title: event.title };
      },
    }),

    tool({
      name: 'delete_event',
      description:
        'Remove an event from the calendar. It is not deleted straight away: for a few seconds the user is shown an Undo button, because deleting from a calendar cannot be reversed afterwards. Call list_events first to get the id. Say what you deleted and that they can undo it; you cannot undo it yourself, and must not claim to.',
      schema: {
        type: 'object',
        properties: { eventId: { type: 'string' } },
        required: ['eventId'],
      },
      input: z.object({ eventId: z.string().min(1) }),
      run: async ({ eventId }) => {
        const pending = await app.deletions.schedule(userId, eventId);
        return {
          undoToken: pending.token,
          title: pending.title,
          secondsToUndo: Math.max(0, Math.round((pending.deletesAt - now()) / 1000)),
          note: 'Nothing has been removed yet. It goes at the end of the window.',
        };
      },
    }),

    tool({
      name: 'search_contacts',
      description: 'Find someone in the address book by name. Returns their reachable handles.',
      schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      input: z.object({ query: z.string().min(1) }),
      run: async ({ query }) => {
        const found = await app.contactLinks.search(query, 10);
        return found.map((contact) => ({
          id: contact.id,
          name: contact.displayName,
          handles: contact.handles.map((handle) => handle.normalized),
        }));
      },
    }),

    tool({
      name: 'draft_outreach',
      description:
        'Draft a message offering someone times for something. It is only a draft - the user presses send. Returns "ambiguous" when more than one contact matches, and "no_time" with how close it got when nothing fits.',
      schema: {
        type: 'object',
        properties: {
          person: { type: 'string' },
          activity: { type: 'string', description: 'What is being arranged; never the name' },
          durationMinutes: { type: 'integer', minimum: 1 },
          rangeStart: iso,
          rangeEnd: iso,
        },
        required: ['person', 'activity'],
      },
      input: z.object({
        person: z.string().min(1),
        activity: z.string().min(1),
        durationMinutes: z.number().int().positive().optional(),
        rangeStart: z.string().optional(),
        rangeEnd: z.string().optional(),
      }),
      run: async ({ person, activity, durationMinutes, rangeStart, rangeEnd }) => {
        const outcome = await app.outreach.draft({
          userId,
          person,
          activity,
          ...(durationMinutes === undefined ? {} : { durationMinutes }),
          ...(rangeStart === undefined || rangeEnd === undefined
            ? {}
            : { range: { start: instantFromISO(rangeStart), end: instantFromISO(rangeEnd) } }),
        });
        if (outcome.kind === 'drafted') {
          return {
            kind: 'drafted',
            id: outcome.outreach.id,
            to: outcome.outreach.displayName,
            message: outcome.outreach.message,
          };
        }
        if (outcome.kind === 'ambiguous') {
          return { kind: 'ambiguous', candidates: outcome.candidates.map((c) => c.displayName) };
        }
        if (outcome.kind === 'no_time') {
          return {
            kind: 'no_time',
            longestFreeMinutes: outcome.longestFreeMinutes,
            neededMinutes: outcome.neededMinutes,
            bufferMinutes: outcome.bufferMinutes,
            nextAvailable: outcome.nextAvailable
              ? instantToISO(outcome.nextAvailable.start)
              : undefined,
          };
        }
        return outcome;
      },
    }),

    tool({
      name: 'confirm_meeting',
      description:
        'Text the person linked to an existing event to ask whether it still stands. Call list_events first to get the id. The event must already have somebody linked to it; nothing is booked or cancelled by this - it only asks. Produces a draft the user presses send on.',
      schema: {
        type: 'object',
        properties: { eventId: { type: 'string' } },
        required: ['eventId'],
      },
      input: z.object({ eventId: z.string().min(1) }),
      run: async ({ eventId }) => {
        const outcome = await app.outreach.confirmMeeting(userId, eventId);
        if (outcome.kind !== 'drafted') return outcome;
        return {
          kind: 'drafted',
          id: outcome.outreach.id,
          to: outcome.outreach.displayName,
          message: outcome.outreach.message,
        };
      },
    }),

    tool({
      name: 'list_event_people',
      description: 'Who is linked to an event, and whether they have said anything since it was made.',
      schema: {
        type: 'object',
        properties: { eventId: { type: 'string' } },
        required: ['eventId'],
      },
      input: z.object({ eventId: z.string().min(1) }),
      run: async ({ eventId }) => {
        const people = await app.contactLinks.peopleOnEvent(eventId);
        return people.map((person) => ({
          name: person.link.displayName,
          handle: person.link.handle,
          posture: person.posture,
        }));
      },
    }),

    tool({
      name: 'link_person_to_event',
      description:
        'Record that an event is with a particular person, so it can be confirmed and so the scheduler stops treating it as movable. Get the contact from search_contacts.',
      schema: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          contactId: { type: 'string' },
          displayName: { type: 'string' },
          handle: { type: 'string', description: 'The normalised handle from search_contacts' },
        },
        required: ['eventId', 'contactId', 'displayName', 'handle'],
      },
      input: z.object({
        eventId: z.string().min(1),
        contactId: z.string().min(1),
        displayName: z.string().min(1),
        handle: z.string().min(1),
      }),
      run: async ({ eventId, contactId, displayName, handle }) => {
        const link = await app.contactLinks.link({
          userId,
          eventId,
          contactId,
          displayName,
          handle,
        });
        return { id: link.id, linked: link.displayName };
      },
    }),

    tool({
      name: 'list_outreach',
      description: 'Messages the agent has drafted or sent, and where each conversation stands.',
      schema: { type: 'object', properties: {} },
      input: z.object({}),
      run: async () => {
        const items = await app.outreach.list(userId);
        return items.map((item) => ({
          id: item.id,
          to: item.displayName,
          activity: item.activity,
          state: item.state,
          note: item.note,
        }));
      },
    }),
  ];

  return tools;
}

/** Preserves each tool's own input type while the list stays uniform. */
function tool<T>(definition: AgentTool<T>): AgentTool<never> {
  return definition as unknown as AgentTool<never>;
}
