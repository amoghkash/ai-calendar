import type { Clock, Logger, UserId } from '@calendar-agent/core';
import { DomainError } from '@calendar-agent/core';
import type { PreferencesService } from './preferences-service.js';
import type { SchedulingService } from './scheduling-service.js';
import type { SyncReport, SyncService } from './sync-service.js';

export interface BackgroundSyncOptions {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  /** Produce a fresh plan when a sync finds something changed externally. */
  readonly replanOnChange: boolean;
}

export interface BackgroundSyncRun {
  readonly startedAt: number;
  readonly report?: SyncReport;
  /** Change set id when a re-plan produced a proposal. */
  readonly changeSetId?: string;
  readonly appliedMutations?: number;
  readonly error?: string;
}

export interface BackgroundSyncStatus {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly running: boolean;
  readonly lastRun?: BackgroundSyncRun;
}

/**
 * Keeps the local mirror fresh without the user pressing anything.
 *
 * It only ever *proposes*: a detected change produces a plan, which is stored
 * as a pending change set exactly like a manual run. Calendar writes still
 * happen only where the automation policy already allows them, so enabling
 * periodic sync cannot start moving events behind the user's back.
 *
 * Owned by the server process. The CLI is one-shot and never starts a loop.
 */
export class BackgroundSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private lastRun: BackgroundSyncRun | undefined;

  constructor(
    private readonly userId: UserId,
    private readonly sync: SyncService,
    private readonly scheduling: SchedulingService,
    private readonly preferences: PreferencesService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: BackgroundSyncOptions,
  ) {}

  status(): BackgroundSyncStatus {
    return {
      enabled: this.options.enabled,
      intervalMinutes: this.options.intervalMinutes,
      running: this.timer !== undefined,
      ...(this.lastRun === undefined ? {} : { lastRun: this.lastRun }),
    };
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    const period = Math.max(1, this.options.intervalMinutes) * 60_000;

    this.timer = setInterval(() => {
      void this.runOnce();
    }, period);
    // Never hold the process open on its own account.
    this.timer.unref?.();

    this.logger.info('sync.background_started', {
      intervalMinutes: this.options.intervalMinutes,
      replanOnChange: this.options.replanOnChange,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.logger.info('sync.background_stopped', {});
  }

  /**
   * One cycle. Overlapping runs are skipped rather than queued: a slow provider
   * should not pile up work, and the next tick will catch anything missed.
   */
  async runOnce(): Promise<BackgroundSyncRun> {
    if (this.inFlight) {
      this.logger.debug('sync.background_skipped', { reason: 'previous run still in flight' });
      return this.lastRun ?? { startedAt: this.clock.now() };
    }
    this.inFlight = true;
    const startedAt = this.clock.now();

    try {
      const report = await this.sync.sync({ userId: this.userId });
      let run: BackgroundSyncRun = { startedAt, report };

      if (report.needsReplan && this.options.replanOnChange) {
        run = { ...run, ...(await this.replan()) };
      }

      this.lastRun = run;
      this.logger.info('sync.background_run', {
        calendars: report.calendars.length,
        externalChanges: report.externalChanges.filter((change) => !change.selfInflicted).length,
        errors: report.errors.length,
        replanned: run.changeSetId !== undefined,
        appliedMutations: run.appliedMutations ?? 0,
      });
      return run;
    } catch (error) {
      const message = error instanceof DomainError ? error.message : String(error);
      // A background loop must survive anything a provider throws at it.
      this.logger.error('sync.background_failed', { message });
      this.lastRun = { startedAt, error: message };
      return this.lastRun;
    } finally {
      this.inFlight = false;
    }
  }

  /** Re-plan around whatever changed, applying only what policy already allows. */
  private async replan(): Promise<Partial<BackgroundSyncRun>> {
    const result = await this.scheduling.plan({ userId: this.userId });
    if (result.changeSet.autoApply.length === 0) {
      return { changeSetId: result.changeSetId, appliedMutations: 0 };
    }

    const preferences = await this.preferences.get(this.userId);
    if (preferences.automation.mode !== 'autonomous') {
      return { changeSetId: result.changeSetId, appliedMutations: 0 };
    }

    // Autonomous mode only: apply the mutations the policy marked automatic,
    // never the ones still waiting for a human.
    const applied = await this.scheduling.applyPlan(this.userId, result.plan, result.changeSet, {
      includePending: false,
    });
    return { changeSetId: result.changeSetId, appliedMutations: applied.appliedMutations };
  }
}
