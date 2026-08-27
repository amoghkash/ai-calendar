import { z } from 'zod';

/**
 * Typed agent commands.
 *
 * The LLM may only propose values that fit these schemas. Anything else is
 * rejected before it reaches an application service, so a hallucinated action
 * can never turn into a calendar mutation.
 */

const isoDateTime = z
  .string()
  .min(4)
  .describe('ISO-8601 timestamp, e.g. 2026-03-12T17:00:00Z or 2026-03-12T17:00:00+01:00');

const timeOfDay = z.string().regex(/^\d{1,2}:\d{2}$/);

const weekday = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

export const priority = z.enum(['low', 'normal', 'high', 'urgent']);
export const focusLevel = z.enum(['deep', 'shallow', 'any']);

const taskFields = {
  title: z.string().min(1),
  description: z.string().optional(),
  estimatedMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 30)
    .optional(),
  deadline: isoDateTime.optional(),
  earliestStart: isoDateTime.optional(),
  priority: priority.optional(),
  importance: z.number().int().min(0).max(100).optional(),
  minimumBlockMinutes: z.number().int().positive().optional(),
  maximumBlockMinutes: z.number().int().positive().optional(),
  allowSplitting: z.boolean().optional(),
  focus: focusLevel.optional(),
  tags: z.array(z.string()).optional(),
  preferredDays: z.array(weekday).optional(),
  preferredWindows: z.array(z.object({ start: timeOfDay, end: timeOfDay })).optional(),
};

export const createTaskCommand = z.object({
  type: z.literal('create_task'),
  ...taskFields,
  estimatedMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 30),
});

export const updateTaskCommand = z.object({
  type: z.literal('update_task'),
  /** Task id, or a title fragment the application resolves. */
  taskRef: z.string().min(1),
  changes: z.object({ ...taskFields, title: z.string().min(1).optional() }),
});

export const completeTaskCommand = z.object({
  type: z.literal('complete_task'),
  taskRef: z.string().min(1),
  completedMinutes: z.number().int().min(0).optional(),
});

export const deleteTaskCommand = z.object({
  type: z.literal('delete_task'),
  taskRef: z.string().min(1),
});

export const scheduleCommand = z.object({
  type: z.literal('schedule'),
  taskRefs: z.array(z.string()).optional(),
  rangeStart: isoDateTime.optional(),
  rangeEnd: isoDateTime.optional(),
  /** Discard the existing plan and rebuild from scratch. */
  rebuild: z.boolean().optional(),
});

export const rescheduleCommand = z.object({
  type: z.literal('reschedule'),
  rangeStart: isoDateTime,
  rangeEnd: isoDateTime,
  /** Everything in the range must finish by this instant. */
  mustEndBy: isoDateTime.optional(),
  reason: z.string().optional(),
});

/**
 * A real commitment on the calendar: a meeting, an appointment, lunch.
 * Distinct from `create_task` (work to be scheduled around your commitments)
 * and from `block_time` (keep a period free without creating an event).
 */
export const createEventCommand = z.object({
  type: z.literal('create_event'),
  title: z.string().min(1),
  start: isoDateTime,
  end: isoDateTime,
  location: z.string().optional(),
  description: z.string().optional(),
  /** Defaults to the calendar that receives task blocks. */
  calendarId: z.string().optional(),
});

/**
 * Change an existing commitment: move it, resize it, rename it, relocate it.
 * The application resolves `eventRef` and applies the automation move policy,
 * so an event the user may not move automatically is refused rather than
 * silently rewritten.
 */
export const updateEventCommand = z.object({
  type: z.literal('update_event'),
  /** Event id, or a title fragment the application resolves. */
  eventRef: z.string().min(1),
  changes: z
    .object({
      title: z.string().min(1).optional(),
      start: isoDateTime.optional(),
      end: isoDateTime.optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    })
    .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
      message: 'update_event needs at least one change.',
    }),
});

export const blockTimeCommand = z.object({
  type: z.literal('block_time'),
  title: z.string().min(1),
  start: isoDateTime,
  end: isoDateTime,
});

