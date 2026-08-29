import { Command } from 'commander';
import type { AppContext } from '@calendar-agent/app';
import { createApp } from '@calendar-agent/app';
import type { AppConfig } from '@calendar-agent/config';
import { loadConfig } from '@calendar-agent/config';
import type { Interval, Task, TaskId } from '@calendar-agent/core';
import {
  DomainError,
  days,
  instantToISO,
  localDayInterval,
  localDayKey,
} from '@calendar-agent/core';
import { parseDeadline, parseDurationMinutes } from '@calendar-agent/agent';
import type { DataScope } from '@calendar-agent/app';
import { DATA_SCOPES } from '@calendar-agent/app';
import {
  bold,
  dim,
  formatAgenda,
  formatExplanation,
  formatPlan,
  formatRisks,
  formatSlots,
  formatTasks,
  green,
  shortId,
  red,
  table,
  yellow,
} from './format.js';

export interface CliOptions {
  /** Injected by tests; production builds the app from the config file. */
  readonly appFactory?: (config: AppConfig) => Promise<AppContext>;
  readonly out?: (line: string) => void;
  readonly errOut?: (line: string) => void;
}

interface GlobalFlags {
  json?: boolean;
  config?: string;
  timezone?: string;
}

/**
 * The CLI is a thin transport. Every command resolves to an application
 * service call; no scheduling or calendar logic lives here.
 */
