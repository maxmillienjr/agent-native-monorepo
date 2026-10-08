import type { AgentDisposition, CriterionFinding } from '@repo/determination';
import type {
  Clock,
  Payer,
  Policy,
  PolicyCatalogue,
  PriorAuthRequest,
  Priority,
  ReferralReason,
} from '@repo/prior-auth';
import type { AssessDeps } from './assessment.js';

/**
 * The prior-authorization graph's state.
 *
 * Every channel is last-value-wins. No channel shares a name with a node
 * (`intake`, `lookup`, `assess`, `dispose`), which LangGraph would reject at
 * `addNode` (`.context/workflows.md`). Times are ISO strings so the checkpoint
 * holds them as written.
 */
export interface PriorAuthState {
  /** The case id: the checkpoint's `thread_id`, and `ClaimResponse.identifier`. */
  readonly caseId: string;
  /** The `$submit` body as received. `intake` reads it. */
  readonly bundle: unknown;
  /** The server's clock at the controller, never `Claim.created`. */
  readonly receivedAt: string;
  readonly request?: PriorAuthRequest;
  readonly priority?: Priority;
  readonly decisionDueBy?: string;
  readonly policy?: Policy;
  /** Set by `lookup` when the request is referred without an assessment. */
  readonly referralReason?: ReferralReason;
  /** The model's findings, as `assess` parsed them. Never serialized to the response. */
  readonly findings: readonly CriterionFinding[];
  readonly disposition?: AgentDisposition;
}

/** What the graph needs from outside it. */
export interface PriorAuthGraphDeps {
  readonly payer: Payer;
  readonly catalogue: PolicyCatalogue;
  readonly assess: AssessDeps;
  readonly clock: Clock;
}
