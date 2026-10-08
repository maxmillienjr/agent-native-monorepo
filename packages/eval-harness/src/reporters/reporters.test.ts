import { describe, it, expect } from 'vitest';
import { renderJsonReport } from './json.js';
import { renderJUnitReport } from './junit.js';
import { renderMarkdownSummary } from './summary.js';
import { abortError, completedTrial, renderAbortJson, renderAbortSummary } from './abort.js';
import type { EvalAbort, SuiteReport, Trial } from '../types.js';

function trial(index: number, passed: boolean): Trial {
  return {
    taskId: 'memory-recall-001',
    index,
    transcript: {
      runId: `run-${index}`,
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      messages: [],
      nodeSequence: ['ingress', 'egress'],
      toolCalls: [],
      retrievedContext: [],
      tokenCounts: { prompt: 1, completion: 1 },
      outcome: 'success',
      latencyMs: 1,
    },
    outcome: {},
    results: [
      {
        grader: 'episodic_row_written',
        kind: 'code',
        score: passed
          ? { value: 1, label: 'pass', explanation: '2 episodes row(s)' }
          : { value: 0, label: 'fail', explanation: '0 episodes row(s) & counting' },
      },
    ],
    passed,
    budgets: [],
    withinBudget: true,
  };
}

const report: SuiteReport = {
  suite: 'memory-recall',
  startedAt: '2026-08-29T00:00:00.000Z',
  finishedAt: '2026-08-29T00:01:00.000Z',
  axes: { model: 'live', memory: 'live' },
  models: { chat: 'gemini-2.5-flash', embedding: 'gemini-embedding-001' },
  trialsPerTask: 2,
  tasks: [
    {
      taskId: 'memory-recall-001',
      description: 'a task',
      trials: [trial(0, true), trial(1, false)],
      trialsPerTask: 2,
      passAtK: true,
      passHatK: false,
      perGraderPassRate: { episodic_row_written: 0.5 },
    },
  ],
  passRate: 0.5,
  skipped: [],
  uncalibratedGraders: ['answer_is_grounded'],
  genAiSemconvCommit: 'e57c543b4889619eb2a05702471937db5119165d',
  budgetBreaches: 0,
  usage: { checked: true, trials: [] },
};

/** The stub-axis shape: one task ran, one was not measurable here. */
const { models: _models, ...stubReport } = report;
const reportWithSkip: SuiteReport = {
  ...stubReport,
  axes: { model: 'stub', memory: 'live' },
  tasks: [{ ...report.tasks[0]!, trials: [trial(0, true), trial(1, true)], passHatK: true }],
  passRate: 1,
  skipped: [
    {
      taskId: 'tool-use-001',
      problems: ['model axis is `stub`, needs one of `live`, `replay`'],
    },
  ],
};

describe('renderJsonReport', () => {
  it('round-trips the whole report, transcripts included', () => {
    const parsed = JSON.parse(renderJsonReport(report)) as SuiteReport;
    expect(parsed).toEqual(report);
  });

  it('carries the skipped tasks and their reasons, so the denominator is reconstructable', () => {
    const parsed = JSON.parse(renderJsonReport(reportWithSkip)) as SuiteReport;
    expect(parsed.skipped).toEqual([
      {
        taskId: 'tool-use-001',
        problems: ['model axis is `stub`, needs one of `live`, `replay`'],
      },
    ]);
  });
});