export function buildProgram(options: CliOptions = {}): Command {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const errOut = options.errOut ?? ((line: string) => process.stderr.write(`${line}\n`));

  const program = new Command();
  program
    .name('calendar-agent')
    .description('Open-source local-first AI scheduling assistant')
    .version('0.1.0')
    .option('--json', 'output machine-readable JSON')
    .option('-c, --config <path>', 'path to a configuration file')
    .option('--timezone <tz>', 'override the configured timezone')
    .showHelpAfterError();

  const withApp = async <T>(
    handler: (app: AppContext, flags: GlobalFlags) => Promise<T>,
  ): Promise<T> => {
    const flags = program.opts<GlobalFlags>();
    const config = loadConfig(flags.config ? { configPath: flags.config } : {});
    const resolved: AppConfig = flags.timezone
      ? {
          ...config,
          timezone: flags.timezone,
          preferences: { ...config.preferences, timezone: flags.timezone },
        }
      : config;
    const app = options.appFactory ? await options.appFactory(resolved) : await createApp(resolved);
    try {
      return await handler(app, flags);
    } finally {
      await app.shutdown();
    }
  };

  const emit = (flags: GlobalFlags, data: unknown, text: string): void => {
    out(flags.json ? JSON.stringify(data, null, 2) : text);
  };

  /**
   * How to approve is surface-specific: the web UI has buttons, so the hint
   * belongs here rather than in the shared agent reply.
   */
  const withApproveHint = (result: {
    reply: string;
    needsConfirmation: boolean;
    changeSetId?: string;
  }): string =>
    result.needsConfirmation && result.changeSetId
      ? `${result.reply}\n\nApprove with: calendar-agent approve ${result.changeSetId}`
      : result.reply;

  // ---- tasks ---------------------------------------------------------------
  const tasks = program.command('tasks').description('manage tasks');

  tasks
    .command('list', { isDefault: true })
    .description('list tasks')
    .option('-a, --all', 'include completed and cancelled tasks')
    .option('--risks', 'include deadline risk for each task')
    .action(async (opts: { all?: boolean; risks?: boolean }) => {
      await withApp(async (app, flags) => {
        const list = await app.tasks.list(app.user.id, { includeCompleted: opts.all === true });
        const risks = opts.risks ? await app.scheduling.risks(app.user.id) : undefined;
        emit(flags, { tasks: list, risks }, formatTasks(list, app.config.timezone, risks));
      });
    });

  tasks
    .command('add <title...>')
    .description('add a task')
    .option('-d, --duration <duration>', 'estimated effort, e.g. 90m or 4h', '1h')
    .option('--due <when>', 'deadline, e.g. "friday 5pm" or an ISO timestamp')
    .option('--start-after <when>', 'earliest time work may begin')
    .option('-p, --priority <priority>', 'low | normal | high | urgent', 'normal')
    .option('--importance <n>', 'long-term importance 0-100')
    .option('--min-block <duration>', 'minimum contiguous block')
    .option('--max-block <duration>', 'maximum contiguous block')
    .option('--max-daily <duration>', 'most time to spend on this task in one day')
    .option('--no-split', 'require a single contiguous block')
    .option('--focus <level>', 'deep | shallow | any')
    .option('--tags <tags>', 'comma separated tags')
    .action(async (titleParts: string[], opts: Record<string, string | boolean | undefined>) => {
      await withApp(async (app, flags) => {
        const title = titleParts.join(' ');
        const now = app.clock.now();
        const timezone = app.config.timezone;
        const task = await app.tasks.create({
          userId: app.user.id,
          title,
          estimatedMinutes: requireDuration(String(opts.duration ?? '1h')),
          ...(opts.due ? { deadline: requireInstant(String(opts.due), now, timezone) } : {}),
          ...(opts.startAfter
            ? { earliestStart: requireInstant(String(opts.startAfter), now, timezone) }
            : {}),
          priority: String(opts.priority ?? 'normal') as Task['priority'],
          ...(opts.importance === undefined ? {} : { importance: Number(opts.importance) }),
          ...(opts.minBlock ? { minimumBlockMinutes: requireDuration(String(opts.minBlock)) } : {}),
          ...(opts.maxBlock ? { maximumBlockMinutes: requireDuration(String(opts.maxBlock)) } : {}),
          ...(opts.maxDaily ? { maxDailyMinutes: requireDuration(String(opts.maxDaily)) } : {}),
          allowSplitting: opts.split !== false,
          ...(opts.focus ? { focus: String(opts.focus) as Task['focus'] } : {}),
          ...(opts.tags
            ? {
                tags: String(opts.tags)
                  .split(',')
                  .map((tag) => tag.trim()),
              }
            : {}),
        });
        emit(
          flags,
          task,
          `${green('Added')} ${bold(task.title)} (${task.id})\n${dim('Run "calendar-agent schedule" to plan it.')}`,
        );
      });
    });

  tasks
    .command('done <task>')
    .description('mark a task complete')
    .action(async (reference: string) => {
      await withApp(async (app, flags) => {
        const task = await app.tasks.resolve(app.user.id, reference);
        const done = await app.tasks.complete(task.id);
        emit(flags, done, `${green('Completed')} ${done.title}`);
      });
    });

  tasks
    .command('log <task> <duration>')
    .description('record time spent on a task')
    .action(async (reference: string, duration: string) => {
      await withApp(async (app, flags) => {
        const task = await app.tasks.resolve(app.user.id, reference);
        const updated = await app.tasks.logProgress(task.id, requireDuration(duration));
        emit(
          flags,
          updated,
          `Logged ${duration} on ${updated.title}; ${app.tasks.remaining(updated)} minutes remain.`,
        );
      });
    });

  tasks
    .command('rm <task>')
    .description('delete a task and its blocks')
    .action(async (reference: string) => {
      await withApp(async (app, flags) => {
        const task = await app.tasks.resolve(app.user.id, reference);
        await app.tasks.delete(task.id);
        emit(flags, { deleted: task.id }, `${yellow('Deleted')} ${task.title}`);
      });
    });

  // ---- scheduling ----------------------------------------------------------
  program
    .command('schedule')
    .description('plan work into your calendar (simulation by default)')
    .option('-t, --task <task>', 'limit planning to one task', collect, [] as string[])
    .option('--days <n>', 'planning horizon in days')
    .option('--rebuild', 'ignore the existing plan and rebuild it')
    .option('--apply', 'apply the resulting changes instead of only proposing them')
    .option('--dry-run', 'explicitly request a simulation (the default)')
    .option('--explain', 'print the full scheduling trace')
    .action(
      async (opts: {
        task?: string[];
        days?: string;
        rebuild?: boolean;
        apply?: boolean;
        explain?: boolean;
      }) => {
        await withApp(async (app, flags) => {
          const taskIds: TaskId[] = [];
          for (const reference of opts.task ?? []) {
            taskIds.push((await app.tasks.resolve(app.user.id, reference)).id);
          }
          const range = opts.days
            ? { start: app.clock.now(), end: app.clock.now() + days(Number(opts.days)) }
            : undefined;

          const result = await app.scheduling.plan({
            userId: app.user.id,
            ...(taskIds.length > 0 ? { taskIds } : {}),
            ...(range ? { range } : {}),
            ...(opts.rebuild ? { rebuild: true } : {}),
          });

          const titles = new Map(result.tasks.map((task) => [task.id, task.title]));
          let applied = false;
          if (opts.apply) {
            const outcome = await app.scheduling.approve(result.changeSetId, {
              userId: app.user.id,
            });
            applied = outcome.failures.length === 0;
            if (outcome.failures.length > 0) {
              errOut(red(`${outcome.failures.length} change(s) failed:`));
              for (const failure of outcome.failures) errOut(`  ${failure.id}: ${failure.error}`);
            }
          }

          const text = [
            formatPlan(result.plan, result.changeSet, titles, { applied }),
            ...(opts.explain ? ['', formatExplanation(result.plan, titles)] : []),
          ].join('\n');
          emit(flags, { plan: result.plan, changeSet: result.changeSet, applied }, text);
        });
      },
    );

  program
    .command('approve <changeSetId>')
    .description('apply a proposed set of calendar changes')
    .action(async (changeSetId: string) => {
      await withApp(async (app, flags) => {
        const result = await app.scheduling.approve(changeSetId, { userId: app.user.id });
        const text = [
          `${green('Applied')} ${result.appliedMutations} calendar change(s).`,
          ...result.skipped.map((entry) => dim(`skipped ${entry.id}: ${entry.reason}`)),
          ...result.failures.map((entry) => red(`failed ${entry.id}: ${entry.error}`)),
        ].join('\n');
        emit(flags, result, text);
      });
    });

  program
    .command('reject <changeSetId>')
    .description('discard a proposed set of calendar changes')
    .action(async (changeSetId: string) => {
      await withApp(async (app, flags) => {
        await app.scheduling.reject(changeSetId);
        emit(flags, { rejected: changeSetId }, `${yellow('Rejected')} ${changeSetId}`);
      });
    });

  program
    .command('risks')
    .description('show tasks whose deadlines are at risk')
    .action(async () => {
      await withApp(async (app, flags) => {
        const risks = await app.scheduling.risks(app.user.id);
        emit(flags, risks, formatRisks(risks));
      });
    });

  program
    .command('today')
    .description("show today's schedule")
    .action(async () => {
      await withApp(async (app, flags) => {
        const range = dayRange(app, 0);
        const agenda = await app.scheduling.agenda(app.user.id, range);
        emit(flags, agenda, formatAgenda(agenda, app.config.timezone));
      });
    });

  program
    .command('tomorrow')
    .description("show tomorrow's schedule")
    .action(async () => {
      await withApp(async (app, flags) => {
        const range = dayRange(app, 1);
        const agenda = await app.scheduling.agenda(app.user.id, range);
        emit(flags, agenda, formatAgenda(agenda, app.config.timezone));
      });
    });

  program
    .command('agenda')
    .description('show the schedule over a number of days')
    .option('--days <n>', 'how many days to show', '7')
    .action(async (opts: { days?: string }) => {
      await withApp(async (app, flags) => {
        const range: Interval = {
          start: app.clock.now(),
          end: app.clock.now() + days(Number(opts.days ?? 7)),
        };
        const agenda = await app.scheduling.agenda(app.user.id, range);
        emit(flags, agenda, formatAgenda(agenda, app.config.timezone));
      });
    });

  program
    .command('free <duration>')
    .description('find free windows of at least this length')
    .option('--days <n>', 'how far ahead to look', '7')
    .option('--deep', 'only deep-work windows')
    .action(async (duration: string, opts: { days?: string; deep?: boolean }) => {
      await withApp(async (app, flags) => {
        const slots = await app.scheduling.findSlots({
          userId: app.user.id,
          durationMinutes: requireDuration(duration),
          range: { start: app.clock.now(), end: app.clock.now() + days(Number(opts.days ?? 7)) },
          ...(opts.deep ? { deepWorkOnly: true } : {}),
        });
        emit(flags, slots, formatSlots(slots, app.config.timezone));
      });
    });

  // ---- calendars -----------------------------------------------------------
  program
    .command('sync')
    .description('pull calendar changes and detect external edits')
    .option('--full', 'ignore sync cursors and refetch everything')
    .action(async (opts: { full?: boolean }) => {
      await withApp(async (app, flags) => {
        const report = await app.sync.sync({
          userId: app.user.id,
          ...(opts.full ? { full: true } : {}),
        });
        const rows = report.calendars.map((calendar) => [
          calendar.name,
          `${calendar.fetched} fetched`,
          `${calendar.created} new`,
          `${calendar.deleted} removed`,
          calendar.incremental ? dim('incremental') : dim('full'),
        ]);
        const text = [
          ...report.calendarsAdded.map((name) => green(`+ calendar discovered: ${name}`)),
          ...report.calendarsRemoved.map((name) =>
            yellow(`- calendar removed (deleted on the provider): ${name}`),
          ),
          report.calendars.length === 0 ? dim('No calendars connected.') : table(rows),
          ...report.errors.map((error) => red(`${error.calendarId}: ${error.message}`)),
          report.needsReplan
            ? yellow('External changes detected. Run "calendar-agent schedule" to react.')
            : dim('No external changes.'),
        ].join('\n');
        emit(flags, report, text);
      });
    });

  program
    .command('calendars')
    .description('list connected calendars')
    .option('--use <calendarId>', 'write task blocks to this calendar')
    .option('--include <calendarId>', 'include this calendar when finding free time')
    .option('--exclude <calendarId>', 'ignore this calendar when finding free time')
    .action(async (opts: { use?: string; include?: string; exclude?: string }) => {
      await withApp(async (app, flags) => {
        if (opts.use) await app.calendars.updateCalendarOptions(opts.use, { isTaskTarget: true });
        if (opts.include) {
          await app.calendars.updateCalendarOptions(opts.include, { includeInAvailability: true });
        }
        if (opts.exclude) {
          await app.calendars.updateCalendarOptions(opts.exclude, { includeInAvailability: false });
        }
        const calendars = await app.calendars.listCalendars(app.user.id);
        const rows = calendars.map((calendar) => [
          calendar.id,
          calendar.name,
          calendar.provider,
          calendar.isTaskTarget ? green('task target') : '',
          calendar.includeInAvailability ? '' : dim('ignored'),
        ]);
        emit(
          flags,
          calendars,
          calendars.length === 0
            ? dim('No calendars. Run "calendar-agent connect google".')
            : table(rows, ['ID', 'NAME', 'PROVIDER', '', '']),
        );
      });
    });

  program
    .command('connect <provider>')
    .description('start the OAuth flow for a calendar provider')
    .action(async (providerId: string) => {
      await withApp(async (app, flags) => {
        const oauth = app.registry.oauth(providerId);
        if (!oauth) {
          throw new DomainError(
            'VALIDATION_ERROR',
            `No credentials configured for "${providerId}". Set its client id and secret in .env, then restart.`,
          );
        }
        // The server owns the OAuth state, so the flow must start there:
        // a URL minted here would be rejected by the callback as unknown state.
        const url = `${app.config.server.publicUrl}/api/oauth/${providerId}/start`;
        emit(
          flags,
          { provider: providerId, url },
          [
            `Start the ${providerId} authorisation by opening:`,
            '',
            bold(url),
            '',
            dim('The server must be running (npm start) - it completes the flow and'),
            dim('imports your calendars. Then run "calendar-agent calendars".'),
          ].join('\n'),
        );
      });
    });

  // ---- categories ----------------------------------------------------------
  const categories = program.command('categories').description('colour and group your work');

  categories
    .command('list', { isDefault: true })
    .description('list categories')
    .action(async () => {
      await withApp(async (app, flags) => {
        const usage = await app.categories.usage(app.user.id);
        const rows = usage.map((entry) => [
          shortId(entry.category.id),
          entry.category.color,
          entry.category.name,
          entry.category.isDefault ? green('default') : '',
          entry.category.matchPattern ?? dim('-'),
          `${entry.taskCount} task(s), ${entry.eventCount} event(s)`,
        ]);
        emit(
          flags,
          usage,
          rows.length === 0
            ? dim('No categories yet.')
            : table(rows, ['ID', 'COLOUR', 'NAME', '', 'MATCHES', 'USED BY']),
        );
      });
    });

  categories
    .command('add <name...>')
    .description('add a category')
    .option('--color <hex>', 'colour, e.g. #5b8def')
    .option('--match <pattern>', 'auto-assign to events whose title matches this regex')
    .option('--calendar <calendarId>', 'auto-assign to everything on a calendar')
    .option('--default', 'use for anything unmatched')
    .action(async (nameParts: string[], opts: Record<string, string | boolean | undefined>) => {
      await withApp(async (app, flags) => {
        const category = await app.categories.create(app.user.id, {
          name: nameParts.join(' '),
          ...(opts.color ? { color: String(opts.color) } : {}),
          ...(opts.match ? { matchPattern: String(opts.match) } : {}),
          ...(opts.calendar ? { calendarId: String(opts.calendar) } : {}),
          ...(opts.default ? { isDefault: true } : {}),
        });
        emit(flags, category, `${green('Added')} ${category.name} (${category.color})`);
      });
    });

  categories
    .command('edit <category>')
    .description('rename, recolour or re-target a category')
    .option('--name <name>', 'new name')
    .option('--color <hex>', 'new colour, e.g. #b8453f')
    .option('--match <pattern>', 'auto-assign to titles matching this regex')
    .option('--no-match', 'stop auto-matching by title')
    .option('--calendar <calendarId>', 'auto-assign to everything on a calendar')
    .option('--default', 'use for anything unmatched')
    .action(async (reference: string, opts: Record<string, string | boolean | undefined>) => {
      await withApp(async (app, flags) => {
        const target = await resolveCategory(app, reference);
        const updated = await app.categories.update(target.id, {
          ...(opts.name ? { name: String(opts.name) } : {}),
          ...(opts.color ? { color: String(opts.color) } : {}),
          ...(opts.match === false ? { matchPattern: '' } : {}),
          ...(typeof opts.match === 'string' ? { matchPattern: opts.match } : {}),
          ...(opts.calendar ? { calendarId: String(opts.calendar) } : {}),
          ...(opts.default ? { isDefault: true } : {}),
        });
        emit(
          flags,
          updated,
          `${green('Updated')} ${bold(updated.name)} (${updated.color})${
            updated.matchPattern ? dim(` matching /${updated.matchPattern}/i`) : ''
          }`,
        );
      });
    });

  categories
    .command('rm <category>')
    .description('delete a category and unassign it from everything')
    .action(async (reference: string) => {
      await withApp(async (app, flags) => {
        const target = await resolveCategory(app, reference);
        const result = await app.categories.delete(target.id);
        emit(
          flags,
          result,
          `${yellow('Deleted')} category; unassigned ${result.tasksUnassigned} task(s) and ${result.eventsUnassigned} event(s).`,
        );
      });
    });

  // ---- data management -------------------------------------------------------
  const data = program.command('data').description('inspect and clean up stored data');

  data
    .command('stats', { isDefault: true })
    .description('what is stored, and what looks stale')
    .action(async () => {
      await withApp(async (app, flags) => {
        const stats = await app.maintenance.stats(app.user.id);
        const rows = Object.entries(stats.counts).map(([name, count]) => [name, String(count)]);
        const warnings = [
          ['stale blocks (task gone)', stats.staleBlocks],
          ['detached blocks', stats.detachedBlocks],
          ['orphaned events (calendar gone)', stats.orphanedEvents],
          ['orphaned sync records', stats.orphanedSyncRecords],
        ].filter(([, count]) => Number(count) > 0);

        const text = [
          table(rows, ['TABLE', 'ROWS']),
          '',
          warnings.length === 0
            ? green('Nothing stale.')
            : table(
                warnings.map(([name, count]) => [yellow(String(name)), String(count)]),
                ['STALE', 'COUNT'],
              ),
          warnings.length === 0 ? '' : dim('Clean up with: calendar-agent data prune --yes'),
        ].join('\n');
        emit(flags, stats, text);
      });
    });

  data
    .command('prune')
    .description('remove old history and orphaned rows (simulation by default)')
    .option('--before <when>', 'delete history older than this', '90 days ago')
    .option('--days <n>', 'keep this many days of history', '90')
    .option('--conversations', 'include old agent conversations')
    .option('--yes', 'actually delete (without this it only reports)')
    .action(async (opts: { days?: string; conversations?: boolean; yes?: boolean }) => {
      await withApp(async (app, flags) => {
        const report = await app.maintenance.prune({
          userId: app.user.id,
          before: app.clock.now() - days(Number(opts.days ?? 90)),
          dryRun: !opts.yes,
          ...(opts.conversations ? { includeConversations: true } : {}),
        });
        const text = [
          report.dryRun ? bold('WOULD DELETE') : bold('DELETED'),
          table([
            ['events', String(report.events)],
            ['blocks', String(report.blocks)],
            ['change sets', String(report.changeSets)],
            ['conversations', String(report.conversations)],
          ]),
          '',
          report.dryRun ? dim('Nothing was deleted. Re-run with --yes to apply.') : green('Done.'),
        ].join('\n');
        emit(flags, report, text);
      });
    });

  data
    .command('reset')
    .description('delete stored data by scope (simulation by default)')
    .option('--scope <scope>', 'repeatable; defaults to everything', collect, [] as string[])
    .option('--yes', 'actually delete (without this it only reports)')
    .action(async (opts: { scope?: string[]; yes?: boolean }) => {
      await withApp(async (app, flags) => {
        const scopes = (opts.scope?.length ? opts.scope : DATA_SCOPES) as DataScope[];
        const report = await app.maintenance.reset({
          userId: app.user.id,
          scopes,
          confirm: opts.yes === true,
          dryRun: !opts.yes,
        });
        const rows = Object.entries(report.deleted).map(([name, count]) => [name, String(count)]);
        const text = [
          report.dryRun ? bold('WOULD DELETE') : red(bold('DELETED')),
          dim(`scopes: ${scopes.join(', ')}`),
          table(rows, ['TABLE', 'ROWS']),
          '',
          report.dryRun
            ? dim('Nothing was deleted. Re-run with --yes to apply. This cannot be undone.')
            : green('Done. Run "calendar-agent sync" to repopulate from your calendars.'),
        ].join('\n');
        emit(flags, report, text);
      });
    });

  // ---- diagnostics ---------------------------------------------------------
  program
    .command('doctor')
    .description('check that the installation is healthy')
    .action(async () => {
      await withApp(async (app, flags) => {
        const report = await app.doctor.run(app.user.id);
        const icon = { ok: green('ok  '), warn: yellow('warn'), fail: red('fail') };
        const text = report.checks
          .map((check) => `${icon[check.status]} ${check.name.padEnd(20)} ${check.detail}`)
          .join('\n');
        emit(flags, report, text);
        if (report.status === 'fail') process.exitCode = 1;
      });
    });

  program
    .command('config')
    .description('show the resolved configuration')
    .action(async () => {
      await withApp(async (app, flags) => {
        const preferences = await app.preferences.get(app.user.id);
        const redacted = {
          ...app.config,
          llm: { ...app.config.llm, apiKey: app.config.llm.apiKey ? '***' : undefined },
          google: {
            ...app.config.google,
            clientSecret: app.config.google.clientSecret ? '***' : undefined,
          },
          microsoft: {
            ...app.config.microsoft,
            clientSecret: app.config.microsoft.clientSecret ? '***' : undefined,
          },
          preferences,
        };
        emit(flags, redacted, JSON.stringify(redacted, null, 2));
      });
    });

  // ---- natural language ----------------------------------------------------
  program
    .command('ask <request...>')
    .description('ask in plain language, e.g. "find me 2 hours tomorrow for my ML project"')
    .action(async (parts: string[]) => {
      await withApp(async (app, flags) => {
        const result = await app.agent.handle({ userId: app.user.id, text: parts.join(' ') });
        emit(flags, result, withApproveHint(result));
      });
    });

  // A bare `calendar-agent "..."` is treated as `ask`.
  program.arguments('[request...]').action(async (parts: string[] = []) => {
    if (parts.length === 0) {
      program.outputHelp();
      return;
    }
    await withApp(async (app, flags) => {
      const result = await app.agent.handle({ userId: app.user.id, text: parts.join(' ') });
      emit(flags, result, withApproveHint(result));
    });
  });

  return program;
}

