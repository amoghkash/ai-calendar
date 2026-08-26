import type { Clock, Database, Logger, UserId } from '@calendar-agent/core';
import { DomainError, isValidTimezone } from '@calendar-agent/core';
import type { AppConfig } from '@calendar-agent/config';
import type { PreferencesService } from './preferences-service.js';
import type { ProviderRegistry } from '../provider-registry.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DiagnosticCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DiagnosticsReport {
  readonly status: CheckStatus;
  readonly checks: readonly DiagnosticCheck[];
}

/** `calendar-agent doctor`: verify the installation can actually work. */
export class DoctorService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly registry: ProviderRegistry,
    private readonly preferences: PreferencesService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** What the process is actually running, which can differ from the file. */
    private readonly llm?: { readonly name: string; readonly model: string },
  ) {}

  async run(userId: UserId): Promise<DiagnosticsReport> {
    const checks: DiagnosticCheck[] = [];

    checks.push({
      name: 'configuration',
      status: 'ok',
      detail:
        this.config.sources.length > 0
          ? `Loaded from ${this.config.sources.join(', ')}`
          : 'Using built-in defaults (no config file found)',
    });

    checks.push({
      name: 'timezone',
      status: isValidTimezone(this.config.timezone) ? 'ok' : 'fail',
      detail: `Configured timezone: ${this.config.timezone}`,
    });

    try {
      const tasks = await this.db.tasks.list({ userId });
      checks.push({
        name: 'database',
        status: 'ok',
        detail: `${this.config.database.driver} driver reachable (${tasks.length} tasks)`,
      });
    } catch (error) {
      checks.push({
        name: 'database',
        status: 'fail',
        detail: `Cannot read from the database: ${describe(error)}`,
      });
    }

    const accounts = await this.db.accounts.list(userId).catch(() => []);
    if (accounts.length === 0) {
      checks.push({
        name: 'calendar accounts',
        status: 'warn',
        detail:
          'No calendar connected. Scheduling still works locally; run "calendar-agent connect google" to sync.',
      });
    } else {
      for (const account of accounts) {
        try {
          const provider = await this.registry.create(account);
          const identity = await provider.authenticate();
          checks.push({
            name: `account ${account.displayName}`,
            status: 'ok',
            detail: `${account.provider} connected as ${identity.externalAccountId}`,
          });
        } catch (error) {
          checks.push({
            name: `account ${account.displayName}`,
            status: 'fail',
            detail: `${account.provider}: ${describe(error)}`,
          });
        }
      }
    }

    const calendars = await this.db.calendars.list(userId).catch(() => []);
    const writable = calendars.filter((calendar) => calendar.isWritable);
    checks.push({
      name: 'task calendar',
      status: calendars.length === 0 ? 'warn' : writable.length > 0 ? 'ok' : 'warn',
      detail:
        calendars.length === 0
          ? 'No calendars imported yet; task blocks stay local.'
          : `${writable.length} writable calendar(s); target: ${
              calendars.find((calendar) => calendar.isTaskTarget)?.name ?? 'none selected'
            }`,
    });

    // Report what is actually running, not what the file says: stored settings
    // override the configuration file, and reporting the file hid that.
    const active = this.llm?.name ?? this.config.llm.provider;
    const configured = this.config.llm.provider;
    checks.push({
      name: 'llm',
      status: active === 'none' ? 'warn' : 'ok',
      detail:
        active === 'none'
          ? configured === 'none'
            ? 'No language model configured. Natural language uses the built-in rule parser.'
            : `No language model active, even though ${configured} is configured. Stored settings select "none" - change it in Settings (or PUT /api/settings).`
          : `${active} (${this.llm?.model ?? this.config.llm.model})${
              this.config.llm.apiKey ? '' : ' - no API key found in the environment'
            }`,
    });

    const preferences = await this.preferences.get(userId);
    const workingDays = Object.values(preferences.workingHours).filter(
      (windows) => Array.isArray(windows) && windows.length > 0,
    ).length;
    checks.push({
      name: 'working hours',
      status: workingDays > 0 ? 'ok' : 'fail',
      detail:
        workingDays > 0
          ? `${workingDays} day(s) of working hours configured`
          : 'No working hours configured: the scheduler has nowhere to place work.',
    });

    checks.push({
      name: 'automation',
      status: 'ok',
      detail: `Mode: ${preferences.automation.mode} (${
        preferences.automation.mode === 'suggest'
          ? 'changes require approval'
          : preferences.automation.mode === 'read_only'
            ? 'no changes will be written'
            : 'allowed changes apply automatically'
      })`,
    });

    checks.push({
      name: 'clock',
      status: 'ok',
      detail: new Date(this.clock.now()).toISOString(),
    });

    const status: CheckStatus = checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'warn')
        ? 'warn'
        : 'ok';
    this.logger.info('doctor.run', { status });
    return { status, checks };
  }
}

function describe(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
