/**
 * JSON Schema handed to the model. It mirrors `commands/schema.ts`; the zod
 * schema remains the authority and re-validates whatever comes back.
 */

const isoDateTime = { type: 'string', description: 'ISO-8601 timestamp with offset or Z' };
const timeOfDay = { type: 'string', pattern: '^\\d{1,2}:\\d{2}$' };
const weekday = {
  type: 'string',
  enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
};

const taskProperties = {
  title: { type: 'string' },
  description: { type: 'string' },
  estimatedMinutes: { type: 'integer', minimum: 1 },
  deadline: isoDateTime,
  earliestStart: isoDateTime,
  priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
  importance: { type: 'integer', minimum: 0, maximum: 100 },
  minimumBlockMinutes: { type: 'integer', minimum: 1 },
  maximumBlockMinutes: { type: 'integer', minimum: 1 },
  maxDailyMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
  allowSplitting: { type: 'boolean' },
  focus: { type: 'string', enum: ['deep', 'shallow', 'any'] },
  tags: { type: 'array', items: { type: 'string' } },
  preferredDays: { type: 'array', items: weekday },
  preferredWindows: {
    type: 'array',
    items: {
      type: 'object',
      properties: { start: timeOfDay, end: timeOfDay },
      required: ['start', 'end'],
    },
  },
};

export const AGENT_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    intent: { type: 'string', description: 'One sentence restating the request.' },
    commands: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'create_task',
              'create_event',
              'update_event',
              'update_task',
              'complete_task',
              'delete_task',
              'schedule',
              'reschedule',
              'block_time',
              'unblock_time',
              'find_time',
              'explain_schedule',
              'list_risks',
              'list_schedule',
              'list_tasks',
              'schedule_with_person',
              'request_clarification',
            ],
          },
          ...taskProperties,
          taskRef: { type: 'string', description: 'Task id or exact title' },
          eventRef: { type: 'string', description: 'Event id or exact title' },
          // Shared by update_task and update_event; zod picks the right shape.
          changes: {
            type: 'object',
            properties: {
              ...taskProperties,
              start: isoDateTime,
              end: isoDateTime,
              location: { type: 'string' },
            },
          },
          completedMinutes: { type: 'integer', minimum: 0 },
          taskRefs: { type: 'array', items: { type: 'string' } },
          rangeStart: isoDateTime,
          rangeEnd: isoDateTime,
          rebuild: { type: 'boolean' },
          mustEndBy: isoDateTime,
          reason: { type: 'string' },
          start: isoDateTime,
          end: isoDateTime,
          purpose: { type: 'string' },
          location: { type: 'string' },
          durationMinutes: { type: 'integer', minimum: 1 },
          preferredWindow: {
            type: 'object',
            properties: { start: timeOfDay, end: timeOfDay },
            required: ['start', 'end'],
          },
          question: { type: 'string' },
          person: { type: 'string', description: 'A person to arrange something with, by name' },
          activity: {
            type: 'string',
            description: 'What is being arranged, e.g. "lunch this week"',
          },
          withinDays: { type: 'integer', minimum: 1 },
          tone: { type: 'string', enum: ['casual', 'warm', 'formal'] },
          calendarId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['todo', 'in_progress', 'blocked', 'completed', 'cancelled'],
          },
        },
        required: ['type'],
      },
    },
  },
  required: ['commands'],
};
