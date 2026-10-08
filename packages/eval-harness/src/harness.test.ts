import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { logs } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { GEN_AI, GEN_AI_OPERATION, GENAI_SEMCONV } from '@repo/telemetry/genai';
import { EvalHarness } from './harness.js';
import { AxisRequirementError } from './axes.js';
import { ModelGrader } from './graders/model.js';
import type { AgentHarness, Axes, Grader, SpanRecord, Task, Transcript } from './types.js';

interface FakeOutcome {
  readonly wrote: boolean;
}

function transcript(index: number): Transcript {
  return {
    runId: `run-${index}`,
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

/** Records the call order, which is the thing the runner is responsible for. */
function fakeAgent(axes: Axes, outcomes: FakeOutcome[], log: string[]): AgentHarness<FakeOutcome> {
  let index = 0;
  return {
    name: 'fake',
    axes: () => axes,
    reset: async () => {
      log.push('reset');
    },
    run: async () => {
      log.push('run');
      return transcript(index);
    },
    captureOutcome: async () => {
      log.push('capture');
      return outcomes[index++] ?? { wrote: false };
    },
    close: async () => {
      log.push('close');
    },
  };
}

const wroteSomething: Grader<FakeOutcome> = {
  name: 'wrote_something',
  kind: 'code',
  requires: { memory: 'live' },
  grade: async (_t, outcome) => ({
    value: outcome.wrote ? 1 : 0,
    label: outcome.wrote ? 'pass' : 'fail',
  }),
};

const alwaysPasses: Grader<FakeOutcome> = {
  name: 'always_passes',
  kind: 'code',
  grade: async () => ({ value: 1, label: 'pass' }),
};

function task(
  graders: Grader<FakeOutcome>[],
  overrides: Partial<Task<FakeOutcome>> = {},
): Task<FakeOutcome> {
  return {
    id: 'memory-recall-001',
    description: 'a task',
    input: {},
    seeds: { neo4j: [], relationships: [], pgvector: [], graphFacts: [] },
    graders,
    ...overrides,
  };
}

const liveAxes: Axes = { model: 'live', memory: 'live' };
const MODELS = { chat: 'gemini-2.5-flash', embedding: 'gemini-embedding-001' } as const;

describe('EvalHarness', () => {
  it('resets before every trial, then runs, captures and grades', async () => {
    const log: string[] = [];
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }, { wrote: true }], log),
      models: MODELS,
      suite: { name: 's', tasks: [task([wroteSomething])], trialsPerTask: 2 },
    }).run();

    // Reset first, not last: a suite that crashes leaves the evidence of the
    // failed trial in the stores.
    expect(log).toEqual(['reset', 'run', 'capture', 'reset', 'run', 'capture']);
    expect(report.tasks[0]!.trials).toHaveLength(2);
  });

  it('reports pass@k as capability and pass^k as reliability', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }, { wrote: false }, { wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([wroteSomething])], trialsPerTask: 3 },
    }).run();

    const taskReport = report.tasks[0]!;
    expect(taskReport.passAtK).toBe(true);
    expect(taskReport.passHatK).toBe(false);
    expect(taskReport.perGraderPassRate['wrote_something']).toBeCloseTo(2 / 3);
    expect(report.passRate).toBeCloseTo(2 / 3);
  });

  it('reports pass^k true only when every trial passed', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }, { wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([wroteSomething])], trialsPerTask: 2 },
    }).run();

    expect(report.tasks[0]!.passHatK).toBe(true);
    expect(report.passRate).toBe(1);
  });

  it('refuses before running a single trial when an axis is unconfigured', async () => {
    const log: string[] = [];
    const harness = new EvalHarness<FakeOutcome>({
      agent: fakeAgent({ model: 'stub', memory: 'unconfigured' }, [{ wrote: false }], log),
      suite: { name: 's', tasks: [task([wroteSomething])], trialsPerTask: 5 },
    });

    await expect(harness.run()).rejects.toThrow(AxisRequirementError);
    // Not one model call, not one database write, and — the point — not one
    // reported pass earned against the no-op writers.
    expect(log).toEqual([]);
  });

  it('skips a task whose axis requirement is unmet instead of refusing the suite', async () => {
    const log: string[] = [];
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent({ model: 'stub', memory: 'live' }, [{ wrote: true }, { wrote: true }], log),
      suite: {
        name: 's',
        tasks: [
          task([wroteSomething]),
          task([alwaysPasses], { id: 'tool-use-001', requires: { model: ['live', 'replay'] } }),
        ],
        trialsPerTask: 2,
      },
    }).run();

    // The suite still ran. Refusing it because one task wants an axis would
    // make `yarn eval` unusable on a clone with no `.env`.
    expect(report.tasks.map((t) => t.taskId)).toEqual(['memory-recall-001']);
    expect(report.skipped).toEqual([
      {
        taskId: 'tool-use-001',
        problems: ['model axis is `stub`, needs one of `live`, `replay`'],
      },
    ]);
    // Not one trial spent on the task that could not be measured.
    expect(log).toEqual(['reset', 'run', 'capture', 'reset', 'run', 'capture']);
  });

  it('computes passRate over the tasks that ran, and says which did not', async () => {
    // The trap: the skipped task contributed the failures, so the rate goes up.
    // A rate that rose because the denominator shrank is only honest while the
    // exclusion travels with it, which is what `skipped` is for.
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent({ model: 'stub', memory: 'live' }, [{ wrote: true }, { wrote: true }], []),
      suite: {
        name: 's',
        tasks: [
          task([wroteSomething]),
          task([alwaysPasses], { id: 'tool-use-001', requires: { model: 'live' } }),
        ],
        trialsPerTask: 2,
      },
    }).run();

    expect(report.passRate).toBe(1);
    expect(report.skipped).toHaveLength(1);
    // trialsPerTask × tasks that were not skipped.
    expect(report.tasks.flatMap((t) => t.trials)).toHaveLength(2);
  });

  it('runs every task when the axes meet what each declared', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }, { wrote: true }], []),
      models: MODELS,
      suite: {
        name: 's',
        tasks: [
          task([wroteSomething]),
          task([alwaysPasses], { id: 'tool-use-001', requires: { model: ['live', 'replay'] } }),
        ],
        trialsPerTask: 1,
      },
    }).run();

    expect(report.skipped).toEqual([]);
    expect(report.tasks).toHaveLength(2);
  });

  it('reports no skips when nothing declared a requirement', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([wroteSomething])], trialsPerTask: 1 },
    }).run();

    expect(report.skipped).toEqual([]);
  });

  it('names an uncalibrated judge in the report', async () => {
    const judged = new ModelGrader<FakeOutcome>({
      name: 'answer_is_grounded',
      rubric: 'grounded?',
      systemUnderTestProvider: 'google',
      judge: {
        provider: 'anthropic',
        model: 'j',
        complete: async () => '{"label":"pass","explanation":"ok"}',
      },
    });

    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([judged])], trialsPerTask: 1 },
    }).run();

    expect(report.uncalibratedGraders).toEqual(['answer_is_grounded']);
  });

  it('rejects a model grader that returns a score with no explanation', async () => {
    const silent: Grader<FakeOutcome> = {
      name: 'silent_judge',
      kind: 'model',
      grade: async () => ({ value: 1, label: 'pass' }),
    };

    const harness = new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([silent])], trialsPerTask: 1 },
    });

    await expect(harness.run()).rejects.toThrow(/no explanation/);
  });
});

