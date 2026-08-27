import type {
  ChangeSet,
  Clock,
  Database,
  FreeWindow,
  IdGenerator,
  Instant,
  Interval,
  Logger,
  NamedInterval,
  SchedulingPlan,
  Task,
  TaskRisk,
  UserId,
} from '@calendar-agent/core';
import {
  DomainError,
  ValidationError,
  days,
  evaluateEventMove,
  describeInstant,
  describeInterval,
  formatMinutes,
  instantFromISO,
  localDayInterval,
  eachLocalDay,
  parseTimeOfDay,
  zonedInstant,
} from '@calendar-agent/core';
import type { AgentCommand, AgentContext, CommandParser, LLMProvider } from '@calendar-agent/agent';
import { explainPlan, renderRiskSummary } from '@calendar-agent/agent';
import type { CalendarService } from './calendar-service.js';
import type { AgentTool } from '@calendar-agent/agent';
import { buildToolAgentSystemPrompt, modelUnavailable, runToolLoop } from '@calendar-agent/agent';
import type { OutreachService } from './outreach-service.js';
import type { PreferencesService } from './preferences-service.js';
import type { SchedulingService } from './scheduling-service.js';
import type { TaskService } from './task-service.js';

export interface AgentTurnInput {
  readonly userId: UserId;
  readonly text: string;
  readonly conversationId?: string;
}

export interface AgentTurnResult {
  readonly reply: string;
  readonly intent?: string;
  readonly source: 'llm' | 'heuristic' | 'none';
  readonly commands: readonly AgentCommand[];
  readonly plan?: SchedulingPlan;
  readonly changeSet?: ChangeSet;
  readonly changeSetId?: string;
  readonly risks?: readonly TaskRisk[];
  readonly tasks?: readonly Task[];
  readonly createdTasks?: readonly Task[];
  readonly slots?: readonly FreeWindow[];
  readonly agenda?: Awaited<ReturnType<SchedulingService['agenda']>>;
  /** True when a calendar change is waiting for the user to approve it. */
  readonly needsConfirmation: boolean;
  readonly conversationId: string;
}

/**
 * Turns a natural-language request into validated commands and executes them
 * through the same application services the CLI and web UI use.
 *
 * The LLM only proposes commands. Every mutation goes through the services
 * below, which enforce validation and the automation policy.
 */
export class AgentService {
  /** How many prior messages a follow-up is resolved against. */
  private static readonly HISTORY_TURNS = 20;

  constructor(
    private readonly db: Database,
    private readonly parser: CommandParser,
    private readonly tasks: TaskService,
    private readonly scheduling: SchedulingService,
    private readonly calendars: CalendarService,
    private readonly preferences: PreferencesService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
    private readonly llm?: LLMProvider,
    private readonly outreach?: OutreachService,
    /** Tools for the loop. Absent means the typed-command path is used. */
    private readonly toolsFor?: (userId: UserId) => AgentTool<never>[],
  ) {}

