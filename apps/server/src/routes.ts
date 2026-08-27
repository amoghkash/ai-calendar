import { Router } from 'express';
import type { AppContext, BackgroundSync, DataScope, OutreachPoller } from '@calendar-agent/app';
import { DATA_SCOPES, dailyWindowList, weekdayList } from '@calendar-agent/app';
import type {
  Attendee,
  AvailabilityBasis,
  Interval,
  OutreachTone,
  Task,
  Transparency,
} from '@calendar-agent/core';
import {
  OUTREACH_TONES,
  ValidationError,
  isOutreachTone,
  days,
  instantFromISO,
  localDayInterval,
  localDayKey,
} from '@calendar-agent/core';
import { asyncRoute } from './http-errors.js';

/** Reject an unknown tone rather than silently falling back to the default. */
function parseTone(value: unknown): OutreachTone {
  if (isOutreachTone(value)) return value;
  throw new ValidationError(`"tone" must be one of: ${OUTREACH_TONES.join(', ')}.`);
}

/** Reject an unknown basis rather than silently falling back to the default. */
function parseBasis(value: unknown): AvailabilityBasis {
  if (value === 'working_hours' || value === 'waking_hours') return value;
  throw new ValidationError('"basis" must be "working_hours" or "waking_hours".');
}

function range(query: Record<string, unknown>, now: number, defaultDays: number): Interval {
  const start = typeof query.start === 'string' ? instantFromISO(query.start) : now;
  const end = typeof query.end === 'string' ? instantFromISO(query.end) : start + days(defaultDays);
  if (end <= start) throw new ValidationError('"end" must be after "start".');
  return { start, end };
}

/**
 * The full guest list, or undefined when the request does not mention guests.
 *
 * An empty array is meaningful - it clears the list - so it must survive as an
 * array rather than collapsing into "not supplied".
 */
function parseAttendees(value: unknown): readonly Attendee[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ValidationError('"attendees" must be an array.');
  return value.map((entry, index) => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const email = typeof raw.email === 'string' ? raw.email.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ValidationError(`Guest ${index + 1} needs a valid email address.`);
    }
    return {
      email,
      ...(typeof raw.name === 'string' && raw.name.trim().length > 0
        ? { name: raw.name.trim() }
        : {}),
      ...(raw.optional === undefined ? {} : { optional: Boolean(raw.optional) }),
      // The RSVP belongs to the guest, so it is only ever echoed back, never set
      // here: dropping it would reset everyone to "no response" on each edit.
      ...(typeof raw.response === 'string'
        ? { response: raw.response as Attendee['response'] }
        : {}),
      ...(raw.self === undefined ? {} : { self: Boolean(raw.self) }),
      ...(raw.organizer === undefined ? {} : { organizer: Boolean(raw.organizer) }),
    };
  });
}

/** `busy`/`free` on the wire; `opaque`/`transparent` in the domain. */
function parseTransparency(value: unknown): Transparency | undefined {
  if (value === undefined) return undefined;
  if (value === 'opaque' || value === 'busy') return 'opaque';
  if (value === 'transparent' || value === 'free') return 'transparent';
  throw new ValidationError('"transparency" must be "busy" or "free".');
}

/**
 * REST surface for the web UI. Every handler delegates to an application
 * service - the same ones the CLI uses - so behaviour cannot diverge.
 */
