import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { NO_USAGE } from '../agent/model/usage.js';
import { SyntheticCaseBoard } from '../agent/tools/case-board.js';
import { RunsService } from '../runs/runs.service.js';
import { InMemoryRunRecords } from './memory-run-records.js';
import { replayRun } from './replay-run.js';

const SHA = 'e'.repeat(40);

const BODY = {
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  messages: [{ role: 'user', content: 'Ask for the missing records on the case.' }],
  config: { maxSteps: 3 },
};

/**
 * A run record of a saga (P4-C × P3-B), on model `stub` / memory unconfigured
 * with a `MemorySaver`: `request-records` succeeds on a seeded case, the next
 * call names an unknown one and fails, and `compensate` withdraws the first
 * request. The record has to carry the undo as a decision of its own, and
 * `audit:replay` has to serve it back without reaching a board.
 */
describe('audit replay of a compensated run', () => {
  let key: string | undefined;
  let sha: string | undefined;

  beforeAll(() => {
    key = process.env['GOOGLE_API_KEY'];
    sha = process.env['GIT_SHA'];
    delete process.env['GOOGLE_API_KEY'];
    process.env['GIT_SHA'] = SHA;
  });

  afterAll(() => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
    if (sha === undefined) delete process.env['GIT_SHA'];
    else process.env['GIT_SHA'] = sha;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function compensatedRun(): Promise<{
    runId: string;
    records: InMemoryRunRecords;
    checkpointer: MemorySaver;
  }> {
    const records = new InMemoryRunRecords();
    const checkpointer = new MemorySaver();
    const service = new RunsService(null, null, null, null, checkpointer, records);
    const script = [
      {
        toolName: 'request-records',
        input: { caseId: 'PA-100001', documents: ['lab-results'], dueInDays: 5 },
      },
      {
        toolName: 'request-records',
        input: { caseId: 'PA-999999', documents: ['lab-results'], dueInDays: 5 },
      },
    ];
    service.setModelDecorator((live) => ({
      ...live,
      act: {
        registry: live.act.registry,
        selectTool: async () => ({ selection: script.shift() ?? null, tokenCounts: NO_USAGE }),
      },
    }));

    const run = await service.executeTraced({ body: BODY, correlationId: 'audit-saga' });
    expect(run.nodeSequence).toContain('compensate');
    return { runId: run.response.runId, records, checkpointer };
  }

  it('records the undo as act.compensate, after the call that failed', async () => {
    const { runId, records } = await compensatedRun();

    const stored = await records.read(runId);
    expect(
      stored?.decisions
        .map((row) => row.decision)
        .filter((decision) => decision.seam.startsWith('act.'))
        .map((decision) => [decision.seam, decision.label]),
    ).toEqual([
      ['act.selectTool', undefined],
      ['act.tool', 'request-records'],
      ['act.selectTool', undefined],
      ['act.tool', 'request-records'],
      ['act.compensate', 'request-records'],
    ]);
  });

  it('attributes the undo to compensate under --read-only', async () => {
    const { runId, records, checkpointer } = await compensatedRun();

    const report = await replayRun({ runId, records, checkpointer, buildSha: SHA, readOnly: true });

    expect(report.verdict).toBe('reconstructed');
    expect(report.steps.map((step) => [step.node, step.decisions])).toEqual([
      ['(input)', []],
      ['__start__', []],
      ['ingress', []],
      ['retrieve', ['embed', 'memory.retrieve']],
      ['plan', ['plan.callLlm']],
      ['act', ['act.selectTool', 'act.tool']],
      ['act', ['act.selectTool', 'act.tool']],
      ['compensate', ['act.compensate']],
      ['distill', ['distill.extractEntities']],
      ['reflect', ['embed']],
      ['egress', []],
    ]);
  });

  it('replays every checkpoint from the record, and never reaches a case board', async () => {
    const { runId, records, checkpointer } = await compensatedRun();
    const opened = vi.spyOn(SyntheticCaseBoard.prototype, 'openRequest');
    const withdrawn = vi.spyOn(SyntheticCaseBoard.prototype, 'withdrawRequest');

    const report = await replayRun({ runId, records, checkpointer, buildSha: SHA });

    expect(report.verdict).toBe('match');
    expect(report.decisions.unconsumed).toEqual([]);
    expect(report.steps.find((step) => step.node === 'compensate')?.decisions).toEqual([
      'act.compensate',
    ]);
    expect(opened).not.toHaveBeenCalled();
    expect(withdrawn).not.toHaveBeenCalled();
  });
});
