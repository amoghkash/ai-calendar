export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
  readonly timestamp: number;
}

/**
 * Structured logging port. Implementations live outside the domain; the core
 * only ever emits structured records.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  /** Implementations that filter by level may allow changing it at runtime. */
  setLevel?(level: LogLevel): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: (record: LogRecord) => void;
  readonly base?: LogFields;
  readonly now?: () => number;
}

/** Default logger: JSON records to a sink (stderr by default). */
export class StructuredLogger implements Logger {
  private level: LogLevel;
  private readonly sink: (record: LogRecord) => void;
  private readonly base: LogFields;
  private readonly now: () => number;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? defaultSink;
    this.base = options.base ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  /** Change the threshold at runtime, so a settings change takes effect now. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    this.sink({ level, message, fields: { ...this.base, ...fields }, timestamp: this.now() });
  }

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit('error', message, fields);
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger({
      level: this.level,
      sink: this.sink,
      base: { ...this.base, ...fields },
      now: this.now,
    });
  }
}

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify({
    ts: new Date(record.timestamp).toISOString(),
    level: record.level,
    msg: record.message,
    ...record.fields,
  });
  process.stderr.write(`${line}\n`);
}

/** Logger that records everything in memory. Useful in tests. */
export class MemoryLogger implements Logger {
  readonly records: LogRecord[] = [];
  constructor(private readonly base: LogFields = {}) {}

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    this.records.push({ level, message, fields: { ...this.base, ...fields }, timestamp: 0 });
  }
  debug(m: string, f?: LogFields): void {
    this.emit('debug', m, f);
  }
  info(m: string, f?: LogFields): void {
    this.emit('info', m, f);
  }
  warn(m: string, f?: LogFields): void {
    this.emit('warn', m, f);
  }
  error(m: string, f?: LogFields): void {
    this.emit('error', m, f);
  }
  child(fields: LogFields): Logger {
    const child = new MemoryLogger({ ...this.base, ...fields });
    // Share the underlying buffer so tests can assert on a single array.
    Object.defineProperty(child, 'records', { value: this.records });
    return child;
  }
}

export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};