describe('renderJUnitReport', () => {
  it('emits one test case per trial, so failures read as pass^k', () => {
    const xml = renderJUnitReport(report);
    expect(xml).toContain('<testsuites name="memory-recall" tests="2" failures="1" skipped="0">');
    expect(xml).toContain('<testcase name="memory-recall-001 trial 1"/>');
    expect(xml).toContain('<testcase name="memory-recall-001 trial 2">');
    expect(xml).toContain('<property name="pass@k" value="true"/>');
    expect(xml).toContain('<property name="memory_axis" value="live"/>');
  });

  it('emits a skipped task as a skipped case, not as a pass and not as an absence', () => {
    const xml = renderJUnitReport(reportWithSkip);
    expect(xml).toContain('<testsuites name="memory-recall" tests="3" failures="0" skipped="1">');
    expect(xml).toContain('<testsuite name="tool-use-001" tests="1" failures="0" skipped="1">');
    expect(xml).toContain('<testcase name="tool-use-001 (not run)">');
    expect(xml).toContain(
      '<skipped message="model axis is `stub`, needs one of `live`, `replay`"/>',
    );
    // Not a pass: no self-closing case for it.
    expect(xml).not.toContain('<testcase name="tool-use-001 (not run)"/>');
  });

  it('escapes a failure message rather than emitting invalid XML', () => {
    const xml = renderJUnitReport(report);
    expect(xml).toContain('0 episodes row(s) &amp; counting');
    expect(xml).not.toContain('& counting');
  });
});

describe('renderMarkdownSummary', () => {
  it('leads with the axes, because nothing else distinguishes a stub run', () => {
    const markdown = renderMarkdownSummary(report);
    expect(markdown).toContain('**Axes:** model `live`, memory `live`');
    expect(markdown).toContain('| `memory-recall-001` | ✅ | ❌ | 1/2 |');
    expect(markdown).toContain('overall pass rate 50%');
  });

  it('names uncalibrated judges rather than presenting a guess as a measurement', () => {
    expect(renderMarkdownSummary(report)).toContain(
      '**Uncalibrated judges:** `answer_is_grounded`',
    );
  });

  it('cannot show the rate without showing what was left out of it', () => {
    const markdown = renderMarkdownSummary(reportWithSkip);
    const rate = markdown.indexOf('overall pass rate 100%');
    const exclusion = markdown.indexOf('Not run on these axes');

    expect(markdown).toContain('overall pass rate 100%** over 1 of 2 tasks');
    expect(markdown).toContain(
      '> - `tool-use-001` — model axis is `stub`, needs one of `live`, `replay`',
    );
    // Above the table, and below nothing: the reader meets it on the way past.
    expect(exclusion).toBeGreaterThan(rate);
    expect(exclusion).toBeLessThan(markdown.indexOf('| Task |'));
    // And in the table too, so the list of tasks is not quietly one short.
    expect(markdown).toContain('| `tool-use-001` | ⏭️ skipped | ⏭️ skipped | not run |');
  });

  it('says nothing about skips when there were none', () => {
    expect(renderMarkdownSummary(report)).not.toContain('Not run on these axes');
    expect(renderMarkdownSummary(report)).toContain('overall pass rate 50%**\n');
  });

  it('names the GenAI conventions commit the report’s spans and events follow', () => {
    expect(renderMarkdownSummary(report)).toContain(
      'GenAI semantic conventions at `e57c543b4889619eb2a05702471937db5119165d`',
    );
    expect(JSON.parse(renderJsonReport(report))).toMatchObject({
      axes: report.axes,
      genAiSemconvCommit: 'e57c543b4889619eb2a05702471937db5119165d',
    });
  });

  it('reports each grader’s pass rate', () => {
    expect(renderMarkdownSummary(report)).toContain('| `episodic_row_written` | 50% |');
  });
});

/** The replay axis: the same suite, served from a recorded set. */
const replayedReport: SuiteReport = {
  ...report,
  axes: { model: 'replay', memory: 'live' },
  replay: {
    recordedAt: '2026-09-10T12:00:00.000Z',
    gitSha: '3b696d5c0ffee1234567890abcdef1234567890a',
    cassettes: 2,
  },
};

