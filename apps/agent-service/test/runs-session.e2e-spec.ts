import { createHash } from 'node:crypto';
import request from 'supertest';
import { RunResponseSchema, StreamEventSchema, type RunRequest } from '@repo/agent-contracts';
import { RunsService, type RunParams } from '../src/runs/runs.service.js';
import { runsSessionId } from '../src/auth/session-scope.js';
import { bootService, type ServiceApp } from './service-app.js';

/**
 * Caller-scoped sessions on `/runs`, on memory stub (P5-D). The stub axis
 * stores nothing, so what is checked here is the body each request hands the
 * run loop; what that does to the stores is `runs-session.integration.test.ts`.
 */

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const BODY = { sessionId: SESSION, messages: [{ role: 'user', content: 'What is LangGraph?' }] };

/** Records the body every chat entry point is given, and still runs it. */
function watchBodies(service: ServiceApp): RunRequest[] {
  const runs = service.app.get(RunsService);
  const seen: RunRequest[] = [];
  const execute = runs.execute.bind(runs);
  const stream = runs.stream.bind(runs);
  runs.execute = (params: RunParams) => {
    seen.push(params.body as RunRequest);
    return execute(params);
  };
  runs.stream = (params: RunParams & Parameters<RunsService['stream']>[0]) => {
    seen.push(params.body as RunRequest);
    return stream(params);
  };
  return seen;
}

describe('POST /runs sessions, two principals', () => {
  let service: ServiceApp;
  let bodies: RunRequest[];

  beforeAll(async () => {
    service = await bootService({
      SERVICE_CREDENTIALS: `a:${digest('token-a')},b:${digest('token-b')}`,
    });
    bodies = watchBodies(service);
  });

  afterAll(async () => {
    await service.close();
  });

  beforeEach(() => {
    bodies.length = 0;
  });

  it('answers each principal 200 with the session id it sent', async () => {
    for (const token of ['token-a', 'token-b']) {
      const response = await request(service.app.getHttpServer())
        .post('/runs')
        .set('Authorization', `Bearer ${token}`)
        .send(BODY);

      expect(response.status).toBe(200);
      expect(() => RunResponseSchema.parse(response.body)).not.toThrow();
      expect(response.body.sessionId).toBe(SESSION);
    }
  });

  it("runs each principal's request in that principal's session", async () => {
    for (const token of ['token-a', 'token-b']) {
      await request(service.app.getHttpServer())
        .post('/runs')
        .set('Authorization', `Bearer ${token}`)
        .send(BODY);
    }

    expect(bodies.map((body) => body.sessionId)).toEqual([
      runsSessionId('a', SESSION),
      runsSessionId('b', SESSION),
    ]);
    expect(bodies.map((body) => body.messages)).toEqual([BODY.messages, BODY.messages]);
  });

  it('scopes POST /runs/stream the same way', async () => {
    const response = await request(service.app.getHttpServer())
      .post('/runs/stream')
      .set('Authorization', 'Bearer token-b')
      .send(BODY);

    expect(response.status).toBe(200);
    expect(response.text).toContain('"node":"done"');
    expect(bodies.map((body) => body.sessionId)).toEqual([runsSessionId('b', SESSION)]);
  });

  it('streams the session id it was sent, and never the stored one', async () => {
    const response = await request(service.app.getHttpServer())
      .post('/runs/stream')
      .set('Authorization', 'Bearer token-b')
      .send(BODY);

    const done = response.text
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => StreamEventSchema.parse(JSON.parse(chunk.slice('data: '.length))))
      .find((frame) => frame.node === 'done');

    expect(done?.state?.sessionId).toBe(SESSION);
    expect(response.text).not.toContain(runsSessionId('b', SESSION));
  });
});

describe('POST /runs sessions, open', () => {
  let service: ServiceApp;
  let bodies: RunRequest[];

  beforeAll(async () => {
    service = await bootService();
    bodies = watchBodies(service);
  });

  afterAll(async () => {
    await service.close();
  });

  it('derives the session for anonymous too, and answers with the id sent', async () => {
    const response = await request(service.app.getHttpServer()).post('/runs').send(BODY);

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe(SESSION);
    expect(bodies.map((body) => body.sessionId)).toEqual([runsSessionId('anonymous', SESSION)]);
  });
});
