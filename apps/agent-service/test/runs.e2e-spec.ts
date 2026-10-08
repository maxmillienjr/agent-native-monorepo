import { Test, type TestingModule } from '@nestjs/testing';
import { type INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe.js';
import { RunRequestSchema, RunResponseSchema, StreamEventSchema } from '@repo/agent-contracts';
import { RunsService } from '../src/runs/runs.service.js';

describe('RunsController (e2e)', () => {
  let app: INestApplication;
  let savedApiKey: string | undefined;
  let savedDatabaseUrl: string | undefined;
  let savedNeo4jUri: string | undefined;

  beforeAll(async () => {
    // RunsService.getDeps() reads GOOGLE_API_KEY at request time and switches to
    // live Gemini calls when it is set. The README tells every reader to put one
    // in .env, so without this the suite reaches the network and fails on
    // whatever the model catalogue looks like that day. This suite covers the
    // HTTP surface and graph wiring, so it pins the stub dependency set.
    savedApiKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];

    // Memory is a second, independent axis: DATABASE_URL and NEO4J_URI select
    // the real adapters, the migrations and the checkpointer. A developer with
    // those in their environment would otherwise boot this suite against
    // databases it does not provide, and the service is built to fail loudly
    // rather than fall back to stubs when a configured store is unreachable.
    savedDatabaseUrl = process.env['DATABASE_URL'];
    savedNeo4jUri = process.env['NEO4J_URI'];
    delete process.env['DATABASE_URL'];
    delete process.env['NEO4J_URI'];

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe(RunRequestSchema));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (savedApiKey !== undefined) process.env['GOOGLE_API_KEY'] = savedApiKey;
    if (savedDatabaseUrl !== undefined) process.env['DATABASE_URL'] = savedDatabaseUrl;
    if (savedNeo4jUri !== undefined) process.env['NEO4J_URI'] = savedNeo4jUri;
  });

  describe('POST /runs', () => {
    it('returns 200 with a valid RunResponse', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', 'test-corr-001')
        .send({
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          messages: [{ role: 'user', content: 'What is LangGraph?' }],
        });

      expect(response.status).toBe(HttpStatus.OK);
      expect(() => RunResponseSchema.parse(response.body)).not.toThrow();
      expect(response.body.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('mints a correlation id when the header is absent', async () => {
      // The gateway mints one, so the README quickstart never hits this. A
      // direct caller of port 3000 did, and got a 500: the controller bound
      // undefined and seedWorkingMemory's Zod parse threw.
      const response = await request(app.getHttpServer())
        .post('/runs')
        .set('Content-Type', 'application/json')
        .send({
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          messages: [{ role: 'user', content: 'What is LangGraph?' }],
        });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('returns 400 for invalid request body', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .set('Content-Type', 'application/json')
        .send({ sessionId: 'not-a-uuid', messages: [] });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body).toHaveProperty('error', 'Validation Error');
      expect(response.body).toHaveProperty('issues');
    });
  });

  describe('POST /runs/stream', () => {
    it('returns text/event-stream content type', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs/stream')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', 'test-corr-002')
        .send({
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          messages: [{ role: 'user', content: 'What is LangGraph?' }],
        });

      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('data:');
    });
  });
});

describe('POST /runs/stream when a node fails', () => {
  let app: INestApplication;
  let savedApiKey: string | undefined;
  let savedDatabaseUrl: string | undefined;
  let savedNeo4jUri: string | undefined;

  beforeAll(async () => {
    savedApiKey = process.env['GOOGLE_API_KEY'];
    savedDatabaseUrl = process.env['DATABASE_URL'];
    savedNeo4jUri = process.env['NEO4J_URI'];
    delete process.env['GOOGLE_API_KEY'];
    delete process.env['DATABASE_URL'];
    delete process.env['NEO4J_URI'];

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe(RunRequestSchema));
    await app.init();

    // A dependency set whose `plan` always throws, so the failure lands after
    // the stream has already written its first frame and committed the
    // response. IO_RETRY exhausts its three attempts and the error escapes the
    // graph, which is exactly the path the terminal frame exists for.
    const service = moduleFixture.get(RunsService);
    const embedding = async () => new Array(4).fill(0);
    service.setDeps({
      retrieve: { retrievalFacade: { retrieve: async () => [] }, embedQuery: embedding },
      plan: {
        callLlm: async () => {
          throw new Error('upstream model unavailable');
        },
      },
      act: {
        tools: [],
        selectTool: async () => ({ selection: null, tokenCounts: { prompt: 0, completion: 0 } }),
      },
      distill: {
        extractEntities: async () => ({
          extraction: { entities: [], relationships: [], facts: [] },
          tokenCounts: { prompt: 0, completion: 0 },
        }),
      },
      reflect: {
        episodicRepo: {
          write: async () => ({ id: '550e8400-e29b-41d4-a716-446655440002' }),
          findBySession: async () => [],
        },
        neo4jWriter: {
          mergeEntity: async () => {},
          mergeRelationship: async () => {},
          mergeFact: async () => {},
        },
        pgvectorWriter: { upsertFact: async () => {} },
        embedText: embedding,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    if (savedApiKey !== undefined) process.env['GOOGLE_API_KEY'] = savedApiKey;
    if (savedDatabaseUrl !== undefined) process.env['DATABASE_URL'] = savedDatabaseUrl;
    if (savedNeo4jUri !== undefined) process.env['NEO4J_URI'] = savedNeo4jUri;
  });

  it('emits a terminal error frame and closes the stream', async () => {
    const response = await request(app.getHttpServer())
      .post('/runs/stream')
      .set('Content-Type', 'application/json')
      .send({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'What is LangGraph?' }],
      });

    const frames = response.text
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => StreamEventSchema.parse(JSON.parse(chunk.slice('data: '.length))));

    // Asserted from an observed response rather than from the schema: STATUS
    // row 14 records `delta` and `state` as declared and emitted zero times,
    // and a third never-emitted optional field would make that worse.
    const terminal = frames[frames.length - 1];
    expect(terminal?.error).toBeDefined();
    expect(terminal?.error?.message).toContain('upstream model unavailable');
    expect(frames.some((frame) => frame.node === 'done')).toBe(false);
  }, 20_000);
});
