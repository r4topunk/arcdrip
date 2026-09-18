// Structured logging for the SDK (PRD D14). One pino instance, JSON lines, an optional `correlationId` bound to
// every line so a single user action can be followed across reads, simulations and transactions.
//
// A library must be quiet by default: the level is `silent` unless the host sets one explicitly or exports
// `SHAREDARC_LOG_LEVEL`. Nothing here ever logs an amount the caller did not already pass in, and never a key.
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/** Levels pino accepts, plus `silent`. */
export const LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Level from `SHAREDARC_LOG_LEVEL`, or `silent` when unset or unrecognised. */
export function envLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const raw = env.SHAREDARC_LOG_LEVEL;
  return isLogLevel(raw) ? raw : 'silent';
}

export type CreateLoggerOptions = {
  /** Default: `SHAREDARC_LOG_LEVEL`, else `silent`. */
  level?: LogLevel;
  /** Bound to every line as `correlationId`. Generated per action when the caller does not supply one. */
  correlationId?: string;
  /** Extra bindings merged into every line (e.g. `{ chainId, poolId }`). */
  bindings?: Record<string, unknown>;
  /** Escape hatch for pino options (transport, redact...). `level` and bindings win over it. */
  pino?: LoggerOptions;
  /** Where the lines go. Default: pino's default (stdout). Tests pass a collecting stream. */
  destination?: DestinationStream;
};

/**
 * The SDK's logger. bigint is serialised as a decimal string, because JSON.stringify throws on bigint and every
 * amount in this SDK is a bigint.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { level = envLogLevel(), correlationId, bindings, pino: extra, destination } = options;
  const base: Record<string, unknown> = { name: '@sharedarc/sdk', ...bindings };
  if (correlationId !== undefined) base.correlationId = correlationId;
  const pinoOptions: LoggerOptions = {
    ...extra,
    level,
    base,
    formatters: {
      ...extra?.formatters,
      bindings: (b) => b,
    },
    serializers: { ...extra?.serializers },
    hooks: {
      ...extra?.hooks,
      logMethod(args, method) {
        method.apply(this, args.map((arg) => replaceBigints(arg)) as Parameters<typeof method>);
      },
    },
  };
  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}

/** A logger that drops everything. Handy as a default and in tests. */
export function silentLogger(): Logger {
  return createLogger({ level: 'silent' });
}

/** Child logger with a `correlationId` bound to every line. */
export function withCorrelationId(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}

/** Child logger with extra bindings (`action`, `poolId`, ...). */
export function withBindings(logger: Logger, bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/**
 * A fresh correlation id: `<prefix>-<time36>-<random>`. Short enough to paste into a support message, unique
 * enough for a single client. Uses `crypto.randomUUID` when available.
 */
export function newCorrelationId(prefix = 'drip'): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff)
          .toString(16)
          .padStart(8, '0');
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Deep-copies a value with every bigint turned into a decimal string. Exported for tests and for hosts. */
export function replaceBigints(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => replaceBigints(item, seen));
  if (value instanceof Error) return value;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = replaceBigints(item, seen);
  }
  return out;
}
