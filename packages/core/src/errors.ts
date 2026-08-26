/** Structured error codes. Keep these stable: they are part of the API surface. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PROVIDER_ERROR'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'SCHEDULING_ERROR'
  | 'LLM_ERROR'
  | 'SYNC_ERROR'
  | 'INTERNAL_ERROR';

export interface DomainErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

/** Base class for all errors raised inside the application. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('VALIDATION_ERROR', message, options);
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found: ${id}`, { details: { resource, id } });
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('CONFLICT', message, options);
  }
}

export class ProviderError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('PROVIDER_ERROR', message, options);
  }
}

export class AuthError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('AUTH_ERROR', message, options);
  }
}

export class UnsupportedError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('UNSUPPORTED', message, options);
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('PERMISSION_DENIED', message, options);
  }
}

export class SchedulingError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('SCHEDULING_ERROR', message, options);
  }
}

export class LLMError extends DomainError {
  constructor(message: string, options: DomainErrorOptions = {}) {
    super('LLM_ERROR', message, options);
  }
}
