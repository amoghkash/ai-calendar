import type { Instant } from '../time/instant.js';
import type { UserId } from './ids.js';

export interface User {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly timezone: string;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/** Single-user deployments use this id, so multi-user can be added later. */
export const DEFAULT_USER_ID = 'local-user';
