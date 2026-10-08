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
import { HttpException } from '@nestjs/common';
import { unlistedAttributeKeys } from '@repo/telemetry';
import { InMemoryCaseRepository } from '@repo/memory-core';
import { MemorySaver } from '@langchain/langgraph';
import { InMemoryLedgerStore, Ledger, verifyChain } from '@repo/decision-ledger';
import { RunLedger } from '../ledger/run-ledger.js';
import { RunsService } from '../runs/runs.service.js';
import { InMemoryRunRecords } from '../audit/memory-run-records.js';
import { OperationOutcomeException, PriorAuthService } from './prior-auth.service.js';

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

function service(cases = new InMemoryCaseRepository()): PriorAuthService {
  const runs = new RunsService(null, null, null, null, null, null);
  return new PriorAuthService(runs, null, { now: () => FIXED }, null, cases);
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

  it('enqueues the case before it answers, under the keys an inquiry matches', async () => {
    const cases = new InMemoryCaseRepository();
    const run = await service(cases).submit(bundle('pa-e0601-ambiguous'), 'corr-pa-7');

    const row = await cases.get(run.caseId);
    expect(row?.status).toBe('pended');
    expect(row?.priority).toBe('expedited');
    expect(row?.receivedAt.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(row?.decisionDueBy.toISOString()).toBe('2026-03-04T10:00:00.000Z');
    expect(row?.memberId).toMatch(/^https:\/\/example\.org\/fhir\/sid\/member-id\|/);
    expect(row?.hcpcs).toBe('E0601');
    expect(row?.disposition).toEqual(run.state.disposition);
    expect(row?.response).toEqual(run.response);
  });

  it('answers 503 with an OperationOutcome when the case cannot be enqueued', async () => {
    const cases = new InMemoryCaseRepository();
    cases.enqueue = async () => {
      throw new Error('the store is down');
    };
    const failed = await service(cases)
      .submit(bundle('pa-e0601-ambiguous'), 'corr-pa-8')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(OperationOutcomeException);
    const exception = failed as OperationOutcomeException;
    expect(exception.getStatus()).toBe(503);
    expect(exception.getResponse()).toMatchObject({ resourceType: 'OperationOutcome' });
    expect(JSON.stringify(exception.getResponse())).not.toContain('ClaimResponse');
  });

  it('records the time it held the request on the dispose span', async () => {
    await service().submit(bundle('pa-k0823-one-missing'), 'corr-pa-6');
    // The clock is fixed, so the request was held for no time at all.
    expect(attribute(exporter.getFinishedSpans(), 'dispose', 'prior_auth.elapsed_ms')).toBe(0);
  });
});

