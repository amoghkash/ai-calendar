import { z } from 'zod';

/**
 * The on-disk configuration schema. Everything is optional: a missing file
 * yields a fully working default configuration.
 */

const timeRange = z
  .union([
    z.string(),
    z.object({ start: z.string(), end: z.string(), label: z.string().optional() }),
  ])
  .describe('"09:00-17:00" or { start, end }');

const dayWindows = z.union([timeRange, z.array(timeRange)]);

export const weeklyScheduleSchema = z
  .object({
    monday: dayWindows.optional(),
    tuesday: dayWindows.optional(),
    wednesday: dayWindows.optional(),
    thursday: dayWindows.optional(),
    friday: dayWindows.optional(),
    saturday: dayWindows.optional(),
    sunday: dayWindows.optional(),
  })
  .strict();

const movePolicy = z.enum(['never', 'ask', 'auto']);

export const configSchema = z
  .object({
    timezone: z.string().optional(),
    user: z
      .object({
        id: z.string().optional(),
        email: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),

    database: z
      .object({
        driver: z.enum(['memory', 'json', 'postgres']).optional(),
        url: z.string().optional(),
        path: z.string().optional(),
      })
      .optional(),

    working_hours: weeklyScheduleSchema.optional(),
    sleep_hours: weeklyScheduleSchema.optional(),
    recurring_blocks: weeklyScheduleSchema.optional(),
    blocked_periods: z
      .array(z.object({ start: z.string(), end: z.string(), label: z.string().optional() }))
      .optional(),

    deep_work: z
      .object({
        enabled: z.boolean().optional(),
        schedule: weeklyScheduleSchema.optional(),
        preferred_start: z.string().optional(),
        preferred_end: z.string().optional(),
        allow_meetings: z.boolean().optional(),
        reserve_for_focus_tasks: z.boolean().optional(),
      })
      .optional(),

    scheduling: z
      .object({
        minimum_block_minutes: z.number().int().positive().optional(),
        maximum_block_minutes: z.number().int().positive().optional(),
        allow_task_splitting: z.boolean().optional(),
        buffer_between_blocks_minutes: z.number().int().min(0).optional(),
        max_daily_task_minutes: z.number().int().positive().optional(),
        protect_existing_events: z.boolean().optional(),
        all_day_events_block_time: z.boolean().optional(),
        granularity_minutes: z.number().int().positive().optional(),
        planning_horizon_days: z.number().int().positive().optional(),
        placement_strategy: z.enum(['earliest_fit', 'best_fit']).optional(),
      })
      .optional(),

    weights: z
      .object({
        deadline_urgency: z.number().optional(),
        priority: z.number().optional(),
        importance: z.number().optional(),
        deadline_risk: z.number().optional(),
        age_bonus: z.number().optional(),
        fragmentation_penalty: z.number().optional(),
        context_switch_penalty: z.number().optional(),
        early_start_preference: z.number().optional(),
        stability_bonus: z.number().optional(),
        deep_work_affinity: z.number().optional(),
      })
      .optional(),

    risk: z
      .object({
        critical_ratio: z.number().positive().optional(),
        at_risk_ratio: z.number().positive().optional(),
        deadline_buffer_minutes: z.number().int().min(0).optional(),
      })
      .optional(),

    automation: z
      .object({
        mode: z.enum(['read_only', 'suggest', 'autonomous']).optional(),
        move_policy: z
          .object({
            MOVABLE: movePolicy.optional(),
            PROTECTED: movePolicy.optional(),
            FIXED: movePolicy.optional(),
            UNKNOWN: movePolicy.optional(),
          })
          .optional(),
        create_blocks: movePolicy.optional(),
        delete_blocks: movePolicy.optional(),
        freeze_window_minutes: z.number().int().min(0).optional(),
        max_auto_mutations: z.number().int().min(0).optional(),
      })
      .optional(),

    stability: z
      .object({
        minimum_improvement: z.number().optional(),
        freeze_window_minutes: z.number().int().min(0).optional(),
        max_moves_per_run: z.number().int().min(0).optional(),
      })
      .optional(),

    classification_rules: z
      .array(
        z.object({
          id: z.string(),
          classification: z.enum(['MOVABLE', 'PROTECTED', 'FIXED', 'UNKNOWN']),
          title_pattern: z.string().optional(),
          calendar_id: z.string().optional(),
          has_other_attendees: z.boolean().optional(),
          is_all_day: z.boolean().optional(),
          created_by_agent: z.boolean().optional(),
        }),
      )
      .optional(),

    calendars: z
      .object({
        google: z
          .object({
            client_id: z.string().optional(),
            client_secret: z.string().optional(),
            redirect_uri: z.string().optional(),
          })
          .optional(),
        microsoft: z
          .object({
            client_id: z.string().optional(),
            client_secret: z.string().optional(),
            tenant_id: z.string().optional(),
            redirect_uri: z.string().optional(),
          })
          .optional(),
      })
      .optional(),

    llm: z
      .object({
        provider: z
          .enum(['none', 'anthropic', 'openai', 'gemini', 'openrouter', 'ollama'])
          .optional(),
        model: z.string().optional(),
        api_key: z.string().optional(),
        base_url: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().positive().optional(),
      })
      .optional(),

    sync: z
      .object({
        enabled: z.boolean().optional(),
        interval_minutes: z.number().int().positive().optional(),
        replan_on_change: z.boolean().optional(),
      })
      .optional(),

    server: z
      .object({
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
        public_url: z.string().optional(),
        cors_origins: z.array(z.string()).optional(),
      })
      .optional(),

    ui: z.object({ week_start: z.enum(['rolling', 'sunday']).optional() }).optional(),

    logging: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).optional() }).optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof configSchema>;
export type RawWeeklySchedule = z.infer<typeof weeklyScheduleSchema>;