describe('a replayed report', () => {
  it('carries the set’s provenance through the JSON reporter', () => {
    const parsed = JSON.parse(renderJsonReport(replayedReport)) as SuiteReport;
    expect(parsed.replay).toEqual(replayedReport.replay);
  });

  it('reads pass^k against the k it was actually run at', () => {
    // The suite asked for two and the cassettes allowed one. The header saying
    // two would make `pass^k` on a single replayed trial look like reliability
    // over two, which is the whole misreading the cap exists to prevent.
    const capped: SuiteReport = {
      ...replayedReport,
      tasks: [{ ...replayedReport.tasks[0]!, trials: [trial(0, true)], trialsPerTask: 1 }],
    };

    expect(renderMarkdownSummary(capped)).toContain(
      "**1 trial(s) per task**, capped below the suite's 2",
    );
    expect(renderMarkdownSummary(replayedReport)).toContain('**2 trial(s) per task**');
  });

  it('prints when and against what the set was recorded, beside the axis line', () => {
    const markdown = renderMarkdownSummary(replayedReport);
    const axisLine = markdown.split('\n').findIndex((line) => line.startsWith('**Axes:**'));
    const replayLine = markdown.split('\n').findIndex((line) => line.startsWith('**Replayed'));

    expect(replayLine).toBe(axisLine + 2);
    expect(markdown).toContain('2026-09-10T12:00:00.000Z');
    expect(markdown).toContain('3b696d5c0ffee1234567890abcdef1234567890a');
    // The sentence a reader has to leave with: the number is a property of the
    // recording as much as of the code.
    expect(markdown).toContain('frozen sample');
  });

  it('says nothing about a recording on a run that was not replaying', () => {
    expect(renderMarkdownSummary(report)).not.toContain('Replayed');
    expect(renderJUnitReport(report)).not.toContain('cassettes_recorded_at');
  });

  it('puts the provenance on the same test suite as the pass^k it qualifies', () => {
    const xml = renderJUnitReport(replayedReport);
    expect(xml).toContain(
      '<property name="cassettes_recorded_at" value="2026-09-10T12:00:00.000Z"/>',
    );
    expect(xml).toContain(
      '<property name="cassettes_git_sha" value="3b696d5c0ffee1234567890abcdef1234567890a"/>',
    );
    expect(xml).toContain('<property name="trials_per_task" value="2"/>');
  });
});

/**
 * P1-E: the axis says a model answered, and only the ids say which. A run on
 * the floating alias must not read as a run on the pinned id in any of the
 * three files.
 */
describe('the model ids', () => {
  const floating: SuiteReport = {
    ...report,
    models: { chat: 'gemini-flash-latest', embedding: 'gemini-embedding-001' },
  };

  it('are in all three reports on the live axis', () => {
    expect((JSON.parse(renderJsonReport(floating)) as SuiteReport).models).toEqual(floating.models);
    expect(renderJUnitReport(floating)).toContain(
      '<property name="chat_model" value="gemini-flash-latest"/>',
    );
    expect(renderJUnitReport(floating)).toContain(
      '<property name="embedding_model" value="gemini-embedding-001"/>',
    );
    expect(renderMarkdownSummary(floating)).toContain(
      '**Models:** chat `gemini-flash-latest`, embedding `gemini-embedding-001`',
    );
  });

  it('are in all three reports on the replay axis', () => {
    const replayed = { ...replayedReport, models: report.models! };
    expect(renderJsonReport(replayed)).toContain('"chat": "gemini-2.5-flash"');
    expect(renderJUnitReport(replayed)).toContain(
      '<property name="chat_model" value="gemini-2.5-flash"/>',
    );
    expect(renderMarkdownSummary(replayed)).toContain('**Models:** chat `gemini-2.5-flash`');
  });

  it('are absent on the stub axis, where no model answered', () => {
    expect(renderMarkdownSummary(reportWithSkip)).not.toContain('**Models:**');
    expect(renderJUnitReport(reportWithSkip)).not.toContain('chat_model');
  });
});

/** A replayed trial that breached its input budget and passed every grader (P1-F). */
const breachedTrial: Trial = {
  ...trial(0, true),
  budgets: [
    {
      budget: 'inputTokens',
      limit: 3000,
      actual: 3412,
      label: 'breached',
      source: 'recorded',
      explanation: '3412 input tokens against a ceiling of 3000: over by 412',
    },
    {
      budget: 'modelCalls',
      limit: 5,
      actual: 5,
      label: 'within',
      source: 'recorded',
      explanation: '5 generate_content calls against a ceiling of 5',
    },
  ],
  withinBudget: false,
};

