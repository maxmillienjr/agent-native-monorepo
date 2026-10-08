import request from 'supertest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { initTelemetry, shutdownTelemetry } from '@repo/telemetry';
import { bootService, type ServiceApp } from './service-app.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

const RUN_BODY = {
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  messages: [{ role: 'user', content: 'What is LangGraph?' }],
};

/**
 * The service's own telemetry setup, `initTelemetry`, with an in-memory
 * exporter beside it: the propagator and context manager under test are the
 * ones `main.ts` installs, not ones this file registers.
 *
 * Export is not immediate under `NodeSDK`: the processor holds a span until
 * the resource's asynchronous attributes settle. `forceFlush` waits for that.
 */
describe('W3C trace context on the external routes', () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor({ exporter });
  let service: ServiceApp;

  beforeAll(async () => {
    initTelemetry({ serviceName: 'agent-service', spanProcessors: [processor] });
    service = await bootService();
  });

  afterAll(async () => {
    await service.close();
    await shutdownTelemetry();
  });

  beforeEach(async () => {
    await processor.forceFlush();
    exporter.reset();
  });

  async function nodeTraceIds(): Promise<Set<string>> {
    await processor.forceFlush();
    const nodes = exporter.getFinishedSpans().filter((s) => s.name.startsWith('agent.node.'));
    expect(nodes.length).toBeGreaterThanOrEqual(7);
    return new Set(nodes.map((s) => s.spanContext().traceId));
  }

  it('parents a POST /runs run in the caller trace', async () => {
    const response = await request(service.app.getHttpServer())
      .post('/runs')
      .set('traceparent', TRACEPARENT)
      .send(RUN_BODY);

    expect(response.status).toBe(200);
    expect(await nodeTraceIds()).toEqual(new Set([TRACE_ID]));
  });

  it('parents an A2A SendMessage run in the caller trace', async () => {
    const response = await request(service.app.getHttpServer())
      .post('/a2a/jsonrpc')
      .set('A2A-Version', '1.0')
      .set('traceparent', TRACEPARENT)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: { message: { messageId: 'trace-1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] } },
      });

    expect(response.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(await nodeTraceIds()).toEqual(new Set([TRACE_ID]));
  });

  it('starts a trace of its own when the caller sends none', async () => {
    await request(service.app.getHttpServer()).post('/runs').send(RUN_BODY);

    const traceIds = await nodeTraceIds();
    expect(traceIds.size).toBe(1);
    expect(traceIds.has(TRACE_ID)).toBe(false);
  });
});