describe('the run record on the prior-authorization path, which fails closed (P3-B)', () => {
  function recorded(
    records: InMemoryRunRecords,
    cases = new InMemoryCaseRepository(),
  ): PriorAuthService {
    const runs = new RunsService(null, null, null, null, null, records);
    return new PriorAuthService(runs, null, { now: () => FIXED }, records, cases);
  }

  it('closes the record before it enqueues the case (P3-E)', async () => {
    const records = new InMemoryRunRecords();
    const cases = new InMemoryCaseRepository();
    const enqueue = cases.enqueue.bind(cases);
    const outcomesSeen: (string | null)[] = [];
    cases.enqueue = async (row) => {
      outcomesSeen.push(records.only().record.outcome);
      return enqueue(row);
    };

    const run = await recorded(records, cases).submit(bundle('pa-e0601-ambiguous'), 'corr-r5');
    expect(outcomesSeen).toEqual(['success']);
    expect((await cases.get(run.caseId))?.status).toBe('pended');
  });

  it('enqueues no case when the record fails (P3-E)', async () => {
    for (const failOn of ['open', 'append', 'close'] as const) {
      const records = new InMemoryRunRecords();
      records.failOn = failOn;
      const cases = new InMemoryCaseRepository();

      await expect(
        recorded(records, cases).submit(bundle('pa-e0601-ambiguous'), `corr-r6-${failOn}`),
      ).rejects.toMatchObject({ status: 503 });
      expect(await cases.queue(10), failOn).toEqual([]);
    }
  });

  it('keeps the closed record of a run whose case could not be enqueued (P3-E)', async () => {
    const records = new InMemoryRunRecords();
    const cases = new InMemoryCaseRepository();
    cases.enqueue = async () => {
      throw new Error('the case store is down');
    };

    await expect(
      recorded(records, cases).submit(bundle('pa-e0601-ambiguous'), 'corr-r7'),
    ).rejects.toMatchObject({ status: 503 });
    expect(records.only().record.outcome).toBe('success');
  });

  it('records the bundle, the receipt time and the assessment', async () => {
    const records = new InMemoryRunRecords();

    const run = await recorded(records).submit(bundle('pa-e0601-all-met-structured'), 'corr-r1');
    const stored = records.only();

    expect(stored.record).toMatchObject({
      runId: run.caseId,
      graph: 'prior-auth',
      sessionId: null,
      outcome: 'success',
      // The graph reads `receivedAt` as an input, so the record keeps it.
      startedAt: FIXED,
    });
    expect(stored.decisions.map((row) => row.decision.seam)).toEqual(['assess.criteria']);
  });

  it('answers 503 and returns no decision when the assessment cannot be recorded', async () => {
    const records = new InMemoryRunRecords();
    records.failOn = 'append';

    const failure = await recorded(records)
      .submit(bundle('pa-e0601-all-met-structured'), 'corr-r2')
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(HttpException);
    expect((failure as HttpException).getStatus()).toBe(503);
    expect((failure as HttpException).getResponse()).toMatchObject({
      resourceType: 'OperationOutcome',
    });
    expect(records.only().record.outcome).toBe('error');
  });

  it('answers 503 when the record of a finished run cannot be closed', async () => {
    const records = new InMemoryRunRecords();
    records.failOn = 'close';

    await expect(
      recorded(records).submit(bundle('pa-e0601-all-met-structured'), 'corr-r3'),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('answers 503 when the record cannot be opened', async () => {
    const records = new InMemoryRunRecords();
    records.failOn = 'open';

    await expect(
      recorded(records).submit(bundle('pa-e0601-all-met-structured'), 'corr-r4'),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('the ledger on the prior-authorization path, which fails closed (P3-C)', () => {
  function ledgered(store: InMemoryLedgerStore, cases = new InMemoryCaseRepository()) {
    const records = new InMemoryRunRecords();
    const checkpointer = new MemorySaver();
    const runs = new RunsService(null, null, null, null, null, records);
    const runLedger = new RunLedger(new Ledger(store), records, checkpointer);
    return {
      records,
      service: new PriorAuthService(
        runs,
        checkpointer,
        { now: () => FIXED },
        records,
        cases,
        runLedger,
      ),
    };
  }

  it('commits the run and its recommendation, and the case carries the recommendation’s seq', async () => {
    const store = new InMemoryLedgerStore();
    const cases = new InMemoryCaseRepository();

    const run = await ledgered(store, cases).service.submit(
      bundle('pa-e0601-ambiguous'),
      'corr-l1',
    );

    const rows = await store.readRows();
    expect(rows.entries.map((entry) => entry.kind)).toEqual([
      'run.recorded',
      'disposition.recommended',
    ]);
    const recommendation = JSON.parse(rows.payloads[1]!.payload) as Record<string, unknown>;
    expect(recommendation).toMatchObject({ runId: run.caseId, runEntrySeq: 0 });
    expect((await cases.get(run.caseId))?.recommendationSeq).toBe(1);
    expect(verifyChain(rows).ok).toBe(true);
  });

  it('answers 503 and enqueues no case when the ledger cannot be written', async () => {
    const store = new InMemoryLedgerStore();
    store.transaction = () => Promise.reject(new Error('the ledger database is stopped'));
    const cases = new InMemoryCaseRepository();
    const { records, service: subject } = ledgered(store, cases);

    const failure = await subject.submit(bundle('pa-e0601-ambiguous'), 'corr-l2').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as HttpException).getStatus()).toBe(503);
    expect((failure as HttpException).getResponse()).toMatchObject({
      resourceType: 'OperationOutcome',
      issue: [{ diagnostics: expect.stringContaining('decision ledger') }],
    });
    expect(await cases.queue(10)).toEqual([]);
    expect(records.only().record.outcome).toBe('success');
  });
});
