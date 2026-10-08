import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type pg from 'pg';
import type { Driver } from 'neo4j-driver';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { canonicalJson } from '@repo/agent-cassette';
import { PgRunRecordRepository, createReadOnlyPool } from '@repo/memory-core';
import { MEMORY_RECALL_DATASET_DIR, loadMemoryRecallSuite } from '@repo/eval-harness';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { NEO4J_DRIVER, PG_POOL } from '../src/memory/memory.tokens.js';
import { RunsService } from '../src/runs/runs.service.js';
import { codeIdentity } from '../src/audit/code-identity.js';
import { replayRun, type ReplayReport } from '../src/audit/replay-run.js';
import { createAgentServiceHarness } from '../src/eval/agent-harness.js';
import { replayDecks, watchForModelRequests } from '../src/eval/cassette-deps.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

/**
 * The run record and `audit:replay` against live Postgres and Neo4j (P3-B).
 * Model `stub` unless a test says otherwise; memory `live` throughout.
 *
 * The mutation tests edit `run_decisions` and `checkpoint_blobs` with SQL,
 * which is the point: they play whoever holds the service's credentials, and
 * show that replay notices an edit to one side and not the other.
 */

const SKIP = skipUnlessIntegrationEnv('audit:replay (integration)', 'DATABASE_URL', 'NEO4J_URI');

const SESSION = '550e8400-e29b-41d4-a716-4466554400b0';
const BODY = { sessionId: SESSION, messages: [{ role: 'user', content: 'What is LangGraph?' }] };
const execFileAsync = promisify(execFile);