  async buildContext(userId: UserId): Promise<AgentContext> {
    const now = this.clock.now();
    const preferences = await this.preferences.get(userId);
    const tasks = await this.tasks.list(userId);
    const { events } = await this.scheduling.agenda(userId, { start: now, end: now + days(7) });
    return {
      now,
      timezone: preferences.timezone,
      workingHoursSummary: summariseWorkingHours(preferences.workingHours),
      automationMode: preferences.automation.mode,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        remainingMinutes: this.tasks.remaining(task),
        ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
        priority: task.priority,
        status: task.status,
      })),
      upcomingEvents: events.slice(0, 15).map((event) => ({
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
      })),
    };
  }

  async handle(input: AgentTurnInput): Promise<AgentTurnResult> {
    const now = this.clock.now();
    const context = await this.buildContext(input.userId);
    const conversationId = await this.ensureConversation(input, now);

    // Read the thread before recording this turn, so the parser sees what came
    // before it and not the message it is being asked to interpret.
    const history = await this.history(conversationId);

    await this.db.conversations.appendMessage({
      id: this.ids.next('msg'),
      conversationId,
      role: 'user',
      content: input.text,
      createdAt: now,
    });

    // A model, if there is one, drives the turn by calling tools. Without one
    // the typed-command parser still answers - scheduling never needed a model
    // and neither does the fallback.
    if (this.toolsFor && this.llm && this.llm.name !== 'none') {
      let loop;
      try {
        loop = await runToolLoop(
          [
            ...history.map((turn) => ({ role: turn.role, content: turn.content })),
            { role: 'user' as const, content: input.text },
          ],
          {
            llm: this.llm,
            tools: this.toolsFor(input.userId),
            system: buildToolAgentSystemPrompt(context),
            logger: this.logger,
          },
        );
      } catch (error) {
        // A configured model that cannot answer must say so. Falling back to
        // the rule parser here would hide a broken key behind a worse answer.
        throw modelUnavailable(this.llm.name, this.llm.model, error);
      }
      const reply =
        loop.text.length > 0 ? loop.text : 'I did that, but had nothing to add about it.';
      await this.record(conversationId, reply, this.clock.now());
      this.logger.info('agent.turn', {
        source: 'tools',
        iterations: loop.iterations,
        tools: loop.calls.map((call) => call.name),
      });
      return {
        reply,
        source: 'llm',
        commands: [],
        needsConfirmation: false,
        conversationId,
      };
    }

    const parsed = await this.parser.parse({
      text: input.text,
      now,
      timezone: context.timezone,
      context,
      ...(history.length > 0 ? { history } : {}),
    });

    if (parsed.commands.length === 0) {
      const reply =
        'I could not turn that into an action. Try something like "schedule my algorithms assignment", "what deadlines are at risk?" or "find me two hours tomorrow morning".';
      await this.record(conversationId, reply, now);
      return {
        reply,
        source: 'none',
        commands: [],
        needsConfirmation: false,
        conversationId,
      };
    }

    const result = await this.execute(input.userId, parsed.commands, context);
    const reply = result.reply;
    await this.record(conversationId, reply, this.clock.now());
    this.logger.info('agent.turn', {
      source: parsed.source,
      commands: parsed.commands.map((command) => command.type),
    });

    return {
      ...result,
      source: parsed.source,
      commands: parsed.commands,
      ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
      conversationId,
    };
  }

  /** Execute already-validated commands. Exposed for the API and tests. */
  async execute(
    userId: UserId,
    commands: readonly AgentCommand[],
    context?: AgentContext,
  ): Promise<Omit<AgentTurnResult, 'source' | 'commands' | 'conversationId'>> {
    const ctx = context ?? (await this.buildContext(userId));
    const lines: string[] = [];
    const createdTasks: Task[] = [];
    let plan: SchedulingPlan | undefined;
    let changeSet: ChangeSet | undefined;
    let changeSetId: string | undefined;
    let risks: readonly TaskRisk[] | undefined;
    let taskList: readonly Task[] | undefined;
    let slots: readonly FreeWindow[] | undefined;
    let agenda: Awaited<ReturnType<SchedulingService['agenda']>> | undefined;
    let extraBlocked: NamedInterval[] = [];
    let scheduleAfterwards: { taskIds?: string[]; range?: Interval; rebuild?: boolean } | undefined;

    for (const command of commands) {
      switch (command.type) {
        case 'create_task': {
          const task = await this.tasks.create({
            userId,
            title: command.title,
            estimatedMinutes: command.estimatedMinutes,
            ...(command.description === undefined ? {} : { description: command.description }),
            ...(command.deadline === undefined
              ? {}
              : { deadline: instantFromISO(command.deadline) }),
            ...(command.earliestStart === undefined
              ? {}
              : { earliestStart: instantFromISO(command.earliestStart) }),
            ...(command.priority === undefined ? {} : { priority: command.priority }),
            ...(command.importance === undefined ? {} : { importance: command.importance }),
            ...(command.minimumBlockMinutes === undefined
              ? {}
              : { minimumBlockMinutes: command.minimumBlockMinutes }),
            ...(command.maximumBlockMinutes === undefined
              ? {}
              : { maximumBlockMinutes: command.maximumBlockMinutes }),
            ...(command.allowSplitting === undefined
              ? {}
              : { allowSplitting: command.allowSplitting }),
            ...(command.focus === undefined ? {} : { focus: command.focus }),
            ...(command.tags === undefined ? {} : { tags: command.tags }),
            ...(command.preferredDays === undefined
              ? {}
              : { preferredDays: command.preferredDays }),
            ...(command.preferredWindows === undefined
              ? {}
              : {
                  preferredWindows: command.preferredWindows.map((window) => ({
                    start: parseTimeOfDay(window.start),
                    end: parseTimeOfDay(window.end),
                  })),
                }),
          });
          createdTasks.push(task);
          lines.push(
            `Created "${task.title}" (${formatMinutes(task.estimatedMinutes)}${
              task.deadline ? `, due ${describeInstant(task.deadline, ctx.timezone)}` : ''
            }).`,
          );
          break;
        }

        case 'create_event': {
          const target = await this.calendars.taskTarget(userId);
          const calendarId = command.calendarId ?? target?.calendarId;
          if (!calendarId) {
            lines.push(
              'No writable calendar is connected, so I cannot add that event. Connect one first.',
            );
            break;
          }
          const event = await this.calendars.createEvent({
            userId,
            calendarId,
            title: command.title,
            start: instantFromISO(command.start),
            end: instantFromISO(command.end),
            ...(command.description === undefined ? {} : { description: command.description }),
            ...(command.location === undefined ? {} : { location: command.location }),
          });
          lines.push(
            `Added "${event.title}" to your calendar on ${describeInterval(event, ctx.timezone)}.`,
          );
          // The new commitment consumes time, so re-plan around it.
          scheduleAfterwards ??= {};
          break;
        }

        case 'update_event': {
          // A window around now: enough to catch "yesterday's standup" without
          // matching a title that repeats months away.
          const reference = this.clock.now();
          const window = { start: reference - days(7), end: reference + days(60) };
          const event = await this.calendars.resolveEvent(userId, command.eventRef, window);
          const changes = command.changes;
          const moving = changes.start !== undefined || changes.end !== undefined;

          // The policy gate only applies to moving an existing commitment.
          // Renaming or relocating one is not a scheduling decision.
          if (moving) {
            const preferences = await this.preferences.get(userId);
            const decision = evaluateEventMove(event, preferences.automation);
            if (decision.policy === 'never') {
              lines.push(
                `${decision.reason.message} Drag it on the grid if you want to move it yourself, or change the policy in Settings > Automation.`,
              );
              break;
            }
          }

          // An event that mirrors a scheduled task block has two halves. Patching
          // only the calendar copy leaves the block where it was, and the next
          // plan moves the event straight back - so the timing goes through
          // moveBlock, which updates both and pins the block. An instruction
          // naming a time is a decision, not a suggestion.
          const pinnedBlock = moving && event.blockId !== undefined;
          if (pinnedBlock) {
            await this.scheduling.moveBlock(userId, event.blockId!, {
              start: changes.start === undefined ? event.start : instantFromISO(changes.start),
              end: changes.end === undefined ? event.end : instantFromISO(changes.end),
              pin: true,
            });
          }

          const content = {
            ...(changes.title === undefined ? {} : { title: changes.title }),
            ...(changes.location === undefined ? {} : { location: changes.location }),
            ...(changes.description === undefined ? {} : { description: changes.description }),
          };
          // moveBlock has already written the timing; a second patch carrying
          // nothing new is a wasted round trip to the provider.
          const updated =
            pinnedBlock && Object.keys(content).length === 0
              ? ((await this.db.events.get(event.id)) ?? event)
              : await this.calendars.updateEvent(userId, event.id, {
                  ...content,
                  ...(pinnedBlock || changes.start === undefined
                    ? {}
                    : { start: instantFromISO(changes.start) }),
                  ...(pinnedBlock || changes.end === undefined
                    ? {}
                    : { end: instantFromISO(changes.end) }),
                  // Telling other people is the user's call, never the agent's.
                  notifyAttendees: false,
                });

          lines.push(`Updated "${updated.title}" to ${describeInterval(updated, ctx.timezone)}.`);
          if (pinnedBlock) {
            lines.push('It is pinned there now, so re-planning will leave it alone.');
          }
          const others = updated.attendees.filter((attendee) => !attendee.self).length;
          if (others > 0) {
            lines.push(
              `${others} other attendee(s) were not notified - tell them yourself, or reopen the event to send an update.`,
            );
          }
          // The commitment changed shape, so re-plan around it.
          scheduleAfterwards ??= {};
          break;
        }

        case 'update_task': {
          const task = await this.tasks.resolve(userId, command.taskRef);
          const changes = command.changes;
          const updated = await this.tasks.update(task.id, {
            ...(changes.title === undefined ? {} : { title: changes.title }),
            ...(changes.description === undefined ? {} : { description: changes.description }),
            ...(changes.estimatedMinutes === undefined
              ? {}
              : { estimatedMinutes: changes.estimatedMinutes }),
            ...(changes.deadline === undefined
              ? {}
              : { deadline: instantFromISO(changes.deadline) }),
            ...(changes.earliestStart === undefined
              ? {}
              : { earliestStart: instantFromISO(changes.earliestStart) }),
            ...(changes.priority === undefined ? {} : { priority: changes.priority }),
            ...(changes.importance === undefined ? {} : { importance: changes.importance }),
            ...(changes.focus === undefined ? {} : { focus: changes.focus }),
            ...(changes.tags === undefined ? {} : { tags: changes.tags }),
            ...(changes.minimumBlockMinutes === undefined
              ? {}
              : { minimumBlockMinutes: changes.minimumBlockMinutes }),
            ...(changes.maximumBlockMinutes === undefined
              ? {}
              : { maximumBlockMinutes: changes.maximumBlockMinutes }),
            ...(changes.allowSplitting === undefined
              ? {}
              : { allowSplitting: changes.allowSplitting }),
            // These two are how "do it tomorrow afternoon" is expressed. The
            // command schema always accepted them; dropping them here is what
            // made the agent claim it had changed the timing and change nothing.
            ...(changes.preferredDays === undefined
              ? {}
              : { preferredDays: changes.preferredDays }),
            ...(changes.preferredWindows === undefined
              ? {}
              : {
                  preferredWindows: changes.preferredWindows.map((window) => ({
                    start: parseTimeOfDay(window.start),
                    end: parseTimeOfDay(window.end),
                  })),
                }),
          });
          lines.push(`Updated "${updated.title}".`);
          scheduleAfterwards ??= { taskIds: [updated.id] };
          break;
        }

        case 'complete_task': {
          const task = await this.tasks.resolve(userId, command.taskRef);
          const done = await this.tasks.complete(task.id, command.completedMinutes);
          lines.push(`Marked "${done.title}" complete.`);
          break;
        }

        case 'delete_task': {
          const task = await this.tasks.resolve(userId, command.taskRef);
          await this.tasks.delete(task.id);
          lines.push(`Deleted "${task.title}".`);
          break;
        }

        case 'schedule': {
          const taskIds = command.taskRefs
            ? await this.resolveMany(userId, command.taskRefs)
            : undefined;
          scheduleAfterwards = {
            ...(taskIds ? { taskIds } : {}),
            ...(command.rangeStart && command.rangeEnd
              ? {
                  range: {
                    start: instantFromISO(command.rangeStart),
                    end: instantFromISO(command.rangeEnd),
                  },
                }
              : {}),
            ...(command.rebuild === undefined ? {} : { rebuild: command.rebuild }),
          };
          break;
        }

        case 'reschedule': {
          const range = {
            start: instantFromISO(command.rangeStart),
            end: instantFromISO(command.rangeEnd),
          };
          if (command.mustEndBy) {
            const mustEndBy = instantFromISO(command.mustEndBy);
            extraBlocked.push({
              start: mustEndBy,
              end: Math.max(range.end, mustEndBy + 1),
              label: 'requested free time',
            });
            lines.push(
              `Keeping everything after ${describeInstant(mustEndBy, ctx.timezone)} free.`,
            );
          }
          scheduleAfterwards = { range, rebuild: true };
          break;
        }

        case 'block_time': {
          const period: NamedInterval = {
            start: instantFromISO(command.start),
            end: instantFromISO(command.end),
            label: command.title,
          };
          if (period.end <= period.start) {
            throw new ValidationError('A blocked period must end after it starts.');
          }
          const preferences = await this.preferences.get(userId);
          await this.preferences.update(userId, {
            blockedPeriods: [...preferences.blockedPeriods, period],
          });
          lines.push(`Blocked ${describeInterval(period, ctx.timezone)}.`);
          scheduleAfterwards ??= {};
          break;
        }

        case 'unblock_time': {
          const range = {
            start: instantFromISO(command.start),
            end: instantFromISO(command.end),
          };
          const preferences = await this.preferences.get(userId);
          const remaining = preferences.blockedPeriods.filter(
            (period) => period.end <= range.start || period.start >= range.end,
          );
          await this.preferences.update(userId, { blockedPeriods: remaining });
          lines.push(
            `Removed ${preferences.blockedPeriods.length - remaining.length} blocked period(s).`,
          );
          scheduleAfterwards ??= {};
          break;
        }

        case 'find_time': {
          const preferences = await this.preferences.get(userId);
          const range = {
            start: command.rangeStart ? instantFromISO(command.rangeStart) : this.clock.now(),
            end: command.rangeEnd
              ? instantFromISO(command.rangeEnd)
              : this.clock.now() + days(preferences.planningHorizonDays),
          };
          if (command.preferredWindow) {
            extraBlocked = [
              ...extraBlocked,
              ...outsideWindowExclusions(range, command.preferredWindow, preferences.timezone),
            ];
          }
          const existing = await this.findTask(userId, command.purpose);
          const task =
            existing ??
            (await this.tasks.create({
              userId,
              title: command.purpose,
              estimatedMinutes: command.durationMinutes,
            }));
          if (!existing) createdTasks.push(task);
          lines.push(
            `${existing ? 'Found' : 'Created'} "${task.title}"; looking for ${formatMinutes(command.durationMinutes)}.`,
          );
          slots = await this.scheduling.findSlots({
            userId,
            durationMinutes: command.durationMinutes,
            range,
            limit: 5,
          });
          lines.push(
            slots.length === 0
              ? 'There is no free window of that length in the requested range.'
              : `Candidate windows: ${slots
                  .map((slot) => describeInterval(slot, ctx.timezone))
                  .join('; ')}.`,
          );
          scheduleAfterwards = { taskIds: [task.id], range };
          break;
        }

        case 'schedule_with_person': {
          if (!this.outreach) {
            lines.push(
              'Arranging something with someone needs the messaging integration. Set CALENDAR_AGENT_MESSAGING_ENABLED=true and start the bridge.',
            );
            break;
          }
          const outcome = await this.outreach.draft({
            userId,
            person: command.person,
            activity: command.activity,
            ...(command.durationMinutes === undefined
              ? {}
              : { durationMinutes: command.durationMinutes }),
            ...(command.withinDays === undefined ? {} : { withinDays: command.withinDays }),
            ...(command.rangeStart === undefined || command.rangeEnd === undefined
              ? {}
              : {
                  range: {
                    start: instantFromISO(command.rangeStart),
                    end: instantFromISO(command.rangeEnd),
                  },
                }),
            ...(command.tone === undefined ? {} : { tone: command.tone }),
          });

          switch (outcome.kind) {
            case 'drafted':
              // The draft is the answer. Saying it was "arranged" would imply
              // something reached another person, and nothing has.
              lines.push(
                `Drafted a message to ${outcome.outreach.displayName}:`,
                `"${outcome.outreach.message}"`,
                'Nothing has been sent - send it yourself, then mark it sent.',
              );
              break;
            case 'ambiguous':
              lines.push(
                `More than one "${command.person}" is in your contacts: ${outcome.candidates
                  .map((contact) => contact.displayName)
                  .join(', ')}. Which one?`,
              );
              break;
            case 'unknown':
              lines.push(`I could not find "${outcome.person}" in your contacts.`);
              break;
            case 'no_time': {
              // A bare "no free time" reads as broken to somebody looking at a
              // calendar with an obvious gap in it. Say how close it got.
              const shortfall =
                outcome.longestFreeMinutes > 0
                  ? `the longest free stretch is ${formatMinutes(outcome.longestFreeMinutes)}, short of the ${formatMinutes(outcome.neededMinutes)} it looked for`
                  : 'nothing is free in those hours at all';
              const buffer =
                outcome.bufferMinutes > 0 && outcome.longestFreeMinutes > 0
                  ? ` Your ${outcome.bufferMinutes}-minute buffer around meetings is counted in that.`
                  : '';
              lines.push(
                `No ${command.activity} fits for ${outcome.person}: ${shortfall}.${buffer}`,
              );
              if (outcome.nextAvailable) {
                lines.push(
                  `The next opening is ${describeInterval(outcome.nextAvailable, ctx.timezone)}. Ask again for that day, or for a shorter ${command.activity}.`,
                );
              }
              break;
            }
          }
          break;
        }

        case 'list_risks': {
          risks = await this.scheduling.risks(userId);
          lines.push(renderRiskSummary(risks));
          break;
        }

        case 'list_schedule': {
          const range = {
            start: command.rangeStart ? instantFromISO(command.rangeStart) : this.clock.now(),
            end: command.rangeEnd ? instantFromISO(command.rangeEnd) : this.clock.now() + days(1),
          };
          agenda = await this.scheduling.agenda(userId, range);
          lines.push(renderAgenda(agenda, ctx.timezone));
          break;
        }

        case 'list_tasks': {
          taskList = await this.tasks.list(userId, {
            includeCompleted: command.status !== undefined,
          });
          const filtered = command.status
            ? taskList.filter((task) => task.status === command.status)
            : taskList;
          taskList = filtered;
          lines.push(
            filtered.length === 0
              ? 'No tasks yet.'
              : filtered
                  .map(
                    (task) =>
                      `- ${task.title} (${formatMinutes(this.tasks.remaining(task))} left, ${task.priority})`,
                  )
                  .join('\n'),
          );
          break;
        }

        case 'explain_schedule': {
          const range =
            command.rangeStart && command.rangeEnd
              ? {
                  start: instantFromISO(command.rangeStart),
                  end: instantFromISO(command.rangeEnd),
                }
              : undefined;
          const preview = await this.scheduling.plan({
            userId,
            persist: false,
            ...(range ? { range } : {}),
          });
          plan = preview.plan;
          const titles = new Map(preview.tasks.map((task) => [task.id, task.title]));
          lines.push(
            await explainPlan(
              preview.plan,
              {
                timezone: ctx.timezone,
                question: command.question,
                ...(this.llm && this.llm.name !== 'none' ? { llm: this.llm } : {}),
              },
              titles,
            ),
          );
          break;
        }

        case 'request_clarification': {
          lines.push(command.question);
          break;
        }
      }
    }

    if (scheduleAfterwards) {
      const result = await this.scheduling.plan({
        userId,
        ...(scheduleAfterwards.taskIds ? { taskIds: scheduleAfterwards.taskIds } : {}),
        ...(scheduleAfterwards.range ? { range: scheduleAfterwards.range } : {}),
        ...(scheduleAfterwards.rebuild === undefined
          ? {}
          : { rebuild: scheduleAfterwards.rebuild }),
        ...(extraBlocked.length > 0 ? { extraBlocked } : {}),
      });
      plan = result.plan;
      changeSet = result.changeSet;
      changeSetId = result.changeSetId;
      const titles = new Map(result.tasks.map((task) => [task.id, task.title]));
      const proposal = renderProposal(result.plan, result.changeSet, titles);
      if (proposal) {
        lines.push(proposal);
      } else if (lines.filter(Boolean).length === 0) {
        // Nothing else was said, so the no-op re-plan is the whole answer.
        lines.push('Nothing to change - your current schedule already works.');
      }
    }

    const needsConfirmation = (changeSet?.pending.length ?? 0) > 0;
    return {
      reply: lines.filter(Boolean).join('\n\n'),
      needsConfirmation,
      ...(plan === undefined ? {} : { plan }),
      ...(changeSet === undefined ? {} : { changeSet }),
      ...(changeSetId === undefined ? {} : { changeSetId }),
      ...(risks === undefined ? {} : { risks }),
      ...(taskList === undefined ? {} : { tasks: taskList }),
      ...(createdTasks.length === 0 ? {} : { createdTasks }),
      ...(slots === undefined ? {} : { slots }),
      ...(agenda === undefined ? {} : { agenda }),
    };
  }

  private async resolveMany(userId: UserId, refs: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const ref of refs) ids.push((await this.tasks.resolve(userId, ref)).id);
    return ids;
  }

  private async findTask(userId: UserId, reference: string): Promise<Task | undefined> {
    try {
      return await this.tasks.resolve(userId, reference);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'NOT_FOUND') return undefined;
      return undefined;
    }
  }

  private async ensureConversation(input: AgentTurnInput, now: Instant): Promise<string> {
    if (input.conversationId) {
      const existing = await this.db.conversations.getConversation(input.conversationId);
      if (existing) {
        await this.db.conversations.saveConversation({ ...existing, updatedAt: now });
        return existing.id;
      }
    }
    const conversation = {
      id: input.conversationId ?? this.ids.next('conv'),
      userId: input.userId,
      title: input.text.slice(0, 60),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.conversations.saveConversation(conversation);
    return conversation.id;
  }

  /**
   * Recent turns, oldest first, so a follow-up like "make it an hour" can be
   * resolved against what was already said. Only user and assistant turns are
   * included; tool and system records are bookkeeping.
   */
  private async history(
    conversationId: string,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const stored = await this.db.conversations.listMessages(
      conversationId,
      AgentService.HISTORY_TURNS,
    );
    return stored
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
  }

  private async record(conversationId: string, content: string, now: Instant): Promise<void> {
    await this.db.conversations.appendMessage({
      id: this.ids.next('msg'),
      conversationId,
      role: 'assistant',
      content,
      createdAt: now,
    });
  }
}

