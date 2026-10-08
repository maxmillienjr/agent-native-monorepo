import { describe, it, expect } from 'vitest';
import {
  STAGE2_CALLS,
  STAGE2_QUERY_COUNT,
  bridgeConcepts,
  bridgeNamed,
  buildStage2Report,
  gradeStage2Answer,
  renderStage2Markdown,
  stage2Status,
  type Stage2Answer,
  type Stage2QueryInput,
  type Stage2ReportInput,
} from './explanation-answers.js';

const BOOT = { resamples: 2_000, seed: 0x5eed } as const;

const answer = (content: string, invocation = 1): Stage2Answer => ({
  content,
  recordedAt: `2026-10-0${invocation}T12:00:00.000Z`,
  invocation,
});

/** A query whose key is "5 business days" and whose bridge is "Kestrel Review". */
const query = (
  id: string,
  answers: Stage2QueryInput['answers'],
  overrides: Partial<Stage2QueryInput> = {},
): Stage2QueryInput => ({
  queryId: id,
  answerKey: ['five business days', '5 business days'],
  bridgeLabels: ['Kestrel Review'],
  explainedFacts: 3,
  answerFactExplained: true,
  answers,
  ...overrides,
});

const RIGHT = 'Kestrel Review decides a standard request in five business days.';
const WRONG = 'I could not find how long the review takes.';

const input = (queries: Stage2QueryInput[]): Stage2ReportInput => ({
  startedAt: '2026-10-08T00:00:00.000Z',
  finishedAt: '2026-10-08T00:00:01.000Z',
  model: 'replay',
  datasetSha256: 'd'.repeat(64),
  labelsSha256: 'e'.repeat(64),
  answerFile: 'recorded/explanation-answers.json',
  answerFileSha256: 'f'.repeat(64),
  chatModel: 'gemini-2.5-flash',
  requestsThisRun: 0,
  topK: 10,
  bootstrap: BOOT,
  queries,
});

describe('the stage-2 budget', () => {
  it('is 38 queries and 76 calls, as P2-D fixed it', () => {
    expect(STAGE2_QUERY_COUNT).toBe(38);
    expect(STAGE2_CALLS).toBe(76);
  });
});

describe('bridgeConcepts', () => {
  it('is the last concept of each gold path, once', () => {
    expect(
      bridgeConcepts({
        queryId: 'r1',
        factHandle: 'e1-f1',
        gold: [
          { concepts: ['plan_a', 'vendor_b'], edgeTypes: ['DELEGATES_TO'] },
          { concepts: ['plan_a', 'vendor_b'], edgeTypes: ['USES'] },
        ],
      }),
    ).toEqual(['vendor_b']);
  });
});

describe('the graders', () => {
  it('answer_key_present accepts either spelling of a number, in any case', () => {
    expect(
      gradeStage2Answer('It takes FIVE business  days.', ['5 business days'], []),
    ).toMatchObject({ answerKeyPresent: true });
    expect(
      gradeStage2Answer('It takes 5 business days.', ['five business days'], []),
    ).toMatchObject({ answerKeyPresent: true });
    expect(gradeStage2Answer('It takes 15 business days.', ['5 business days'], [])).toMatchObject({
      answerKeyPresent: true,
    }); // lexical, and said so in P2-D's Risks
    expect(gradeStage2Answer('It takes a week.', ['5 business days'], [])).toMatchObject({
      answerKeyPresent: false,
    });
  });

  it('bridge_named reads the label, normalized', () => {
    expect(bridgeNamed('Ask kestrel  review.', ['Kestrel Review'])).toBe(true);
    expect(bridgeNamed('Ask the vendor.', ['Kestrel Review'])).toBe(false);
    expect(bridgeNamed('anything', [])).toBe(false);
  });
});

describe('buildStage2Report', () => {
  it('applies no rule to a part-recorded set, and rates only what is recorded', () => {
    const report = buildStage2Report(
      input([
        query('r1', { without: answer(WRONG), with: answer(RIGHT) }),
        query('r2', { without: answer(RIGHT) }),
        query('r3', {}),
      ]),
    );
    expect(report.answers).toMatchObject({ recorded: 3, expected: 6, invocations: 1 });
    expect(report.outcome).toBeNull();
    expect(report.graders.answerKeyPresent).toEqual({ without: 0.5, with: 1, difference: null });
    expect(report.reason).toBe('3 of 6 answers are recorded; the rule is applied once all are');
    expect(stage2Status(report)).toEqual({
      ran: false,
      generateContentCalls: 3,
      reason: 'stage 2 is part-recorded, 3 of 6 answers; the rule is applied once all are',
      outcome: null,
    });
    expect(renderStage2Markdown(report)).toContain('**Stage 2: not decided.**');
  });

  it('is met when the paths add more than the margin with a lower bound above zero', () => {
    // 38 queries; the paths turn 10 wrong answers right and break none.
    const queries = Array.from({ length: 38 }, (_, i) =>
      query(`r${i}`, {
        without: answer(i < 10 ? WRONG : RIGHT),
        with: answer(RIGHT),
      }),
    );
    const report = buildStage2Report(input(queries));
    const d = report.graders.answerKeyPresent.difference!;
    expect(d.n).toBe(38);
    expect(d.mean).toBeCloseTo(10 / 38, 10);
    expect(d.lower).toBeGreaterThan(0);
    expect(report.outcome).toBe('met');
    expect(stage2Status(report)).toMatchObject({
      ran: true,
      generateContentCalls: 76,
      outcome: 'met',
    });
    expect(renderStage2Markdown(report)).toContain('**Stage 2: met.**');
  });

  it('is not met when the paths change nothing, or help as often as they hurt', () => {
    const same = Array.from({ length: 38 }, (_, i) =>
      query(`r${i}`, { without: answer(RIGHT), with: answer(RIGHT) }),
    );
    expect(buildStage2Report(input(same)).outcome).toBe('not met');

    const mixed = Array.from({ length: 38 }, (_, i) =>
      query(`r${i}`, {
        without: answer(i % 2 === 0 ? WRONG : RIGHT),
        with: answer(i % 2 === 0 ? RIGHT : WRONG),
      }),
    );
    const report = buildStage2Report(input(mixed));
    expect(report.graders.answerKeyPresent.difference!.mean).toBe(0);
    expect(report.outcome).toBe('not met');
  });

  it('names a query whose two answers were recorded by different invocations', () => {
    const report = buildStage2Report(
      input([
        query('r1', { without: answer(RIGHT, 1), with: answer(RIGHT, 2) }),
        query('r2', { without: answer(RIGHT, 2), with: answer(RIGHT, 2) }),
      ]),
    );
    expect(report.queries.map((q) => q.split)).toEqual([[1, 2], null]);
    expect(report.answers).toMatchObject({
      invocations: 2,
      recordedFrom: '2026-10-01T12:00:00.000Z',
      recordedTo: '2026-10-02T12:00:00.000Z',
    });
  });

  it('reports bridge_named beside the rule without reading it', () => {
    const queries = Array.from({ length: 4 }, (_, i) =>
      query(`r${i}`, {
        without: answer('five business days'),
        with: answer('Kestrel Review: five business days'),
      }),
    );
    const report = buildStage2Report(input(queries));
    expect(report.graders.bridgeNamed).toMatchObject({ without: 0, with: 1 });
    expect(report.graders.bridgeNamed.difference!.mean).toBe(1);
    // The rule reads answer_key_present alone, which did not move.
    expect(report.outcome).toBe('not met');
  });
});
