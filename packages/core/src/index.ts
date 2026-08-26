// Domain
export * from './domain/ids.js';
export * from './domain/user.js';
export * from './domain/task.js';
export * from './domain/calendar.js';
export * from './domain/contact.js';
export * from './domain/messaging.js';
export * from './domain/name-match.js';
export * from './domain/classification.js';
export * from './domain/category.js';
export * from './domain/schedule.js';
export * from './domain/preferences.js';
export * from './domain/settings.js';
export * from './domain/sync.js';

// Time
export * from './time/instant.js';
export * from './time/interval.js';
export * from './time/wall-clock.js';
export * from './time/format.js';

// Scheduling engine
export * from './scheduling/index.js';

// Planning / mutations
export * from './planning/change-set.js';

// Ports
export * from './ports/calendar-provider.js';
export * from './ports/messaging.js';
export * from './ports/repositories.js';

// Cross-cutting
export * from './errors.js';
export * from './result.js';
export * from './logging/logger.js';

// Test fixtures (small, dependency-free; handy for downstream packages)
export * from './testing/fixtures.js';
