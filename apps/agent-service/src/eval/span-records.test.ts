import { describe, it, expect } from 'vitest';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { SpanCollector } from './span-records.js';

describe('SpanCollector', () => {
  it('returns one trace as SpanRecords, holds the rest to the allowlist, and forgets both', () => {
    const collector = new SpanCollector();
    const tracer = new TracerProvider({ spanProcessors: [collector.processor] }).getTracer('t');

    const root = tracer.startSpan('invoke_agent agent-service', {
      attributes: { 'gen_ai.operation.name': 'invoke_agent' },
    });
    const child = tracer.startSpan(
      'generate_content gemini-2.5-flash',
      { kind: SpanKind.CLIENT, attributes: { 'gen_ai.usage.input_tokens': 58 } },
      trace.setSpan(ROOT_CONTEXT, root),
    );
    child.setStatus({ code: SpanStatusCode.ERROR });
    child.end();
    root.end();
    // The harness's own: a separate trace, and a key that is not on the list.
    tracer.startSpan('memory.inspect.run', { attributes: { 'entity.id': 'a member' } }).end();

    const records = collector.take(root.spanContext().traceId);

    expect(records.map((record) => record.name)).toEqual([
      'generate_content gemini-2.5-flash',
      'invoke_agent agent-service',
    ]);
    expect(records[0]).toMatchObject({
      kind: 'client',
      traceId: root.spanContext().traceId,
      parentSpanId: root.spanContext().spanId,
      status: 'error',
      attributes: { 'gen_ai.usage.input_tokens': 58 },
    });
    expect(records[0]!.startTimeUnixMs).toBeGreaterThan(1_700_000_000_000);
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(records[1]).toMatchObject({ kind: 'internal', status: 'unset' });
    expect('parentSpanId' in records[1]!).toBe(false);

    expect(collector.unlistedKeys()).toEqual(['entity.id']);
    expect(collector.take(root.spanContext().traceId)).toEqual([]);
  });
});