const usageRow = {
  taskId: 'tool-use-001',
  index: 0,
  modelCalls: 5,
  erroredModelCalls: 0,
  inputTokens: 3412,
  outputTokens: 2210,
  reasoningTokens: 1900,
  embeddingCalls: 7,
  cost: {
    usd: 0.0065,
    unpricedModels: ['gemini-9-ultra'],
    unpricedEmbeddingCalls: 7,
  },
};

const prices = {
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  pageLastUpdated: '2026-10-07',
  readOn: '2026-10-08',
  tier: 'paid, standard',
};

const budgetedReport: SuiteReport = {
  ...replayedReport,
  tasks: [
    {
      ...replayedReport.tasks[0]!,
      taskId: 'tool-use-001',
      trials: [{ ...breachedTrial, taskId: 'tool-use-001' }],
      trialsPerTask: 1,
      passHatK: true,
    },
  ],
  passRate: 1,
  budgetBreaches: 1,
  usage: {
    checked: true,
    prices,
    trials: [{ ...usageRow, source: 'recorded', modelLatencyMs: null }],
  },
};

describe('budgets and usage', () => {
  it('prints a breach beside a 100% pass rate, with the limit and the actual value', () => {
    const markdown = renderMarkdownSummary(budgetedReport);

    expect(markdown).toContain('overall pass rate 100%');
    expect(markdown).toContain('**1 budget breach(es).**');
    expect(markdown).toContain(
      '| `tool-use-001` | 1 | `inputTokens` | 3000 | 3412 | ❌ breached | recorded |',
    );
    expect(markdown).toContain(
      '| `tool-use-001` | 1 | `modelCalls` | 5 | 5 | ✅ within | recorded |',
    );
  });

  it('prints the cost as a list-price equivalent naming its source, and what is unpriced', () => {
    const markdown = renderMarkdownSummary(budgetedReport);

    expect(markdown).toContain('$0.0065 + unpriced: `gemini-9-ultra`');
    expect(markdown).toContain('7 (unpriced)');
    expect(markdown).toContain(
      'list-price equivalent at paid, standard prices from https://ai.google.dev/gemini-api/docs/pricing (page last updated 2026-10-07',
    );
  });

  it('prints no model latency on replay, and says why', () => {
    const markdown = renderMarkdownSummary(budgetedReport);

    expect(markdown).not.toContain('Model latency |');
    expect(markdown).toContain('No model latency is reported on replay');
  });

  it('prints model latency on the live axis, as one sample', () => {
    const markdown = renderMarkdownSummary({
      ...budgetedReport,
      axes: { model: 'live', memory: 'live' },
      usage: {
        checked: true,
        prices,
        trials: [{ ...usageRow, source: 'measured', modelLatencyMs: 40169.44 }],
      },
    });

    expect(markdown).toContain('| Model latency |');
    expect(markdown).toContain('| 40169 ms |');
    expect(markdown).toContain('reported and never asserted');
  });

  it('says budgets were not checked on the stub axis, beside the skipped tasks', () => {
    const markdown = renderMarkdownSummary({
      ...reportWithSkip,
      usage: {
        checked: false,
        reason: 'budgets not checked on model=stub: the canned model set opens no inference span',
        trials: [],
      },
    });
    const notice = markdown.indexOf('budgets not checked on model=stub');

    // Beside the exclusions and above the table, where a reader looks for
    // what the run left out.
    expect(notice).toBeGreaterThan(markdown.indexOf('Not run on these axes'));
    expect(notice).toBeLessThan(markdown.indexOf('| Task |'));
    expect(markdown).not.toContain('### Budgets');
  });

  it('gives budgets a JUnit suite of their own, so the task’s suite stays at k cases', () => {
    const xml = renderJUnitReport(budgetedReport);

    expect(xml).toContain('<testsuites name="memory-recall" tests="3" failures="1" skipped="0">');
    expect(xml).toContain('<testsuite name="tool-use-001" tests="1" failures="0">');
    expect(xml).toContain('<testsuite name="tool-use-001 budgets" tests="2" failures="1">');
    expect(xml).toContain(
      '<failure message="breached: 3412 input tokens against a ceiling of 3000: over by 412"/>',
    );
    expect(xml).toContain('<testcase name="tool-use-001 trial 1 modelCalls"/>');
  });

  it('carries the budget results and the usage section in the JSON', () => {
    const parsed = JSON.parse(renderJsonReport(budgetedReport)) as SuiteReport;
    expect(parsed.budgetBreaches).toBe(1);
    expect(parsed.tasks[0]!.trials[0]!.withinBudget).toBe(false);
    expect(parsed.usage).toEqual(budgetedReport.usage);
  });
});

