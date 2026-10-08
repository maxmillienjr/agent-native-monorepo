import { withNodeSpan } from '@repo/telemetry';
import {
  coverageActiveOn,
  decideDisposition,
  decisionDueBy,
  evidenceFor,
  readSubmission,
} from '@repo/prior-auth';
import type { AgentDisposition } from '@repo/determination';
import type { PriorAuthGraphDeps, PriorAuthState } from './state.js';

/**
 * The four nodes of the prior-authorization graph:
 *
 *   START → intake → lookup → assess → dispose → END
 *
 * `intake`, `lookup` and `dispose` are pure functions of state and the
 * catalogue; `assess` is the one model call. Each opens its
 * `agent.node.<name>` span. The span attributes are times, a priority and
 * the disposition's kind: nothing from the member's record.
 */

type Update = Promise<Partial<PriorAuthState>>;

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`prior-auth graph reached a node without ${what}`);
  return value;
}

/**
 * Reads the bundle with the Zod subset and starts the clock.
 *
 * The controller has already answered a body it cannot read, so a failure
 * here is a defect, not a client error, and it throws.
 */
export async function intakeNode(state: PriorAuthState, deps: PriorAuthGraphDeps): Update {
  return withNodeSpan('intake', async (span) => {
    span.setAttribute('run_id', state.caseId);

    const submission = readSubmission(state.bundle, deps.payer);
    if (submission.kind !== 'ok') {
      throw new Error(
        `intake received a ${submission.kind} submission the controller should have answered`,
      );
    }

    const { request } = submission;
    const dueBy = decisionDueBy(new Date(state.receivedAt), request.priority).toISOString();

    span.setAttribute('prior_auth.received_at', state.receivedAt);
    span.setAttribute('prior_auth.priority', request.priority);
    span.setAttribute('prior_auth.decision_due_by', dueBy);

    return { request, priority: request.priority, decisionDueBy: dueBy };
  });
}

/**
 * Finds the policy for the HCPCS code and checks the coverage on the date of
 * service. Either failing sets a reason, and the graph skips `assess`: there
 * is nothing for the model to read a request against, or nothing it could
 * find would change the referral.
 */
export async function lookupNode(state: PriorAuthState, deps: PriorAuthGraphDeps): Update {
  return withNodeSpan('lookup', async (span) => {
    span.setAttribute('run_id', state.caseId);
    const request = required(state.request, 'a request');

    const policy = deps.catalogue.forCode(request.hcpcs);
    if (policy === undefined) return { referralReason: 'no-policy' };
    if (!coverageActiveOn(request.coverage, request.serviceDate)) {
      return { policy, referralReason: 'coverage-inactive' };
    }
    return { policy };
  });
}

/** The one model call: a finding per criterion, through the `assess.criteria` seam. */
export async function assessNode(state: PriorAuthState, deps: PriorAuthGraphDeps): Update {
  return withNodeSpan('assess', async (span) => {
    span.setAttribute('run_id', state.caseId);
    const request = required(state.request, 'a request');
    const policy = required(state.policy, 'a policy');

    const findings = await deps.assess.assessCriteria(policy.criteria, evidenceFor(request));
    return { findings };
  });
}

/**
 * Code, not model: `automated-approval` if and only if every criterion is
 * met with a citation that resolves into this bundle, otherwise
 * `refer-to-clinician` carrying every finding. A request `lookup` referred
 * carries no findings, because nothing was assessed.
 *
 * `prior_auth.elapsed_ms` is the time from receipt to here, which is the
 * whole of what the tool holds a request for (P3-D's second SB 1120
 * invariant), on the span so P1-F can budget it.
 */
export async function disposeNode(state: PriorAuthState, deps: PriorAuthGraphDeps): Update {
  return withNodeSpan('dispose', async (span) => {
    span.setAttribute('run_id', state.caseId);
    const request = required(state.request, 'a request');

    const disposition: AgentDisposition =
      state.referralReason !== undefined || state.policy === undefined
        ? { kind: 'refer-to-clinician', findings: [] }
        : decideDisposition(state.policy, state.findings, request.resourceIds);

    span.setAttribute('prior_auth.disposition', disposition.kind);
    span.setAttribute(
      'prior_auth.elapsed_ms',
      deps.clock.now().getTime() - new Date(state.receivedAt).getTime(),
    );

    return { disposition };
  });
}
