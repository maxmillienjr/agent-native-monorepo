import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import type { RunResponse } from '@repo/agent-contracts';
import { PG_POOL } from '../src/memory/memory.tokens.js';
import { RunsService } from '../src/runs/runs.service.js';
import { contextSessionId } from '../src/a2a/session-id.js';
import { runsSessionId } from '../src/auth/session-scope.js';
import { bootService, type ServiceApp } from './service-app.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

/**
 * Caller-scoped sessions on `/runs`, against live Postgres and Neo4j (P5-D).
 * Model `stub`, memory `live`, two principals.
 *
 * The first test is the measurement in P5-D's Problem, run the other way: `b`
 * names `a`'s A2A session on `/runs` and reaches nothing of it.
 *
 * `semantic_facts` is keyed on the content hash, and the first writer's
 * session stays on the row. The stub extracts the same sentence on every run,
 * so whichever suite ran first would own it, and a fact this suite wrote could
 * never be found under its session. Each test therefore extracts a sentence of
 * its own.
 */

const SKIP = skipUnlessIntegrationEnv('runs sessions (integration)', 'DATABASE_URL', 'NEO4J_URI');

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKENS = { a: 'token-a', b: 'token-b' } as const;
type Principal = keyof typeof TOKENS;

describe.skipIf(SKIP)('runs sessions (integration)', () => {
  let service: ServiceApp;
  let pool: pg.Pool;
  let fact: string;

  beforeAll(async () => {
    service = await bootService({
      SERVICE_CREDENTIALS: `a:${digest(TOKENS.a)},b:${digest(TOKENS.b)}`,
      DATABASE_URL: process.env['DATABASE_URL']!,
      NEO4J_URI: process.env['NEO4J_URI']!,
    });
    pool = service.app.get<pg.Pool>(PG_POOL);

    service.app.get(RunsService).setModelDecorator((stub) => ({
      ...stub,
      distill: {
        extractEntities: async (context) => {
          const extracted = await stub.distill.extractEntities(context);
          return { ...extracted, extraction: { ...extracted.extraction, facts: [{ text: fact }] } };
        },
      },
    }));
  });

  afterAll(async () => {
    await service?.close();
  });

  beforeEach(() => {
    fact = `P5-D fact ${randomUUID()}`;
  });

  async function runs(principal: Principal, body: object): Promise<RunResponse> {
    const response = await request(service.app.getHttpServer())
      .post('/runs')
      .set('Authorization', `Bearer ${TOKENS[principal]}`)
      .send(body);
    expect(response.status).toBe(200);
    return response.body as RunResponse;
  }

  /** An A2A `SendMessage`, and the `run` artifact of the task it completed. */
  async function send(principal: Principal, text: string, contextId: string) {
    const response = await request(service.app.getHttpServer())
      .post('/a2a/jsonrpc')
      .set('A2A-Version', '1.0')
      .set('Authorization', `Bearer ${TOKENS[principal]}`)
      .send({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'SendMessage',
        params: {
          message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], contextId },
        },
      });
    const task = response.body.result.task as {
      status: { state: string };
      artifacts: { name: string; parts: { data: Record<string, unknown> }[] }[];
    };
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    return task.artifacts.find((artifact) => artifact.name === 'run')!.parts[0]!.data;
  }

  async function turns(sessionId: string): Promise<{ turn: number; runId: string }[]> {
    const rows = await pool.query<{ turn: number; run_id: string }>(
      'SELECT turn_index AS turn, run_id FROM episodes WHERE session_id = $1 ORDER BY turn_index',
      [sessionId],
    );
    return rows.rows.map((row) => ({ turn: row.turn, runId: row.run_id }));
  }

  it("does not let b read or write a's A2A session by naming its derived id", async () => {
    const contextId = randomUUID();
    const first = await send('a', 'What is LangGraph?', contextId);
    expect(first['messageCount']).toBe(1);

    const stolen = contextSessionId('a', contextId);
    const injected = await runs('b', {
      sessionId: stolen,
      messages: [
        { role: 'user', content: 'What is LangGraph?' },
        { role: 'assistant', content: 'A framework for stateful agents.' },
        { role: 'user', content: 'INJECTED BY PRINCIPAL b' },
      ],
    });

    expect(injected.sessionId).toBe(stolen);
    expect(injected.retrievedContext).toEqual([]);

    const second = await send('a', 'And what is a checkpointer?', contextId);
    expect(second['messageCount']).toBe(3);

    const own = await turns(stolen);
    expect(own.map((row) => row.turn)).toEqual([0, 1, 2, 3]);
    expect(own.map((row) => row.runId)).not.toContain(injected.runId);
  });

  it('gives two principals with one sessionId two sessions', async () => {
    const sessionId = randomUUID();
    const body = { sessionId, messages: [{ role: 'user', content: 'What is LangGraph?' }] };

    const fromA = await runs('a', body);
    const fromB = await runs('b', body);

    const records = await pool.query<{ run_id: string; session_id: string }>(
      'SELECT run_id, session_id FROM run_records WHERE run_id = ANY($1::uuid[])',
      [[fromA.runId, fromB.runId]],
    );
    const sessionOf = new Map(records.rows.map((row) => [row.run_id, row.session_id]));

    expect(sessionOf.get(fromA.runId)).toBe(runsSessionId('a', sessionId));
    expect(sessionOf.get(fromB.runId)).toBe(runsSessionId('b', sessionId));
    expect(fromA.sessionId).toBe(sessionId);
    expect(fromB.sessionId).toBe(sessionId);
    expect(fromB.retrievedContext.map((item) => item.episodeId)).not.toContain(fromA.runId);
    expect(await turns(sessionId)).toEqual([]);
  });

  it('continues one principal’s conversation across two requests', async () => {
    const sessionId = randomUUID();

    const first = await runs('a', {
      sessionId,
      messages: [{ role: 'user', content: 'What is LangGraph?' }],
    });
    const second = await runs('a', {
      sessionId,
      messages: [...first.messages, { role: 'user', content: 'And what is a checkpointer?' }],
    });

    expect(second.retrievedContext).toContainEqual(
      expect.objectContaining({ content: fact, episodeId: first.runId }),
    );
    expect((await turns(runsSessionId('a', sessionId))).map((row) => row.turn)).toEqual([
      0, 1, 2, 3,
    ]);
  });
});