export function buildRoutes(
  app: AppContext,
  backgroundSync?: BackgroundSync,
  outreachPoller?: OutreachPoller,
): Router {
  const router = Router();
  const userId = app.user.id;

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0', timezone: app.config.timezone });
  });

  router.get(
    '/state',
    asyncRoute(async (_req, res) => {
      const now = app.clock.now();
      // Anchored to the start of the local day, not to `now`. A horizon that
      // begins at the current instant hides everything that already happened
      // today, which reads as the morning's events having been deleted.
      const preferences = await app.preferences.get(userId);
      const horizon = {
        start: localDayInterval(localDayKey(now, preferences.timezone), preferences.timezone).start,
        end: now + days(14),
      };
      const [tasks, agenda, calendars, risks, settings] = await Promise.all([
        app.tasks.list(userId),
        app.scheduling.agenda(userId, horizon),
        app.calendars.listCalendars(userId),
        app.scheduling.risks(userId),
        app.settings.get(userId),
      ]);
      const colors = await app.categories.colorMap(userId, tasks, agenda.events, agenda.blocks);
      res.json({
        user: app.user,
        now,
        timezone: preferences.timezone,
        categories: colors.categories,
        categoryByTask: colors.byTask,
        categoryByEvent: colors.byEvent,
        categoryByBlock: colors.byBlock,
        automationMode: preferences.automation.mode,
        llm: { provider: app.llm.name, model: app.llm.model },
        weekStart: settings.weekStart,
        tasks,
        events: agenda.events,
        blocks: agenda.blocks,
        preferences,
        calendars,
        risks,
      });
    }),
  );

  // ---- tasks ---------------------------------------------------------------
  router.get(
    '/tasks',
    asyncRoute(async (req, res) => {
      res.json(await app.tasks.list(userId, { includeCompleted: req.query.all === 'true' }));
    }),
  );

  router.post(
    '/tasks',
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        throw new ValidationError('A task needs a title.');
      }
      const task = await app.tasks.create({
        userId,
        title: body.title,
        estimatedMinutes: Number(body.estimatedMinutes ?? 60),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.deadline === 'string' ? { deadline: instantFromISO(body.deadline) } : {}),
        ...(typeof body.earliestStart === 'string'
          ? { earliestStart: instantFromISO(body.earliestStart) }
          : {}),
        ...(typeof body.priority === 'string'
          ? { priority: body.priority as Task['priority'] }
          : {}),
        ...(body.importance === undefined ? {} : { importance: Number(body.importance) }),
        ...(body.minimumBlockMinutes === undefined
          ? {}
          : { minimumBlockMinutes: Number(body.minimumBlockMinutes) }),
        ...(body.allowSplitting === undefined
          ? {}
          : { allowSplitting: Boolean(body.allowSplitting) }),
        ...(typeof body.focus === 'string' ? { focus: body.focus as Task['focus'] } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
        ...(body.preferredWindows === undefined
          ? {}
          : { preferredWindows: dailyWindowList(body.preferredWindows, 'preferredWindows') }),
        ...(body.preferredDays === undefined
          ? {}
          : { preferredDays: weekdayList(body.preferredDays, 'preferredDays') }),
      });
      res.status(201).json(task);
    }),
  );

  router.patch(
    '/tasks/:id',
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const changes: Record<string, unknown> = { ...body };
      if (typeof body.deadline === 'string') changes.deadline = instantFromISO(body.deadline);
      if (body.deadline === null) changes.deadline = undefined;
      if (typeof body.earliestStart === 'string') {
        changes.earliestStart = instantFromISO(body.earliestStart);
      }
      // These two reach the scheduler's placement filter directly, so they are
      // parsed rather than merged raw like the rest of the body.
      if (body.preferredWindows !== undefined) {
        changes.preferredWindows = dailyWindowList(body.preferredWindows, 'preferredWindows');
      }
      if (body.preferredDays !== undefined) {
        changes.preferredDays = weekdayList(body.preferredDays, 'preferredDays');
      }
      res.json(await app.tasks.update(req.params.id!, changes));
    }),
  );

  router.post(
    '/tasks/:id/complete',
    asyncRoute(async (req, res) => {
      res.json(await app.tasks.complete(req.params.id!));
    }),
  );

  router.delete(
    '/tasks/:id',
    asyncRoute(async (req, res) => {
      await app.tasks.delete(req.params.id!);
      res.status(204).end();
    }),
  );

  // ---- schedule ------------------------------------------------------------
  router.get(
    '/agenda',
    asyncRoute(async (req, res) => {
      const window = range(req.query as Record<string, unknown>, app.clock.now(), 7);
      res.json(await app.scheduling.agenda(userId, window));
    }),
  );

  router.get(
    '/events',
    asyncRoute(async (req, res) => {
      const window = range(req.query as Record<string, unknown>, app.clock.now(), 7);
      res.json(await app.calendars.listEvents(userId, window));
    }),
  );

  router.post(
    '/schedule/plan',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const window = body.days
        ? { start: app.clock.now(), end: app.clock.now() + days(Number(body.days)) }
        : undefined;
      const result = await app.scheduling.plan({
        userId,
        ...(Array.isArray(body.taskIds) ? { taskIds: body.taskIds as string[] } : {}),
        ...(window ? { range: window } : {}),
        ...(body.rebuild === undefined ? {} : { rebuild: Boolean(body.rebuild) }),
      });
      res.json(result);
    }),
  );

  router.post(
    '/schedule/apply',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.changeSetId !== 'string') {
        throw new ValidationError('changeSetId is required.');
      }
      res.json(
        await app.scheduling.approve(body.changeSetId, {
          userId,
          ...(Array.isArray(body.mutationIds) ? { mutationIds: body.mutationIds as string[] } : {}),
        }),
      );
    }),
  );

  router.post(
    '/schedule/reject',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.changeSetId !== 'string') {
        throw new ValidationError('changeSetId is required.');
      }
      await app.scheduling.reject(body.changeSetId);
      res.status(204).end();
    }),
  );

  router.get(
    '/risks',
    asyncRoute(async (_req, res) => {
      res.json(await app.scheduling.risks(userId));
    }),
  );

  router.get(
    '/free',
    asyncRoute(async (req, res) => {
      const minutes = Number(req.query.minutes ?? 60);
      const window = range(req.query as Record<string, unknown>, app.clock.now(), 7);
      res.json(await app.scheduling.findSlots({ userId, durationMinutes: minutes, range: window }));
    }),
  );

  // ---- direct editing ------------------------------------------------------
  router.patch(
    '/blocks/:id',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.start !== 'string' || typeof body.end !== 'string') {
        throw new ValidationError('start and end are required ISO timestamps.');
      }
      res.json(
        await app.scheduling.moveBlock(userId, req.params.id!, {
          start: instantFromISO(body.start),
          end: instantFromISO(body.end),
          ...(body.pin === undefined ? {} : { pin: Boolean(body.pin) }),
        }),
      );
    }),
  );

  router.post(
    '/blocks/:id/pin',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await app.scheduling.setBlockPinned(userId, req.params.id!, body.pinned !== false));
    }),
  );

  router.delete(
    '/blocks/:id',
    asyncRoute(async (req, res) => {
      await app.scheduling.deleteBlock(userId, req.params.id!);
      res.status(204).end();
    }),
  );

  router.post(
    '/events',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        throw new ValidationError('An event needs a title.');
      }
      if (typeof body.calendarId !== 'string') throw new ValidationError('calendarId is required.');
      if (typeof body.start !== 'string' || typeof body.end !== 'string') {
        throw new ValidationError('start and end are required ISO timestamps.');
      }
      const attendees = parseAttendees(body.attendees);
      const transparency = parseTransparency(body.transparency);
      const event = await app.calendars.createEvent({
        userId,
        calendarId: body.calendarId,
        title: body.title,
        start: instantFromISO(body.start),
        end: instantFromISO(body.end),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.location === 'string' ? { location: body.location } : {}),
        ...(body.isAllDay === undefined ? {} : { isAllDay: Boolean(body.isAllDay) }),
        ...(attendees === undefined ? {} : { attendees }),
        ...(transparency === undefined ? {} : { transparency }),
        ...(body.notifyAttendees === undefined
          ? {}
          : { notifyAttendees: Boolean(body.notifyAttendees) }),
      });
      res.status(201).json(event);
    }),
  );

  router.patch(
    '/events/:id',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const attendees = parseAttendees(body.attendees);
      const transparency = parseTransparency(body.transparency);
      res.json(
        await app.calendars.updateEvent(userId, req.params.id!, {
          ...(typeof body.start === 'string' ? { start: instantFromISO(body.start) } : {}),
          ...(typeof body.end === 'string' ? { end: instantFromISO(body.end) } : {}),
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.location === 'string' ? { location: body.location } : {}),
          ...(attendees === undefined ? {} : { attendees }),
          ...(transparency === undefined ? {} : { transparency }),
          ...(body.notifyAttendees === undefined
            ? {}
            : { notifyAttendees: Boolean(body.notifyAttendees) }),
        }),
      );
    }),
  );

  router.delete(
    '/events/:id',
    asyncRoute(async (req, res) => {
      await app.calendars.deleteEvent(userId, req.params.id!, {
        notifyAttendees: req.query.notify === 'true',
      });
      res.status(204).end();
    }),
  );

  // ---- agent ---------------------------------------------------------------
  router.post(
    '/agent/message',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        throw new ValidationError('text is required.');
      }
      res.json(
        await app.agent.handle({
          userId,
          text: body.text,
          ...(typeof body.conversationId === 'string'
            ? { conversationId: body.conversationId }
            : {}),
        }),
      );
    }),
  );

  // ---- calendars & sync ----------------------------------------------------
  router.get(
    '/calendars',
    asyncRoute(async (_req, res) => {
      res.json({
        accounts: await app.calendars.listAccounts(userId),
        calendars: await app.calendars.listCalendars(userId),
        providers: app.registry.available(),
      });
    }),
  );

  router.patch(
    '/calendars/:id',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(
        await app.calendars.updateCalendarOptions(req.params.id!, {
          ...(body.selected === undefined ? {} : { selected: Boolean(body.selected) }),
          ...(body.isTaskTarget === undefined ? {} : { isTaskTarget: Boolean(body.isTaskTarget) }),
          ...(body.includeInAvailability === undefined
            ? {}
            : { includeInAvailability: Boolean(body.includeInAvailability) }),
        }),
      );
    }),
  );

  router.delete(
    '/accounts/:id',
    asyncRoute(async (req, res) => {
      await app.calendars.disconnectAccount(req.params.id!);
      res.status(204).end();
    }),
  );

  router.get(
    '/sync/status',
    asyncRoute(async (_req, res) => {
      const states = await app.db.syncState.list(userId);
      const lastSyncedAt = states.reduce<number | undefined>(
        (latest, state) =>
          state.lastSyncedAt === undefined ? latest : Math.max(latest ?? 0, state.lastSyncedAt),
        undefined,
      );
      res.json({
        ...(backgroundSync?.status() ?? { enabled: false, intervalMinutes: 0, running: false }),
        lastSyncedAt: lastSyncedAt ?? null,
        calendars: states.map((state) => ({
          calendarId: state.calendarId,
          lastSyncedAt: state.lastSyncedAt ?? null,
          failureCount: state.failureCount,
          lastError: state.lastError ?? null,
        })),
      });
    }),
  );

  router.post(
    '/sync',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await app.sync.sync({ userId, ...(body.full ? { full: true } : {}) }));
    }),
  );

  // ---- preferences & diagnostics -------------------------------------------
  router.get(
    '/preferences',
    asyncRoute(async (_req, res) => {
      res.json(await app.preferences.get(userId));
    }),
  );

  router.put(
    '/preferences',
    asyncRoute(async (req, res) => {
      res.json(await app.preferences.patch(userId, req.body ?? {}));
    }),
  );

  // ---- categories ----------------------------------------------------------
  router.get(
    '/categories',
    asyncRoute(async (_req, res) => {
      res.json(await app.categories.usage(userId));
    }),
  );

  router.post(
    '/categories',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.name !== 'string') throw new ValidationError('A category needs a name.');
      res.status(201).json(
        await app.categories.create(userId, {
          name: body.name,
          ...(typeof body.color === 'string' ? { color: body.color } : {}),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.matchPattern === 'string' ? { matchPattern: body.matchPattern } : {}),
          ...(typeof body.calendarId === 'string' ? { calendarId: body.calendarId } : {}),
          ...(body.isDefault === undefined ? {} : { isDefault: Boolean(body.isDefault) }),
        }),
      );
    }),
  );

  router.patch(
    '/categories/:id',
    asyncRoute(async (req, res) => {
      res.json(await app.categories.update(req.params.id!, (req.body ?? {}) as never));
    }),
  );

  router.delete(
    '/categories/:id',
    asyncRoute(async (req, res) => {
      res.json(await app.categories.delete(req.params.id!));
    }),
  );

  // ---- data management -------------------------------------------------------
  router.get(
    '/maintenance/stats',
    asyncRoute(async (_req, res) => {
      res.json(await app.maintenance.stats(userId));
    }),
  );

  router.post(
    '/maintenance/prune',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(
        await app.maintenance.prune({
          userId,
          // Destructive endpoints simulate unless explicitly told not to.
          dryRun: body.dryRun !== false,
          ...(typeof body.before === 'string' ? { before: instantFromISO(body.before) } : {}),
          ...(body.includeConversations === undefined
            ? {}
            : { includeConversations: Boolean(body.includeConversations) }),
        }),
      );
    }),
  );

  router.post(
    '/maintenance/reset',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scopes = Array.isArray(body.scopes) ? (body.scopes as DataScope[]) : DATA_SCOPES;
      res.json(
        await app.maintenance.reset({
          userId,
          scopes,
          confirm: body.confirm === true,
          dryRun: body.dryRun !== false,
        }),
      );
    }),
  );

  router.delete(
    '/calendars/:id',
    asyncRoute(async (req, res) => {
      res.json(await app.calendars.deleteCalendar(userId, req.params.id!));
    }),
  );

  // ---- settings ------------------------------------------------------------
  // Runtime settings (model, log level). Credentials are not part of this
  // surface: they are read from the environment and never accepted over HTTP.
  router.get(
    '/settings',
    asyncRoute(async (_req, res) => {
      res.json(await app.settings.view(userId));
    }),
  );

  router.put(
    '/settings',
    asyncRoute(async (req, res) => {
      await app.settings.update(userId, req.body ?? {});
      res.json(await app.settings.view(userId));
    }),
  );

  router.get(
    '/doctor',
    asyncRoute(async (_req, res) => {
      res.json(await app.doctor.run(userId));
    }),
  );

  // ---- people --------------------------------------------------------------
  // Nothing here can send a message. Linking is a local annotation, and the
  // bridge's outbox is deliberately not reachable from this API.
  router.get(
    '/messaging/status',
    asyncRoute(async (_req, res) => {
      res.json(await app.contactLinks.capabilities());
    }),
  );

  router.get(
    '/contacts',
    asyncRoute(async (req, res) => {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 10;
      res.json({
        contacts: await app.contactLinks.search(
          query,
          Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10,
        ),
      });
    }),
  );

  router.get(
    '/events/:id/people',
    asyncRoute(async (req, res) => {
      res.json({ people: await app.contactLinks.peopleOnEvent(req.params.id!) });
    }),
  );

  router.post(
    '/events/:id/confirm',
    asyncRoute(async (req, res) => {
      res.json(await app.outreach.confirmMeeting(userId, req.params.id!));
    }),
  );

  router.get(
    '/events/:id/people/suggestions',
    asyncRoute(async (req, res) => {
      res.json({ suggestions: await app.contactLinks.suggestForEvent(req.params.id!) });
    }),
  );

  router.post(
    '/events/:id/people',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.handle !== 'string') {
        throw new ValidationError('Linking a person needs a handle.');
      }
      res.status(201).json(
        await app.contactLinks.link({
          userId,
          eventId: req.params.id!,
          handle: body.handle,
          contactId: typeof body.contactId === 'string' ? body.contactId : '',
          displayName: typeof body.displayName === 'string' ? body.displayName : body.handle,
        }),
      );
    }),
  );

  // ---- outreach ------------------------------------------------------------
  // Drafts only. Nothing here sends a message; `sent` records that a human did.
  router.post(
    '/events/:id/delete',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(
        await app.deletions.schedule(userId, req.params.id!, {
          ...(typeof body.notifyAttendees === 'boolean'
            ? { notifyAttendees: body.notifyAttendees }
            : {}),
        }),
      );
    }),
  );

  router.post(
    '/deletions/:token/undo',
    asyncRoute(async (req, res) => {
      res.json(app.deletions.undo(userId, req.params.token!));
    }),
  );

  router.get(
    '/deletions',
    asyncRoute(async (_req, res) => {
      res.json({ pending: app.deletions.pending(userId) });
    }),
  );

  router.get(
    '/today',
    asyncRoute(async (_req, res) => {
      res.json(await app.today.get(userId));
    }),
  );

  router.get(
    '/outreach/status',
    asyncRoute(async (_req, res) => {
      res.json({
        poller: outreachPoller?.status() ?? { enabled: false, intervalMinutes: 0, running: false },
        canSend: app.outreach.canSend,
        waiting: (await app.outreach.list(userId, ['sent', 'needs_you'])).length,
      });
    }),
  );

  router.get(
    '/outreach',
    asyncRoute(async (_req, res) => {
      res.json({ outreach: await app.outreach.list(userId) });
    }),
  );

  router.post(
    '/outreach',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.person !== 'string' || typeof body.activity !== 'string') {
        throw new ValidationError('An outreach needs a person and an activity.');
      }
      const outcome = await app.outreach.draft({
        userId,
        person: body.person,
        activity: body.activity,
        ...(typeof body.durationMinutes === 'number'
          ? { durationMinutes: body.durationMinutes }
          : {}),
        ...(typeof body.withinDays === 'number' ? { withinDays: body.withinDays } : {}),
        ...(body.basis === undefined ? {} : { basis: parseBasis(body.basis) }),
        ...(body.tone === undefined ? {} : { tone: parseTone(body.tone) }),
      });
      // A question is not a failure: 200 with what needs answering.
      res.status(outcome.kind === 'drafted' ? 201 : 200).json(outcome);
    }),
  );

  router.post(
    '/outreach/:id/send',
    asyncRoute(async (req, res) => {
      res.json(await app.outreach.send(userId, req.params.id!));
    }),
  );

  router.post(
    '/outreach/:id/reply',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.text !== 'string') throw new ValidationError('A reply needs text.');
      res.json(await app.outreach.recordReply(userId, req.params.id!, body.text));
    }),
  );

  router.post(
    '/outreach/:id/sent',
    asyncRoute(async (req, res) => {
      res.json(await app.outreach.markSent(userId, req.params.id!));
    }),
  );

  router.delete(
    '/outreach/:id',
    asyncRoute(async (req, res) => {
      res.json(await app.outreach.cancel(userId, req.params.id!));
    }),
  );

  router.delete(
    '/people/:id',
    asyncRoute(async (req, res) => {
      await app.contactLinks.unlink(userId, req.params.id!);
      res.status(204).end();
    }),
  );

  return router;
}