export const unblockTimeCommand = z.object({
  type: z.literal('unblock_time'),
  start: isoDateTime,
  end: isoDateTime,
});

export const findTimeCommand = z.object({
  type: z.literal('find_time'),
  purpose: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  rangeStart: isoDateTime.optional(),
  rangeEnd: isoDateTime.optional(),
  preferredWindow: z.object({ start: timeOfDay, end: timeOfDay }).optional(),
});

export const explainScheduleCommand = z.object({
  type: z.literal('explain_schedule'),
  question: z.string().min(1),
  rangeStart: isoDateTime.optional(),
  rangeEnd: isoDateTime.optional(),
});

export const listRisksCommand = z.object({ type: z.literal('list_risks') });

export const listScheduleCommand = z.object({
  type: z.literal('list_schedule'),
  rangeStart: isoDateTime.optional(),
  rangeEnd: isoDateTime.optional(),
});

export const listTasksCommand = z.object({
  type: z.literal('list_tasks'),
  status: z.enum(['todo', 'in_progress', 'blocked', 'completed', 'cancelled']).optional(),
});

/**
 * Arrange something with a person who is not on your calendar.
 *
 * Distinct from `create_event`: there is nobody to invite and nothing to write
 * yet. It produces a draft message offering times, and a human decides whether
 * it is ever sent.
 */
export const scheduleWithPersonCommand = z.object({
  type: z.literal('schedule_with_person'),
  /** A name as a person said it: "Sarah", "Sarah Chen". */
  person: z.string().min(1),
  /** What is being arranged, in words that can appear in the message. */
  activity: z.string().min(1),
  durationMinutes: z.number().int().positive().optional(),
  withinDays: z.number().int().positive().optional(),
  /** When the user named a day or span - "tomorrow", "next week" - it goes here. */
  rangeStart: isoDateTime.optional(),
  rangeEnd: isoDateTime.optional(),
  tone: z.enum(['casual', 'warm', 'formal']).optional(),
});

export const requestClarificationCommand = z.object({
  type: z.literal('request_clarification'),
  question: z.string().min(1),
});

export const agentCommandSchema = z.discriminatedUnion('type', [
  createTaskCommand,
  createEventCommand,
  updateEventCommand,
  updateTaskCommand,
  completeTaskCommand,
  deleteTaskCommand,
  scheduleCommand,
  rescheduleCommand,
  blockTimeCommand,
  unblockTimeCommand,
  findTimeCommand,
  explainScheduleCommand,
  listRisksCommand,
  listScheduleCommand,
  listTasksCommand,
  scheduleWithPersonCommand,
  requestClarificationCommand,
]);

export const agentPlanSchema = z.object({
  commands: z.array(agentCommandSchema).max(10),
  /** Short natural-language restatement of what the user asked for. */
  intent: z.string().optional(),
});

export type AgentCommand = z.infer<typeof agentCommandSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type CreateTaskCommand = z.infer<typeof createTaskCommand>;
export type CreateEventCommand = z.infer<typeof createEventCommand>;
export type UpdateEventCommand = z.infer<typeof updateEventCommand>;
export type UpdateTaskCommand = z.infer<typeof updateTaskCommand>;
export type ScheduleCommand = z.infer<typeof scheduleCommand>;
export type RescheduleCommand = z.infer<typeof rescheduleCommand>;
export type FindTimeCommand = z.infer<typeof findTimeCommand>;
export type ScheduleWithPersonCommand = z.infer<typeof scheduleWithPersonCommand>;
export type BlockTimeCommand = z.infer<typeof blockTimeCommand>;
export type ExplainScheduleCommand = z.infer<typeof explainScheduleCommand>;

export const COMMAND_TYPES = [
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
] as const;

/** Validate an untrusted payload (typically LLM output) into a plan. */
export function parseAgentPlan(value: unknown): AgentPlan {
  return agentPlanSchema.parse(value);
}

export function safeParseAgentPlan(
  value: unknown,
): { ok: true; plan: AgentPlan } | { ok: false; issues: string[] } {
  const result = agentPlanSchema.safeParse(value);
  if (result.success) return { ok: true, plan: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  };
}