describe('the per-task trial cap', () => {
  const replayAxes: Axes = { model: 'replay', memory: 'live' };
  const provenance = {
    recordedAt: '2026-09-10T00:00:00.000Z',
    gitSha: 'a'.repeat(40),
    cassettes: 1,
  };

  it('runs a task as many times as it asked for, when it asked for fewer', async () => {
    const log: string[] = [];
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(replayAxes, [{ wrote: true }], log),
      models: MODELS,
      suite: {
        name: 's',
        tasks: [task([alwaysPasses], { trialsPerTask: 1 })],
        trialsPerTask: 5,
      },
      replay: provenance,
    }).run();

    expect(log).toEqual(['reset', 'run', 'capture']);
    expect(report.tasks[0]!.trials).toHaveLength(1);
  });

  it('reports the count it used, not the suite’s', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(replayAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: {
        name: 's',
        tasks: [task([alwaysPasses], { trialsPerTask: 1 })],
        trialsPerTask: 5,
      },
      replay: provenance,
    }).run();

    // `pass^k` over one trial is `pass@k` over one trial, and the only thing on
    // the page that says so is the k beside it.
    expect(report.tasks[0]!.trialsPerTask).toBe(1);
    expect(report.trialsPerTask).toBe(5);
  });

  it('cannot raise the suite’s figure, only lower it', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: {
        name: 's',
        tasks: [task([alwaysPasses], { trialsPerTask: 9 })],
        trialsPerTask: 2,
      },
    }).run();

    expect(report.tasks[0]!.trialsPerTask).toBe(2);
    expect(report.tasks[0]!.trials).toHaveLength(2);
  });

  it('leaves a task that capped nothing on the suite’s figure', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }, { wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 2 },
    }).run();

    expect(report.tasks[0]!.trialsPerTask).toBe(2);
  });
});

