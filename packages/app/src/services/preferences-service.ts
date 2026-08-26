import type { Clock, Database, SchedulingPreferences, UserId } from '@calendar-agent/core';
import { defaultPreferences } from '@calendar-agent/core';
import { parsePreferencesPatch } from './preferences-input.js';

/**
 * Reads and writes the user's scheduling policy, falling back to the values
 * from the configuration file the first time it is requested.
 */
export class PreferencesService {
  constructor(
    private readonly db: Database,
    private readonly fallback: SchedulingPreferences,
    private readonly clock: Clock,
  ) {}

  async get(userId: UserId): Promise<SchedulingPreferences> {
    const stored = await this.db.preferences.get(userId);
    if (stored) return { ...this.fallback, ...stored, userId };
    return { ...this.fallback, userId };
  }

  async save(preferences: SchedulingPreferences): Promise<SchedulingPreferences> {
    return this.db.preferences.save({ ...preferences, updatedAt: this.clock.now() });
  }

  async update(
    userId: UserId,
    changes: Partial<SchedulingPreferences>,
  ): Promise<SchedulingPreferences> {
    const current = await this.get(userId);
    return this.save({ ...current, ...changes, userId });
  }

  /**
   * Apply a validated partial update from an untrusted source (the HTTP API).
   * Unknown fields are dropped; invalid ones raise before anything is written.
   */
  async patch(userId: UserId, raw: unknown): Promise<SchedulingPreferences> {
    const current = await this.get(userId);
    return this.save({ ...current, ...parsePreferencesPatch(raw, current), userId });
  }

  /** Defaults for a brand-new user, derived from the configuration file. */
  seed(userId: UserId, timezone: string): SchedulingPreferences {
    return { ...defaultPreferences(userId, timezone, this.clock.now()), ...this.fallback, userId };
  }
}