function summariseWorkingHours(schedule: Record<string, unknown>): string {
  const entries = Object.entries(schedule).filter(([, windows]) => Array.isArray(windows));
  if (entries.length === 0) return 'not configured';
  return entries
    .map(([day, windows]) => {
      const list = windows as {
        start: { hour: number; minute: number };
        end: { hour: number; minute: number };
      }[];
      const text = list
        .map(
          (window) =>
            `${pad(window.start.hour)}:${pad(window.start.minute)}-${pad(window.end.hour)}:${pad(window.end.minute)}`,
        )
        .join(', ');
      return `${day.slice(0, 3)} ${text}`;
    })
    .join('; ');
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * The scheduling outcome, or nothing at all.
 *
 * Most turns that touch the calendar trigger a re-plan, and most re-plans find
 * nothing to do. Saying so is noise: the reply should end after the sentence
 * describing what actually happened, so `undefined` means "no news".
 */
function renderProposal(
  plan: SchedulingPlan,
  changeSet: ChangeSet,
  titles: ReadonlyMap<string, string>,
): string | undefined {
  const { added, moved, removed } = plan.diff;
  const changed = added.length + moved.length + removed.length;
  if (changed === 0 && plan.unscheduled.length === 0 && changeSet.blocked.length === 0) {
    return undefined;
  }

  // No lead-in: the +/~/-/! lines say what they are, and the change-set
  // summary below already carries the counts and what will happen to them.
  const lines: string[] = [];
  for (const entry of added) {
    lines.push(`+ ${describeInterval(entry.after!, plan.timezone)}  ${entry.taskTitle}`);
  }
  for (const entry of moved) {
    lines.push(
      `~ ${entry.taskTitle}: ${describeInterval(entry.before!, plan.timezone)} -> ${describeInterval(entry.after!, plan.timezone)}`,
    );
  }
  for (const entry of removed) {
    lines.push(`- ${describeInterval(entry.before!, plan.timezone)}  ${entry.taskTitle}`);
  }
  for (const entry of plan.unscheduled) {
    lines.push(`! ${titles.get(entry.taskId) ?? entry.title}: ${entry.reason.message}`);
  }
  if (changed > 0) lines.push('', changeSet.summary);
  return lines.join('\n');
}

function renderAgenda(
  agenda: Awaited<ReturnType<SchedulingService['agenda']>>,
  timezone: string,
): string {
  const rows = [
    ...agenda.events.map((event) => ({
      start: event.start,
      text: `${describeInterval(event, timezone)}  ${event.title}`,
    })),
    ...agenda.blocks.map((block) => ({
      start: block.start,
      text: `${describeInterval(block, timezone)}  ${block.title} [task]`,
    })),
  ].sort((a, b) => a.start - b.start);
  return rows.length === 0 ? 'Nothing scheduled.' : rows.map((row) => row.text).join('\n');
}

/** Everything in `range` outside the given local window, as blocked periods. */
function outsideWindowExclusions(
  range: Interval,
  window: { start: string; end: string },
  timezone: string,
): NamedInterval[] {
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  const exclusions: NamedInterval[] = [];
  for (const dayKey of eachLocalDay(range, timezone)) {
    const day = localDayInterval(dayKey, timezone);
    const windowStart = zonedInstant(dayKey, start, timezone);
    const windowEnd = zonedInstant(dayKey, end, timezone);
    if (day.start < windowStart) {
      exclusions.push({ start: day.start, end: windowStart, label: 'outside requested window' });
    }
    if (windowEnd < day.end) {
      exclusions.push({ start: windowEnd, end: day.end, label: 'outside requested window' });
    }
  }
  return exclusions;
}
