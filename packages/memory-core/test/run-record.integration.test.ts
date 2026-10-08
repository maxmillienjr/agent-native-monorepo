import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { requestHash } from '@repo/agent-cassette';
import { PgRunRecordRepository } from '../src/audit/run-record.repo.js';
import { createReadOnlyPool } from '../src/audit/read-only-pool.js';
import type { RunDecision, RunRecordOpen } from '../src/audit/run-record.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const DATABASE_URL = process.env['DATABASE_URL'];

const SKIP = skipUnlessIntegrationEnv('PgRunRecordRepository (integration)', 'DATABASE_URL');

function header(runId: string, overrides: Partial<RunRecordOpen> = {}): RunRecordOpen {
  return {
    runId,
    graph: 'chat',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    correlationId: 'corr-run-record',
    request: {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      messages: [{ role: 'user', content: 'What is LangGraph?' }],
    },
    gitSha: 'b'.repeat(40),
    gitDirty: false,
    chatModel: 'gemini-2.5-flash',
    embeddingModel: 'gemini-embedding-001',
    embeddingDimensions: 768,
    modelAxis: 'stub',
    ...overrides,
  };
}

function decision(seam: RunDecision['seam'], request: unknown, value: unknown): RunDecision {
  return {
    seam,
    requestHash: requestHash({ seam, request }),
    request,
    response: { kind: 'value', value },
    latencyMs: 1,
  };
}

describe.skipIf(SKIP)('PgRunRecordRepository (integration)', () => {
  let pool: pg.Pool;
  let repo: PgRunRecordRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // The migration is the only DDL for these tables.
    await runMigrations(pool);
    repo = new PgRunRecordRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('round-trips a record and its decisions in the order they resolved', async () => {
    const runId = randomUUID();
    const opened = await repo.open(header(runId));
    const retrieval = decision('memory.retrieve', { topK: 10 }, [
      { source: 'pgvector', score: 0.8312345678901234, content: 'A fact.' },
    ]);
    const plan = decision('plan.callLlm', { systemPrompt: 's', userPrompt: 'u' }, { content: 'p' });

    await repo.append(runId, 0, retrieval);
    await repo.append(runId, 1, plan);
    await repo.close(runId, 'success');

    const stored = await repo.read(runId);

    expect(opened).toEqual({ created: true, decisions: 0 });
    expect(stored?.record).toMatchObject({
      runId,
      graph: 'chat',
      modelAxis: 'stub',
      gitSha: 'b'.repeat(40),
      outcome: 'success',
    });
    expect(stored?.record.request).toEqual(header(runId).request);
    expect(stored?.record.finishedAt).toBeInstanceOf(Date);
    // jsonb stores a number as numeric and gives back the same double.
    expect(stored?.decisions.map((row) => row.decision)).toEqual([retrieval, plan]);
    expect(stored?.decisions.map((row) => row.formatVersion)).toEqual([2, 2]);
  });

  it('re-opens the same run_id idempotently, keeping the first header and counting what it holds', async () => {
    const runId = randomUUID();
    await repo.open(header(runId));
    await repo.append(runId, 0, decision('embed', { text: 'q' }, [0.5]));

    const again = await repo.open(header(runId, { correlationId: 'a-second-open' }));
    const stored = await repo.read(runId);
    const rows = await pool.query('SELECT count(*)::int AS n FROM run_records WHERE run_id = $1', [
      runId,
    ]);

    expect(again).toEqual({ created: false, decisions: 1 });
    expect(rows.rows[0]).toEqual({ n: 1 });
    expect(stored?.record.correlationId).toBe('corr-run-record');
  });

  it('appends after the run failed, and keeps what the failed run recorded', async () => {
    const runId = randomUUID();
    await repo.open(header(runId));
    await repo.append(runId, 0, {
      seam: 'plan.callLlm',
      requestHash: requestHash({ seam: 'plan.callLlm', request: { u: 1 } }),
      request: { u: 1 },
      response: { kind: 'error', name: 'Error', message: 'model unavailable', status: 503 },
      latencyMs: 4,
    });
    await repo.close(runId, 'error');

    // A decision that resolves after the outcome was written — a resumed run,
    // or a call that settled after the graph gave up — is still a decision
    // the run made, and the record takes it.
    await repo.append(runId, 1, decision('plan.callLlm', { u: 1 }, { content: 'late' }));

    const stored = await repo.read(runId);
    expect(stored?.record.outcome).toBe('error');
    expect(stored?.decisions.map((row) => row.decision.response.kind)).toEqual(['error', 'value']);
  });

  it('refuses an ordinal that is already taken', async () => {
    const runId = randomUUID();
    await repo.open(header(runId));
    await repo.append(runId, 0, decision('embed', { text: 'a' }, [1]));

    await expect(repo.append(runId, 0, decision('embed', { text: 'b' }, [2]))).rejects.toThrow();
  });

  it('refuses a decision for a run that was never opened', async () => {
    await expect(
      repo.append(randomUUID(), 0, decision('embed', { text: 'a' }, [1])),
    ).rejects.toThrow();
  });

  it('reads through a read-only pool, which refuses any write', async () => {
    const runId = randomUUID();
    await repo.open(header(runId));
    const readOnly = createReadOnlyPool(DATABASE_URL!);
    try {
      const reader = new PgRunRecordRepository(readOnly);
      expect((await reader.read(runId))?.record.runId).toBe(runId);
      await expect(reader.close(runId, 'success')).rejects.toThrow(/read-only transaction/);
    } finally {
      await readOnly.end();
    }
  });
});
