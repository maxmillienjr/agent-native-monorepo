import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type DestinationStream, type Logger } from 'pino';

interface LogContext {
  correlationId?: string;
}

const als = new AsyncLocalStorage<LogContext>();

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return als.run({ correlationId }, fn);
}

export function getCorrelationId(): string | undefined {
  return als.getStore()?.correlationId;
}

let sharedTransport: DestinationStream | undefined;

/**
 * One transport for every logger in the process.
 *
 * Each pino `transport` option starts a worker thread, and a process exiting
 * with many of them deadlocks: `process.exit` flushes each synchronously, and
 * with about a dozen workers it never returns. Measured on 2026-10-08 — 8
 * loggers exited, 12 hung — and `agent-service` creates one per module. Once
 * P5-A's modules took it past that, a malformed variable stopped exiting 1
 * and hung instead, with the fatal line never written.
 */
function transport(): DestinationStream {
  return (sharedTransport ??= pino.transport({ target: 'pino/file', options: { destination: 1 } }));
}

export function createLogger(name: string): Logger {
  const options = {
    name,
    level: process.env['LOG_LEVEL'] ?? 'info',
    // Without this an Error logged as `{ error: err }` serializes to `{}`, because
    // message and stack are non-enumerable. A container dying with `"error":{}` in
    // its last log line is unreadable, which is the opposite of the point.
    serializers: { error: pino.stdSerializers.err, err: pino.stdSerializers.err },
    mixin() {
      const store = als.getStore();
      return store?.correlationId ? { correlationId: store.correlationId } : {};
    },
  };
  return process.env['NODE_ENV'] !== 'production' ? pino(options, transport()) : pino(options);
}
