import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EvalHarness,
  type AgentHarness,
  type EvalAbort,
  type Grader,
  type Suite,
  type Transcript,
} from '@repo/eval-harness';
import { runAndReport, type RunEnd } from './run-suite.js';

/**
 * The runner's two ends, driven through the real `EvalHarness` with a fake
 * agent. No store, no model, no Nest context: what is under test is which
 * files a run leaves behind, and that is decided here rather than by the agent.
 */
interface FakeOutcome {
  readonly wrote: boolean;
}

function transcript(runId: string): Transcript {
  return {
    runId,
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    messages: [],
    nodeSequence: ['ingress', 'egress'],
    toolCalls: [],
    retrievedContext: [],
    tokenCounts: { prompt: 1, completion: 1 },
    outcome: 'success',
    latencyMs: 1,
  };
}

const wroteSomething: Grader<FakeOutcome> = {
  name: 'wrote_something',
  kind: 'code',
  grade: async (_transcript, outcome) =>
    outcome.wrote ? { value: 1, label: 'pass' } : { value: 0, label: 'fail' },
};

const suite: Suite<FakeOutcome> = {
  name: 'fake-suite',
  trialsPerTask: 2,
  tasks: [
    {
      id: 'task-001',
      description: 'a task',
      input: {},
      seeds: { neo4j: [], relationships: [], pgvector: [] },
      graders: [wroteSomething],
    },
  ],
};

/** An agent whose nth run either returns an outcome or throws. */
function fakeAgent(runs: readonly (FakeOutcome | Error)[]): AgentHarness<FakeOutcome> {
  let call = 0;
  const outcomes = new Map<string, FakeOutcome>();
  return {
    name: 'fake',
    axes: () => ({ model: 'stub', memory: 'live' }),
    reset: async () => {},
    run: async () => {
      const next = runs[call];
      const runId = `run-${call}`;
      call += 1;
      if (next === undefined) throw new Error('the fake ran out of runs');
      if (next instanceof Error) throw next;
      outcomes.set(runId, next);
      return transcript(runId);
    },
    captureOutcome: async (_task, run) => outcomes.get(run.runId)!,
    close: async () => {},
  };
}

function run(dir: string, agent: AgentHarness<FakeOutcome>): Promise<RunEnd> {
  return runAndReport<FakeOutcome>({
    outputDir: dir,
    suite: suite.name,
    body: (progress, onTrial) => {
      progress.axes = agent.axes();
      return new EvalHarness({ agent, suite, onTrial }).run();
    },
    now: () => new Date('2026-09-26T00:00:00.000Z'),
  });
}

describe('runAndReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-suite-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the three reports for a passing suite, and nothing else', async () => {
    const end = await run(dir, fakeAgent([{ wrote: true }, { wrote: true }]));

    expect(end).toBe('passed');
    expect(existsSync(join(dir, 'eval-report.json'))).toBe(true);
    expect(existsSync(join(dir, 'eval-report.xml'))).toBe(true);
    expect(existsSync(join(dir, 'eval-summary.md'))).toBe(true);
    expect(existsSync(join(dir, 'eval-abort.json'))).toBe(false);
  });

  it('writes all three reports for a graded failure, ends `failed`, and writes no abort', async () => {
    // The existing contract, kept: a failed trial is a completed suite with a
    // rate, and its reports are what a reader diagnoses it from. The runner
    // turns `failed` into exit 1, as it always has.
    const end = await run(dir, fakeAgent([{ wrote: true }, { wrote: false }]));

    expect(end).toBe('failed');
    expect(existsSync(join(dir, 'eval-report.json'))).toBe(true);
    expect(existsSync(join(dir, 'eval-report.xml'))).toBe(true);
    expect(readFileSync(join(dir, 'eval-summary.md'), 'utf8')).toContain('overall pass rate 50%');
    expect(existsSync(join(dir, 'eval-abort.json'))).toBe(false);
  });

  it('writes an abort, not a report, when the second run throws, and lists the first', async () => {
    const miss = Object.assign(new Error('cassette miss at seam `plan.callLlm`'), {
      name: 'CassetteMissError',
    });
    const end = await run(dir, fakeAgent([{ wrote: true }, miss]));

    expect(end).toBe('aborted');
    expect(existsSync(join(dir, 'eval-report.json'))).toBe(false);
    expect(existsSync(join(dir, 'eval-report.xml'))).toBe(false);

    const abort = JSON.parse(readFileSync(join(dir, 'eval-abort.json'), 'utf8')) as EvalAbort;
    expect(abort.error).toEqual({
      name: 'CassetteMissError',
      message: 'cassette miss at seam `plan.callLlm`',
    });
    expect(abort.axes).toEqual({ model: 'stub', memory: 'live' });
    expect(abort.completedTrials).toEqual([
      { taskId: 'task-001', index: 0, runId: 'run-0', passed: true, failedGraders: [] },
    ]);

    const summary = readFileSync(join(dir, 'eval-summary.md'), 'utf8');
    expect(summary.startsWith('## Eval — aborted')).toBe(true);
    expect(summary).toContain('**`CassetteMissError`**');
  });

  it("clears an earlier run's report, so an abort never sits beside one", async () => {
    writeFileSync(join(dir, 'eval-report.json'), '{"stale":true}\n');
    writeFileSync(join(dir, 'eval-report.xml'), '<stale/>\n');

    const end = await run(dir, fakeAgent([new Error('stores unreachable')]));

    expect(end).toBe('aborted');
    expect(existsSync(join(dir, 'eval-report.json'))).toBe(false);
    expect(existsSync(join(dir, 'eval-report.xml'))).toBe(false);
    expect(existsSync(join(dir, 'eval-abort.json'))).toBe(true);
  });

  it('redacts a key-shaped string before the abort reaches the artifact', async () => {
    const key = `AIza${'x'.repeat(35)}`;
    await run(dir, fakeAgent([new Error(`request failed for ?key=${key}`)]));

    const written = readFileSync(join(dir, 'eval-abort.json'), 'utf8');
    expect(written).not.toContain(key);
    expect(written).toContain('[REDACTED]');
  });
});
