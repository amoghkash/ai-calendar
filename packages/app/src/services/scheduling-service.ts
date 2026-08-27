import type {
  AvailabilityBasis,
  CalendarEvent,
  CalendarMutation,
  CalendarTarget,
  ChangeSet,
  Clock,
  Database,
  FreeWindow,
  IdGenerator,
  Instant,
  Interval,
  Logger,
  NamedInterval,
  ScheduleBlock,
  Scheduler,
  SchedulingPlan,
  SchedulingPreferences,
  Task,
  TaskId,
  TaskRisk,
  UserId,
} from '@calendar-agent/core';
import {
  ConflictError,
  DomainError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  buildChangeSet,
  computeAvailability,
  days,
  durationMinutes,
  isLiveBlock,
  minutes as msFromMinutes,
} from '@calendar-agent/core';
import type { CalendarService } from './calendar-service.js';
import type { PreferencesService } from './preferences-service.js';

export interface PlanOptions {
  readonly userId: UserId;
  readonly taskIds?: readonly TaskId[];
  readonly range?: Interval;
  readonly rebuild?: boolean;
  /** Extra unavailable periods that apply to this run only. */
  readonly extraBlocked?: readonly NamedInterval[];
  /** Store the proposal so it can be approved later. Defaults to true. */
  readonly persist?: boolean;
}

export interface PlanResult {
  readonly changeSetId: string;
  readonly plan: SchedulingPlan;
  readonly changeSet: ChangeSet;
  readonly tasks: readonly Task[];
  readonly preferences: SchedulingPreferences;
  /** True when nothing was written; the default for every plan call. */
  readonly dryRun: true;
}

export interface ApplyResult {
  readonly changeSetId: string;
  readonly appliedMutations: number;
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly failures: readonly { readonly id: string; readonly error: string }[];
  readonly blocks: readonly ScheduleBlock[];
}

export interface SlotQuery {
  readonly userId: UserId;
  readonly durationMinutes: number;
  readonly range?: Interval;
  readonly limit?: number;
  readonly deepWorkOnly?: boolean;
  /** `waking_hours` for anything that is not work. Defaults to working hours. */
  readonly basis?: AvailabilityBasis;
}

/**
 * Planning and application of schedules.
 *
 * `plan()` never writes anything - simulation is the default. Calendar
 * mutations only happen through `approve()`, and only for mutations the
 * automation policy allows.
 */
export class SchedulingService {
  constructor(
    private readonly db: Database,
    private readonly scheduler: Scheduler,
    private readonly calendars: CalendarService,
    private readonly preferences: PreferencesService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
  ) {}

  /** Build a plan and the change set it implies. Nothing is written. */
  async plan(options: PlanOptions): Promise<PlanResult> {
    const now = this.clock.now();
    const preferences = await this.withOverrides(options);
    const horizon = options.range ?? {
      start: now,
      end: now + days(preferences.planningHorizonDays),
    };

    const [tasks, events, blocks] = await Promise.all([
      this.db.tasks.list({ userId: options.userId }),
      this.db.events.list({ userId: options.userId, range: horizon }),
      this.db.blocks.list({ userId: options.userId, range: horizon }),
    ]);

    const planningEvents = await this.busyEvents(options.userId, events);

    const plan = this.scheduler.plan({
      now,
      horizon,
      timezone: preferences.timezone,
      tasks,
      events: planningEvents,
      existingBlocks: blocks.filter(isLiveBlock),
      preferences,
      ...(options.taskIds ? { taskIds: options.taskIds } : {}),
      ...(options.rebuild === undefined ? {} : { rebuild: options.rebuild }),
    });

    const changeSetId = this.ids.next('cs');
    const target = await this.calendars.taskTarget(options.userId);
    const titles = new Map(tasks.map((task) => [task.id, task.title]));

    // A task may name the calendar its blocks belong on; otherwise the
    // configured task target is used.
    const calendars = await this.db.calendars.list(options.userId);
    const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
    const taskCalendars = new Map(tasks.map((task) => [task.id, task.calendarId]));
    const resolveTarget = (taskId: TaskId): CalendarTarget | undefined => {
      const preferred = taskCalendars.get(taskId);
      const calendar = preferred === undefined ? undefined : byId.get(preferred);
      if (calendar?.isWritable) {
        return {
          calendarId: calendar.id,
          calendarExternalId: calendar.externalId,
          timezone: calendar.timezone,
        };
      }
      return target;
    };
    const changeSet = buildChangeSet({
      id: changeSetId,
      userId: options.userId,
      now,
      plan,
      previousBlocks: blocks,
      taskTitles: titles,
      resolveTarget,
      automation: preferences.automation,
      timezone: preferences.timezone,
      describeTask: (taskId) => describeTask(titles.get(taskId)),
    });

    this.logger.info('scheduling.plan', {
      runId: plan.runId,
      blocks: plan.blocks.length,
      unscheduled: plan.unscheduled.length,
      added: plan.diff.summary.addedCount,
      moved: plan.diff.summary.movedCount,
      removed: plan.diff.summary.removedCount,
      quality: plan.quality.overall,
    });

    if (options.persist !== false) {
      await this.db.changeSets.save({
        id: changeSetId,
        userId: options.userId,
        createdAt: now,
        status: 'pending',
        payload: { plan, changeSet },
      });
    }

    return { changeSetId, plan, changeSet, tasks, preferences, dryRun: true };
  }