describe('budgets', () => {
  /** A trial that made two model calls, 600 input tokens and 900 output between them. */
  function spentAgent(axes: Axes): AgentHarness<FakeOutcome> {
    const call = (input: number, output: number, spanId: string): SpanRecord => ({
      name: 'generate_content gemini-2.5-flash',
      kind: 'client',
      traceId: 't'.repeat(32),
      spanId,
      startTimeUnixMs: 0,
      durationMs: 10,
      status: 'unset',
      attributes: {
        [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.GENERATE_CONTENT,
        [GEN_AI.REQUEST_MODEL]: 'gemini-2.5-flash',
        [GEN_AI.USAGE_INPUT_TOKENS]: input,
        [GEN_AI.USAGE_OUTPUT_TOKENS]: output,
      },
    });
    const agent = fakeAgent(axes, [{ wrote: true }], []);
    return {
      ...agent,
      run: async () => ({
        ...transcript(0),
        spans: axes.model === 'stub' ? [] : [call(400, 300, 'a'), call(200, 600, 'b')],
      }),
    };
  }

  const overInput = task([wroteSomething], {
    budgets: { inputTokens: 500, outputTokens: 1000, modelCalls: 5 },
  });

  it('keeps a correct trial that spent too much passed, and counts the breach beside the rate', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: spentAgent(liveAxes),
      models: MODELS,
      suite: { name: 's', tasks: [overInput], trialsPerTask: 1 },
    }).run();
    const trial = report.tasks[0]!.trials[0]!;

    expect(trial.passed).toBe(true);
    expect(trial.withinBudget).toBe(false);
    expect(trial.budgets.map((budget) => [budget.budget, budget.label, budget.actual])).toEqual([
      ['inputTokens', 'breached', 600],
      ['outputTokens', 'within', 900],
      ['modelCalls', 'within', 2],
    ]);
    // Beside the rate, not inside it: P1-D compares pass rates.
    expect(report.passRate).toBe(1);
    expect(report.tasks[0]!.passHatK).toBe(true);
    expect(report.budgetBreaches).toBe(1);
    expect(report.usage.trials).toEqual([
      expect.objectContaining({ taskId: 'memory-recall-001', inputTokens: 600, modelCalls: 2 }),
    ]);
  });

  it('checks nothing on model=stub and says why in the usage section', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: spentAgent({ model: 'stub', memory: 'live' }),
      suite: { name: 's', tasks: [overInput], trialsPerTask: 1 },
    }).run();

    expect(report.tasks[0]!.trials[0]!.budgets).toEqual([]);
    expect(report.tasks[0]!.trials[0]!.withinBudget).toBe(true);
    expect(report.budgetBreaches).toBe(0);
    expect(report.usage).toMatchObject({ checked: false, trials: [] });
    expect(report.usage.reason).toContain('budgets not checked on model=stub');
  });
});

describe('replay provenance', () => {
  const replayAxes: Axes = { model: 'replay', memory: 'live' };
  const provenance = {
    recordedAt: '2026-09-10T00:00:00.000Z',
    gitSha: 'b'.repeat(40),
    cassettes: 2,
  };

  it('travels into the report, so a replayed rate names the set behind it', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(replayAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
      replay: provenance,
    }).run();

    expect(report.replay).toEqual(provenance);
  });

  it('refuses to replay without it, before a single trial runs', async () => {
    const log: string[] = [];
    const harness = new EvalHarness<FakeOutcome>({
      agent: fakeAgent(replayAxes, [{ wrote: true }], log),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
    });

    await expect(harness.run()).rejects.toThrow(/no cassette provenance/);
    expect(log).toEqual([]);
  });

  it('refuses to attribute a live run to a cassette set', async () => {
    const harness = new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
      replay: provenance,
    });

    await expect(harness.run()).rejects.toThrow(/model axis `live`/);
  });

  it('names the model ids on the live and replay axes, and refuses them on stub', async () => {
    const live = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
    }).run();
    expect(live.models).toEqual(MODELS);

    const log: string[] = [];
    await expect(
      new EvalHarness<FakeOutcome>({
        agent: fakeAgent(liveAxes, [{ wrote: true }], log),
        suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
      }).run(),
    ).rejects.toThrow(/no model ids were given/);
    await expect(
      new EvalHarness<FakeOutcome>({
        agent: fakeAgent({ model: 'stub', memory: 'live' }, [{ wrote: true }], log),
        models: MODELS,
        suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
      }).run(),
    ).rejects.toThrow(/model axis `stub`/);
    // Both refusals come before the first trial.
    expect(log).toEqual([]);
  });

  it('leaves the block off a report that did not replay', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
    }).run();

    expect(report.replay).toBeUndefined();
    expect(Object.keys(report)).not.toContain('replay');
  });
});

