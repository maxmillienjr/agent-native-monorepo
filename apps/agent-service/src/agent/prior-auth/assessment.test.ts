import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IO_RETRY } from '../graph/retry.js';
import {
  AssessmentFormatError,
  assessmentPrompt,
  parseAssessment,
  stubAssessment,
} from './assessment.js';

const criteria = [
  { id: 'c1', title: 'First', requirement: 'Synthetic requirement one.' },
  { id: 'c2', title: 'Second', requirement: 'Synthetic requirement two.' },
];

describe('parseAssessment', () => {
  it('reads a finding per criterion', () => {
    const findings = parseAssessment(
      JSON.stringify({
        findings: [
          { criterionId: 'c1', status: 'met', evidence: ['Condition/a'], rationale: 'r' },
          { criterionId: 'c2', status: 'insufficient', evidence: [], rationale: 'r' },
        ],
      }),
    );
    expect(findings.map((finding) => finding.status)).toEqual(['met', 'insufficient']);
  });

  it('throws a retryable error on prose or a wrong shape', () => {
    for (const content of ['The request should be approved.', '{"findings":[{"status":"yes"}]}']) {
      let error: unknown;
      try {
        parseAssessment(content);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AssessmentFormatError);
      expect(error).not.toBeInstanceOf(z.ZodError);
      expect(IO_RETRY.retryOn?.(error)).toBe(true);
    }
  });

  it('refuses a finding that recommends an outcome', () => {
    expect(() =>
      parseAssessment(
        JSON.stringify({
          findings: [{ criterionId: 'c1', status: 'deny', evidence: [], rationale: 'r' }],
        }),
      ),
    ).toThrow(AssessmentFormatError);
  });
});

describe('assessmentPrompt', () => {
  it('is stable for the same request, which is what a cassette is keyed on', () => {
    const evidence = [{ reference: 'DocumentReference/d', text: 'A synthetic note.' }];
    expect(assessmentPrompt(criteria, evidence)).toBe(assessmentPrompt(criteria, evidence));
    expect(JSON.parse(assessmentPrompt(criteria, evidence))).toEqual({ criteria, evidence });
  });
});

describe('stubAssessment', () => {
  it('finds every criterion insufficient, so the stub axis refers everything', async () => {
    const findings = await stubAssessment.assessCriteria(criteria, []);
    expect(findings.map((finding) => finding.status)).toEqual(['insufficient', 'insufficient']);
  });
});
