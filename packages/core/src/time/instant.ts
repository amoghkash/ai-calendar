/**
 * An `Instant` is an unambiguous point in time: milliseconds since the Unix
 * epoch, i.e. always UTC. Every timestamp inside the domain is an Instant.
 *
 * Wall-clock information (working hours, "9am on Tuesday") is always stored
 * separately together with an IANA timezone id, and converted to Instants by
 * `time/wall-clock.ts`. Naive date strings never enter the scheduling engine.
 */
export type Instant = number;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const minutes = (n: number): number => n * MINUTE_MS;
export const hours = (n: number): number => n * HOUR_MS;
export const days = (n: number): number => n * DAY_MS;

export const toMinutes = (ms: number): number => ms / MINUTE_MS;

/** Parse an ISO-8601 string (with offset or `Z`) into an Instant. */
export function instantFromISO(iso: string): Instant {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    throw new TypeError(`Invalid ISO timestamp: ${iso}`);
  }
  return value;
}

export const instantToISO = (instant: Instant): string => new Date(instant).toISOString();

export const isInstant = (value: unknown): value is Instant =>
  typeof value === 'number' && Number.isFinite(value);

/** Round an instant up to the next multiple of `granularityMinutes`. */
export function ceilToMinutes(instant: Instant, granularityMinutes: number): Instant {
  const step = minutes(granularityMinutes);
  return Math.ceil(instant / step) * step;
}

/** Round an instant down to the previous multiple of `granularityMinutes`. */
export function floorToMinutes(instant: Instant, granularityMinutes: number): Instant {
  const step = minutes(granularityMinutes);
  return Math.floor(instant / step) * step;
}

/** Port for reading the current time. Never call `Date.now()` in domain code. */
export interface Clock {
  now(): Instant;
}

export class SystemClock implements Clock {
  now(): Instant {
    return Date.now();
  }
}

/** Deterministic clock for tests and replayable scheduling runs. */
export class FixedClock implements Clock {
  constructor(private current: Instant) {}
  now(): Instant {
    return this.current;
  }
  set(instant: Instant): void {
    this.current = instant;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