/** Accept a category id, a unique id prefix, or its name. */
async function resolveCategory(
  app: AppContext,
  reference: string,
): Promise<{ id: string; name: string }> {
  const categories = await app.categories.list(app.user.id);
  const lower = reference.trim().toLowerCase();
  const byName = categories.filter((category) => category.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  const byId = categories.filter((category) => category.id.includes(reference.trim()));
  if (byId.length === 1) return byId[0]!;
  throw new DomainError(
    'NOT_FOUND',
    `No category matches "${reference}". Known: ${categories.map((c) => c.name).join(', ')}.`,
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requireDuration(text: string): number {
  const minutes = parseDurationMinutes(text);
  if (minutes === undefined) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Could not read "${text}" as a duration. Try 90m, 2h or 1h30m.`,
    );
  }
  return minutes;
}

function requireInstant(text: string, now: number, timezone: string): number {
  const direct = Date.parse(text);
  if (!Number.isNaN(direct)) return direct;
  const parsed = parseDeadline(text, now, timezone);
  if (parsed === undefined) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Could not read "${text}" as a date. Try "friday", "tomorrow 5pm" or an ISO timestamp.`,
    );
  }
  return parsed;
}

function dayRange(app: AppContext, offsetDays: number): Interval {
  const timezone = app.config.timezone;
  const dayKey = localDayKey(app.clock.now() + days(offsetDays), timezone);
  return localDayInterval(dayKey, timezone);
}

export { instantToISO };
