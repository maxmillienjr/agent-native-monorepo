import { z } from 'zod';
import { CriterionFindingSchema, type CriterionFinding } from '@repo/determination';
import type { EvidenceItem, PolicyCriterion } from '@repo/prior-auth';

/**
 * The one model call the prior-authorization graph makes, at the
 * `assess.criteria` seam.
 *
 * The model reports a finding per criterion and nothing else. It is never
 * asked for an outcome: `dispose` derives that from the findings in code, so
 * the rule for when software may approve is something a reviewer reads rather
 * than a prompt.
 */
export interface AssessDeps {
  assessCriteria(
    criteria: readonly PolicyCriterion[],
    evidence: readonly EvidenceItem[],
  ): Promise<CriterionFinding[]>;
}

export const ASSESS_PROMPT = `You review a prior-authorization request against a medical policy's criteria.
For each criterion, decide from the evidence alone whether it is:
- "met": the evidence states that the criterion is satisfied,
- "not-met": the evidence states something that fails the criterion,
- "insufficient": the evidence does not say, or says it only vaguely, without a date, or as hearsay.
Cite every evidence reference you relied on, exactly as given (for example "DocumentReference/doc-1").
Never cite a reference that is not in the evidence list. Do not recommend an outcome.
Respond with JSON only:
{"findings": [{"criterionId": "...", "status": "met" | "not-met" | "insufficient", "evidence": ["..."], "rationale": "..."}]}`;

/**
 * The user turn: the criteria and the evidence, as JSON, in the order given.
 * The order is the policy's and the bundle's, so the cassette's request hash
 * is stable for an unchanged request.
 */
export function assessmentPrompt(
  criteria: readonly PolicyCriterion[],
  evidence: readonly EvidenceItem[],
): string {
  return JSON.stringify(
    {
      criteria: criteria.map(({ id, title, requirement }) => ({ id, title, requirement })),
      evidence: evidence.map(({ reference, text }) => ({ reference, text })),
    },
    null,
    2,
  );
}

/**
 * A model response that is not a valid assessment.
 *
 * Not a `ZodError` and with no `status`, because `IO_RETRY.retryOn` excludes
 * both: a malformed response is the transient failure the retry policy is for,
 * as it is for `ExtractionFormatError`.
 */
export class AssessmentFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentFormatError';
  }
}

const AssessmentSchema = z.object({ findings: z.array(CriterionFindingSchema) });

export function parseAssessment(content: string): CriterionFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AssessmentFormatError(`assessment was not JSON (${content.length} characters)`);
  }
  const result = AssessmentSchema.safeParse(parsed);
  if (!result.success) {
    throw new AssessmentFormatError(`assessment did not match the schema: ${result.error.message}`);
  }
  return result.data.findings;
}

/**
 * The stub axis: every criterion `insufficient`, so every request is referred.
 * That makes the stub useful for the HTTP and mapping tests and useless for
 * grading the agent, which is why the suite's tasks require a live or
 * replayed model.
 */
export const stubAssessment: AssessDeps = {
  assessCriteria: async (criteria) =>
    criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: 'insufficient' as const,
      evidence: [],
      rationale: 'stub model: no assessment was made',
    })),
};
