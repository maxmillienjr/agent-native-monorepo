import { describe, it, expect } from 'vitest';
import { renderJsonReport } from './json.js';
import { renderJUnitReport } from './junit.js';
import { renderMarkdownSummary } from './summary.js';
import type { SuiteReport, Trial } from '../types.js';

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
  };
}

const report: SuiteReport = {
  suite: 'memory-recall',
  startedAt: '2026-08-29T00:00:00.000Z',
  finishedAt: '2026-08-29T00:01:00.000Z',
  axes: { model: 'live', memory: 'live' },
  trialsPerTask: 2,
  tasks: [
    {
      taskId: 'memory-recall-001',
      description: 'a task',
      trials: [trial(0, true), trial(1, false)],
      passAtK: true,
      passHatK: false,
      perGraderPassRate: { episodic_row_written: 0.5 },
    },
  ],
  passRate: 0.5,
  skipped: [],
  uncalibratedGraders: ['answer_is_grounded'],
};

/** The stub-axis shape: one task ran, one was not measurable here. */
const reportWithSkip: SuiteReport = {
  ...report,
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

  it('reports each grader’s pass rate', () => {
    expect(renderMarkdownSummary(report)).toContain('| `episodic_row_written` | 50% |');
  });
});
