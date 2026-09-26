import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { SpanRecord } from '@repo/eval-harness';
import { unlistedAttributeKeys } from '@repo/telemetry';

const KINDS: Record<SpanKind, SpanRecord['kind']> = {
  [SpanKind.INTERNAL]: 'internal',
  [SpanKind.SERVER]: 'server',
  [SpanKind.CLIENT]: 'client',
  [SpanKind.PRODUCER]: 'producer',
  [SpanKind.CONSUMER]: 'consumer',
};

const STATUSES: Record<SpanStatusCode, SpanRecord['status']> = {
  [SpanStatusCode.UNSET]: 'unset',
  [SpanStatusCode.OK]: 'ok',
  [SpanStatusCode.ERROR]: 'error',
};

const millis = ([seconds, nanos]: HrTime): number => seconds * 1000 + nanos / 1e6;

/** A finished span as the transcript carries it: no OpenTelemetry type survives. */
export function toSpanRecord(span: ReadableSpan): SpanRecord {
  const parentSpanId = span.parentSpanContext?.spanId;
  return {
    name: span.name,
    kind: KINDS[span.kind],
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    startTimeUnixMs: millis(span.startTime),
    durationMs: millis(span.duration),
    status: STATUSES[span.status.code],
    attributes: { ...span.attributes },
  };
}

/**
 * Every span the evaluation process finishes, held until the trial that
 * produced it asks for its run's trace.
 *
 * Synchronous export (`SimpleSpanProcessor`), so a span is here the moment it
 * ends, and `executeTraced` has ended the root before it returns.
 */
export class SpanCollector {
  private readonly exporter = new InMemorySpanExporter();
  private readonly unlisted = new Set<string>();
  readonly processor: SpanProcessor = new SimpleSpanProcessor({ exporter: this.exporter });

  /**
   * The spans of one trace, and nothing else; everything held is then
   * dropped.
   *
   * By trace rather than everything since the last call, because the harness
   * opens spans of its own around the run — `memory.inspect.*` from the seed
   * reset and the outcome capture — and those are not part of the run under
   * evaluation. They are still held to the allowlist before they go.
   */
  take(traceId: string): SpanRecord[] {
    const finished = this.exporter.getFinishedSpans();
    this.exporter.reset();

    const records = finished.map(toSpanRecord);
    for (const key of unlistedAttributeKeys(records)) this.unlisted.add(key);
    return records.filter((record) => record.traceId === traceId);
  }

  /** Every attribute key outside `ALLOWED_SPAN_ATTRIBUTES` seen on any span so far. */
  unlistedKeys(): string[] {
    return [...this.unlisted].sort();
  }
}
