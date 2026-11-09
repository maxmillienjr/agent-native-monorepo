import type { AgentDisposition, CriterionFinding } from '@repo/determination';
import type { Policy } from './policy.js';

/**
 * Why a referral happened, as code knows it. The reason is routing, decided
 * by `lookup` from the bundle, and the response states it from a template.
 */
export type ReferralReason = 'criteria' | 'no-policy' | 'coverage-inactive';

/** Fixed text for a finding code synthesized rather than one the model returned. */
const NO_FINDING = 'no finding was returned for this criterion';
const UNRESOLVED =
  'the finding was met, but none of its citations names a resource in this request';
const UNRESOLVED_BESIDE =
  'the finding was met, but one or more of its citations names no resource in this request';
const DROPPED = (count: number) =>
  `${count} cited reference(s) named no resource in this request and were removed`;

/**
 * Normalizes the model's findings against the policy and the bundle.
 *
 * - A finding for a criterion the policy does not have is dropped: the model
 *   does not get to add criteria.
 * - A criterion the model returned no finding for is `insufficient`.
 * - Citations that do not name a resource in this bundle are removed. A `met`
 *   finding that cited any such reference becomes `insufficient`, whether or
 *   not a real citation is left beside it. CDI's SB 1120 guidance asks that a
 *   tool decide from "the insured's medical or other clinical history", and a
 *   `met` resting even partly on a document this member's record does not
 *   hold is one the tool cannot show it made from that record (P3-G).
 * - A `not-met` or `insufficient` finding keeps its status, since it refers
 *   whatever it cites, and its rationale says how many citations were removed.
 *
 * The output is in policy order, one finding per criterion.
 */
export function normalizeFindings(
  policy: Policy,
  findings: readonly CriterionFinding[],
  resourceIds: readonly string[],
): CriterionFinding[] {
  const inBundle = new Set(resourceIds);

  return policy.criteria.map((criterion) => {
    const finding = findings.find((candidate) => candidate.criterionId === criterion.id);
    if (finding === undefined) {
      return {
        criterionId: criterion.id,
        status: 'insufficient',
        evidence: [],
        rationale: NO_FINDING,
      };
    }

    const evidence = finding.evidence.filter((reference) => inBundle.has(reference));
    const dropped = finding.evidence.length - evidence.length;
    if (finding.status === 'met' && (evidence.length === 0 || dropped > 0)) {
      const reason = evidence.length === 0 ? UNRESOLVED : UNRESOLVED_BESIDE;
      return {
        criterionId: criterion.id,
        status: 'insufficient',
        evidence,
        rationale: `${reason}. Model rationale: ${finding.rationale}`,
      };
    }
    if (dropped > 0) {
      const rationale = `${DROPPED(dropped)}. Model rationale: ${finding.rationale}`;
      return { ...finding, evidence, rationale };
    }
    return { ...finding, evidence };
  });
}

/**
 * The rule for when software may approve, and it is code rather than a prompt.
 *
 * `automated-approval` if and only if every criterion of the policy is `met`
 * with at least one citation that resolves into this request's bundle and
 * none that does not.
 * Anything else is `refer-to-clinician`, carrying every finding. The model
 * reports findings and never chooses this outcome.
 *
 * If a regulator read any referral a tool originates as a "delay" under
 * SB 1120, the fallback is to approve nothing: return the referral branch
 * unconditionally. The evaluation suite would then report an unnecessary
 * referral rate of 100%.
 */
export function decideDisposition(
  policy: Policy,
  findings: readonly CriterionFinding[],
  resourceIds: readonly string[],
): AgentDisposition {
  const normalized = normalizeFindings(policy, findings, resourceIds);
  const approvable = normalized.every(
    (finding) => finding.status === 'met' && finding.evidence.length > 0,
  );

  return approvable
    ? { kind: 'automated-approval', criteriaMet: normalized.map((finding) => finding.criterionId) }
    : { kind: 'refer-to-clinician', findings: normalized };
}
