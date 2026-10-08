import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decodeFloat32Base64,
  DecisionQueue,
  requestHash,
} from '@repo/agent-cassette';
import { EMBEDDING_DIMENSIONS } from '@repo/memory-core';
import { RunsService } from '../runs/runs.service.js';
import { calls, replayRetrievalFacade } from '../agent/model/decision-seam.js';
import { InMemoryRunRecords } from './memory-run-records.js';
import { readCodeIdentity } from './code-identity.js';

const BODY = {
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  messages: [{ role: 'user', content: 'What is LangGraph?' }],
};

const SHA = 'c'.repeat(40);

describe('a chat run on the stub model', () => {
  let key: string | undefined;

  beforeAll(() => {
    key = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
  });

  afterAll(() => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
  });

  function service(records: InMemoryRunRecords): RunsService {
    return new RunsService(null, null, null, null, null, records);
  }

  it('records the body as received and every decision in the order it resolved', async () => {
    const records = new InMemoryRunRecords();

    const run = await service(records).executeTraced({ body: BODY, correlationId: 'corr-1' });
    const stored = records.only();

    expect(stored.record).toMatchObject({
      runId: run.response.runId,
      graph: 'chat',
      sessionId: BODY.sessionId,
      correlationId: 'corr-1',
      modelAxis: 'stub',
      outcome: 'success',
    });
    expect(canonicalJson(stored.record.request)).toBe(canonicalJson(BODY));
    // The stub extracts one fact, so `reflect` embeds once.
    expect(stored.decisions.map((row) => row.decision.seam)).toEqual([
      'embed',
      'memory.retrieve',
      'plan.callLlm',
      'act.selectTool',
      'distill.extractEntities',
      'embed',
    ]);
    expect(stored.decisions.map((row) => row.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('records a retried call as the error and then the success', async () => {
    const records = new InMemoryRunRecords();
    const runs = service(records);
    let calls = 0;
    runs.setModelDecorator((live) => ({
      ...live,
      plan: {
        callLlm: async (system, user) => {
          calls += 1;
          if (calls === 1) throw new Error('model unavailable');
          return live.plan.callLlm(system, user);
        },
      },
    }));

    await runs.executeTraced({ body: BODY, correlationId: 'corr-2' });
    const plans = records
      .only()
      .decisions.filter((row) => row.decision.seam === 'plan.callLlm')
      .map((row) => row.decision.response.kind);

    expect(plans).toEqual(['error', 'value']);
  });

  it('fails the run when the record cannot be opened, before any work', async () => {
    const records = new InMemoryRunRecords();
    records.failOn = 'open';

    await expect(
      service(records).executeTraced({ body: BODY, correlationId: 'corr-3' }),
    ).rejects.toThrow('open refused');
  });

  it('completes the run when an append fails, and closes the record partial', async () => {
    const records = new InMemoryRunRecords();
    records.failOn = 'append';

    const run = await service(records).executeTraced({ body: BODY, correlationId: 'corr-4' });

    expect(run.response.outcome).toBe('success');
    expect(records.only().record.outcome).toBe('partial');
    expect(records.only().decisions).toEqual([]);
  });

  it('records nothing on the unconfigured memory axis', async () => {
    const run = await new RunsService(null, null, null, null, null, null).executeTraced({
      body: BODY,
      correlationId: 'corr-5',
    });

    expect(run.response.outcome).toBe('success');
  });
});

describe('the memory.retrieve seam', () => {
  it('hashes a query the same after its embedding has been through the float32 codec', async () => {
    // The stub embedder returns doubles; the record keeps float32. A replayed
    // `retrieve` asks with the decoded vector, and must still find the
    // recorded read.
    const exact = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(i * 0.01));
    const recorded = calls.retrieve({ queryEmbedding: exact, topK: 10, sessionId: BODY.sessionId });
    const decoded = decodeFloat32Base64(
      (recorded.request as { queryEmbedding: string }).queryEmbedding,
    );

    const queue = new DecisionQueue([
      {
        seam: recorded.seam,
        requestHash: requestHash(recorded),
        request: recorded.request,
        response: {
          kind: 'value',
          value: [{ source: 'pgvector', score: 0.9, content: 'A fact.' }],
        },
        latencyMs: 1,
      },
    ]);

    await expect(
      replayRetrievalFacade(queue).retrieve({
        queryEmbedding: decoded,
        topK: 10,
        sessionId: BODY.sessionId,
      }),
    ).resolves.toEqual([{ source: 'pgvector', score: 0.9, content: 'A fact.' }]);
  });
});

describe('readCodeIdentity', () => {
  const head = () => ({ sha: 'd'.repeat(40), dirty: true });

  it('prefers GIT_SHA, which is all an image has', () => {
    expect(readCodeIdentity({ GIT_SHA: SHA }, head)).toEqual({
      sha: SHA,
      dirty: null,
      source: 'GIT_SHA',
    });
  });

  it('asks the working tree when GIT_SHA is unset or empty', () => {
    expect(readCodeIdentity({ GIT_SHA: '' }, head)).toEqual({
      sha: 'd'.repeat(40),
      dirty: true,
      source: 'git',
    });
  });

  it('ignores a GIT_SHA that is not a full sha rather than recording it', () => {
    expect(readCodeIdentity({ GIT_SHA: 'main' }, head).source).toBe('git');
  });

  it('is null when there is no GIT_SHA and no repository', () => {
    const noGit = () => {
      throw new Error('spawn git ENOENT');
    };
    expect(readCodeIdentity({}, noGit)).toEqual({ sha: null, dirty: null, source: 'none' });
  });
});