/**
 * One `gen_ai.evaluation.result` log record per grader result, carrying the
 * trace and span id of the run it judged.
 */
describe('evaluation events', () => {
  const exporter = new InMemoryLogRecordExporter();
  const ROOT = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

  beforeAll(() => {
    logs.setGlobalLoggerProvider(
      new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] }),
    );
  });

  beforeEach(() => exporter.reset());

  /** A transcript whose spans arrive children first, as an exporter sees them. */
  const withSpans = (base: Transcript): Transcript => ({
    ...base,
    spans: [
      {
        name: 'agent.node.ingress',
        kind: 'internal',
        traceId: ROOT.traceId,
        spanId: 'c'.repeat(16),
        parentSpanId: ROOT.spanId,
        startTimeUnixMs: 1,
        durationMs: 1,
        status: 'unset',
        attributes: {},
      },
      {
        name: 'invoke_agent agent-service',
        kind: 'internal',
        traceId: ROOT.traceId,
        spanId: ROOT.spanId,
        startTimeUnixMs: 0,
        durationMs: 3,
        status: 'unset',
        attributes: { 'gen_ai.operation.name': 'invoke_agent' },
      },
    ],
  });

  const explained: Grader<FakeOutcome> = {
    name: 'explained',
    kind: 'model',
    grade: async () => ({ value: 0, label: 'fail', explanation: 'the answer was ungrounded' }),
  };

  it('emits one per grader result, parented to the trial’s invoke_agent span', async () => {
    const agent = fakeAgent(liveAxes, [{ wrote: true }, { wrote: true }], []);
    const report = await new EvalHarness<FakeOutcome>({
      agent: { ...agent, run: async (t) => withSpans(await agent.run(t)) },
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses, explained])], trialsPerTask: 2 },
    }).run();

    const records = exporter.getFinishedLogRecords();
    const results = report.tasks.flatMap((t) => t.trials.flatMap((trial) => trial.results));
    expect(records).toHaveLength(results.length);
    expect(records).toHaveLength(4);

    for (const record of records) {
      expect(record.eventName).toBe('gen_ai.evaluation.result');
      expect(record.spanContext?.traceId).toBe(ROOT.traceId);
      expect(record.spanContext?.spanId).toBe(ROOT.spanId);
    }

    expect(records[1]!.attributes).toEqual({
      'gen_ai.evaluation.name': 'explained',
      'gen_ai.evaluation.score.value': 0,
      'gen_ai.evaluation.score.label': 'fail',
      'gen_ai.evaluation.explanation': 'the answer was ungrounded',
      'agent_native.eval.task_id': 'memory-recall-001',
      'agent_native.eval.trial_index': 0,
      'agent_native.eval.grader_kind': 'model',
      'agent_native.model_axis': 'live',
      'agent_native.memory_axis': 'live',
    });
    // No explanation, no key: absent is not an empty string.
    expect(records[0]!.attributes['gen_ai.evaluation.explanation']).toBeUndefined();
    expect(records[3]!.attributes['agent_native.eval.trial_index']).toBe(1);
  });

  it('emits unparented events, and no error, for a transcript with no spans', async () => {
    await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
    }).run();

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.spanContext).toBeUndefined();
  });

  it('names the conventions commit the events and spans follow in the report', async () => {
    const report = await new EvalHarness<FakeOutcome>({
      agent: fakeAgent(liveAxes, [{ wrote: true }], []),
      models: MODELS,
      suite: { name: 's', tasks: [task([alwaysPasses])], trialsPerTask: 1 },
    }).run();

    expect(report.genAiSemconvCommit).toBe(GENAI_SEMCONV.commit);
  });
});
