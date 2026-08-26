import type { BridgeErrorCode } from '@calendar-agent/imessage-contract';
import { STATUS_BY_BRIDGE_ERROR } from '@calendar-agent/imessage-contract';

/**
 * The bridge's only error type. It deliberately does not reuse the calendar
 * app's `DomainError`: the bridge imports nothing from the workspace except the
 * contract, which is what keeps its lifecycle independent.
 */
export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    /** Operator-facing remedy, e.g. which permission to grant. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  get status(): number {
    return STATUS_BY_BRIDGE_ERROR[this.code];
  }

  toJSON(): { code: BridgeErrorCode; message: string } {
    return { code: this.code, message: this.detail ? `${this.message} ${this.detail}` : this.message };
  }
}

export const validationError = (message: string): BridgeError =>
  new BridgeError('VALIDATION_ERROR', message);

export const notFound = (message: string): BridgeError => new BridgeError('NOT_FOUND', message);

/** A capability the machine has not granted. Carries the remedy, not a stack trace. */
export const unavailable = (message: string, detail?: string): BridgeError =>
  new BridgeError('UNSUPPORTED', message, detail);