describe('the abort reporters', () => {
  const abort: EvalAbort = {
    suite: 'memory-recall',
    startedAt: '2026-09-26T00:00:00.000Z',
    abortedAt: '2026-09-26T00:00:05.000Z',
    axes: { model: 'replay', memory: 'live' },
    replay: { recordedAt: '2026-09-10T12:00:00.000Z', gitSha: '021c6f2', cassettes: 2 },
    error: {
      name: 'CassetteMissError',
      message: 'cassette miss at seam `plan.callLlm`\n- "old"\n+ "new"',
    },
    cause: {
      code: 'cassette-miss',
      summary: 'a recorded request no longer matches',
      remedy: '`EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval` with a key',
    },
    completedTrials: [completedTrial(trial(0, false))],
  };

  it('heads the summary `aborted` and gives no pass rate', () => {
    const markdown = renderAbortSummary(abort);
    expect(markdown.startsWith('## Eval — aborted\n')).toBe(true);
    expect(markdown).not.toMatch(/pass rate \d/);
    expect(markdown).toContain('there is no pass rate');
  });

  it('names the error, prints its message whole, and says what to do about it', () => {
    const markdown = renderAbortSummary(abort);
    expect(markdown).toContain('**`CassetteMissError`**');
    expect(markdown).toContain('- "old"\n+ "new"');
    expect(markdown).toContain('**Cause (`cassette-miss`):** a recorded request no longer matches');
    expect(markdown).toContain('**To fix:** `EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval`');
    expect(markdown).toContain('recorded `2026-09-10T12:00:00.000Z` at `021c6f2`');
  });

  it('lists the trials that finished before the abort, with what they failed', () => {
    expect(renderAbortSummary(abort)).toContain(
      '| `memory-recall-001` | 1 | ❌ | `episodic_row_written` |',
    );
    expect(renderAbortSummary({ ...abort, completedTrials: [] })).toContain(
      'stopped before its first trial finished',
    );
  });

  it('keeps a message holding a backtick fence inside a longer fence of its own', () => {
    const markdown = renderAbortSummary({
      ...abort,
      error: { name: 'Error', message: 'inner ``` fence' },
    });
    expect(markdown).toContain('````text\ninner ``` fence\n````');
  });

  it('round-trips through JSON, error details included', () => {
    const withDetails: EvalAbort = {
      ...abort,
      error: {
        name: 'GoogleGenerativeAIFetchError',
        message: '429',
        status: 429,
        errorDetails: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }],
      },
    };
    expect(JSON.parse(renderAbortJson(withDetails))).toEqual(withDetails);
  });

  it('reads status and details off a thrown client error, and nothing else', () => {
    const thrown = Object.assign(new Error('quota'), {
      status: 429,
      errorDetails: [{ '@type': 'x' }],
      request: { headers: { 'x-goog-api-key': 'not-copied' } },
    });
    expect(abortError(thrown)).toEqual({
      name: 'Error',
      message: 'quota',
      status: 429,
      errorDetails: [{ '@type': 'x' }],
    });
    expect(abortError('a string')).toEqual({ name: 'NonError', message: 'a string' });
  });
});
