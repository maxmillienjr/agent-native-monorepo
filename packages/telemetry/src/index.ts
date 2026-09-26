export { initTelemetry, shutdownTelemetry, getTracer } from './otel.setup.js';
export { createLogger, runWithCorrelationId, getCorrelationId } from './logger.js';
// Also published alone as `@repo/telemetry/genai`, which loads the API and not
// the SDK — the entry point for a package that only needs the names.
export * from './genai.js';
