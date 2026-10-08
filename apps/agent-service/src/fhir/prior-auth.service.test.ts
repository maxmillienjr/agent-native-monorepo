import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { unlistedAttributeKeys } from '@repo/telemetry';
import { RunsService } from '../runs/runs.service.js';
import { PriorAuthService } from './prior-auth.service.js';

/**
 * The prior-authorization graph's spans and clock, model `stub` / memory
 * `stub`: a service with no checkpointer and the stub model half.
 */
const exporter = new InMemorySpanExporter();
const DATASET = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'eval-harness',
  'datasets',
  'prior-auth',
  'bundles',
);
const bundle = (
  task: string,
): Record<string, unknown> & { entry: { resource: Record<string, unknown> }[] } =>
  JSON.parse(readFileSync(join(DATASET, `${task}.bundle.json`), 'utf8')) as Record<
    string,
    unknown
  > & { entry: { resource: Record<string, unknown> }[] };

const FIXED = new Date('2026-03-01T10:00:00Z');

function service(): PriorAuthService {
  const runs = new RunsService(null, null, null, null, null);
  return new PriorAuthService(runs, null, { now: () => FIXED });
}

const attribute = (spans: readonly ReadableSpan[], node: string, key: string): unknown =>
  spans.find((span) => span.name === `agent.node.${node}`)?.attributes[key];

describe('the prior-authorization graph', () => {
  const key = process.env['GOOGLE_API_KEY'];

  beforeAll(() => {
    delete process.env['GOOGLE_API_KEY'];
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });

  beforeEach(() => exporter.reset());

  afterAll(async () => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
    await exporter.shutdown();
  });

  it('opens one agent.node span per node, all four under the invoke_agent root', async () => {
    const run = await service().submit(bundle('pa-e0601-all-met-structured'), 'corr-pa-1');
    const spans = exporter.getFinishedSpans();

    expect(run.nodeSequence).toEqual(['intake', 'lookup', 'assess', 'dispose']);
    const root = spans.find((span) => span.name === 'invoke_agent prior-auth');
    expect(root).toBeDefined();
    for (const node of ['intake', 'lookup', 'assess', 'dispose']) {
      const span = spans.find((candidate) => candidate.name === `agent.node.${node}`);
      expect(span, node).toBeDefined();
      expect(span?.parentSpanContext?.spanId, node).toBe(root?.spanContext().spanId);
    }
    expect(unlistedAttributeKeys(spans)).toEqual([]);
  });

  it('produces a disposition and gates it: the stub model refers, and dispose records the kind', async () => {
    const run = await service().submit(bundle('pa-e0601-all-met-structured'), 'corr-pa-2');
    expect(run.state.disposition?.kind).toBe('refer-to-clinician');
    expect(attribute(exporter.getFinishedSpans(), 'dispose', 'prior_auth.disposition')).toBe(
      'refer-to-clinician',
    );
  });

  it('skips assess when the coverage is not active on the date of service', async () => {
    const run = await service().submit(bundle('pa-e0601-administrative'), 'corr-pa-3');
    expect(run.nodeSequence).toEqual(['intake', 'lookup', 'dispose']);
    expect(run.state.referralReason).toBe('coverage-inactive');
    expect(run.state.disposition).toEqual({ kind: 'refer-to-clinician', findings: [] });
  });

  it('counts the deadline from the fixed clock, not from Claim.created', async () => {
    const standard = bundle('pa-e0601-all-met-structured');
    const expedited = bundle('pa-e0601-ambiguous');
    for (const body of [standard, expedited]) {
      const claim = body.entry[0]?.resource as { created: string };
      claim.created = '2026-02-28T10:00:00Z';
    }

    await service().submit(standard, 'corr-pa-4');
    const standardSpans = exporter.getFinishedSpans();
    expect(attribute(standardSpans, 'intake', 'prior_auth.received_at')).toBe(
      '2026-03-01T10:00:00.000Z',
    );
    expect(attribute(standardSpans, 'intake', 'prior_auth.priority')).toBe('standard');
    expect(attribute(standardSpans, 'intake', 'prior_auth.decision_due_by')).toBe(
      '2026-03-08T10:00:00.000Z',
    );

    exporter.reset();
    await service().submit(expedited, 'corr-pa-5');
    const expeditedSpans = exporter.getFinishedSpans();
    expect(attribute(expeditedSpans, 'intake', 'prior_auth.priority')).toBe('expedited');
    expect(attribute(expeditedSpans, 'intake', 'prior_auth.decision_due_by')).toBe(
      '2026-03-04T10:00:00.000Z',
    );
  });

  it('records the time it held the request on the dispose span', async () => {
    await service().submit(bundle('pa-k0823-one-missing'), 'corr-pa-6');
    // The clock is fixed, so the request was held for no time at all.
    expect(attribute(exporter.getFinishedSpans(), 'dispose', 'prior_auth.elapsed_ms')).toBe(0);
  });
});