describe.skipIf(SKIP)('audit:replay (integration)', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;
  let readOnly: pg.Pool;
  let driver: Driver;
  let savedKey: string | undefined;

  beforeAll(async () => {
    savedKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];

    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    pool = app.get<pg.Pool>(PG_POOL);
    driver = app.get<Driver>(NEO4J_DRIVER);
    readOnly = createReadOnlyPool(process.env['DATABASE_URL']!);
  });

  afterAll(async () => {
    await readOnly?.end();
    await app?.close();
    if (savedKey !== undefined) process.env['GOOGLE_API_KEY'] = savedKey;
  });

  async function post(body: unknown = BODY): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/runs')
      .set('Content-Type', 'application/json')
      .set('x-correlation-id', `audit-${Date.now()}`)
      .send(body as object);
    expect(response.status).toBe(200);
    return (response.body as { runId: string }).runId;
  }

  function replay(runId: string, overrides: { buildSha?: string | null; readOnly?: boolean } = {}) {
    return replayRun({
      runId,
      records: new PgRunRecordRepository(readOnly),
      checkpointer: new PostgresSaver(readOnly),
      buildSha: overrides.buildSha === undefined ? codeIdentity().sha : overrides.buildSha,
      readOnly: overrides.readOnly ?? false,
    });
  }

  async function seams(runId: string): Promise<string[]> {
    const rows = await pool.query<{ seam: string }>(
      `SELECT decision->>'seam' AS seam FROM run_decisions WHERE run_id = $1 ORDER BY ordinal`,
      [runId],
    );
    return rows.rows.map((row) => row.seam);
  }

  it('leaves one run_records row holding the body sent and every decision in order', async () => {
    const runId = await post();

    const rows = await pool.query<{ request: unknown; model_axis: string; outcome: string }>(
      'SELECT request, model_axis, outcome FROM run_records WHERE run_id = $1',
      [runId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(canonicalJson(rows.rows[0]!.request)).toBe(canonicalJson(BODY));
    expect(rows.rows[0]).toMatchObject({ model_axis: 'stub', outcome: 'success' });
    // The stub extracts one fact, so `reflect` embeds once.
    expect(await seams(runId)).toEqual([
      'embed',
      'memory.retrieve',
      'plan.callLlm',
      'act.selectTool',
      'distill.extractEntities',
      'embed',
    ]);
  });

  it('replays a stub run with every checkpoint matching, and derives what it wrote', async () => {
    const runId = await post();

    const report = await replay(runId);

    expect(report.exitCode).toBe(0);
    expect(report.verdict).toBe('match');
    expect(report.recordedCheckpoints).toBe(9);
    expect(report.replayedCheckpoints).toBe(9);
    expect(report.steps.map((step) => step.match)).toEqual(new Array(9).fill(true));
    expect(report.decisions).toMatchObject({ recorded: 6, consumed: 6, unconsumed: [] });
    expect(report.steps.find((step) => step.node === 'retrieve')?.decisions).toEqual([
      'embed',
      'memory.retrieve',
    ]);
    expect(report.writes.map((write) => write.store)).toEqual([
      'episodes',
      'episodes',
      'neo4j.concept',
      'semantic_facts',
      'neo4j.fact',
    ]);
  });

  it('records a retried plan as two decisions while the history shows one step, and replays it', async () => {
    const runs = app.get(RunsService);
    let attempts = 0;
    runs.setModelDecorator((live) => ({
      ...live,
      plan: {
        callLlm: async (system, user) => {
          attempts += 1;
          if (attempts === 1) throw new Error('the model was unavailable once');
          return live.plan.callLlm(system, user);
        },
      },
    }));

    let runId: string;
    try {
      runId = await post();
    } finally {
      runs.setModelDecorator((live) => live);
    }

    const plans = (await seams(runId)).filter((seam) => seam === 'plan.callLlm');
    const kinds = await pool.query<{ kind: string }>(
      `SELECT decision->'response'->>'kind' AS kind FROM run_decisions
       WHERE run_id = $1 AND decision->>'seam' = 'plan.callLlm' ORDER BY ordinal`,
      [runId],
    );
    const report = await replay(runId);

    expect(plans).toHaveLength(2);
    expect(kinds.rows.map((row) => row.kind)).toEqual(['error', 'value']);
    expect(report.steps.filter((step) => step.node === 'plan')).toHaveLength(1);
    expect(report.exitCode).toBe(0);
  });

  describe('mutations', () => {
    async function mutated(edit: (runId: string) => Promise<unknown>): Promise<ReplayReport> {
      const runId = await post();
      await edit(runId);
      return replay(runId);
    }

    it('editing one decision’s response exits 1 naming the first divergent step', async () => {
      const report = await mutated((runId) =>
        pool.query(
          `UPDATE run_decisions
           SET decision = jsonb_set(decision, '{response,value,content}', '"an edited plan"')
           WHERE run_id = $1 AND decision->>'seam' = 'plan.callLlm'`,
          [runId],
        ),
      );

      expect(report.exitCode).toBe(1);
      expect(report.divergence).toMatchObject({ step: 3, node: 'plan' });
      expect(report.divergence?.channels).toContain('currentPlan');
      // The prototype's finding, reproduced from a record: -1 to 2 still match.
      expect(report.steps.slice(0, 4).map((step) => step.match)).toEqual([true, true, true, true]);
    });

    it('deleting one decision exits 1 with a miss', async () => {
      const report = await mutated((runId) =>
        pool.query(
          `DELETE FROM run_decisions WHERE run_id = $1
           AND ordinal = (SELECT max(ordinal) FROM run_decisions WHERE run_id = $1)`,
          [runId],
        ),
      );

      expect(report.exitCode).toBe(1);
      expect(report.reason).toMatch(/does not hold/);
      expect(report.replayError).toMatch(/CassetteMissError/);
    });

    it('adding one decision exits 1 with an unconsumed decision', async () => {
      const report = await mutated((runId) =>
        pool.query(
          `INSERT INTO run_decisions (run_id, ordinal, format_version, decision)
           SELECT run_id, ordinal + 1, format_version, decision FROM run_decisions
           WHERE run_id = $1 AND ordinal = (SELECT max(ordinal) FROM run_decisions WHERE run_id = $1)`,
          [runId],
        ),
      );

      expect(report.exitCode).toBe(1);
      expect(report.decisions.unconsumed).toEqual([{ seam: 'embed' }]);
      expect(report.reason).toMatch(/never asked for/);
    });

    it('editing one checkpoint blob exits 1 at that step', async () => {
      const report = await mutated((runId) =>
        pool.query(
          `UPDATE checkpoint_blobs SET blob = convert_to('"an edited plan"', 'UTF8')
           WHERE thread_id = $1 AND channel = 'currentPlan'`,
          [runId],
        ),
      );

      expect(report.exitCode).toBe(1);
      expect(report.divergence).toMatchObject({ step: 3, node: 'plan', channels: ['currentPlan'] });
    });
  });

  describe('refusals', () => {
    it('exits 2 with the recorded sha when the build’s sha differs', async () => {
      const runId = await post();
      const recorded = codeIdentity().sha!;

      const report = await replay(runId, { buildSha: 'f'.repeat(40) });

      expect(report.exitCode).toBe(2);
      expect(report.reason).toContain(recorded);
      expect(report.steps).toEqual([]);
    });

    it('exits 2 when the record names no commit', async () => {
      const runId = await post();
      await pool.query('UPDATE run_records SET git_sha = NULL WHERE run_id = $1', [runId]);

      const report = await replay(runId);

      expect(report.exitCode).toBe(2);
      expect(report.reason).toMatch(/git_sha is null/);
    });
  });

  it('makes no write to Postgres or Neo4j', async () => {
    const runId = await post();
    const tables = [
      'run_records',
      'run_decisions',
      'checkpoints',
      'checkpoint_blobs',
      'checkpoint_writes',
      'episodes',
      'semantic_facts',
    ];
    const counts = async (): Promise<Record<string, number>> => {
      const counted: Record<string, number> = {};
      for (const table of tables) {
        const rows = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        counted[table] = rows.rows[0]!.n;
      }
      const session = driver.session();
      try {
        const nodes = await session.run('MATCH (n) RETURN count(n) AS n');
        counted['neo4j nodes'] = Number(nodes.records[0]!.get('n'));
      } finally {
        await session.close();
      }
      return counted;
    };

    const before = await counts();
    const report = await replay(runId);
    const after = await counts();

    expect(report.exitCode).toBe(0);
    expect(after).toEqual(before);
  });

  it('reconstructs a run with --read-only, attributing each decision to its node', async () => {
    const runId = await post();

    const report = await replay(runId, { readOnly: true });

    expect(report).toMatchObject({ exitCode: 0, verdict: 'reconstructed' });
    expect(report.steps.map((step) => [step.node, step.decisions])).toEqual([
      ['(input)', []],
      ['__start__', []],
      ['ingress', []],
      ['retrieve', ['embed', 'memory.retrieve']],
      ['plan', ['plan.callLlm']],
      ['act', ['act.selectTool']],
      ['distill', ['distill.extractEntities']],
      ['reflect', ['embed']],
      ['egress', []],
    ]);
  });

  it('replays a prior-authorization run, whose receipt time is an input', async () => {
    const bundle = readFileSync(
      join(
        import.meta.dirname,
        '../../../packages/eval-harness/datasets/prior-auth/bundles',
        'pa-e0601-all-met-structured.bundle.json',
      ),
      'utf8',
    );
    const response = await request(app.getHttpServer())
      .post('/fhir/Claim/$submit')
      .set('Content-Type', 'application/fhir+json')
      .send(bundle);
    expect(response.status).toBe(200);
    const caseId = await pool.query<{ run_id: string }>(
      `SELECT run_id FROM run_records WHERE graph = 'prior-auth' ORDER BY started_at DESC LIMIT 1`,
    );

    const report = await replay(caseId.rows[0]!.run_id);

    expect(report.exitCode).toBe(0);
    expect(report.steps.map((step) => step.node)).toEqual([
      '(input)',
      '__start__',
      'intake',
      'lookup',
      'assess',
      'dispose',
    ]);
  });

  it('replays a run whose decisions came from the committed cassettes, with no request to the model host', async () => {
    const reached = watchForModelRequests(() => {});
    const task = loadMemoryRecallSuite(1).tasks.find((entry) => entry.id === 'memory-recall-001')!;
    const harness = await createAgentServiceHarness(
      replayDecks(MEMORY_RECALL_DATASET_DIR, [{ taskId: task.id, trials: 1 }]),
    );

    let runId: string;
    try {
      await harness.reset(task);
      runId = (await harness.run(task)).runId;
    } finally {
      await harness.close();
    }

    const header = await pool.query<{ model_axis: string }>(
      'SELECT model_axis FROM run_records WHERE run_id = $1',
      [runId],
    );
    const report = await replay(runId);

    expect(header.rows[0]?.model_axis).toBe('replay');
    expect(report.exitCode).toBe(0);
    expect(report.decisions.recorded).toBeGreaterThan(6);
    expect(reached()).toEqual([]);
  });

  it('runs as the compiled command and exits with the verdict', async () => {
    const runId = await post();

    const { stdout } = await execFileAsync(
      process.execPath,
      [join(import.meta.dirname, '..', 'dist', 'audit', 'replay.js'), runId],
      { env: { ...process.env } },
    );

    expect(stdout).toContain('verdict: match (exit 0)');
  });
});