  /** Approve a stored proposal and apply it. */
  async approve(
    changeSetId: string,
    options: { readonly userId: UserId; readonly mutationIds?: readonly string[] } = {
      userId: '',
    },
  ): Promise<ApplyResult> {
    const stored = await this.db.changeSets.get(changeSetId);
    if (!stored) throw new NotFoundError('change set', changeSetId);
    if (stored.status === 'applied') {
      throw new ConflictError('This change set has already been applied.');
    }
    const payload = stored.payload as { plan: SchedulingPlan; changeSet: ChangeSet };
    const preferences = await this.preferences.get(stored.userId);
    if (preferences.automation.mode === 'read_only') {
      throw new PermissionDeniedError(
        'The system is in read-only mode. Change automation.mode to apply calendar changes.',
      );
    }

    const result = await this.applyPlan(stored.userId, payload.plan, payload.changeSet, {
      includePending: true,
      ...(options.mutationIds ? { mutationIds: options.mutationIds } : {}),
    });

    await this.db.changeSets.save({
      ...stored,
      status: result.failures.length > 0 ? 'failed' : 'applied',
      appliedAt: this.clock.now(),
      ...(result.failures.length > 0
        ? { error: result.failures.map((failure) => failure.error).join('; ') }
        : {}),
    });
    return result;
  }

  async reject(changeSetId: string): Promise<void> {
    const stored = await this.db.changeSets.get(changeSetId);
    if (!stored) throw new NotFoundError('change set', changeSetId);
    await this.db.changeSets.save({ ...stored, status: 'rejected' });
  }

