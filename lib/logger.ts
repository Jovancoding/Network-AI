/**
 * Structured Logger for Network-AI
 * 
 * Replaces raw console.log/warn/error with a leveled, filterable logger.
 * Users can set the log level, provide a custom transport, or disable
 * logging entirely. All log entries include a timestamp, level, module
 * source, and structured data.
 * 
 * @module Logger
 * @version 1.0.0
 * @license MIT
 */

// ============================================================================
// TYPES
// ============================================================================

/** Log severity levels (numeric for comparison) */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/** A structured log entry */
export interface LogEntry {
  timestamp: string;
  level: keyof typeof LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Custom log transport function. Receives a structured log entry.
 * Return value is ignored.
 * 
 * @example
 * // Send logs to an external service
 * const transport: LogTransport = (entry) => {
 *   fetch('/logs', { method: 'POST', body: JSON.stringify(entry) });
 * };
 */
export type LogTransport = (entry: LogEntry) => void;

/** Logger configuration */
export interface LoggerConfig {
  /** Minimum level to emit. Default: LogLevel.WARN */
  level: LogLevel;
  /** Custom transport. Default: console-based output */
  transport?: LogTransport;
  /** If true, suppresses all output (equivalent to LogLevel.SILENT) */
  silent: boolean;
}

// ============================================================================
// DEFAULT TRANSPORT
// ============================================================================

const defaultTransport: LogTransport = (entry: LogEntry) => {
  const prefix = `[${entry.timestamp}] [${entry.level}] [${entry.module}]`;
  const msg = `${prefix} ${entry.message}`;

  switch (entry.level) {
    case 'ERROR':
      console.error(msg, entry.data ?? '');
      break;
    case 'WARN':
      console.warn(msg, entry.data ?? '');
      break;
    case 'DEBUG':
      console.debug(msg, entry.data ?? '');
      break;
    default:
      console.log(msg, entry.data ?? '');
      break;
  }
};

// ============================================================================
// LOGGER CLASS
// ============================================================================

/**
 * Structured logger with level filtering, module tagging, and pluggable transports.
 * 
 * @example
 * ```typescript
 * import { Logger, LogLevel } from 'network-ai';
 * 
 * // Set global log level
 * Logger.setLevel(LogLevel.DEBUG);
 * 
 * // Create a module-scoped logger
 * const log = Logger.create('MyAdapter');
 * log.info('Adapter initialized', { agents: 3 });
 * log.warn('Slow response', { latencyMs: 5000 });
 * log.error('Connection failed', { host: 'api.example.com' });
 * 
 * // Silence all logs
 * Logger.setLevel(LogLevel.SILENT);
 * 
 * // Use a custom transport (e.g., send to monitoring service)
 * Logger.setTransport((entry) => {
 *   myMonitoringService.log(entry);
 * });
 * ```
 */
export class Logger {
  private static config: LoggerConfig = {
    level: LogLevel.WARN,
    silent: false,
  };

  private module: string;

  private constructor(module: string) {
    this.module = module;
  }

  // ---- Static configuration ----

  /** Set the minimum log level globally */
  static setLevel(level: LogLevel): void {
    Logger.config.level = level;
  }

  /** Get the current log level */
  static getLevel(): LogLevel {
    return Logger.config.level;
  }

  /** Set a custom transport for all loggers */
  static setTransport(transport: LogTransport): void {
    Logger.config.transport = transport;
  }

  /** Reset to default console transport */
  static resetTransport(): void {
    Logger.config.transport = undefined;
  }

  /** Silence all logging */
  static silence(): void {
    Logger.config.silent = true;
  }

  /** Re-enable logging */
  static unsilence(): void {
    Logger.config.silent = false;
  }

  /** Create a logger scoped to a module name */
  static create(module: string): Logger {
    return new Logger(module);
  }

  // ---- Instance methods ----

  /** Log at DEBUG level */
  debug(message: string, data?: Record<string, unknown>): void {
    this.emit(LogLevel.DEBUG, 'DEBUG', message, data);
  }

  /** Log at INFO level */
  info(message: string, data?: Record<string, unknown>): void {
    this.emit(LogLevel.INFO, 'INFO', message, data);
  }

  /** Log at WARN level */
  warn(message: string, data?: Record<string, unknown>): void {
    this.emit(LogLevel.WARN, 'WARN', message, data);
  }

  /** Log at ERROR level */
  error(message: string, data?: Record<string, unknown>): void {
    this.emit(LogLevel.ERROR, 'ERROR', message, data);
  }

  // ---- Internal ----

  private emit(
    numericLevel: LogLevel,
    levelName: keyof typeof LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (Logger.config.silent) return;
    if (numericLevel < Logger.config.level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: levelName,
      module: this.module,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    const transport = Logger.config.transport ?? defaultTransport;
    transport(entry);
  }
}
