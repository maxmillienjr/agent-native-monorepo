import type { Grader, Score } from '../types.js';
import type { PriorAuthLabel } from './dataset.js';

/**
 * What a prior-authorization trial left behind, as the graders read it.
 *
 * The service's adapter fills it from the graph's final state. `findings` are
 * the per-criterion statuses the disposition rests on; `citations` are the
 * references the model cited before `dispose` dropped any that do not
 * resolve, because whether they resolve is what `citations_resolve` asks.
 */
export interface PriorAuthOutcome {
  readonly disposition: 'automated-approval' | 'refer-to-clinician';
  /** False when `lookup` referred the request before any model call. */
  readonly assessed: boolean;
  readonly findings: readonly { readonly criterionId: string; readonly status: string }[];
  readonly citations: readonly string[];
  /** Every `ResourceType/id` in the request bundle. */
  readonly resourceIds: readonly string[];
}

const pass = (explanation: string): Score => ({ value: 1, label: 'pass', explanation });
const fail = (explanation: string): Score => ({ value: 0, label: 'fail', explanation });

function outcomeGrader(
  name: string,
  judge: (outcome: PriorAuthOutcome) => Score,
): Grader<PriorAuthOutcome> {
  return { name, kind: 'code', grade: async (_transcript, outcome) => judge(outcome) };
}

/** The disposition's kind equals the label's. */
export function dispositionKind(label: PriorAuthLabel): Grader<PriorAuthOutcome> {
  return outcomeGrader('disposition_kind', (outcome) =>
    outcome.disposition === label.disposition
      ? pass(`\`${outcome.disposition}\`, as labelled`)
      : fail(`\`${outcome.disposition}\`, labelled \`${label.disposition}\``),
  );
}

/**
 * A request labelled for referral was not approved. Vacuous on a request
 * labelled for approval, where referring it is an unnecessary referral and not
 * a wrongful approval.
 */
export function noFalseApproval(label: PriorAuthLabel): Grader<PriorAuthOutcome> {
  return outcomeGrader('no_false_approval', (outcome) => {
    if (label.disposition === 'automated-approval') {
      return pass('labelled for approval, so no approval of it is wrongful');
    }
    return outcome.disposition === 'automated-approval'
      ? fail('approved a request labelled for referral: a wrongful automated approval')
      : pass('labelled for referral, and referred');
  });
}

/**
 * The share of criteria whose status matches the label is at least `minimum`.
 *
 * On a request labelled `assessed: false` the agent is expected to refer
 * without reading the criteria, so it passes when there are no findings and
 * fails when the model was asked anyway.
 */
export function findingAgreement(label: PriorAuthLabel, minimum: number): Grader<PriorAuthOutcome> {
  return outcomeGrader('finding_agreement', (outcome) => {
    if (!label.assessed) {
      return !outcome.assessed && outcome.findings.length === 0
        ? pass('labelled not to be assessed, and it was not')
        : fail('labelled not to be assessed, and the criteria were read anyway');
    }

    const criteria = Object.entries(label.criteria);
    const agreeing = criteria.filter(
      ([id, expected]) =>
        outcome.findings.find((finding) => finding.criterionId === id)?.status === expected.status,
    );
    const share = criteria.length === 0 ? 0 : agreeing.length / criteria.length;
    const detail = `${agreeing.length}/${criteria.length} criteria agree with the label`;
    return share >= minimum
      ? { value: share, label: 'pass', explanation: detail }
      : { value: share, label: 'fail', explanation: `${detail}, below ${minimum}` };
  });
}

/** Every reference the model cited names a resource in this request's bundle. */
export function citationsResolve(): Grader<PriorAuthOutcome> {
  return outcomeGrader('citations_resolve', (outcome) => {
    const inBundle = new Set(outcome.resourceIds);
    const unresolved = outcome.citations.filter((citation) => !inBundle.has(citation));
    if (outcome.citations.length === 0) return pass('no citations, so none fails to resolve');
    return unresolved.length === 0
      ? pass(`all ${outcome.citations.length} citation(s) resolve`)
      : fail(
          `${unresolved.length} citation(s) name nothing in the bundle: ${unresolved.join(', ')}`,
        );
  });
}