  /**
   * Persist the planned blocks and run the allowed calendar mutations.
   * Local state is updated first so a provider failure cannot lose the plan.
   */
  async applyPlan(
    userId: UserId,
    plan: SchedulingPlan,
    changeSet: ChangeSet,
    options: {
      readonly includePending?: boolean;
      readonly mutationIds?: readonly string[];
    } = {},
  ): Promise<ApplyResult> {
    const now = this.clock.now();
    const existing = new Map(
      (await this.db.blocks.list({ userId })).map((block) => [block.id, block]),
    );
    const target = await this.calendars.taskTarget(userId);

    // 1. write the blocks the plan asks for.
    const blocks: ScheduleBlock[] = [];
    for (const planned of plan.blocks) {
      const previous = existing.get(planned.id);
      const block: ScheduleBlock = {
        id: planned.id,
        userId,
        taskId: planned.taskId,
        kind: 'task',
        start: planned.start,
        end: planned.end,
        timezone: planned.timezone,
        sequence: planned.sequence,
        status: previous?.status === 'synced' ? 'synced' : 'confirmed',
        pinned: previous?.pinned ?? false,
        ...(previous?.calendarId
          ? { calendarId: previous.calendarId }
          : target
            ? { calendarId: target.calendarId }
            : {}),
        ...(previous?.provider ? { provider: previous.provider } : {}),
        ...(previous?.externalEventId ? { externalEventId: previous.externalEventId } : {}),
        reasonCode: planned.reason.code,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      blocks.push(block);
    }
    await this.db.blocks.saveMany(blocks);

    // 2. drop blocks the plan removed.
    const removedIds = plan.diff.removed.map((entry) => entry.blockId);
    if (removedIds.length > 0) await this.db.blocks.deleteMany(removedIds);

    // 3. run the calendar mutations this policy allows.
    const selected = [
      ...changeSet.autoApply,
      ...(options.includePending ? changeSet.pending : []),
    ].filter((mutation) => !options.mutationIds || options.mutationIds.includes(mutation.id));

    const skipped = changeSet.blocked.map((entry) => ({
      id: entry.mutation.id,
      reason: entry.reason.message,
    }));
    const failures: { id: string; error: string }[] = [];
    const byId = new Map(blocks.map((block) => [block.id, block]));
    let applied = 0;

    for (const mutation of selected) {
      try {
        await this.executeMutation(userId, mutation, byId, target);
        applied += 1;
      } catch (error) {
        const message = error instanceof DomainError ? error.message : String(error);
        this.logger.error('scheduling.mutation_failed', { mutationId: mutation.id, message });
        failures.push({ id: mutation.id, error: message });
      }
    }

    await this.db.blocks.saveMany([...byId.values()]);
    return {
      changeSetId: changeSet.id,
      appliedMutations: applied,
      skipped,
      failures,
      blocks: [...byId.values()],
    };
  }

  private async executeMutation(
    userId: UserId,
    mutation: CalendarMutation,
    blocks: Map<string, ScheduleBlock>,
    target: CalendarTarget | undefined,
  ): Promise<void> {
    const calendarId = mutation.calendarId || target?.calendarId;
    if (!calendarId) {
      throw new NotFoundError('calendar', 'no writable calendar is configured');
    }
    const calendar = await this.db.calendars.get(calendarId);
    if (!calendar) throw new NotFoundError('calendar', calendarId);
    const account = await this.db.accounts.get(calendar.accountId);
    if (!account) throw new NotFoundError('calendar account', calendar.accountId);
    const provider = await this.calendars.providerFor(account);
    const preferences = await this.preferences.get(userId);
    const now = this.clock.now();

    if (mutation.kind === 'create_event') {
      const created = await provider.createEvent(mutation.input);
      const event = this.calendars.toCalendarEvent(created, calendar, preferences);
      await this.db.events.save(event);
      await this.calendars.recordWrite(userId, calendar.id, created);
      const block = mutation.blockId ? blocks.get(mutation.blockId) : undefined;
      if (block) {
        blocks.set(block.id, {
          ...block,
          calendarId: calendar.id,
          provider: account.provider,
          externalEventId: created.externalId,
          status: 'synced',
          updatedAt: now,
        });
      }
      return;
    }

    if (mutation.kind === 'update_event') {
      const stored = await this.db.events.findByExternalId(
        userId,
        account.provider,
        calendar.id,
        mutation.externalId,
      );
      const updated = await provider.updateEvent(
        {
          calendarExternalId: calendar.externalId,
          externalId: mutation.externalId,
          ...(stored?.etag ? { etag: stored.etag } : {}),
        },
        mutation.changes,
      );
      const event = this.calendars.toCalendarEvent(
        updated,
        calendar,
        preferences,
        stored,
        await this.calendars.linkedHandles(stored?.id),
      );
      await this.db.events.save(event);
      await this.calendars.recordWrite(userId, calendar.id, updated);
      const block = mutation.blockId ? blocks.get(mutation.blockId) : undefined;
      if (block) blocks.set(block.id, { ...block, status: 'synced', updatedAt: now });
      return;
    }

    const stored = await this.db.events.findByExternalId(
      userId,
      account.provider,
      calendar.id,
      mutation.externalId,
    );
    await provider.deleteEvent({
      calendarExternalId: calendar.externalId,
      externalId: mutation.externalId,
      ...(stored?.etag ? { etag: stored.etag } : {}),
    });
    if (stored) await this.db.events.delete(stored.id);
    await this.db.syncState.deleteEventRecord(userId, calendar.id, mutation.externalId);
  }

  // ---- direct block manipulation ------------------------------------------

  /**
   * Move a block because the user dragged it.
   *
   * An explicit human decision outranks the scheduler, so the block is pinned
   * by default and the calendar event is patched immediately rather than being
   * queued as a proposal.
   */
  async moveBlock(
    userId: UserId,
    blockId: string,
    changes: { readonly start: Instant; readonly end: Instant; readonly pin?: boolean },
  ): Promise<ScheduleBlock> {
    if (changes.end <= changes.start) {
      throw new ValidationError('A block must end after it starts.');
    }
    const block = await this.db.blocks.get(blockId);
    if (!block || block.userId !== userId) throw new NotFoundError('schedule block', blockId);

    const preferences = await this.preferences.get(userId);
    if (preferences.automation.mode === 'read_only') {
      throw new PermissionDeniedError(
        'The system is in read-only mode, so blocks cannot be moved on your calendar.',
      );
    }

    const updated: ScheduleBlock = {
      ...block,
      start: changes.start,
      end: changes.end,
      pinned: changes.pin ?? true,
      updatedAt: this.clock.now(),
    };
    await this.db.blocks.save(updated);

    if (block.externalEventId && block.calendarId) {
      const { calendar, provider } = await this.calendars.resolveProvider(block.calendarId);
      const stored = await this.db.events.findByExternalId(
        userId,
        calendar.provider,
        calendar.id,
        block.externalEventId,
      );
      const written = await provider.updateEvent(
        {
          calendarExternalId: calendar.externalId,
          externalId: block.externalEventId,
          ...(stored?.etag ? { etag: stored.etag } : {}),
        },
        { start: changes.start, end: changes.end, timezone: calendar.timezone },
      );
      const preferencesForClassification = preferences;
      await this.db.events.save(
        this.calendars.toCalendarEvent(
          written,
          calendar,
          preferencesForClassification,
          stored,
          await this.calendars.linkedHandles(stored?.id),
        ),
      );
      await this.calendars.recordWrite(userId, calendar.id, written);
    }

    this.logger.info('scheduling.block_moved', { blockId, pinned: updated.pinned });
    return updated;
  }

  /** Pin or unpin a block. Unpinning hands it back to the scheduler. */
  async setBlockPinned(userId: UserId, blockId: string, pinned: boolean): Promise<ScheduleBlock> {
    const block = await this.db.blocks.get(blockId);
    if (!block || block.userId !== userId) throw new NotFoundError('schedule block', blockId);
    return this.db.blocks.save({ ...block, pinned, updatedAt: this.clock.now() });
  }

  /**
   * Remove a block and its calendar event. The task keeps its remaining work,
   * so a later planning run may propose a new slot for it.
   */
  async deleteBlock(userId: UserId, blockId: string): Promise<void> {
    const block = await this.db.blocks.get(blockId);
    if (!block || block.userId !== userId) throw new NotFoundError('schedule block', blockId);

    const preferences = await this.preferences.get(userId);
    if (preferences.automation.mode === 'read_only') {
      throw new PermissionDeniedError('The system is in read-only mode.');
    }

    if (block.externalEventId && block.calendarId) {
      const { calendar, provider } = await this.calendars.resolveProvider(block.calendarId);
      const stored = await this.db.events.findByExternalId(
        userId,
        calendar.provider,
        calendar.id,
        block.externalEventId,
      );
      await provider.deleteEvent({
        calendarExternalId: calendar.externalId,
        externalId: block.externalEventId,
        ...(stored?.etag ? { etag: stored.etag } : {}),
      });
      if (stored) await this.db.events.delete(stored.id);
      await this.db.syncState.deleteEventRecord(userId, calendar.id, block.externalEventId);
    }
    await this.db.blocks.delete(blockId);
    this.logger.info('scheduling.block_deleted', { blockId });
  }

  /** Deterministic deadline-risk report for every open task. */
  async risks(userId: UserId, range?: Interval): Promise<readonly TaskRisk[]> {
    const result = await this.plan({ userId, persist: false, ...(range ? { range } : {}) });
    return result.plan.risks;
  }

  /** Events and task blocks in one chronological list. */
  async agenda(
    userId: UserId,
    range: Interval,
  ): Promise<{
    readonly events: readonly CalendarEvent[];
    readonly blocks: readonly (ScheduleBlock & { readonly title: string })[];
  }> {
    const [events, blocks, tasks] = await Promise.all([
      this.db.events.list({ userId, range }),
      this.db.blocks.list({ userId, range }),
      this.db.tasks.list({ userId }),
    ]);
    const titles = new Map(tasks.map((task) => [task.id, task.title]));
    const live = blocks.filter(isLiveBlock);
    const liveBlockIds = new Set(live.map((block) => block.id));

    // A synced task block exists twice: as the block, and as the calendar
    // event mirroring it. Return it once, as the block, so the UI does not
    // render the same hour twice.
    const visible = (await this.visibleEvents(userId, events)).filter(
      (event) => event.blockId === undefined || !liveBlockIds.has(event.blockId),
    );

    return {
      events: visible,
      blocks: live.map((block) => ({ ...block, title: titles.get(block.taskId) ?? block.taskId })),
    };
  }

  /** Free windows large enough for a given duration. */
  async findSlots(query: SlotQuery): Promise<readonly FreeWindow[]> {
    const now = this.clock.now();
    const preferences = await this.preferences.get(query.userId);
    const range = query.range ?? { start: now, end: now + days(preferences.planningHorizonDays) };
    const [events, blocks] = await Promise.all([
      this.db.events.list({ userId: query.userId, range }),
      this.db.blocks.list({ userId: query.userId, range }),
    ]);
    const availability = computeAvailability({
      range,
      now,
      timezone: preferences.timezone,
      preferences,
      events: await this.busyEvents(query.userId, events),
      reserved: blocks.filter(isLiveBlock).map((block) => ({ start: block.start, end: block.end })),
      ...(query.basis === undefined ? {} : { basis: query.basis }),
    });
    return availability.windows
      .filter((window) => durationMinutes(window) >= query.durationMinutes)
      .filter((window) => !query.deepWorkOnly || window.deepWork)
      .slice(0, query.limit ?? 10);
  }

  /** Merge run-scoped constraints into the stored preferences. */
  private async withOverrides(options: PlanOptions): Promise<SchedulingPreferences> {
    const preferences = await this.preferences.get(options.userId);
    if (!options.extraBlocked?.length) return preferences;
    return {
      ...preferences,
      blockedPeriods: [...preferences.blockedPeriods, ...options.extraBlocked],
    };
  }

  /** Events the user asked to see. Deselected calendars are hidden entirely. */
  private async visibleEvents(
    userId: UserId,
    events: readonly CalendarEvent[],
  ): Promise<CalendarEvent[]> {
    const calendars = await this.db.calendars.list(userId);
    if (calendars.length === 0) return [...events];
    const hidden = new Set(
      calendars.filter((calendar) => !calendar.selected).map((calendar) => calendar.id),
    );
    return events.filter((event) => !hidden.has(event.calendarId));
  }

  /**
   * Events that consume time. A calendar can be visible but excluded from
   * planning (a colleague's calendar you watch but are not busy for).
   */
  private async busyEvents(
    userId: UserId,
    events: readonly CalendarEvent[],
  ): Promise<CalendarEvent[]> {
    const calendars = await this.db.calendars.list(userId);
    if (calendars.length === 0) return [...events];
    const excluded = new Set(
      calendars
        .filter((calendar) => !calendar.selected || !calendar.includeInAvailability)
        .map((calendar) => calendar.id),
    );
    return events.filter((event) => !excluded.has(event.calendarId));
  }

  /** Window that "leave by <time>" style requests block out. */
  static blockAfter(instant: Instant, until: Instant, label: string): NamedInterval {
    return { start: instant, end: Math.max(until, instant + msFromMinutes(1)), label };
  }
}

function describeTask(title: string | undefined): string | undefined {
  if (!title) return undefined;
  return `Scheduled by calendar-agent for "${title}". Move it if you like - the agent will notice and adapt.`;
}
